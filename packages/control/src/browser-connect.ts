import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * Log in through the real retailer site, in a real Chrome window (S15).
 *
 * The mechanism this does NOT use is worth being explicit about, because the
 * obvious version of this feature (see e.g. madebydia/amazon-mcp-server on
 * GitHub) launches a bundled Chromium with `--disable-blink-features=
 * AutomationControlled` and a spoofed `navigator.webdriver`, specifically to
 * hide the automation from the retailer's own fraud detection. This file
 * does neither of those things:
 *
 *   - It launches the user's ALREADY-INSTALLED Chrome (`channel: "chrome"`,
 *     falling back to well-known install paths), not a downloaded Chromium.
 *     Nobody using this needed to install anything extra.
 *   - It never touches the automation-detection surface. If a retailer's
 *     bot detection notices Puppeteer is attached, that is left true. Hiding
 *     it would be the difference between "an agent drove a real browser" and
 *     "an agent impersonated a human to a fraud system", and only the first
 *     one is a line Basketed will build on.
 *   - Nothing is captured until the human clicks "I'm logged in — capture".
 *     There is no polling for a session-cookie name to appear and grabbing it
 *     the moment it does; the human decides when login is actually finished.
 *
 * This is still real automation of a real retailer's login flow, and every
 * one of Tesco/Costco/Walmart/Amazon's Terms of Service prohibits automated
 * access -- including, most of them, when the account owner is the one doing
 * it. That risk is disclosed on the Connect-stores page itself (see
 * `connections.ts`'s `reach` text), not just in this comment.
 */

interface CaptureSession {
  browser: Browser;
  page: Page;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, CaptureSession>();

/** How long an opened login window is allowed to sit before it is auto-closed. */
const SESSION_TTL_MS = 15 * 60 * 1000;

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
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  }
}

/**
 * Find and launch the machine's own Chrome.
 *
 * `channel: "chrome"` is Puppeteer's own OS-standard-location lookup; the
 * explicit path list is the fallback for the installs it does not know about
 * (a portable install, a non-standard drive). Both avoid the one thing this
 * package will not do: download and bundle a browser nobody asked for.
 */
async function launchRealChrome(): Promise<Browser> {
  try {
    return await puppeteer.launch({ channel: "chrome", headless: false, defaultViewport: null });
  } catch {
    // channel lookup failed; try the well-known paths ourselves.
  }
  for (const executablePath of candidateChromePaths()) {
    if (!existsSync(executablePath)) continue;
    try {
      return await puppeteer.launch({ executablePath, headless: false, defaultViewport: null });
    } catch {
      // this path resolved but failed to launch (permissions, a running lock); try the next.
    }
  }
  throw new Error(
    "Google Chrome was not found on this machine. Install it, or use the paste-it-yourself form below instead.",
  );
}

export type CaptureState = "idle" | "waiting";

export function stateOf(storeId: string): CaptureState {
  return sessions.has(storeId) ? "waiting" : "idle";
}

/** Close every open login window. Called on shutdown so nothing outlives the server. */
export async function closeAll(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(
    all.map((s) => {
      clearTimeout(s.timeout);
      return s.browser.close();
    }),
  );
}

async function endSession(storeId: string): Promise<void> {
  const s = sessions.get(storeId);
  if (!s) return;
  sessions.delete(storeId);
  clearTimeout(s.timeout);
  try {
    await s.browser.close();
  } catch {
    // already gone
  }
}

/** Open a real Chrome window on the store's real site. The human takes it from here. */
export async function startLogin(storeId: string, url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sessions.has(storeId)) return { ok: true }; // already open; do not spawn a second window

  let browser: Browser;
  try {
    browser = await launchRealChrome();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    await browser.close();
    return { ok: false, error: `Could not reach ${url}: ${(err as Error).message}` };
  }

  const timeout = setTimeout(() => void endSession(storeId), SESSION_TTL_MS);
  sessions.set(storeId, { browser, page, startedAt: Date.now(), timeout });
  browser.once("disconnected", () => void endSession(storeId));
  return { ok: true };
}

/**
 * Read back whatever cookies the real site set for its domain, on the human's
 * say-so. This is the one place this file reads session state, and it is
 * only reachable through a route gated exactly like every other write to the
 * vault -- the panel token, checked before this function is ever called.
 */
export async function captureLogin(
  storeId: string,
  domains: string[],
): Promise<{ ok: true; cookieHeader: string } | { ok: false; error: string }> {
  const s = sessions.get(storeId);
  if (!s) return { ok: false, error: "No login window is open for this store. Click \"Log in with Chrome\" first." };

  try {
    const client = await s.page.target().createCDPSession();
    const { cookies } = await client.send("Network.getCookies", {
      urls: domains.flatMap((d) => [`https://${d}`, `https://www.${d}`]),
    });
    await client.detach();
    if (!cookies.length) {
      return { ok: false, error: "No cookies were set for that site yet -- finish logging in, then try again." };
    }
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await endSession(storeId);
    return { ok: true, cookieHeader };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function cancelLogin(storeId: string): Promise<boolean> {
  const had = sessions.has(storeId);
  await endSession(storeId);
  return had;
}
