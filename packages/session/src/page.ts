import type { BrowserContext, Page } from "patchright";

/**
 * The narrow view of a browser page the probes are written against.
 *
 * Narrow on purpose: everything in `probe.ts` and `detect.ts` is decided from
 * these nine calls, so a unit test can hand them a fake page and assert on the
 * decision without a browser anywhere near the test run. `wrapPage` is the
 * only production implementation.
 */
export interface ProbePage {
  url(): string;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForLoadState(state: "networkidle", opts: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  title(): Promise<string>;
  /** How many elements match. Presence, not visibility. */
  count(selector: string): Promise<number>;
  /** Text of the first match, or null when there is none. */
  text(selector: string): Promise<string | null>;
  bodyText(): Promise<string>;
  /** Cookies the jar would send to these URLs. Names and values stay inside the process. */
  cookies(urls: string[]): Promise<Array<{ name: string; value: string }>>;
  isClosed(): boolean;
}

export function wrapPage(page: Page, context: BrowserContext): ProbePage {
  return {
    url: () => page.url(),
    goto: (url, opts) => page.goto(url, opts),
    waitForLoadState: (state, opts) => page.waitForLoadState(state, opts),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    title: () => page.title(),
    count: (selector) => page.locator(selector).count(),
    text: async (selector) => {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) return null;
      return loc.textContent({ timeout: 1500 });
    },
    bodyText: () => page.locator("body").innerText({ timeout: 2500 }),
    cookies: async (urls) => (await context.cookies(urls)).map((c) => ({ name: c.name, value: c.value })),
    isClosed: () => page.isClosed(),
  };
}

/** Resolve `p`, or `fallback` if it has not settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}
