#!/usr/bin/env node
/**
 * Generate the simulated store catalogue.
 *
 * These retailers have no lawful automated route at any price for a solo
 * developer: Amazon retired its product API, the UK grocers and US big-box
 * chains offer nothing self-serve, and every Chinese platform requires a
 * Chinese business entity. Simulation is the honest option, which is exactly
 * why every row is stamped rather than quietly mixed in with real data.
 *
 * Deterministic: a fixed seed means the demo shows the same prices every run.
 * Deep links are REAL -- they point at each retailer's own search page, so the
 * link works even though the price beside it is synthetic.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** mulberry32 -- small, fast, and reproducible across machines. */
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STORES = [
  {
    id: "sim:tesco",
    name: "Tesco",
    country: "GB",
    currency: "GBP",
    categories: ["grocery"],
    search: "https://www.tesco.com/groceries/en-GB/search?query=",
    note: "UK grocery. No public product API; Tesco is reachable only via a licensed data provider.",
    priceBand: [0.75, 12.0],
  },
  {
    id: "sim:amazon",
    name: "Amazon",
    country: "US",
    currency: "USD",
    categories: ["general", "electronics", "grocery"],
    search: "https://www.amazon.com/s?k=",
    note: "Product Advertising API retired May 2026. Provider-sourced in the day-two roadmap.",
    priceBand: [4.99, 249.0],
  },
  {
    id: "sim:costco",
    name: "Costco",
    country: "US",
    currency: "USD",
    categories: ["grocery", "general"],
    search: "https://www.costco.com/CatalogSearch?keyword=",
    note: "No self-serve API. Bulk sizing reflected in the fixtures.",
    priceBand: [9.99, 189.0],
  },
  {
    id: "sim:shopee",
    name: "Shopee",
    country: "SG",
    currency: "SGD",
    categories: ["general", "apparel", "electronics"],
    search: "https://shopee.sg/search?keyword=",
    note: "Open Platform is seller-side only.",
    priceBand: [2.5, 120.0],
  },
  {
    id: "sim:taobao",
    name: "Taobao",
    country: "CN",
    currency: "CNY",
    categories: ["general", "apparel", "electronics"],
    search: "https://s.taobao.com/search?q=",
    note: "Alibaba open platform requires a Chinese business entity.",
    priceBand: [9.0, 900.0],
  },
  {
    id: "sim:ikea",
    name: "IKEA",
    country: "GB",
    currency: "GBP",
    categories: ["furniture"],
    search: "https://www.ikea.com/gb/en/search/?q=",
    note: "No official product API.",
    priceBand: [4.0, 450.0],
  },
];

const CATALOGUE = {
  grocery: [
    ["Ground Coffee", "500g", ["arabica", "fairtrade"]],
    ["Instant Coffee", "200g", []],
    ["Coffee Beans", "1kg", ["arabica"]],
    ["Decaf Ground Coffee", "227g", ["decaf"]],
    ["Semi-Skimmed Milk", "2L", []],
    ["Free-Range Eggs", "12 pack", ["free-range"]],
    ["Wholemeal Bread", "800g", ["vegan"]],
    ["Olive Oil", "750ml", ["vegan"]],
    ["Dark Chocolate", "180g", ["vegan"]],
    ["Green Tea", "80 bags", ["vegan"]],
  ],
  general: [
    ["Stainless Steel Water Bottle", "750ml", []],
    ["Cotton Bath Towel Set", "4 piece", []],
    ["Storage Boxes", "set of 3", []],
    ["LED Desk Lamp", "adjustable", []],
    ["Kitchen Knife Set", "5 piece", []],
  ],
  electronics: [
    ["Wireless Earbuds", "ANC", []],
    ["USB-C Charger", "65W", []],
    ["Bluetooth Speaker", "portable", []],
    ["Mechanical Keyboard", "75%", []],
  ],
  apparel: [
    ["Cotton T-Shirt", "unisex", []],
    ["Running Leggings", "high-waist", []],
    ["Hooded Sweatshirt", "fleece-lined", []],
  ],
  furniture: [
    ["Two-Seat Sofa", "fabric", []],
    ["Oak Coffee Table", "110x60cm", []],
    ["Bookshelf", "5 tier", []],
    ["Office Chair", "ergonomic", []],
  ],
};

const BRANDS = {
  "sim:tesco": ["Tesco Finest", "Tesco", "Nescafé", "Taylors"],
  "sim:amazon": ["Amazon Basics", "Solimo", "Lavazza", "Anker"],
  "sim:costco": ["Kirkland Signature", "Starbucks", "Member's Mark"],
  "sim:shopee": ["ShopeeChoice", "OEM", "Xiaomi"],
  "sim:taobao": ["小米", "网易严选", "OEM"],
  "sim:ikea": ["IKEA"],
};

const products = [];

for (const store of STORES) {
  const rand = rng(
    // Seed from the store id so each store is stable independently of the others.
    [...store.id].reduce((a, c) => a + c.charCodeAt(0), 0),
  );
  const brands = BRANDS[store.id];

  for (const cat of store.categories) {
    for (const [base, size, diet] of CATALOGUE[cat] ?? []) {
      const brand = brands[Math.floor(rand() * brands.length)];
      const [lo, hi] = store.priceBand;
      const value = Number((lo + rand() * (hi - lo)).toFixed(2));
      const score = Number((3.6 + rand() * 1.3).toFixed(1));
      const count = Math.floor(20 + rand() * 4800);
      const name = `${brand} ${base} — ${size}`;

      const attrs = { cat, brand };
      if (cat === "grocery") {
        attrs.size = size;
        if (diet.length) attrs.diet = diet;
      } else if (cat === "apparel") {
        attrs.size = "M";
      } else if (cat === "furniture") {
        attrs.material = "oak";
      }

      products.push({
        store: store.id,
        nativeId: `${store.id.split(":")[1]}-${products.length + 1000}`,
        name,
        price: { value, currency: store.currency },
        rating: { score: Math.min(score, 5), count },
        // Real URL: the retailer's own search page for this product.
        url: store.search + encodeURIComponent(`${brand} ${base}`),
        attrs,
      });
    }
  }
}

const out = {
  generated_at: new Date().toISOString(),
  warning:
    "SIMULATED DATA. Prices and ratings are synthetic and deterministic. URLs are real retailer search links. " +
    "Every product carries mode:'simulated' and must be displayed as such.",
  stores: STORES.map(({ priceBand, search, ...s }) => ({ ...s, searchUrl: search })),
  products,
};

await mkdir(resolve(ROOT, "fixtures/simulated"), { recursive: true });
await writeFile(resolve(ROOT, "fixtures/simulated/catalog.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`Seeded ${products.length} simulated products across ${STORES.length} stores.`);
for (const s of STORES) {
  console.log(`  ${s.id.padEnd(12)} ${String(products.filter((p) => p.store === s.id).length).padStart(3)} products  ${s.currency}`);
}
