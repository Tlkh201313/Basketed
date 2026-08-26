import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ShopifyUcpAdapter } from "./adapter.js";

interface PinnedFile {
  probed_at: string;
  stores: Array<{ id: string; domain: string; endpoint: string; tools?: string[] }>;
}

/**
 * Locale inference from the TLD. Crude, but wrong currency on a price is a
 * demo-ending bug and a .co.uk store quoting USD would be exactly that.
 */
function localeFor(domain: string): { country: string; currency: string } {
  if (domain.endsWith(".co.uk") || domain.endsWith(".uk")) return { country: "GB", currency: "GBP" };
  if (domain.endsWith(".ca")) return { country: "CA", currency: "CAD" };
  if (domain.endsWith(".au") || domain.endsWith(".com.au")) return { country: "AU", currency: "AUD" };
  return { country: "US", currency: "USD" };
}

function titleCase(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".")[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Build adapters from the store list pinned at Day-0.
 *
 * The list is committed rather than discovered at runtime on purpose: probing
 * 18 domains on every start would be slow, would burn goodwill with stores we
 * do not own, and would make the demo depend on all of them being up at once.
 */
export async function loadPinnedShopifyStores(root = process.cwd()): Promise<ShopifyUcpAdapter[]> {
  const path = resolve(root, "fixtures/stores.pinned.json");
  let file: PinnedFile;
  try {
    file = JSON.parse(await readFile(path, "utf8")) as PinnedFile;
  } catch {
    throw new Error(`No pinned store list at ${path}. Run "pnpm probe:stores" first.`);
  }

  return file.stores.map((s) => {
    const { country, currency } = localeFor(s.domain);
    return new ShopifyUcpAdapter({
      domain: s.domain,
      endpoint: s.endpoint,
      name: titleCase(s.domain),
      country,
      currency,
    });
  });
}
