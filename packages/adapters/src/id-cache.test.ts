import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdCache } from "./id-cache.js";
import { mintProductId, __setServerKey } from "./ids.js";
import { randomBytes } from "node:crypto";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "basketed-idcache-"));
  __setServerKey(Buffer.from("a-fixed-test-key-of-adequate-length"));
});
afterEach(() => {
  __setServerKey(null);
  rmSync(dir, { recursive: true, force: true });
});

const STORE = "amz:amazon";
const file = () => join(dir, "amz-amazon.json");

describe("the id cache", () => {
  it("hands back what it was given", () => {
    const cache = new IdCache<{ asin: string }>(STORE, { dir });
    const id = mintProductId(STORE, "B08N5WRWNW");
    cache.set(id, { asin: "B08N5WRWNW" });
    expect(cache.get(id)).toEqual({ asin: "B08N5WRWNW" });
  });

  // The bug: an id was only usable by the process that minted it, so a search
  // followed by a restart followed by a detail call read as "no such product".
  it("survives a restart", () => {
    const id = mintProductId(STORE, "B08N5WRWNW");
    const first = new IdCache<{ asin: string }>(STORE, { dir });
    first.set(id, { asin: "B08N5WRWNW" });
    first.flush();

    const second = new IdCache<{ asin: string }>(STORE, { dir });
    expect(second.get(id)).toEqual({ asin: "B08N5WRWNW" });
  });

  it("drops a row that does not verify under the current key", () => {
    const id = mintProductId(STORE, "B08N5WRWNW");
    const cache = new IdCache<{ asin: string }>(STORE, { dir });
    cache.set(id, { asin: "B08N5WRWNW" });
    cache.flush();

    // A new key means the old ids are no longer ours to trust.
    __setServerKey(randomBytes(32));
    expect(new IdCache<{ asin: string }>(STORE, { dir }).get(id)).toBeUndefined();
  });

  it("refuses a row somebody hand-edited into the file", () => {
    // The file is writable by any process running as this user. Without the
    // signature check, editing it would hand an adapter a native id it never
    // minted -- exactly what the HMAC exists to prevent.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, store: STORE, rows: [["bk_amz-amazon_forged_AAAAAAAA", { asin: "FORGED" }]] }),
      "utf8",
    );
    expect(new IdCache<{ asin: string }>(STORE, { dir }).get("bk_amz-amazon_forged_AAAAAAAA")).toBeUndefined();
  });

  it("treats a corrupt file as an empty cache rather than an error", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(), "{ not json", "utf8");
    const cache = new IdCache<{ asin: string }>(STORE, { dir });
    expect(cache.size).toBe(0);
    expect(() => cache.set(mintProductId(STORE, "X"), { asin: "X" })).not.toThrow();
  });

  it("evicts the least recently used row when it is full", () => {
    const cache = new IdCache<{ n: number }>(STORE, { dir, maxRows: 3 });
    const ids = ["a", "b", "c"].map((n) => mintProductId(STORE, n));
    ids.forEach((id, i) => cache.set(id, { n: i }));
    cache.get(ids[0]!); // touch the oldest so it is no longer least-recently-used
    const fresh = mintProductId(STORE, "d");
    cache.set(fresh, { n: 3 });

    expect(cache.size).toBe(3);
    expect(cache.get(ids[0]!)).toEqual({ n: 0 });
    expect(cache.get(ids[1]!)).toBeUndefined();
    expect(cache.get(fresh)).toEqual({ n: 3 });
  });

  it("writes valid JSON that another reader can parse", () => {
    const cache = new IdCache<{ asin: string }>(STORE, { dir });
    cache.set(mintProductId(STORE, "B0TEST"), { asin: "B0TEST" });
    cache.flush();
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.store).toBe(STORE);
    expect(parsed.rows).toHaveLength(1);
  });

  it("does not throw when the directory cannot be written", () => {
    const cache = new IdCache<{ asin: string }>(STORE, { dir: join(dir, "nope", "\0bad") });
    const id = mintProductId(STORE, "B0TEST");
    cache.set(id, { asin: "B0TEST" });
    expect(() => cache.flush()).not.toThrow();
    // Still a working cache in memory.
    expect(cache.get(id)).toEqual({ asin: "B0TEST" });
  });
});
