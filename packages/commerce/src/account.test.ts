import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StoreAccount, StoreManifest } from "@basketed/core";
import type { Connection } from "@basketed/vault";
import {
  connectHint,
  laneFor,
  needsAccount,
  needsAccountFor,
  sessionState,
  sessionUnusableReason,
  syncAccountStatus,
  usesPhrase,
} from "./account.js";

/**
 * The account questions, asked once instead of six times.
 *
 * These pin the two things that made the old scattered store-id checks a
 * problem: they disagreed with each other, and none of them could be made to
 * fail when a second account store arrived.
 */

const SESSION: StoreAccount = {
  kind: "session",
  uses: ["cart", "slots"],
  refresh: "browser",
  login: {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken"],
    capture: { match: "xapi.tesco.com", headers: ["authorization", "customer-uuid"] },
  },
};

const manifest = (account: StoreAccount): StoreManifest =>
  ({
    id: "tsc:tesco",
    name: "Tesco",
    country: "GB",
    currency: "GBP",
    language: "en",
    categories: ["grocery"],
    mode: "native",
    account,
    capabilities: ["discovery", "detail", "cart", "slots"],
    domain: "tesco.com",
  }) as StoreManifest;

const held = (over: Partial<Connection> = {}): Connection => ({
  storeId: "tsc:tesco",
  kind: "session",
  username: null,
  createdAt: 0,
  lastUsedAt: null,
  broken: false,
  expiresAt: null,
  expired: false,
  ...over,
});

describe("needsAccountFor", () => {
  it("gates only the tiers the store actually named", () => {
    expect(needsAccountFor(SESSION, "cart")).toBe(true);
    expect(needsAccountFor(SESSION, "slots")).toBe(true);
    // The whole point of naming tiers: search stays open to everyone. A store
    // that walls off discovery is a store nobody can try before signing in.
    expect(needsAccountFor(SESSION, "discovery")).toBe(false);
    expect(needsAccountFor(SESSION, "detail")).toBe(false);
  });

  it("gates nothing for a store with no account", () => {
    for (const account of [{ kind: "none" } as const, { kind: "demo" } as const]) {
      expect(needsAccount(account)).toBe(false);
      expect(needsAccountFor(account, "cart")).toBe(false);
    }
  });
});

describe("sessionState", () => {
  it("calls a missing credential none, not expired", () => {
    expect(sessionState(null)).toBe("none");
    expect(sessionState(undefined)).toBe("none");
  });

  it("reports broken ahead of expired", () => {
    // A credential that cannot be decrypted is dead whatever the clock says,
    // and telling someone to wait for a refresh would send them nowhere.
    expect(sessionState(held({ broken: true, expired: true }))).toBe("broken");
  });

  it("reports live only when it is both readable and in date", () => {
    expect(sessionState(held())).toBe("live");
    expect(sessionState(held({ expired: true }))).toBe("expired");
  });
});

describe("laneFor", () => {
  it("puts a store with no account on the fetch shelf, never on connected", () => {
    // A scrape store with nothing to connect is not in the same state as one
    // whose sign-in succeeded. A green tick on both tells a shopper their
    // Etsy account is hooked up when no such thing ever happened.
    expect(laneFor({ kind: "none" }, null)).toBe("fetch");
    expect(laneFor({ kind: "demo" }, null)).toBe("fetch");
  });

  it("splits an account store by whether the session is usable", () => {
    expect(laneFor(SESSION, held())).toBe("connected");
    expect(laneFor(SESSION, held({ expired: true }))).toBe("unconnected");
    expect(laneFor(SESSION, held({ broken: true }))).toBe("unconnected");
    expect(laneFor(SESSION, null)).toBe("unconnected");
  });
});

describe("sessionUnusableReason", () => {
  it("is null exactly when the session can be used", () => {
    expect(sessionUnusableReason(held())).toBeNull();
  });

  it("distinguishes the three failures, because the fixes differ", () => {
    expect(sessionUnusableReason(null)).toMatch(/no account is connected/);
    expect(sessionUnusableReason(held({ expired: true }))).toMatch(/expired/);
    expect(sessionUnusableReason(held({ broken: true }))).toMatch(/cannot be read/);
  });
});

describe("usesPhrase", () => {
  it("reads as a sentence, not as tier names", () => {
    expect(usesPhrase(SESSION)).toBe("trolley and delivery slots");
    expect(usesPhrase({ ...SESSION, uses: ["cart"] })).toBe("trolley");
    expect(usesPhrase({ kind: "none" })).toBe("");
  });
});

describe("connectHint", () => {
  it("names the store, the problem, what it unlocks and where the button is", () => {
    const hint = connectHint(manifest(SESSION), null);
    expect(hint).toContain("Tesco");
    expect(hint).toContain("trolley and delivery slots");
    expect(hint).toContain("no account is connected");
    expect(hint).toContain("Connect stores");
    expect(hint).toContain("tesco.com");
  });

  it("says the session expired rather than that nothing is connected", () => {
    // Those need different actions, and a shopper who was connected a minute
    // ago and is told "no account is connected" goes looking for a bug.
    expect(connectHint(manifest(SESSION), held({ expired: true }))).toContain("expired");
  });
});

describe("syncAccountStatus", () => {
  function fakeRegistry(accounts: Record<string, StoreAccount>) {
    const status: Record<string, string> = {};
    const adapters = Object.entries(accounts).map(([id, account]) => ({
      manifest: { ...manifest(account), id },
    }));
    return {
      status,
      registry: {
        all: () => adapters,
        get: (id: string) => adapters.find((a) => a.manifest.id === id),
        setStatus: (id: string, s: string) => void (status[id] = s),
      } as never,
    };
  }

  it("marks an account store needs_auth until the vault holds a live session", () => {
    const { registry, status } = fakeRegistry({ "tsc:tesco": SESSION });
    syncAccountStatus(registry, { get: () => null } as never);
    expect(status["tsc:tesco"]).toBe("needs_auth");

    syncAccountStatus(registry, { get: () => held() } as never);
    expect(status["tsc:tesco"]).toBe("ready");
  });

  it("leaves a store with no account alone", () => {
    // Its status is about whether the adapter loaded. A vault has nothing to
    // say about that, and overwriting it would hide a load failure.
    const { registry, status } = fakeRegistry({ "etsy:etsy": { kind: "none" } });
    syncAccountStatus(registry, { get: () => null } as never);
    expect(status["etsy:etsy"]).toBeUndefined();
  });

  it("does the same for a second account store, with no code change", () => {
    // The failure the old per-id version had: anything whose id was not the
    // one literal sat at whatever status it was registered with, forever.
    const { registry, status } = fakeRegistry({ "tsc:tesco": SESSION, "new:store": SESSION });
    syncAccountStatus(registry, { get: () => null } as never);
    expect(status["new:store"]).toBe("needs_auth");
  });
});

describe("no store id is hard-coded on the wire", () => {
  it("keeps the Tesco id out of the MCP tool and runtime branches", async () => {
    /*
     * The regression this whole change exists to prevent. Every one of these
     * files once branched on the literal, so a second account store would
     * have been silently treated as needing nothing at all.
     *
     * Registering Tesco by name is correct and stays allowed. Branching on
     * the name is what is banned.
     */
    const dir = resolve(import.meta.dirname, "../../mcp/src");
    const files = (await readdir(dir)).filter(
      (f) => (f.startsWith("tools") || f === "runtime.ts") && f.endsWith(".ts") && !f.includes(".test."),
    );
    expect(files.length).toBeGreaterThan(2);

    for (const file of files) {
      const src = await readFile(resolve(dir, file), "utf8");
      const branching = src
        .split("\n")
        .filter((l) => l.includes("tsc:tesco"))
        .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
        .filter((l) => !l.includes("loaded.push"));
      expect(branching, `${file} still branches on a store id`).toEqual([]);
    }
  });
});
