import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page, type HTTPRequest } from "puppeteer-core";
import { closeConnect, TTL_MS as HANDOFF_TTL_MS } from "./handoff.js";

/**
 * Sign in through the retailer's own site, in a real browser tab (S15, S18, S19).
 *
 * The mechanism this does NOT use is worth being explicit about, because the
 * obvious version of this feature (see e.g. madebydia/amazon-mcp-server on
 * GitHub) launches a bundled Chromium with `--disable-blink-features=
 * AutomationControlled` and a spoofed `navigator.webdriver`, specifically to
 * hide the automation from the retailer's own fraud detection. This file
 * does neither of those things:
 *
 *   - It uses the browser already on the machine -- the user's OWN running
 *     Chrome when it can reach one, otherwise their installed Chrome against
 *     a Basketed-owned profile. Never a downloaded Chromium.
 *   - It never touches the automation-detection surface. If a retailer's bot
 *     detection notices, that is left true. Hiding it would be the difference
 *     between "an agent drove a real browser" and "an agent impersonated a
 *     human to a fraud system", and only the first is a line Basketed builds
 *     on.
 *   - It never types a credential. The human signs in on the retailer's own
 *     page; this module reads back the session afterwards and nothing else.
 *     That is why S19 deleted the password form entirely -- see connections.ts.
 *
 * This is still real automation of a real retailer's login flow, and every
 * one of these retailers' Terms of Service prohibits automated access --
 * including, for most of them, when the account owner is the one doing it.
 * That risk is disclosed on the Connect page itself, not just in this comment.
 *
 * ## Which browser, and why (S19)
 *
 * Two paths, tried in this order:
 *
 *   1. **The user's own running Chrome**, over CDP. This is the one people
 *      actually want: the tab opens in the browser they already have, next to
 *      the tabs they already have, with the logins they already have -- so a
 *      shopper signed into Tesco this morning is connected in one click with
 *      no login at all. It requires Chrome to have been started with
 *      `--remote-debugging-port`, because Chrome will not begin speaking CDP
 *      on request; so this is auto-DETECTED, never auto-arranged. If nothing
 *      is listening, we do not nag and we do not fail.
 *   2. **Basketed's own persistent profile**, at `~/.basketed/chrome-profile`.
 *      Their installed Chrome, a durable profile of ours: log in once and the
 *      next window opens already signed in. It is deliberately NOT their real
 *      profile -- Chrome locks a profile to one process (so launching against
 *      it fails while their browser is open) and closing it at capture would
 *      shut every tab they had.
 *
 * `BASKETED_CHROME_CDP` pins path 1 to a specific endpoint and makes an
 * unreachable one a loud error instead of a silent fall-through, because
 * someone who set it explicitly expects their own browser.
 */

interface CaptureSession {
  browser: Browser;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  poll: ReturnType<typeof setInterval>;
  domains: string[];
  authCookies: string[];
  /** Flips true once the site has set a cookie (or issued a token) only a signed-in session has. */
  loggedIn: boolean;
  /**
   * True when we ATTACHED to a Chrome someone else started, rather than
   * launching our own. It changes exactly one thing, and it is the important
   * one: teardown detaches and closes our own tab instead of closing the
   * browser, because that browser is the user's entire session.
   */
  attached: boolean;
  /** The tab we opened. Closed on teardown; the browser is not, when attached. */
  page: Page | null;
  /** What to lift, and from where. Null when the cookie jar is the credential. */
  capture: { match: string; headers: string[] } | null;
  /** Header name (lower-cased) -> value, as last seen. Never logged, never served. */
  captured: Record<string, string>;
  /** Where a signed-out human is sent. Used once, when the landing page says they are out. */
  loginUrl: string | null;
  /** True once we have already redirected to `loginUrl`, so we only do it once. */
  sentToLogin: boolean;
}

const sessions = new Map<string, CaptureSession>();

/** How long an opened login tab is allowed to sit before it is auto-closed. */
const SESSION_TTL_MS = HANDOFF_TTL_MS;

/** How often we re-read cookies to notice that the human has finished signing in. */
const POLL_MS = 1_500;

/** The debug port a user following our own instructions would have used. */
const DEFAULT_CDP_PORT = 9222;

/**
 * The persistent Chrome profile. Same convention as `BASKETED_DB` and
 * `BASKETED_KEY`: an env override, otherwise a directory under `~/.basketed`.
 */
export function chromeProfileDir(): string {
  return process.env["BASKETED_CHROME_PROFILE"] ?? resolve(homedir(), ".basketed", "chrome-profile");
}

/** Normalise a bare port, a host:port, or a full URL into an endpoint. */
function normaliseEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`;
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Explicitly pinned endpoint, if the user set one. */
function pinnedEndpoint(): string | null {
  const raw = process.env["BASKETED_CHROME_CDP"];
  return raw ? normaliseEndpoint(raw) : null;
}

/**
 * Is a CDP-speaking browser actually listening there?
 *
 * `/json/version` is the one endpoint that answers before any target exists,
 * and a short timeout keeps a wrong guess from stalling the page load that
 * asks. A probe is cheap; guessing is not.
 */
async function probe(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The endpoint we will actually use, if any.
 *
 * Pinned wins and is returned unprobed, so a set-but-unreachable endpoint
 * fails loudly at launch rather than quietly downgrading to our own profile.
 * Otherwise we look for the default port and use it only if something real
 * answers there.
 */
async function discoverEndpoint(): Promise<{ endpoint: string; pinned: boolean } | null> {
  const pinned = pinnedEndpoint();
  if (pinned) return { endpoint: pinned, pinned: true };
  const guess = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
  return (await probe(guess)) ? { endpoint: guess, pinned: false } : null;
}

/**
 * Reach the user's running Chrome. A pinned-but-unreachable port is a real
 * error worth surfacing, not a silent fallback.
 */
async function attachToRunningChrome(browserURL: string, pinned: boolean): Promise<Browser> {
  try {
    return await puppeteer.connect({ browserURL, defaultViewport: null });
  } catch (err) {
    if (!pinned) throw err;
    throw new Error(
      `BASKETED_CHROME_CDP is set to ${browserURL}, but no Chrome is listening there. ` +
        `Start Chrome with --remote-debugging-port, or unset the variable to use Basketed's own profile. ` +
        `(${(err as Error).message})`,
    );
  }
}

function candidateChromePaths(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        resolve(home, "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
      ];
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        resolve(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ];
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];
  }
}

/**
 * Flags that make the window behave like a browser rather than a first-run
 * wizard. None of them touch automation detection -- see the header comment.
 */
function launchArgs(): string[] {
  return ["--no-first-run", "--no-default-browser-check", "--start-maximized"];
}

/**
 * Find and launch the machine's own Chrome, against our own durable profile.
 *
 * `channel: "chrome"` is Puppeteer's OS-standard-location lookup; the explicit
 * path list is the fallback for installs it does not know about. Both avoid
 * the one thing this package will not do: download a browser nobody asked for.
 */
async function launchRealChrome(): Promise<Browser> {
  const userDataDir = chromeProfileDir();
  try {
    mkdirSync(userDataDir, { recursive: true });
  } catch (err) {
    throw new Error(`Could not create the Chrome profile at ${userDataDir}: ${(err as Error).message}`);
  }

  const opts = { headless: false as const, defaultViewport: null, userDataDir, args: launchArgs() };
  const failures: string[] = [];
  try {
    return await puppeteer.launch({ channel: "chrome", ...opts });
  } catch (err) {
    failures.push((err as Error).message);
  }
  for (const executablePath of candidateChromePaths()) {
    if (!existsSync(executablePath)) continue;
    try {
      return await puppeteer.launch({ executablePath, ...opts });
    } catch (err) {
      failures.push((err as Error).message);
    }
  }

  // A profile lock is the one failure with a specific, actionable cause, and
  // it only happens when a stray Basketed-opened window is still alive. Say
  // so, rather than making the user guess from a Puppeteer stack trace.
  if (failures.some((m) => /profile|singleton|lock|already (in use|running)/i.test(m))) {
    throw new Error(
      `The Basketed Chrome profile at ${userDataDir} is already open in another window. ` +
        `Close that window and try again.`,
    );
  }
  if (!failures.length) {
    throw new Error("Google Chrome was not found on this machine. Install Chrome and try Connect again.");
  }
  throw new Error(`Chrome would not start: ${failures[failures.length - 1]}`);
}

/**
 * Which browser the next Connect will actually use, so the page can say so
 * before the click rather than after the surprise. Async because the honest
 * answer requires asking whether the user's own Chrome is reachable.
 */
export async function chromeMode(): Promise<{ attached: boolean; where: string }> {
  const found = await discoverEndpoint();
  if (!found) return { attached: false, where: chromeProfileDir() };
  // A pinned endpoint is reported as the user's own browser because that is
  // what they asked for; if it is not actually up, Connect says so loudly.
  return { attached: true, where: `your own Chrome (${found.endpoint})` };
}

export type CaptureState = "idle" | "waiting" | "logged_in";

export function stateOf(storeId: string): CaptureState {
  const s = sessions.get(storeId);
  if (!s) return "idle";
  return s.loggedIn ? "logged_in" : "waiting";
}

/** Everything the panel needs to render the connect card without guessing. */
export function statusOf(storeId: string): { state: CaptureState; logged_in: boolean; waited_ms: number } {
  const s = sessions.get(storeId);
  return {
    state: stateOf(storeId),
    logged_in: s?.loggedIn ?? false,
    waited_ms: s ? Date.now() - s.startedAt : 0,
  };
}

/** Close every open login tab. Called on shutdown so nothing outlives the server. */
export async function closeAll(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(
    all.map(async (s) => {
      clearTimeout(s.timeout);
      clearInterval(s.poll);
      // Same rule as endSession: never close a browser we did not launch.
      if (s.attached) {
        if (s.page && !s.page.isClosed()) await s.page.close();
        s.browser.disconnect();
        return;
      }
      await s.browser.close();
    }),
  );
}

/**
 * Tear one session down.
 *
 * The branch is the whole reason `attached` exists. A browser we launched is
 * ours to close. A browser we merely connected to is the user's entire
 * session -- every window, every tab, work that has nothing to do with
 * Basketed -- so we close only the one tab we opened and let go of the rest.
 * Calling `close()` on an attached browser would end their browsing day.
 */
async function endSession(storeId: string): Promise<void> {
  const s = sessions.get(storeId);
  if (!s) return;
  sessions.delete(storeId);
  clearTimeout(s.timeout);
  clearInterval(s.poll);
  closeConnect(storeId);
  try {
    if (s.attached) {
      if (s.page && !s.page.isClosed()) await s.page.close();
      s.browser.disconnect();
    } else {
      await s.browser.close();
    }
  } catch {
    // already gone
  }
}

/** The first page still open in the window. The human may have opened tabs. */
async function livePage(browser: Browser): Promise<Page | null> {
  try {
    const pages = await browser.pages();
    return pages.find((p) => !p.isClosed()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read every cookie the profile holds for the store's domains, including the
 * httpOnly ones a page script could never see. This is the only place in the
 * module that reads session state, and both the detector and the capture go
 * through it.
 */
async function readCookies(
  browser: Browser,
  domains: string[],
  preferred?: Page | null,
): Promise<Array<{ name: string; value: string }>> {
  // Cookies are per-profile, so any tab would answer -- but when we are
  // attached to someone's own Chrome, "any tab" means opening a debugger on
  // whatever they happen to be reading. Use the tab we opened.
  const page = preferred && !preferred.isClosed() ? preferred : await livePage(browser);
  if (!page) return [];
  const client = await page.target().createCDPSession();
  try {
    const { cookies } = await client.send("Network.getCookies", {
      urls: domains.flatMap((d) => [`https://${d}`, `https://www.${d}`]),
    });
    return cookies.map((c) => ({ name: c.name, value: c.value }));
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Has the human finished signing in?
 *
 * `authCookies` are name PREFIXES, matched case-insensitively against a
 * cookie carrying a non-empty value. They are best-effort signatures for
 * retailers that publish no integration contract and are free to rename a
 * cookie tomorrow, which is why a miss here is never a dead end: the capture
 * route does not consult this at all. The prefixes are kept specific, because
 * a false positive seals a jar the adapter will later reject.
 */
function looksLoggedIn(cookies: Array<{ name: string; value: string }>, authCookies: string[]): boolean {
  if (!authCookies.length) return false;
  return cookies.some(
    (c) => c.value.length > 0 && authCookies.some((p) => c.name.toLowerCase().startsWith(p.toLowerCase())),
  );
}

/**
 * Watch the tab for the request headers worth keeping (S19, widened S21).
 *
 * Some retailers' credentials are not in the cookie jar at all: Tesco's basket
 * API authenticates on the `authorization` + `customer-uuid` pair its own
 * frontend sends to `xapi.tesco.com`. Listening for them here is what replaced
 * "open DevTools, find a request, copy two headers, paste them into a form".
 *
 * Read-only: the listener never blocks, rewrites or replays a request, and
 * what it keeps lives in this process, is never logged, and leaves only
 * through the same token-gated capture route as everything else.
 */
function watchForHeaders(page: Page, storeId: string, want: { match: string; headers: string[] }): void {
  page.on("request", (req: HTTPRequest) => {
    try {
      if (!req.url().includes(want.match)) return;
      const sent = req.headers();
      const s = sessions.get(storeId);
      if (!s) return;
      for (const name of want.headers) {
        const value = sent[name.toLowerCase()];
        if (value) s.captured[name.toLowerCase()] = value;
      }
      // A COMPLETE set is proof of a signed-in session, and it usually arrives
      // before the cookie signature does. A partial one proves nothing: the
      // signed-out site calls the same API.
      if (want.headers.every((h) => s.captured[h.toLowerCase()])) s.loggedIn = true;
    } catch {
      // a request that vanished mid-flight tells us nothing; ignore it
    }
  });
}

export interface LoginTarget {
  url: string;
  loginUrl?: string;
  domains?: string[];
  authCookies?: string[];
  capture?: { match: string; headers: string[] };
}

/**
 * Open a tab on the store's real site. The human takes it from here.
 *
 * The tab lands on a page that reveals whether they are already signed in.
 * If they are, `logged_in` comes back true on this very call and the panel
 * captures immediately -- for someone whose own Chrome is already signed into
 * Tesco, connecting is one click and no login. If they are not, the tab is
 * moved to the retailer's login page so the next thing they see is the form
 * they need, and the poll below notices when they are done.
 */
export async function startLogin(
  storeId: string,
  target: LoginTarget,
): Promise<{ ok: true; logged_in: boolean; attached: boolean } | { ok: false; error: string }> {
  const open = sessions.get(storeId);
  // Already open: do not spawn a second tab, and re-front the one we have so
  // a second click still puts the user in front of the login.
  if (open) {
    if (open.page && !open.page.isClosed()) await open.page.bringToFront().catch(() => {});
    return { ok: true, logged_in: open.loggedIn, attached: open.attached };
  }

  const domains = target.domains ?? [];
  const authCookies = target.authCookies ?? [];

  const found = await discoverEndpoint();
  const attached = found !== null;

  let browser: Browser;
  try {
    browser = found ? await attachToRunningChrome(found.endpoint, found.pinned) : await launchRealChrome();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Attached: always a NEW tab, never a page the user already had open --
  // navigating one of their tabs out from under them would be theft of their
  // place. Launched: reuse the blank tab Chrome opens with.
  let page: Page;
  try {
    page = attached ? await browser.newPage() : ((await browser.pages())[0] ?? (await browser.newPage()));
  } catch (err) {
    if (attached) browser.disconnect();
    return { ok: false, error: `Could not open a tab: ${(err as Error).message}` };
  }

  const session: CaptureSession = {
    browser,
    startedAt: Date.now(),
    timeout: setTimeout(() => void endSession(storeId), SESSION_TTL_MS),
    /*
     * Watch for the login completing. The tick only ever sets a boolean the
     * panel can read -- it never captures, never writes the vault, and never
     * closes the tab. Sealing a credential still requires the token-gated
     * capture route, so "notice" and "store" stay separate decisions.
     */
    poll: setInterval(() => {
      void (async () => {
        const s = sessions.get(storeId);
        if (!s || s.loggedIn) return;
        try {
          s.loggedIn = looksLoggedIn(await readCookies(s.browser, s.domains, s.page), s.authCookies);
        } catch {
          // mid-navigation, or the tab went away; the next tick settles it
        }
      })();
    }, POLL_MS),
    domains,
    authCookies,
    loggedIn: false,
    attached,
    page,
    capture: target.capture ?? null,
    captured: {},
    loginUrl: target.loginUrl ?? null,
    sentToLogin: false,
  };
  // Registered before the first navigation so the bearer listener, which can
  // fire on the very first request, has a session to write to.
  sessions.set(storeId, session);
  browser.once("disconnected", () => void endSession(storeId));
  if (session.capture) watchForHeaders(page, storeId, session.capture);

  try {
    await page.bringToFront().catch(() => {});
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    await endSession(storeId);
    return { ok: false, error: `Could not reach ${target.url}: ${(err as Error).message}` };
  }

  // Whether they are already in decides what they see next, so check once,
  // up front, rather than a poll interval later.
  try {
    const complete =
      session.capture !== null && session.capture.headers.every((h) => session.captured[h.toLowerCase()]);
    session.loggedIn = looksLoggedIn(await readCookies(browser, domains, page), authCookies) || complete;
  } catch {
    // not fatal; the poll picks it up
  }

  if (!session.loggedIn && session.loginUrl && session.loginUrl !== target.url) {
    session.sentToLogin = true;
    // Best-effort: a retailer that redirects, rate-limits or interstitials
    // this leaves the shopper on the landing page, which is still their own
    // site and still has a sign-in link. Not worth failing the connect over.
    await page.goto(session.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }

  return { ok: true, logged_in: session.loggedIn, attached };
}

/**
 * Read back the session the real site issued, on the human's say-so.
 *
 * This is the one place this file hands session state out, and it is only
 * reachable through a route gated exactly like every other write to the vault
 * -- the panel token, checked before this function is ever called.
 *
 * A captured header set wins over the cookie jar when the store asked for one:
 * for a header-authenticated API the jar is the wrong credential, and sealing
 * it would look like success here and fail at the first basket call.
 */
export async function captureLogin(
  storeId: string,
  domains: string[],
): Promise<
  { ok: true; cookieHeader: string; headers: Record<string, string> } | { ok: false; error: string }
> {
  const s = sessions.get(storeId);
  if (!s) return { ok: false, error: "No sign-in tab is open for this store. Press Connect first." };

  try {
    const cookies = await readCookies(s.browser, s.domains.length ? s.domains : domains, s.page);
    const headers = { ...s.captured };
    if (!cookies.length && !Object.keys(headers).length) {
      return { ok: false, error: "Nothing was set for that site yet -- finish signing in, then try again." };
    }
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await endSession(storeId);
    return { ok: true, cookieHeader, headers };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function cancelLogin(storeId: string): Promise<boolean> {
  const had = sessions.has(storeId);
  await endSession(storeId);
  return had;
}
