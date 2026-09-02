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
    // Public tiers go in `improves`, which is not a gate. Signed-in Tesco
    // quotes the shopper's own store and Clubcard price; signed-out Tesco
    // still answers, and must keep answering.
    expect(account.improves).toEqual(["discovery", "detail"]);
    expect(account.refresh).toBe("browser");
    expect(account.login.domains).toContain("tesco.com");
    expect(account.login.capture?.headers).toEqual(["authorization", "customer-uuid"]);
  });

  it("gates nothing but the Tesco trolley, on any store", () => {
    /*
     * The distinction the whole `uses` / `improves` split exists for.
     *
     * Six other stores now declare a session, because a signed-in request to
     * any of them is a materially better answer -- the shopper's own address,
     * their store's stock, and a request that is turned away as a robot far
     * less often. Not one of them may GATE anything: Amazon search worked
     * signed out before anyone thought about accounts and has to keep
     * working that way, or connecting a store would have cost the shopper the
     * thing that already worked.
     */
    for (const adapter of REAL) {
      const account = adapter.manifest.account;
      if (adapter.manifest.id === "tsc:tesco") continue;
      if (account.kind !== "session") continue;
      expect(account.uses, adapter.manifest.id).toEqual([]);
      expect(account.improves.length, adapter.manifest.id).toBeGreaterThan(0);
    }
  });

  it("offers a session on every live store where one changes the answer", () => {
    const withAccounts = REAL.filter((a) => a.manifest.account.kind === "session").map((a) => a.manifest.id);
    // The complaint this fixes, written down: the panel offered exactly one
    // Connect button, on the one store with a gated cart, and eleven working
    // shops sat under "no account needed" with no way to sign in to any of
    // them. A session is offered wherever the adapter genuinely reads one.
    expect(withAccounts.sort()).toEqual([
      "amz:amazon",
      "bby:bestbuy",
      "ebay:ebay",
      "etsy:etsy",
      "ikea:ikea",
      "tgt:target",
      "tsc:tesco",
    ]);
  });

  it("gives every session store somewhere to send a human and something to read back", () => {
    for (const adapter of REAL) {
      const account = adapter.manifest.account;
      if (account.kind !== "session") continue;
      const where = adapter.manifest.id;
      // A Connect button that opens a page which cannot show a sign-in, or
      // that has no cookie signature to poll, leaves a human on a tab that
      // never finishes -- the exact dead end captureComplete was written for.
      expect(account.login.url, where).toMatch(/^https:\/\//);
      expect(account.login.loginUrl, where).toMatch(/^https:\/\//);
      expect(account.login.domains.length, where).toBeGreaterThan(0);
      expect(account.login.authCookies.length + (account.login.capture ? 1 : 0), where).toBeGreaterThan(0);
      // The login page has to belong to the store whose cookies we then read.
      for (const url of [account.login.url, account.login.loginUrl]) {
        const host = new URL(url).hostname;
        expect(
          account.login.domains.some((d) => host === d || host.endsWith(`.${d}`)),
          `${where}: ${url}`,
        ).toBe(true);
      }
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
      for (const tier of [...account.uses, ...account.improves]) {
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
          improves: [],
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

  it("refuses a session that neither gates a tier nor improves one", () => {
    /*
     * A Connect button, a retailer tab, a human signing in, a sealed
     * credential -- and no code path that ever reads it. Nothing downstream
     * can detect that: the vault holds a valid session and the panel shows a
     * green tick for an account that does nothing.
     */
    const adapter = {
      manifest: {
        ...new TescoAdapter().manifest,
        id: "test:pointless",
        // Only the two tiers this stub really implements, so the overclaim
        // check passes and the account check is the one under test.
        capabilities: ["discovery", "detail"],
        account: { ...new TescoAdapter().manifest.account, uses: [], improves: [] },
      },
      search: async () => [],
      detail: async () => null,
    } as unknown as StoreAdapter;

    expect(() => new StoreRegistry().register(adapter)).toThrow(/login screen for its own sake/i);
  });

  it("refuses an improved tier the adapter does not implement either", () => {
    // `improves` is not a gate, but it is still a claim about this adapter,
    // and an unimplemented one would put a store on the Connect page
    // promising to sharpen something it cannot do at all.
    const adapter = {
      manifest: {
        ...new TescoAdapter().manifest,
        id: "test:overreach-soft",
        capabilities: ["discovery"],
        account: { ...new TescoAdapter().manifest.account, uses: [], improves: ["cart"] },
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
