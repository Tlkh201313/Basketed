import { describe, expect, it } from "vitest";
import type { StoreAccount } from "@basketed/core";
import { authPolicyFor, captureComplete, methodLabel, sessionHeaderAliases } from "./connections.js";

/**
 * The panel's account copy, now that it is derived rather than kept.
 *
 * The table this replaced was hand-maintained and keyed by store id, so it
 * could disagree with the adapter and nothing would catch it. These check the
 * projection: same store, same declaration, same sentence, and no store id
 * anywhere in the mapping.
 */

/**
 * Typed as the session MEMBER, not as the whole union, so `{ ...SESSION,
 * uses: [...] }` below still resolves to a session. Spreading a union value
 * widens `kind` back to a string and the discriminated union stops matching.
 */
type SessionAccount = Extract<StoreAccount, { kind: "session" }>;

const SESSION: SessionAccount = {
  kind: "session",
  uses: ["cart", "slots"],
  improves: ["discovery", "detail"],
  refresh: "browser",
  login: {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken"],
    capture: { match: "xapi.tesco.com", headers: ["authorization", "customer-uuid"] },
  },
};

describe("authPolicyFor", () => {
  it("offers a browser sign-in for an account store, and says what it unlocks", () => {
    const policy = authPolicyFor({ name: "Tesco", mode: "native", account: SESSION });
    expect(policy.methods).toEqual(["session"]);
    expect(policy.chromeLogin).toEqual(SESSION.login);
    expect(policy.reach).toContain("trolley and delivery slots");
    expect(policy.reach).toContain("tesco.com");
    // The S19 promise, in the copy a shopper actually reads.
    expect(policy.reach).toContain("No password is typed into Basketed");
  });

  it("offers nothing for a live store with no account", () => {
    const policy = authPolicyFor({ name: "Etsy", mode: "native", account: { kind: "none" } });
    expect(policy.methods).toEqual([]);
    expect(policy.chromeLogin).toBeNull();
    // Sealing cookies nothing reads would put a green tick on a store whose
    // adapter never sends one.
    expect(policy.reach).toBe("Live Etsy search from their public pages. No account needed.");
  });

  it("says a demo catalogue is a demo, not an account waiting to be connected", () => {
    const policy = authPolicyFor({ name: "Tesco", mode: "simulated", account: { kind: "demo" } });
    expect(policy.methods).toEqual([]);
    expect(policy.reach).toMatch(/Demo catalogue/);
  });

  it("names no retailer that the declaration did not name", () => {
    // The old table hard-coded "Tesco" into the reach sentence. A second
    // account store would have been introduced to shoppers as Tesco.
    const policy = authPolicyFor({
      name: "Waitrose",
      mode: "native",
      account: { ...SESSION, uses: ["cart"] },
    });
    expect(policy.reach).toContain("Waitrose");
    expect(policy.reach).toContain("trolley");
    expect(policy.reach).not.toContain("Tesco");
  });

  it("never offers a password, whatever the store declared", () => {
    for (const account of [SESSION, { kind: "none" } as const, { kind: "demo" } as const]) {
      expect(authPolicyFor({ name: "X", mode: "native", account }).methods).not.toContain("password");
    }
  });
});

describe("captureComplete", () => {
  it("accepts either spelling of the customer id header", () => {
    /*
     * Tesco's gateway sends the customer id as customer-uuid on one route and
     * x-customer-uuid on another. The check this replaced compared the asked-
     * for name against the captured keys directly, so a session that WAS
     * complete read as still waiting and the human watched a tab that would
     * never finish.
     */
    const want = { headers: ["authorization", "customer-uuid"] };
    expect(captureComplete(want, { authorization: "Bearer x", "customer-uuid": "abc" })).toBe(true);
    expect(captureComplete(want, { authorization: "Bearer x", "x-customer-uuid": "abc" })).toBe(true);
  });

  it("still refuses a half-capture", () => {
    // Half a session succeeds here and fails at the first basket call,
    // somewhere with far less context than this route has.
    const want = { headers: ["authorization", "customer-uuid"] };
    expect(captureComplete(want, { authorization: "Bearer x" })).toBe(false);
    expect(captureComplete(want, { authorization: "Bearer x", "customer-uuid": "   " })).toBe(false);
  });

  it("is false when the store asked for nothing, rather than vacuously true", () => {
    // A store with no capture spec is not "captured"; it has no headers to
    // lift, and treating it as complete would seal an empty session.
    expect(captureComplete(null, { authorization: "Bearer x" })).toBe(false);
    expect(captureComplete(undefined, {})).toBe(false);
  });
});

describe("sessionHeaderAliases", () => {
  it("treats the two customer-id spellings as one header", () => {
    expect(sessionHeaderAliases("customer-uuid")).toEqual(["customer-uuid", "x-customer-uuid"]);
    expect(sessionHeaderAliases("X-Customer-UUID")).toEqual(["customer-uuid", "x-customer-uuid"]);
  });

  it("leaves every other header alone, lowercased", () => {
    expect(sessionHeaderAliases("Authorization")).toEqual(["authorization"]);
  });
});

describe("methodLabel", () => {
  it("calls a captured session what it is", () => {
    // "session" had no case at all and fell through to "Account", which is
    // what the page then told a shopper they had connected.
    expect(methodLabel("session")).toBe("Browser session");
    expect(methodLabel("cookie")).toBe("Browser session");
    expect(methodLabel("token")).toBe("Access token");
  });
});
