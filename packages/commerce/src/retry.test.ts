import { describe, it, expect } from "vitest";
import { isTransientError, withRetry, withTimeout } from "./retry.js";

const noSleep = async () => {};

describe("isTransientError", () => {
  it("retries the statuses that mean 'ask again'", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientError(new Error(`Tesco search returned HTTP ${s}.`))).toBe(true);
    }
  });

  it("does not retry a status that means 'stop asking'", () => {
    for (const s of [400, 401, 403, 404, 410, 422]) {
      expect(isTransientError(new Error(`Etsy search returned HTTP ${s}.`))).toBe(false);
    }
  });

  it("retries a transport failure that never reached the retailer", () => {
    for (const m of ["fetch failed", "socket hang up", "connect ETIMEDOUT 1.2.3.4:443", "read ECONNRESET"]) {
      expect(isTransientError(new Error(m))).toBe(true);
    }
  });

  it("retries our own timeout wrapper", () => {
    expect(isTransientError(new Error("ikea:ikea timed out after 9000ms"))).toBe(true);
  });

  // The bug this replaces: /5\d\d/ over the whole message.
  it("does not read a product id as a server error", () => {
    expect(isTransientError(new Error('Unknown product id "503" for eBay.'))).toBe(false);
    expect(isTransientError(new Error("Best Buy product page for 6502134 had no readable price."))).toBe(false);
    expect(isTransientError(new Error("IKEA returned no price for article 429.001.23."))).toBe(false);
  });

  it("never retries an anti-bot wall, however it is dressed up", () => {
    expect(isTransientError(new Error("Amazon search appears blocked (captcha)."))).toBe(false);
    expect(isTransientError(new Error("Target: are you a human?"))).toBe(false);
    // A block served WITH a retryable status is still a block.
    expect(isTransientError(new Error("Target search returned HTTP 503 (captcha wall)."))).toBe(false);
  });

  it("never retries a store saying it cannot do the thing", () => {
    expect(isTransientError(new Error('Store "amz:amazon" does not support product detail.'))).toBe(false);
    expect(isTransientError(new Error("amz:amazon cannot build a cart."))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls += 1; return "ok"; }, { sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("Tesco search returned HTTP 503.");
        return "recovered";
      },
      { sleep: noSleep },
    );
    expect(out).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("gives up after the configured number of attempts, rethrowing the retailer's own words", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new Error("Tesco search returned HTTP 503."); }, {
        attempts: 3,
        sleep: noSleep,
      }),
    ).rejects.toThrow("returned HTTP 503");
    expect(calls).toBe(3);
  });

  it("does not retry a block at all — one refusal, not three", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new Error("Amazon search appears blocked (captcha)."); }, {
        sleep: noSleep,
      }),
    ).rejects.toThrow("blocked");
    expect(calls).toBe(1);
  });

  it("backs off longer each time", async () => {
    const slept: number[] = [];
    await expect(
      withRetry(async () => { throw new Error("HTTP 503"); }, {
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => { slept.push(ms); },
      }),
    ).rejects.toThrow();
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0]!);
  });
});

describe("withTimeout", () => {
  it("passes a fast result straight through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "fast")).resolves.toBe(7);
  });

  it("rejects with a label a human can act on", async () => {
    const never = new Promise<number>(() => {});
    await expect(withTimeout(never, 5, "tsc:tesco")).rejects.toThrow("tsc:tesco timed out after 5ms");
  });

  it("clears its timer, so a resolved call leaves nothing pending", async () => {
    const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
    await withTimeout(Promise.resolve("done"), 60_000, "slow");
    const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});
