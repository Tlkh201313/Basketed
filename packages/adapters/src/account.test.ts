import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { StoreRegistry } from "./registry.js";
import { SimulatedAdapter } from "./simulated/adapter.js";
import { TescoAdapter } from "./tesco/adapter.js";
import { AmazonAdapter } from "./amazon/adapter.js";
import { EtsyAdapter } from "./etsy/adapter.js";
import { EbayAdapter } from "./ebay/adapter.js";
import { BestBuyAdapter } from "./bestbuy/adapter.js";
import { IkeaAdapter } from "./ikea/adapter.js";
import { TargetAdapter } from "./target/adapter.js";
import type { StoreAdapter } from "./types.js";

/**
 * Who has an account, said once, by the adapter that would use it.
 *
 * Until S21 this fact lived in a table in the control panel keyed by store id,
 * so the panel could offer a Connect button for a store whose adapter never
 * reads a session, and no test could tell. The declaration moved into the
 * manifest, and these pin the two things that make it worth having: it is
 * accurate, and it cannot over-claim.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

const REAL: StoreAdapter[] = [
  new TescoAdapter(),
  new AmazonAdapter(),
  new EtsyAdapter(),
  new EbayAdapter(),
  new BestBuyAdapter(),
  new IkeaAdapter(),
  new TargetAdapter(),
];

describe("account descriptors", () => {
  it("gives Tesco a session for the trolley and the slots, and nothing else", () => {
    const account = new TescoAdapter().manifest.account;
    expect(account.kind).toBe("session");
    if (account.kind !== "session") return;
    // Search and detail are public. Gating them behind a sign-in would put a
    // wall in front of the one thing that works for everyone.
    expect(account.uses).toEqual(["cart", "slots"]);
    expect(account.refresh).toBe("browser");
    expect(account.login.domains).toContain("tesco.com");
    expect(account.login.capture?.headers).toEqual(["authorization", "customer-uuid"]);
  });

  it("gives every other live store no account at all", () => {
    for (const adapter of REAL) {
      if (adapter.manifest.id === "tsc:tesco") continue;
      expect(adapter.manifest.account.kind, adapter.manifest.id).toBe("none");
    }
  });

  it("marks simulated catalogues as demo, never as a real account", async () => {
    for (const adapter of await SimulatedAdapter.loadAll(ROOT)) {
      expect(adapter.manifest.account.kind, adapter.manifest.id).toBe("demo");
    }
  });

  it("names only tiers the adapter actually implements", () => {
    for (const adapter of REAL) {
      const account = adapter.manifest.account;
      if (account.kind !== "session") continue;
      for (const tier of account.uses) {
        expect(adapter.manifest.capabilities, adapter.manifest.id).toContain(tier);
      }
    }
  });
});

describe("registry.register", () => {
  it("refuses a store whose session promises reach the adapter does not have", () => {
    const adapter = {
      manifest: {
        ...new TescoAdapter().manifest,
        id: "test:overreach",
        capabilities: ["discovery", "detail"],
        account: {
          kind: "session",
          uses: ["cart"],
          refresh: "browser",
          login: {
            url: "https://example.test/",
            loginUrl: "https://example.test/login",
            domains: ["example.test"],
            authCookies: [],
          },
        },
      },
      search: async () => [],
      detail: async () => null,
    } as unknown as StoreAdapter;

    expect(() => new StoreRegistry().register(adapter)).toThrow(/does not implement that tier/i);
  });

  it("accepts the same store once the tier is really there", () => {
    expect(() => new StoreRegistry().register(new TescoAdapter())).not.toThrow();
  });
});
