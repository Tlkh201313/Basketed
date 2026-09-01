/**
 * One retry policy for every outbound store call.
 *
 * Search, product detail and cart building each grew their own copy of this,
 * and the three had drifted: different attempt counts, different backoffs, and
 * two different opinions about whether a captcha wall is worth retrying. They
 * are the same decision -- "is it worth asking this retailer again?" -- so it
 * is made in one place.
 *
 * Two rules the old copies got wrong:
 *
 *  - A BLOCK IS NOT TRANSIENT. Anti-bot walls (captcha, "are you a human",
 *    403) do not clear in 400ms; retrying one is three times the traffic for
 *    the same refusal, and it is exactly the traffic that gets an IP banned
 *    for longer. It fails once, loudly, and the store is named as unavailable.
 *  - A STATUS CODE IS ONLY A STATUS CODE IN CONTEXT. The old test was
 *    /5\d\d/ against the whole message, so `Unknown product id "503"` and
 *    `no price for SKU 500` read as server errors and got retried. Adapters
 *    all word it `HTTP <status>`, so that is what is matched.
 */

/** Statuses worth asking again. 4xx is the client's fault -- except these. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** `HTTP 503`, `status: 429`, `status=500`. Not a bare number anywhere. */
const STATUS_IN_CONTEXT = /\b(?:http|status|code)\b[^0-9a-z]{0,4}(\d{3})\b/gi;

/** Transport-level failures. The request never got an answer at all. */
const TRANSPORT = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETDOWN|ENETUNREACH|ENETRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))\b|fetch failed|socket hang up|network(?: |-)?error|timed? ?out/i;

/**
 * Refusals that repeat identically however many times you ask. Checked FIRST,
 * so a message that carries both (a captcha page served as HTTP 503) is
 * treated as the block it is.
 */
const PERMANENT =
  /captcha|are you a human|robot or human|access denied|blocked|bot detection|unusual traffic|unknown product|no such product|does not support|cannot build a cart|not loaded|did not look like|no readable price|no parseable price|has no link/i;

export function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  if (PERMANENT.test(msg)) return false;
  if (TRANSPORT.test(msg)) return true;
  STATUS_IN_CONTEXT.lastIndex = 0;
  for (let m = STATUS_IN_CONTEXT.exec(msg); m; m = STATUS_IN_CONTEXT.exec(msg)) {
    if (TRANSIENT_STATUS.has(Number(m[1]))) return true;
  }
  return false;
}

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  /** First backoff in ms; doubles each time, plus jitter. */
  baseDelayMs?: number;
  /** Test seam. Real callers never pass this. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying only what `isTransientError` calls worth retrying.
 *
 * The last failure is rethrown unchanged: the caller reports the retailer's
 * own words, not "retried 3 times".
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i === attempts - 1 || !isTransientError(err)) throw err;
      await sleep(base * 2 ** i + Math.random() * (base / 2));
    }
  }
  throw last;
}

/**
 * Bounds a promise that has no timeout of its own.
 *
 * The timer is cleared whichever way the race ends, so a slow store cannot
 * hold the process open after the answer has already been sent.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
