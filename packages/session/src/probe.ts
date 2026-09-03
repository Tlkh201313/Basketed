import { cookieUrlsFor, type StoreLogin } from "./descriptors.js";
import { detectHumanNeeded, type HumanKind } from "./detect.js";
import { withTimeout, type ProbePage } from "./page.js";

/**
 * "Am I signed in?", answered from the page rather than guessed from a cookie
 * name (S23).
 *
 * The old detector raced: it read the jar the instant `domcontentloaded`
 * fired, before a single-page app had hydrated or re-issued its tokens, and
 * called the empty jar "signed out". This one navigates, waits for the
 * redirect chain to stop moving, and only then asks -- in order of how much
 * each answer can be trusted:
 *
 *   1. a challenge page (captcha, OTP, Cloudflare) beats everything, because
 *      it can ALSO match a login URL and would otherwise read as signed-out;
 *   2. the final URL: an account page that bounced to `/login` is the
 *      retailer's own verdict;
 *   3. what the page shows: a sign-out link, a greeting, a "Sign in" button;
 *   4. the cookie jar, prefix-matched, as the last resort.
 *
 * Never throws. A page that cannot be reached is `{signedIn: false}` with a
 * reason that says so, and the reason string only ever carries a signal name
 * -- a selector, a cookie NAME -- never a value.
 */

export interface ProbeResult {
  signedIn: boolean;
  reason: string;
  finalUrl: string;
  human: HumanKind | null;
}

export interface ProbeOptions {
  /** Navigate to the account page first. Off for a non-hijacking check of wherever the human is. */
  navigate?: boolean;
  timeoutMs?: number;
  /** Test seam: how long to let redirects settle. */
  settleMs?: number;
  stabilityMs?: number;
}

const GOTO_RETRIES = 3;

async function navigate(page: ProbePage, url: string, timeoutMs: number): Promise<string | null> {
  let last = "";
  for (let attempt = 0; attempt < GOTO_RETRIES; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return null;
    } catch (err) {
      last = (err as Error).message ?? String(err);
      if (!/net::ERR_|Timeout|timeout|ECONN|ENOTFOUND/i.test(last) || attempt === GOTO_RETRIES - 1) break;
      await page.waitForTimeout(1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
    }
  }
  return last.split("\n")[0]?.slice(0, 120) ?? "navigation failed";
}

/**
 * Wait for the page to stop moving: network-idle if it ever gets there, a
 * fixed settle if not (IKEA never goes idle -- see stealth/browser.ts), and
 * then the URL has to hold still for three samples in a row. That last part
 * is what catches an /ap/signin bounce that lands a second after the first
 * page painted.
 */
export async function settle(page: ProbePage, settleMs: number, stabilityMs: number): Promise<void> {
  await withTimeout(page.waitForLoadState("networkidle", { timeout: settleMs }), settleMs + 250, undefined);
  const deadline = Date.now() + stabilityMs;
  let previous = page.url();
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const now = page.url();
    if (now === previous) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
      previous = now;
    }
  }
}

function prefixed(cookies: Array<{ name: string; value: string }>, prefixes: string[]): string | null {
  for (const c of cookies) {
    if (!c.value) continue;
    const hit = prefixes.find((p) => c.name.toLowerCase().startsWith(p.toLowerCase()));
    if (hit) return c.name;
  }
  return null;
}

export async function isSignedIn(page: ProbePage, d: StoreLogin, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const settleMs = opts.settleMs ?? 6000;
  const stabilityMs = opts.stabilityMs ?? 8000;
  const out = (signedIn: boolean, reason: string, human: HumanKind | null = null): ProbeResult => {
    let finalUrl = "";
    try {
      finalUrl = page.url();
    } catch {
      /* closed */
    }
    return { signedIn, reason, finalUrl, human };
  };

  try {
    if (opts.navigate !== false) {
      const failed = await navigate(page, d.accountUrl, timeoutMs);
      if (failed) return out(false, `error:${failed}`);
      await settle(page, settleMs, stabilityMs);
    }
    if (page.isClosed()) return out(false, "error:page closed");

    const human = await detectHumanNeeded(page);
    if (human) return out(false, `needs_human:${human.kind}`, human.kind);

    const url = page.url();
    if (d.probe.loggedOutUrlPattern.test(url)) return out(false, "url:logged_out");

    const p = d.probe;
    if (p.loggedInSelector && (await withTimeout(page.count(p.loggedInSelector), 2000, 0)) > 0) {
      return out(true, "selector:logged_in");
    }
    if (p.loggedInText) {
      const text = await withTimeout(page.text(p.loggedInText.selector), 2000, null);
      if (text !== null && text.trim() && !p.loggedInText.not.test(text)) return out(true, "text:logged_in");
    }
    if (p.loggedOutSelector && (await withTimeout(page.count(p.loggedOutSelector), 2000, 0)) > 0) {
      return out(false, "selector:logged_out");
    }

    const cookies = await withTimeout(page.cookies(cookieUrlsFor(d)), 3000, []);
    const name = prefixed(cookies, p.authCookies);
    if (name) return out(true, `cookie:${name}`);

    return out(false, "no_signal");
  } catch (err) {
    const msg = ((err as Error).message ?? String(err)).split("\n")[0] ?? "";
    return out(false, `error:${msg.slice(0, 120)}`);
  }
}
