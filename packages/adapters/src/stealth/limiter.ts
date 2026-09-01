/**
 * How many real Chromiums this process is allowed to have open at once, and
 * how long any one of them may live.
 *
 * `renderPage` launches a fresh browser per call, which is the right call for
 * fingerprinting -- a clean profile per request accumulates nothing and leaks
 * nothing between unrelated searches -- but it means concurrency is decided by
 * whoever called it. A multi-store search fans out across every adapter at
 * once, so a lane that reaches for a browser reaches for one per store, in
 * parallel, each of them a few hundred megabytes. On a laptop that is the
 * whole machine.
 *
 * Two at a time. Not one, because a single lane would serialise a fallback
 * behind an unrelated store's slow page; not more, because these are
 * low-volume discovery lookups and the third caller waiting two seconds is
 * cheaper for everyone than a fourth Chromium.
 */

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A FIFO gate. Callers past the limit wait their turn rather than being
 * refused -- a search that has already been asked for should be slow before it
 * is wrong.
 */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      // In a finally, so a thrown render still hands its slot back. A leaked
      // slot here is permanent: the gate never reopens and every later render
      // in this process waits forever.
      release();
    }
  };
}

/**
 * Bounds the whole render, not just the navigation.
 *
 * `page.goto` has its own timeout, but the settle wait, `page.content()` on a
 * huge DOM, and `browser.close()` do not -- and a Chromium that will not close
 * is a process this one now waits on at exit. The cleanup runs whether the
 * work finished, threw, or ran out of time.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  cleanup: () => Promise<void>,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms.`)), ms);
        // Never hold the process open on our own deadline.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Always. On the timeout path especially: the work promise is still
    // running and still holding a browser nobody is waiting for any more.
    await cleanup().catch(() => {});
  }
}

/**
 * Whether a browser may be launched at all.
 *
 * `BASKETED_NO_BROWSER=1` is for a CI box, a container with no Chromium, and
 * the offline drill -- anywhere the honest answer is "this lane is not
 * available" rather than a 30-second wait ending in a launch failure nobody
 * can read.
 */
export function browserDisabled(): boolean {
  return process.env["BASKETED_NO_BROWSER"] === "1";
}
