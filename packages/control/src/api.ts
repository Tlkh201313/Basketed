import {
  approveApproval,
  rejectApproval,
  listOrders,
  listPendingApprovals,
  markOrderOutcome,
  loadGuardrails,
  saveGuardrails,
  GuardrailValueError,
  spentInWindow,
  type CartMandate,
  describeShoppingModes,
  listBaskets,
  saveShoppingMode,
  ShoppingModeError,
} from "@basketed/commerce";
import { isAuxKey, isLoginKey, jarKey, loginKey, type CredentialKind } from "@basketed/vault";
import { authPolicyFor } from "./connections.js";
import { openConnect, pendingFor, listPending, closeConnect, finish, statusFor } from "./handoff.js";
import type { ControlDeps } from "./types.js";

/**
 * The panel's REST surface — approval channel A (§6).
 *
 * This is a SEPARATE channel from the MCP one, and that separation is most of
 * the security property -- but the route split is not what enforces it. Every
 * client Basketed installs into has a shell, so reaching these paths was never
 * beyond an agent. What is beyond it is the panel token these routes sit
 * behind, which is minted per process and printed on the server's own console.
 * See the gate in `./index.ts`.
 *
 * Same `approveApproval()` underneath, so the guarantees are identical wherever
 * the human clicked.
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

/** A list of strings, or null if the caller sent something else. */
function asList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((v) => typeof v !== "string")) return null;
  return raw as string[];
}

function mandateOf(row: Record<string, unknown>): CartMandate | null {
  try {
    return JSON.parse(String(row["cart_json"])) as CartMandate;
  } catch {
    return null;
  }
}

/** Everything the approval card renders, built ONLY from the mandate. */
function approvalView(row: Record<string, unknown>, now: number) {
  const mandate = mandateOf(row);
  return {
    id: String(row["id"]),
    store_id: String(row["store_id"]),
    mode: mandate?.mode ?? "unknown",
    total: { value: Number(row["total_value"]), currency: String(row["total_currency"]) },
    // Numeric and enumerated fields plus the normalized product name. No
    // description, no review, no merchant message reaches this screen -- which
    // is what stops injected vendor text from steering an approval.
    line_items: (mandate?.lineItems ?? []).map((li) => ({
      name: li.name,
      quantity: li.quantity,
      unit_price: li.unitPrice,
    })),
    adjustments: (mandate?.adjustments ?? []).map((a) => ({ label: a.label, amount: a.amount })),
    subtotal: mandate?.subtotal ?? null,
    route_rung: mandate?.routeRung ?? null,
    account_handle: String(row["account_handle"]),
    expires_in_ms: Math.max(0, Number(row["expires_at"]) - now),
  };
}

export async function handleApi(
  deps: ControlDeps,
  method: string,
  path: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<ApiResult | null> {
  const purchase = deps.purchase;
  const now = Date.now();
  const log = (msg: string): void => purchase.ctx.log(`panel: ${msg}`);

  if (method === "GET" && path === "/api/state") {
    const g = loadGuardrails(purchase.db);
    return {
      status: 200,
      body: {
        server: { name: "basketed", version: deps.version },
        stores: deps.registry.list().map((s) => ({
          id: s.id,
          name: s.name,
          country: s.country,
          currency: s.currency,
          mode: s.mode,
          status: s.status,
          capabilities: s.capabilities,
        })),
        summary: deps.summary,
        // Named plainly. A user reading the panel should never have to guess
        // whether the flag they set touches the purchase path.
        fast_mode: deps.policy.fastMode,
        fast_mode_scope: "read-only tools only — it is not reachable from the purchase path",
        tokens: deps.ledger.report(),
        guardrails: {
          ...g,
          spent_24h: Number(spentInWindow(purchase.db, 24 * 60 * 60 * 1000, now).toFixed(2)),
        },
        // The mode in force and every option, locked ones included, so the
        // panel can grey out what this build does not unlock (S24).
        shopping_mode: describeShoppingModes(purchase.db),
        redaction_alarms: deps.redactionAlarms(),
      },
    };
  }

  if (method === "GET" && path === "/api/baskets") {
    return { status: 200, body: { baskets: listBaskets(purchase.db, 50) } };
  }

  if (method === "POST" && path === "/api/settings/mode") {
    const payload = await body();
    const wanted = String(payload["mode"] ?? "");
    try {
      const mode = saveShoppingMode(purchase.db, wanted);
      log(`shopping mode set to ${mode}`);
    } catch (err) {
      // A locked mode is refused as a lock, not as an error the panel should
      // retry: the response says so and the mode in force is unchanged.
      if (err instanceof ShoppingModeError) {
        return { status: err.locked ? 423 : 400, body: { error: err.message, locked: err.locked, ...describeShoppingModes(purchase.db) } };
      }
      throw err;
    }
    return { status: 200, body: describeShoppingModes(purchase.db) };
  }

  if (method === "GET" && path === "/api/approvals") {
    const rows = listPendingApprovals(purchase.db, deps.principal, now);
    return { status: 200, body: { approvals: rows.map((r) => approvalView(r, now)), count: rows.length } };
  }

  const approve = /^\/api\/approvals\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approve) {
    const payload = await body();
    const result = approveApproval(purchase, decodeURIComponent(approve[1]!), deps.principal, {
      channel: "panel",
      typedTotal: String(payload["typed_total"] ?? ""),
    });
    return { status: result.ok ? 200 : 409, body: result };
  }

  const reject = /^\/api\/approvals\/([^/]+)\/reject$/.exec(path);
  if (method === "POST" && reject) {
    const result = rejectApproval(purchase, decodeURIComponent(reject[1]!), deps.principal);
    return { status: result.ok ? 200 : 409, body: result };
  }

  /*
   * Connections (S14).
   *
   * Everything served here is metadata: store, method, username, timestamps.
   * There is deliberately no route that returns a secret, not even to the
   * panel -- once a credential is in the vault the only thing that ever sees
   * it again is the request interceptor, inside the process.
   */
  if (method === "GET" && path === "/api/connections") {
    // The optional email+password rows (S23) are not connections: they are
    // what a profile uses to make one. Filtered out here, reported as a flag.
    const all = deps.vault.list();
    const held = new Map(all.filter((c) => !isAuxKey(c.storeId)).map((c) => [c.storeId, c]));
    const withCredentials = new Set(all.filter((c) => isLoginKey(c.storeId)).map((c) => c.storeId));
    return {
      status: 200,
      body: {
        connections: deps.registry.list().map((s) => {
          const policy = authPolicyFor(s);
          const held_ = held.get(s.id) ?? null;
          const session = deps.sessions.health(s.id);
          const login = deps.sessions.pollStatus(s.id);
          return {
            store_id: s.id,
            name: s.name,
            mode: s.mode,
            country: s.country,
            currency: s.currency,
            methods: policy.methods,
            oauth: policy.oauth,
            reach: policy.reach,
            connected: held_ !== null && !held_.broken,
            broken: held_?.broken ?? false,
            method: held_?.kind ?? null,
            username: held_?.username ?? null,
            connected_at: held_?.createdAt ?? null,
            last_used_at: held_?.lastUsedAt ?? null,
            login: policy.login !== null,
            login_state: login.state,
            login_human: login.human,
            session_state: held_ ? session.session_state : "unknown",
            last_verified_at: session.last_verified_at,
            has_login_credentials: withCredentials.has(loginKey(s.id)),
          };
        }),
      },
    };
  }

  /*
   * Sign in, in a window Basketed keeps for the store (S23).
   *
   * POST opens the window (or reports the one already open), GET is what the
   * panel polls, DELETE closes it. `finish` seals whatever the profile holds
   * right now, for the case where the page-reading probe cannot tell that a
   * human is in fact signed in. Every reply is a state word and a clock --
   * no cookie names, no values, nothing that turns a poll into a read.
   */
  const login = /^\/api\/connections\/([^/]+)\/login$/.exec(path);
  if (login && (method === "POST" || method === "GET" || method === "DELETE")) {
    const storeId = decodeURIComponent(login[1]!);
    if (method === "GET") return { status: 200, body: deps.sessions.pollStatus(storeId) };
    if (method === "DELETE") {
      const closed = await deps.sessions.cancelLogin(storeId);
      return { status: 200, body: { ok: true, closed } };
    }
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.login) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
    }
    const opened = await deps.sessions.openLogin(storeId);
    if (!opened.ok) {
      log(`connect ${storeId} could not open a window: ${opened.error}`);
      return { status: 503, body: { error: opened.error } };
    }
    log(`connect ${storeId}: sign-in window ${opened.state}`);
    return { status: 200, body: { ok: true, state: opened.state } };
  }

  const loginFinish = /^\/api\/connections\/([^/]+)\/login\/finish$/.exec(path);
  if (method === "POST" && loginFinish) {
    const storeId = decodeURIComponent(loginFinish[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    if (!authPolicyFor(store).login) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
    }
    const sealed = await deps.sessions.finishLogin(storeId);
    if (!sealed.ok) return { status: 409, body: { error: sealed.error } };
    log(`connect ${storeId}: sealed as ${sealed.kind}`);
    return { status: 200, body: { ok: true, store_id: storeId, method: sealed.kind } };
  }

  /*
   * The optional email and password (S23). Stored under a second vault key
   * beside the session, typed by Basketed into the retailer's own form and
   * nowhere else -- see connections.ts. The reply is metadata: the email
   * comes back, the password never does.
   */
  const credentials = /^\/api\/connections\/([^/]+)\/credentials$/.exec(path);
  if (credentials && (method === "POST" || method === "DELETE")) {
    const storeId = decodeURIComponent(credentials[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.login) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
    }
    if (method === "DELETE") {
      const forgotten = deps.vault.forget(loginKey(storeId));
      return { status: forgotten ? 200 : 404, body: { ok: forgotten, store_id: storeId } };
    }
    if (!policy.login.loginForm) {
      return { status: 400, body: { error: `${store.name}'s sign-in form is not one Basketed can fill in yet.` } };
    }
    const payload = await body();
    const email = String(payload["email"] ?? "").trim();
    const password = String(payload["password"] ?? "");
    if (!email || !password) return { status: 400, body: { error: "Both the email and the password are needed." } };
    try {
      const saved = deps.vault.connect({ storeId: loginKey(storeId), kind: "password", username: email, secret: password });
      log(`connect ${storeId}: sign-in details stored`);
      return { status: 200, body: { ok: true, store_id: storeId, email: saved.username, stored_at: saved.createdAt } };
    } catch (err) {
      const reason = (err as Error).message;
      log(`connect ${storeId} credentials could not be saved: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  /*
   * Is the profile still signed in? GET is the cached answer; POST runs the
   * headless check now, and -- because a human is at the panel to press it --
   * may fall through to a stored-password re-login that escalates to a window
   * if the store asks for a code.
   */
  const health = /^\/api\/connections\/([^/]+)\/health$/.exec(path);
  if (health && (method === "GET" || method === "POST")) {
    const storeId = decodeURIComponent(health[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    if (method === "GET") return { status: 200, body: deps.sessions.health(storeId) };
    if (!authPolicyFor(store).login) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to check.` } };
    }
    let result = await deps.sessions.checkSession(storeId);
    if (result.session_state === "expired" && deps.sessions.hasCredentials(storeId)) {
      result = await deps.sessions.reloginWithCredentials(storeId, { interactive: true });
    }
    log(`health ${storeId}: ${result.session_state}${result.reason ? ` (${result.reason})` : ""}`);
    return { status: 200, body: result };
  }

  const profile = /^\/api\/connections\/([^/]+)\/profile$/.exec(path);
  if (method === "DELETE" && profile) {
    const storeId = decodeURIComponent(profile[1]!);
    const removed = await deps.sessions.forgetProfile(storeId);
    log(`connect ${storeId}: profile ${removed ? "removed" : "was not there"}`);
    return { status: 200, body: { ok: true, removed } };
  }

  /*
   * Connect in the browser the user is already using (S20).
   *
   * The tab is NOT opened here. The panel is already a page in that browser,
   * so it opens the retailer with a plain target="_blank" link -- their
   * window, their profile, their logins, no automation involved. All this
   * route does is leave a note saying a sign-in is in flight, which the
   * Basketed extension (running in that same browser) reads so it can post
   * the finished session back. See handoff.ts for why it has to work this
   * way round.
   */
  const browserConnect = /^\/api\/connections\/([^/]+)\/browser-connect$/.exec(path);
  if (browserConnect) {
    const storeId = decodeURIComponent(browserConnect[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };

    if (method === "GET") return { status: 200, body: statusFor(storeId) };
    if (method === "DELETE") return { status: 200, body: { ok: true, closed: closeConnect(storeId) } };

    if (method === "POST") {
      const policy = authPolicyFor(store);
      if (!policy.login) {
        return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
      }
      const note = openConnect({
        storeId,
        storeName: store.name,
        url: policy.login.bearer?.triggerUrl ?? policy.login.accountUrl,
        domains: policy.login.domains,
        authCookies: policy.login.probe.authCookies,
        bearerMatch: policy.login.bearer?.match ?? null,
        bearerPagePattern: policy.login.bearer?.pagePattern?.source ?? null,
      });
      log(`connect ${storeId}: waiting on a sign-in at ${note.url}`);
      return { status: 200, body: { ok: true, url: note.url, waiting: true } };
    }
  }

  /*
   * How the extension proves the page that just messaged it is really the
   * panel (S20).
   *
   * The extension's content script runs on every 127.0.0.1 page, and
   * localhost is shared ground -- any local page could otherwise ask it to
   * hand over tesco.com's cookies. So the ask must carry the panel token,
   * and the extension checks it HERE before it reads a single cookie. Same
   * gate as everything else in this file; answering at all is the answer.
   */
  if (method === "GET" && path === "/api/extension/verify") {
    /*
     * The reply also carries what the extension is allowed to read, because
     * the alternative is letting the PAGE say. A page that has the token is
     * the panel, but "which domains may I open the cookie jar for" is a
     * decision that belongs to the server's own policy table either way --
     * and routing it through the pending note means the extension will only
     * ever read cookies for a store the user just pressed Connect on.
     *
     * None of this is secret: it is `connections.ts` policy, already rendered
     * into the Connect page as data- attributes.
     */
    return {
      status: 200,
      body: {
        ok: true,
        panel: "basketed",
        pending: listPending().map((p) => ({
          store_id: p.storeId,
          domains: p.domains,
          auth_cookies: p.authCookies,
          bearer_match: p.bearerMatch,
          bearer_page_pattern: p.bearerPagePattern,
        })),
      },
    };
  }

  /*
   * The extension posting back a session it read from the user's own browser.
   *
   * Gated three ways: the panel token like every other route, a policy that
   * actually has somewhere to sign in, and an OPEN note for this store. The
   * last one matters -- without it, anything holding the token could seal an
   * arbitrary string against any store at any time, with no user action
   * anywhere near it.
   */
  const extCapture = /^\/api\/connections\/([^/]+)\/extension-capture$/.exec(path);
  if (method === "POST" && extCapture) {
    const storeId = decodeURIComponent(extCapture[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.login) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
    }
    const note = pendingFor(storeId);
    if (!note) {
      return { status: 409, body: { error: "No sign-in is in flight for this store. Press Connect first." } };
    }

    const payload = await body();
    const cookieHeader = String(payload["cookie_header"] ?? "").trim();
    const bearer = String(payload["bearer"] ?? "").trim();
    const wantsBearer = policy.login.bearer !== undefined;
    if (wantsBearer && !bearer && cookieHeader) {
      // The extension read the jar but saw no token (the basket tab was not
      // open, or the store keeps it off the wire). The jar is enough: seed
      // it into this store's headless profile, which then probes and seals
      // -- and keeps the session renewed from there on (session/jar.ts).
      deps.vault.connect({ storeId: jarKey(storeId), kind: "cookie", username: null, secret: cookieHeader });
      const h = await deps.sessions.checkSession(storeId);
      if (h.session_state === "live") {
        finish(storeId, "extension");
        closeConnect(storeId);
        log(`connect ${storeId}: sealed as token, seeded from the user's own browser`);
        return {
          status: 200,
          body: { ok: true, store_id: storeId, method: "token", connected_at: deps.vault.get(storeId)?.createdAt ?? null },
        };
      }
      log(`connect ${storeId}: the captured jar did not seed a session (${h.session_state}${h.reason ? `: ${h.reason}` : ""})`);
      if (h.session_state === "needs_human") {
        return { status: 409, body: { error: `${store.name} asked for a human check before it would issue a token. Try again in a moment.` } };
      }
    }
    if (wantsBearer && !bearer) {
      return {
        status: 409,
        body: {
          error:
            `Signed in, but ${store.name} has not issued a session token yet. ` +
            `Open your basket in that tab and it will finish by itself.`,
        },
      };
    }
    if (!wantsBearer && !cookieHeader) {
      return { status: 409, body: { error: `Not signed in at ${store.name} yet.` } };
    }

    const kind: CredentialKind = wantsBearer ? "token" : "cookie";
    try {
      const saved = deps.vault.connect({ storeId, kind, username: null, secret: wantsBearer ? bearer : cookieHeader });
      // The jar beside the seal is what lets the session outlive its access
      // token's hour without a browser of ours: the session manager seeds it
      // into a headless profile, which renews itself from then on (see
      // @basketed/session jar.ts). Kicked off now, off the response path.
      if (cookieHeader) {
        deps.vault.connect({ storeId: jarKey(storeId), kind: "cookie", username: null, secret: cookieHeader });
        void deps.sessions.checkSession(storeId).catch((err: unknown) => {
          log(`connect ${storeId}: seeding the captured jar failed: ${(err as Error).message}`);
        });
      }
      finish(storeId, "extension");
      closeConnect(storeId);
      log(`connect ${storeId}: sealed as ${kind}, captured from the user's own browser`);
      return {
        status: 200,
        body: { ok: true, store_id: saved.storeId, method: saved.kind, connected_at: saved.createdAt },
      };
    } catch (err) {
      const reason = (err as Error).message;
      log(`connect ${storeId} could not be saved: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  const connect = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (connect && (method === "POST" || method === "DELETE")) {
    const storeId = decodeURIComponent(connect[1]!);
    if (isLoginKey(storeId)) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };

    if (method === "DELETE") {
      const forgotten = deps.vault.forget(storeId);
      deps.vault.forget(jarKey(storeId));
      return { status: forgotten ? 200 : 404, body: { ok: forgotten, store_id: storeId } };
    }

    const policy = authPolicyFor(store);
    if (policy.methods.length === 0) {
      return { status: 400, body: { error: `${store.name} needs no account: its endpoint is anonymous.` } };
    }

    const payload = await body();
    const kind = String(payload["method"] ?? "") as CredentialKind;
    if (!policy.methods.includes(kind)) {
      return { status: 400, body: { error: `${store.name} accepts: ${policy.methods.join(", ")}.` } };
    }

    const secret = String(payload["secret"] ?? "");
    const username = payload["username"] === undefined ? null : String(payload["username"]);
    if (!secret.trim()) return { status: 400, body: { error: "Nothing was entered." } };
    if (kind === "password" && !username?.trim()) {
      return { status: 400, body: { error: "A password connection needs the account it belongs to." } };
    }

    try {
      const saved = deps.vault.connect({ storeId, kind, username, secret });
      log(`connected ${storeId} via ${kind}`);
      // Metadata back, never an echo of what was just sent.
      return {
        status: 200,
        body: {
          ok: true,
          store_id: saved.storeId,
          method: saved.kind,
          username: saved.username,
          connected_at: saved.createdAt,
        },
      };
    } catch (err) {
      // Covers both a bad master key (degradedVault always throws here) and
      // any crypto failure -- either way the human gets a reason, not a blank
      // 500, and it lands on stderr for whoever is debugging this machine.
      const reason = (err as Error).message;
      log(`connect ${storeId} failed: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  if (method === "GET" && path === "/api/orders") {
    return { status: 200, body: { orders: listOrders(purchase.db, 50) } };
  }

  const outcome = /^\/api\/orders\/([^/]+)\/outcome$/.exec(path);
  if (method === "POST" && outcome) {
    const payload = await body();
    const want = String(payload["state"] ?? "");
    if (want !== "CONFIRMED" && want !== "CANCELLED") {
      return { status: 400, body: { error: "state must be CONFIRMED or CANCELLED." } };
    }
    // Only a human can move an order off HANDED_OFF. There is no MCP tool for
    // this, because the agent has no way to know what happened in the browser.
    const moved = markOrderOutcome(purchase.db, decodeURIComponent(outcome[1]!), want, now);
    return { status: moved ? 200 : 409, body: { ok: moved, state: moved ? want : undefined } };
  }

  if (method === "POST" && path === "/api/guardrails") {
    const payload = await body();
    const next: Record<string, unknown> = {};
    if (payload["home_currency"] !== undefined) next["homeCurrency"] = String(payload["home_currency"]);
    if (payload["per_order_cap"] !== undefined) next["perOrderCap"] = Number(payload["per_order_cap"]);
    if (payload["daily_cap"] !== undefined) next["dailyCap"] = Number(payload["daily_cap"]);

    /*
     * The two allowlists had no write route at all, so they could only ever
     * hold their default. An empty store allowlist means "any registered
     * store", which made the guardrail unreachable rather than merely unset --
     * while `evaluateGuardrails` checked it on every single confirm.
     *
     * Store ids are checked against the registry here rather than inside
     * `saveGuardrails`, which has no registry to check against. An allowlist
     * naming a store that does not exist is a typo that silently refuses
     * everything, and that is the failure this route must not ship.
     */
    if (payload["allowed_stores"] !== undefined) {
      const wanted = asList(payload["allowed_stores"]);
      if (!wanted) return { status: 400, body: { error: "allowed_stores must be a list of store ids." } };
      const known = new Set(deps.registry.list().map((s) => s.id));
      const unknown = wanted.filter((id) => !known.has(id));
      if (unknown.length) {
        return { status: 400, body: { error: `No such store: ${unknown.join(", ")}. Use the ids from /api/state.` } };
      }
      next["allowedStores"] = wanted;
    }

    // Nothing can put an address on a cart today -- there is no MCP tool for it
    // and the panel does not offer one -- so this list guards a field that is
    // always null. It is settable because the guardrail reading it is live, and
    // a dormant check with no way to arm it is worse than either alternative.
    if (payload["allowed_addresses"] !== undefined) {
      const wanted = asList(payload["allowed_addresses"]);
      if (!wanted) return { status: 400, body: { error: "allowed_addresses must be a list of address ids." } };
      next["allowedAddresses"] = wanted;
    }

    try {
      saveGuardrails(purchase.db, next);
    } catch (err) {
      // A refused write says why, in words the panel can show. `Number("abc")`
      // is NaN, and a NaN written here would read back as the DEFAULT cap --
      // the user would be running 250 while the panel showed what they typed.
      if (err instanceof GuardrailValueError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    return { status: 200, body: loadGuardrails(purchase.db) };
  }

  return null;
}
