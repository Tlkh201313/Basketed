import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StoreRegistry } from "@basketed/adapters";
import {
  TescoAdapter,
  AmazonAdapter,
  EtsyAdapter,
  EbayAdapter,
  BestBuyAdapter,
  IkeaAdapter,
  TargetAdapter,
} from "@basketed/adapters";
import { needsAccount } from "@basketed/commerce";

/**
 * What the browser extension is allowed to see, checked against what the
 * adapters actually need.
 *
 * The manifest asked for cookie access on amazon.com, costco.com,
 * walmart.com, shopee.sg, taobao.com and ikea.com. Not one adapter reads a
 * session from any of them -- four of those stores are not even live. Chrome
 * shows every host in that list to the user at install time, so the install
 * prompt was asking for six retailers' cookies to do nothing with them, and
 * anyone reading it carefully had every reason to say no.
 *
 * The list is now loopback plus the domains of stores that declare a session,
 * and this test fails when the two drift apart in either direction.
 */

const MANIFEST = resolve(import.meta.dirname, "../../extension/manifest.json");

type Manifest = { version: string; host_permissions: string[]; permissions: string[] };

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
}

/** Every domain an adapter would actually want a session from. */
function sessionDomains(): string[] {
  const registry = new StoreRegistry();
  for (const adapter of [
    new TescoAdapter(),
    new AmazonAdapter(),
    new EtsyAdapter(),
    new EbayAdapter(),
    new BestBuyAdapter(),
    new IkeaAdapter(),
    new TargetAdapter(),
  ]) {
    registry.register(adapter);
  }
  const domains: string[] = [];
  for (const adapter of registry.all()) {
    const account = adapter.manifest.account;
    if (account.kind !== "session") continue;
    domains.push(...account.login.domains);
  }
  return [...new Set(domains)].sort();
}

describe("extension host permissions", () => {
  it("asks for loopback, so it can talk to the panel", async () => {
    const hosts = (await manifest()).host_permissions;
    expect(hosts).toContain("http://127.0.0.1/*");
    expect(hosts).toContain("http://localhost/*");
  });

  it("asks for exactly the retailers whose adapters consume a session", async () => {
    const hosts = (await manifest()).host_permissions.filter((h) => !h.includes("127.0.0.1") && !h.includes("localhost"));
    expect(hosts.sort()).toEqual(sessionDomains().map((d) => `https://*.${d}/*`));
  });

  it("asks for no retailer whose adapter never reads a session", async () => {
    /*
     * The regression, named: a host in this list that no adapter needs is a
     * permission the user is asked to grant for nothing, and the ask lands at
     * install time when they have the least context to judge it.
     */
    const hosts = (await manifest()).host_permissions;
    const wanted = sessionDomains();
    for (const stale of ["amazon.com", "costco.com", "walmart.com", "shopee.sg", "taobao.com", "ikea.com"]) {
      if (wanted.includes(stale)) continue;
      expect(hosts.some((h) => h.includes(stale)), stale).toBe(false);
    }
  });

  it("keeps the domain list non-empty, or the extension can finish nothing", async () => {
    // If every store lost its account block this test would pass vacuously
    // while the extension became a no-op nobody had noticed shipping.
    expect(sessionDomains().length).toBeGreaterThan(0);
  });

  it("was version-bumped, because Chrome re-prompts on a permission change", async () => {
    // An unchanged version on a changed permission set leaves installed
    // copies running the old grant, which is the worst of both.
    expect((await manifest()).version).not.toBe("1.1.0");
  });
});

describe("what the extension can do at all", () => {
  it("still needs cookies and webRequest, and asks for nothing broader", async () => {
    const perms = (await manifest()).permissions.sort();
    expect(perms).toEqual(["cookies", "storage", "webRequest"]);
    // Notably absent: "tabs" and "<all_urls>". Reading the session out of one
    // named domain is the whole job.
    expect(perms).not.toContain("tabs");
  });

  it("agrees with the adapters that only account stores are involved", () => {
    const withAccounts = [
      new TescoAdapter(),
      new AmazonAdapter(),
      new EtsyAdapter(),
      new TargetAdapter(),
    ].filter((a) => needsAccount(a.manifest.account));
    expect(withAccounts.map((a) => a.manifest.id)).toEqual(["tsc:tesco"]);
  });
});
