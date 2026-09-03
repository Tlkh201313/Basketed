import type { BrowserContext, Page, Request } from "patchright";
import type { StoreStatus } from "@basketed/core";
import { jarKey, loginKey, sameSite, type CredentialKind, type Vault } from "@basketed/vault";
import { cookieUrlsFor, loginFor, type StoreLogin } from "./descriptors.js";
import { detectHumanNeeded, type HumanKind } from "./detect.js";
import { bearerFromHtml, cookiesFromHeader } from "./jar.js";
import { withTimeout, wrapPage, type ProbePage } from "./page.js";
import { isSignedIn, settle } from "./probe.js";
import { Profiles, profileDir } from "./profiles.js";
import { readState, writeState, type SessionHealth, type SessionState } from "./state.js";

/**
 * The session manager: sign in once, stay signed in (S23).
 *
 *   openLogin      a VISIBLE window on the store's account page. Already
 *                  signed in? Seal and close. Not? Land on the sign-in page,
 *                  fill it in if a password was left with us, and watch --
 *                  without ever taking the tab away from the human -- until
 *                  the page says "signed in". Then seal, then close.
 *   checkSession   headless: is the profile still signed in? Yes -> re-seal
 *                  (the profile has renewed its own tokens; this is what
 *                  makes a session "forever"). No -> expired.
 *   relogin        headless, only with a stored password, only on the
 *                  retailer's own host: fill the form, and STOP the moment
 *                  the page asks for a code or a captcha. That escalates to
 *                  a window only when a human is at the panel (`interactive`).
 *   refresh        what the purchase path calls on a 401: check, then relogin
 *                  if it can, rate-limited so a broken store cannot make us
 *                  hammer its sign-in page.
 *
 * What gets sealed into the vault is what the adapters already expect -- a
 * `Cookie:` header, or for Tesco the bearer its frontend sends -- so nothing
 * downstream changes. The profile directory is the source of truth; the vault
 * row is a snapshot of it.
 */

export type LoginState =
  | "idle"
  | "opening"
  | "waiting"
  | "autofilling"
  | "needs_human"
  | "signed_in"
  | "sealing"
  | "connected"
  | "failed"
  | "cancelled";

export interface LoginStatus {
  state: LoginState;
  human: HumanKind | null;
  waited_ms: number;
  error: string | null;
}

export interface RefreshResult {
  ok: boolean;
  state: "live" | "expired" | "needs_human";
  reason?: string;
}

export interface SessionRegistry {
  setStatus(id: string, status: StoreStatus): void;
}

export interface SessionManager {
  loginFor(storeId: string): StoreLogin | null;
  hasProfile(storeId: string): boolean;
  /** A cookie jar captured from the user's own browser, kept to renew the bearer without one of ours. */
  hasJar(storeId: string): boolean;
  hasCredentials(storeId: string): boolean;
  openLogin(storeId: string): Promise<{ ok: true; state: LoginState } | { ok: false; error: string }>;
  pollStatus(storeId: string): LoginStatus;
  finishLogin(storeId: string): Promise<{ ok: true; kind: CredentialKind } | { ok: false; error: string }>;
  cancelLogin(storeId: string): Promise<boolean>;
  health(storeId: string): SessionHealth;
  checkSession(storeId: string): Promise<SessionHealth>;
  reloginWithCredentials(storeId: string, opts: { interactive: boolean }): Promise<SessionHealth>;
  refresh(storeId: string): Promise<RefreshResult>;
  forgetProfile(storeId: string): Promise<boolean>;
  closeAll(): Promise<void>;
}

export interface SessionManagerOptions {
  vault: Vault;
  registry?: SessionRegistry;
  log?: (line: string) => void;
  profiles?: Profiles;
  /** How long a sign-in window stays open unattended. */
  headedTtlMs?: number;
  pollMs?: number;
  refreshCooldownMs?: number;
}

const ACTIVE = new Set<LoginState>(["opening", "waiting", "autofilling", "needs_human", "signed_in", "sealing"]);
const NAV = { waitUntil: "domcontentloaded" as const, timeout: 30_000 };

interface Attempt {
  state: LoginState;
  human: HumanKind | null;
  startedAt: number;
  error: string | null;
  bearer: string | null;
  context: BrowserContext | null;
  ttl: NodeJS.Timeout | null;
  done: boolean;
}

function message(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split("\n")[0]?.slice(0, 160) ?? "unknown error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bearerFrom(req: Request, match: string): string | null {
  if (!req.url().includes(match)) return null;
  const h = req.headers()["authorization"];
  return h && h.startsWith("Bearer ") ? h.slice("Bearer ".length) : null;
}

export { bearerFromHtml } from "./jar.js";

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const vault = opts.vault;
  const registry = opts.registry;
  const log = opts.log ?? (() => {});
  const profiles = opts.profiles ?? new Profiles({ log });
  const headedTtlMs = opts.headedTtlMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 2000;
  const cooldownMs = opts.refreshCooldownMs ?? 60_000;

  const attempts = new Map<string, Attempt>();
  const refreshedAt = new Map<string, number>();

  const active = (id: string): Attempt | null => {
    const a = attempts.get(id);
    return a && ACTIVE.has(a.state) ? a : null;
  };

  const mark = (id: string, session_state: SessionState, reason: string | null): SessionHealth => {
    const h = writeState(profileDir(id), {
      session_state,
      last_verified_at: session_state === "live" ? Date.now() : (readState(profileDir(id)).last_verified_at ?? null),
      reason,
    });
    const status: StoreStatus | null =
      session_state === "live" ? "ready" : session_state === "expired" ? "expired" : session_state === "needs_human" ? "needs_auth" : null;
    if (status && registry) {
      try {
        registry.setStatus(id, status);
      } catch {
        /* a store the registry does not know -- the sim twins in a live-only run */
      }
    }
    return h;
  };

  /**
   * A jar captured in the user's own browser is waiting: adopt it into this
   * store's headless profile, then probe and seal exactly as a check would
   * (see jar.ts for why there is no cheaper way). One shot -- the jar row is
   * forgotten whatever happens, so a stale jar can never shadow the profile
   * that grew out of it, and a fresh Connect always wins over an old profile.
   */
  async function seedFromJar(id: string, d: StoreLogin): Promise<SessionHealth> {
    const jar = vault.reveal(jarKey(id));
    if (!jar) return { session_state: "unknown", last_verified_at: null, reason: "no_profile", profile: false };
    vault.forget(jarKey(id));
    if (active(id)) return { ...readState(profileDir(id)), session_state: "checking" };
    try {
      const probe = await profiles.with(id, { headed: false }, async (h) => {
        await h.context.addCookies(cookiesFromHeader(jar.secret, d));
        const page = await h.context.newPage();
        try {
          const r = await isSignedIn(wrapPage(page, h.context), d, { navigate: true });
          if (r.signedIn) await captureAndSeal(id, d, h.context, null);
          return r;
        } finally {
          await page.close().catch(() => {});
        }
      });
      if (probe.signedIn) {
        log(`session: ${id} seeded from the jar captured in the user's browser`);
        return mark(id, "live", "jar_seeded");
      }
      if (probe.human) return mark(id, "needs_human", probe.reason);
      return mark(id, "expired", probe.reason);
    } catch (err) {
      log(`session: seeding ${id} failed: ${message(err)}`);
      return mark(id, "expired", `error:${message(err)}`);
    }
  }

  /** Snapshot the profile's session into the vault. Throws when there is nothing worth sealing. */
  async function captureAndSeal(id: string, d: StoreLogin, ctx: BrowserContext, seen: string | null): Promise<CredentialKind> {
    let bearer = seen;
    if (d.bearer && !bearer) {
      const match = d.bearer.match;
      let resolveSeen: (v: string) => void = () => {};
      const arrived = new Promise<string>((r) => {
        resolveSeen = r;
      });
      const onRequest = (req: Request): void => {
        const b = bearerFrom(req, match);
        if (b) resolveSeen(b);
      };
      ctx.on("request", onRequest);
      const page = await ctx.newPage();
      try {
        await page.goto(d.bearer.triggerUrl, NAV).catch(() => {});
        if (d.bearer.pagePattern) {
          const html = await page.content().catch(() => "");
          bearer = bearerFromHtml(html, d.bearer.pagePattern);
        }
        if (!bearer) bearer = await withTimeout(arrived, 10_000, null);
      } finally {
        ctx.off("request", onRequest);
        await page.close().catch(() => {});
      }
      if (!bearer) {
        throw new Error(`Signed in, but ${id} has not issued an API token yet. Open your basket in the window, then press Finish.`);
      }
    }
    const kind: CredentialKind = d.bearer ? "token" : "cookie";
    let secret: string;
    if (kind === "token") {
      secret = bearer as string;
    } else {
      const jar = await ctx.cookies(cookieUrlsFor(d));
      const seenNames = new Set<string>();
      const pairs: string[] = [];
      for (const c of jar) {
        if (!c.value || seenNames.has(c.name)) continue;
        seenNames.add(c.name);
        pairs.push(`${c.name}=${c.value}`);
      }
      if (pairs.length === 0) throw new Error(`Signed in, but ${id} set no cookies to keep.`);
      secret = pairs.join("; ");
    }
    const previous = vault.get(id)?.username ?? vault.get(loginKey(id))?.username ?? null;
    vault.connect({ storeId: id, kind, username: previous, secret });
    mark(id, "live", "sealed");
    log(`session: sealed ${id} (${kind})`);
    return kind;
  }

  /** Type the stored email and password into the store's own form. Never anywhere else. */
  async function fillForm(page: Page, pp: ProbePage, d: StoreLogin, id: string): Promise<void> {
    const form = d.loginForm;
    if (!form) throw new Error(`${id} has no form we know how to fill.`);
    const host = new URL(page.url()).hostname;
    const allowed = [...d.domains, ...(d.cookieUrls ?? []).map((u) => new URL(u).hostname)];
    if (!allowed.some((dom) => sameSite(host, dom))) {
      throw new Error(`Refused to type a password into ${host}: not a ${d.domains[0] ?? "store"} page.`);
    }
    const cred = vault.reveal(loginKey(id));
    if (!cred) throw new Error("No sign-in details are stored for this store.");
    await page.locator(form.emailSelector).first().fill(cred.username ?? "", { timeout: 10_000 });
    if (form.continueSelector) {
      await page.locator(form.continueSelector).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.locator(form.passwordSelector).first().fill(cred.secret, { timeout: 10_000 });
    await page.locator(form.submitSelector).first().click({ timeout: 5000 });
    await settle(pp, 6000, 8000);
  }

  function finish(a: Attempt, state: LoginState, error: string | null): void {
    if (a.done) return;
    a.done = true;
    a.state = state;
    a.error = error;
    if (a.ttl) {
      clearTimeout(a.ttl);
      a.ttl = null;
    }
  }

  async function sealAttempt(id: string, d: StoreLogin, a: Attempt, ctx: BrowserContext): Promise<void> {
    a.state = "signed_in";
    a.state = "sealing";
    try {
      await captureAndSeal(id, d, ctx, a.bearer);
      finish(a, "connected", null);
    } catch (err) {
      finish(a, "failed", message(err));
    }
    setTimeout(() => void profiles.close(id), 1500).unref();
  }

  async function runLogin(id: string, d: StoreLogin, a: Attempt, ctx: BrowserContext): Promise<void> {
    if (d.bearer) {
      const match = d.bearer.match;
      ctx.on("request", (req) => {
        const b = bearerFrom(req, match);
        if (b) a.bearer = b;
      });
    }
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    a.state = "waiting";
    a.ttl = setTimeout(() => {
      finish(a, "cancelled", "The sign-in window was left open too long and has been closed.");
      void profiles.close(id);
    }, headedTtlMs);
    a.ttl.unref();

    const first = await isSignedIn(wrapPage(page, ctx), d, { navigate: true });
    if (a.done) return;
    if (first.signedIn || a.bearer) {
      await sealAttempt(id, d, a, ctx);
      return;
    }
    if (first.human) {
      a.state = "needs_human";
      a.human = first.human;
    } else {
      await page.goto(d.loginUrl, NAV).catch(() => {});
      if (d.loginForm && vault.get(loginKey(id))) {
        a.state = "autofilling";
        try {
          await fillForm(page, wrapPage(page, ctx), d, id);
        } catch (err) {
          log(`session: autofill ${id} did not complete: ${message(err)}`);
        }
        if (a.done) return;
        a.state = "waiting";
      }
    }

    while (!a.done) {
      await sleep(pollMs);
      if (a.done) break;
      const open = ctx.pages().filter((p) => !p.isClosed());
      const current = open[open.length - 1];
      if (!current) {
        finish(a, "cancelled", "The sign-in window was closed.");
        break;
      }
      const r = await isSignedIn(wrapPage(current, ctx), d, { navigate: false });
      if (a.done) break;
      if (r.signedIn || a.bearer) {
        await sealAttempt(id, d, a, ctx);
        break;
      }
      if (r.human) {
        a.state = "needs_human";
        a.human = r.human;
      } else if (a.state === "needs_human") {
        a.state = "waiting";
        a.human = null;
      }
    }
  }

  const manager: SessionManager = {
    loginFor,
    hasProfile: (id) => profiles.hasProfile(id),
    hasJar: (id) => vault.get(jarKey(id)) !== null,
    hasCredentials: (id) => vault.get(loginKey(id)) !== null,

    async openLogin(id) {
      const d = loginFor(id);
      if (!d) return { ok: false, error: "This store has no sign-in flow." };
      const running = active(id);
      if (running) return { ok: true, state: running.state };
      const a: Attempt = {
        state: "opening",
        human: null,
        startedAt: Date.now(),
        error: null,
        bearer: null,
        context: null,
        ttl: null,
        done: false,
      };
      attempts.set(id, a);
      let ctx: BrowserContext;
      try {
        const h = await profiles.open(id, {
          headed: true,
          onClosed: () => {
            if (!a.done) finish(a, "cancelled", "The sign-in window was closed.");
          },
        });
        ctx = h.context;
      } catch (err) {
        finish(a, "failed", `Could not open a browser window: ${message(err)}`);
        return { ok: false, error: a.error ?? "Could not open a browser window." };
      }
      a.context = ctx;
      void runLogin(id, d, a, ctx).catch((err) => {
        finish(a, "failed", message(err));
        void profiles.close(id);
      });
      return { ok: true, state: a.state };
    },

    pollStatus(id) {
      const a = attempts.get(id);
      if (!a) return { state: "idle", human: null, waited_ms: 0, error: null };
      return { state: a.state, human: a.human, waited_ms: Date.now() - a.startedAt, error: a.error };
    },

    async finishLogin(id) {
      const d = loginFor(id);
      const a = active(id);
      if (!d || !a || !a.context) return { ok: false, error: "No sign-in window is open for this store." };
      a.state = "sealing";
      try {
        const kind = await captureAndSeal(id, d, a.context, a.bearer);
        finish(a, "connected", null);
        setTimeout(() => void profiles.close(id), 1500).unref();
        return { ok: true, kind };
      } catch (err) {
        a.state = "waiting";
        return { ok: false, error: message(err) };
      }
    },

    async cancelLogin(id) {
      const a = active(id);
      if (a) finish(a, "cancelled", "Cancelled from the panel.");
      await profiles.close(id);
      return a !== null;
    },

    health(id) {
      const h = readState(profileDir(id));
      if (active(id)) return { ...h, session_state: "checking" };
      return h;
    },

    async checkSession(id) {
      const d = loginFor(id);
      if (!d) return { session_state: "unknown", last_verified_at: null, reason: "no_login_flow", profile: false };
      if (manager.hasJar(id)) return seedFromJar(id, d);
      if (!profiles.hasProfile(id)) return { session_state: "unknown", last_verified_at: null, reason: "no_profile", profile: false };
      if (active(id)) return { ...readState(profileDir(id)), session_state: "checking" };
      try {
        const probe = await profiles.with(id, { headed: false }, async (h) => {
          const page = await h.context.newPage();
          try {
            const r = await isSignedIn(wrapPage(page, h.context), d, { navigate: true });
            if (r.signedIn) {
              try {
                await captureAndSeal(id, d, h.context, null);
              } catch (err) {
                // Signed in but no token to seal yet (Tesco before a basket
                // visit). The session is fine; the snapshot just did not move.
                log(`session: ${id} live but not re-sealed: ${message(err)}`);
              }
            }
            return r;
          } finally {
            await page.close().catch(() => {});
          }
        });
        if (probe.signedIn) return mark(id, "live", probe.reason);
        if (probe.human) return mark(id, "needs_human", probe.reason);
        if (probe.reason.startsWith("error:")) {
          // Could not reach the store: not evidence either way.
          const prev = readState(profileDir(id));
          return writeState(profileDir(id), { ...prev, reason: probe.reason });
        }
        return mark(id, "expired", probe.reason);
      } catch (err) {
        log(`session: check ${id} failed: ${message(err)}`);
        const prev = readState(profileDir(id));
        return { ...prev, reason: `error:${message(err)}` };
      }
    },

    async reloginWithCredentials(id, { interactive }) {
      const d = loginFor(id);
      const current = readState(profileDir(id));
      if (!d?.loginForm) return { ...current, reason: "no_login_form" };
      if (!vault.get(loginKey(id))) return { ...current, reason: "no_credentials" };
      if (active(id)) return { ...current, session_state: "checking" };
      let outcome: { human: HumanKind } | { live: boolean; reason: string };
      try {
        outcome = await profiles.with(id, { headed: false }, async (h) => {
          const page = await h.context.newPage();
          const pp = wrapPage(page, h.context);
          try {
            await page.goto(d.loginUrl, NAV).catch(() => {});
            await settle(pp, 6000, 8000);
            let human = await detectHumanNeeded(pp);
            if (!human) {
              await fillForm(page, pp, d, id);
              human = await detectHumanNeeded(pp);
            }
            if (human) return { human: human.kind };
            const r = await isSignedIn(pp, d, { navigate: true });
            if (r.human) return { human: r.human };
            if (r.signedIn) {
              await captureAndSeal(id, d, h.context, null);
              return { live: true, reason: r.reason };
            }
            return { live: false, reason: r.reason };
          } finally {
            await page.close().catch(() => {});
          }
        });
      } catch (err) {
        log(`session: relogin ${id} failed: ${message(err)}`);
        return mark(id, "expired", `error:${message(err)}`);
      }
      if ("human" in outcome) {
        if (interactive) {
          const opened = await manager.openLogin(id);
          if (opened.ok) return { ...readState(profileDir(id)), session_state: "checking", reason: `needs_human:${outcome.human}` };
        }
        return mark(id, "needs_human", `needs_human:${outcome.human}`);
      }
      if (outcome.live) return readState(profileDir(id));
      return mark(id, "expired", outcome.reason);
    },

    async refresh(id) {
      const toResult = (h: SessionHealth, reason?: string): RefreshResult => {
        const state = h.session_state === "live" ? "live" : h.session_state === "needs_human" ? "needs_human" : "expired";
        const r = reason ?? h.reason ?? undefined;
        return r === undefined ? { ok: state === "live", state } : { ok: state === "live", state, reason: r };
      };
      const last = refreshedAt.get(id);
      if (last !== undefined && Date.now() - last < cooldownMs) return toResult(manager.health(id), "cooldown");
      refreshedAt.set(id, Date.now());
      let h = await manager.checkSession(id);
      if (h.session_state === "live") return toResult(h);
      if (h.session_state === "expired" && manager.hasCredentials(id)) {
        h = await manager.reloginWithCredentials(id, { interactive: false });
      }
      return toResult(h);
    },

    async forgetProfile(id) {
      const a = active(id);
      if (a) finish(a, "cancelled", "Profile forgotten.");
      attempts.delete(id);
      return profiles.destroy(id);
    },

    async closeAll() {
      for (const [, a] of attempts) if (!a.done) finish(a, "cancelled", "Basketed is shutting down.");
      await profiles.closeAll();
    },
  };

  return manager;
}
