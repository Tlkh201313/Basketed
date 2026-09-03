import type { ProbePage } from "./page.js";

/**
 * A page for the tests: a scripted URL history, a title, a DOM the probes
 * ask about only by selector, and a cookie jar. Test-only; never imported
 * by production code.
 */
export interface FakePageInit {
  /** Each goto walks this chain; url() reports the furthest reached. */
  redirects?: string[];
  url?: string;
  title?: string;
  present?: string[];
  texts?: Record<string, string>;
  body?: string;
  cookies?: Array<{ name: string; value: string }>;
  /** Throw on the first N goto calls. */
  failGotos?: number;
  /** Selectors whose locator throws. */
  throwing?: string[];
}

export class FakePage implements ProbePage {
  #url: string;
  #chain: string[];
  #step = 0;
  #failGotos: number;
  gotos: string[] = [];
  closed = false;
  readonly init: FakePageInit;

  constructor(init: FakePageInit = {}) {
    this.init = init;
    this.#url = init.url ?? "about:blank";
    this.#chain = init.redirects ?? [];
    this.#failGotos = init.failGotos ?? 0;
  }

  url(): string {
    return this.#url;
  }
  async goto(url: string): Promise<void> {
    this.gotos.push(url);
    if (this.#failGotos > 0) {
      this.#failGotos -= 1;
      throw new Error("net::ERR_CONNECTION_RESET");
    }
    this.#url = this.#chain.length ? (this.#chain[0] as string) : url;
    this.#step = 1;
  }
  async waitForLoadState(): Promise<void> {
    /* idle */
  }
  async waitForTimeout(): Promise<void> {
    // Redirect chains advance one hop per tick, like a real bounce.
    if (this.#step > 0 && this.#step < this.#chain.length) {
      this.#url = this.#chain[this.#step] as string;
      this.#step += 1;
    }
  }
  async title(): Promise<string> {
    return this.init.title ?? "";
  }
  async count(selector: string): Promise<number> {
    if (this.init.throwing?.includes(selector)) throw new Error("locator exploded");
    return this.init.present?.includes(selector) ? 1 : 0;
  }
  async text(selector: string): Promise<string | null> {
    return this.init.texts?.[selector] ?? null;
  }
  async bodyText(): Promise<string> {
    return this.init.body ?? "";
  }
  async cookies(): Promise<Array<{ name: string; value: string }>> {
    return this.init.cookies ?? [];
  }
  isClosed(): boolean {
    return this.closed;
  }
}
