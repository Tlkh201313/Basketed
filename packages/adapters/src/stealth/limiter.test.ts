import { describe, expect, it, afterEach } from "vitest";
import { createLimiter, withDeadline, browserDisabled } from "./limiter.js";

/**
 * The gate in front of Chromium. A leaked slot here never comes back: the
 * limiter stops admitting anyone and every later render in the process waits
 * forever, so the release path matters more than the happy one.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createLimiter", () => {
  it("never runs more than the limit at once", async () => {
    const gate = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("hands the slot back when the work throws", async () => {
    // In a finally, because a leaked slot is permanent.
    const gate = createLimiter(1);
    await expect(gate(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(gate(async () => "still open")).resolves.toBe("still open");
  });

  it("queues rather than refusing", async () => {
    // A search that has already been asked for should be slow before wrong.
    const gate = createLimiter(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => gate(async () => { await sleep(2); order.push(n); })));
    expect(order).toHaveLength(3);
  });

  it("returns each caller its own result", async () => {
    const gate = createLimiter(2);
    expect(await Promise.all([1, 2, 3, 4].map((n) => gate(async () => n * 10)))).toEqual([10, 20, 30, 40]);
  });
});

describe("withDeadline", () => {
  it("returns the value and still runs cleanup", async () => {
    let closed = false;
    const out = await withDeadline(async () => "done", 1000, async () => { closed = true; }, "work");
    expect(out).toBe("done");
    expect(closed).toBe(true);
  });

  it("runs cleanup when the work throws", async () => {
    let closed = false;
    await expect(
      withDeadline(async () => { throw new Error("nope"); }, 1000, async () => { closed = true; }, "work"),
    ).rejects.toThrow("nope");
    expect(closed).toBe(true);
  });

  it("gives up on work that overruns, and closes the browser anyway", async () => {
    // The timeout path is the one that matters: the work promise is still
    // running and still holding a browser nobody is waiting for any more.
    let closed = false;
    await expect(
      withDeadline(() => sleep(5000), 20, async () => { closed = true; }, "Rendering https://x.test/"),
    ).rejects.toThrow(/Rendering https:\/\/x\.test\/ did not finish within 20ms/);
    expect(closed).toBe(true);
  });

  it("survives a cleanup that itself fails", async () => {
    // A Chromium that will not close must not turn a good render into an error.
    const out = await withDeadline(
      async () => "fine",
      1000,
      async () => { throw new Error("close failed"); },
      "work",
    );
    expect(out).toBe("fine");
  });
});

describe("browserDisabled", () => {
  const before = process.env["BASKETED_NO_BROWSER"];
  afterEach(() => {
    if (before === undefined) delete process.env["BASKETED_NO_BROWSER"];
    else process.env["BASKETED_NO_BROWSER"] = before;
  });

  it("is off unless set to exactly 1", () => {
    delete process.env["BASKETED_NO_BROWSER"];
    expect(browserDisabled()).toBe(false);
    for (const v of ["0", "", "true", "yes"]) {
      process.env["BASKETED_NO_BROWSER"] = v;
      expect(browserDisabled()).toBe(false);
    }
    process.env["BASKETED_NO_BROWSER"] = "1";
    expect(browserDisabled()).toBe(true);
  });

  it("is read on every call, so a test can set it", () => {
    // Cached at import time, this would be unsettable from a test and
    // unsettable from the drill, which is the only place it is used.
    process.env["BASKETED_NO_BROWSER"] = "1";
    expect(browserDisabled()).toBe(true);
    process.env["BASKETED_NO_BROWSER"] = "0";
    expect(browserDisabled()).toBe(false);
  });
});
