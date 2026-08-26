import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { openVault, degradedVault, authorizedFetch, type Vault } from "./index.js";

/**
 * The vault's one job: hold a secret so a human can add it, and make sure the
 * model sharing this machine can never read it back. Every test here is aimed
 * at one of those two halves.
 */

function tmpKeyPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bk-vault-")), "master.key");
}

describe("round trip", () => {
  let db: DatabaseSync;
  let vault: Vault;
  let keyPath: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    keyPath = tmpKeyPath();
    vault = openVault(db, { keyPath });
  });

  it("stores a secret and reveals it back", () => {
    vault.connect({ storeId: "sim:tesco", kind: "password", username: "me@example.com", secret: "hunter2" });
    const revealed = vault.reveal("sim:tesco");
    expect(revealed).toEqual({ kind: "password", username: "me@example.com", secret: "hunter2" });
  });

  it("list() and get() never carry the secret", () => {
    vault.connect({ storeId: "sim:costco", kind: "token", secret: "sk-abcdefghijklmnop" });
    const [row] = vault.list();
    expect(JSON.stringify(row)).not.toContain("sk-abcdefghijklmnop");
    expect(JSON.stringify(vault.get("sim:costco"))).not.toContain("sk-abcdefghijklmnop");
  });

  it("connecting again replaces the old secret, not appends", () => {
    vault.connect({ storeId: "sim:walmart", kind: "token", secret: "first-secret-value" });
    vault.connect({ storeId: "sim:walmart", kind: "token", secret: "second-secret-value" });
    expect(vault.reveal("sim:walmart")?.secret).toBe("second-secret-value");
    expect(vault.list().filter((c) => c.storeId === "sim:walmart")).toHaveLength(1);
  });

  it("forget() removes it, and reveal() then finds nothing", () => {
    vault.connect({ storeId: "sim:amazon", kind: "cookie", secret: "session=abc123xyz789" });
    expect(vault.forget("sim:amazon")).toBe(true);
    expect(vault.reveal("sim:amazon")).toBeNull();
    expect(vault.forget("sim:amazon")).toBe(false);
  });

  it("a store that was never connected reveals nothing", () => {
    expect(vault.reveal("sim:nosuchstore")).toBeNull();
    expect(vault.get("sim:nosuchstore")).toBeNull();
  });

  it("what is on disk is not the plaintext", () => {
    vault.connect({ storeId: "sim:tesco", kind: "password", username: "me@example.com", secret: "hunter2plaintext" });
    const raw = db.prepare(`SELECT sealed FROM credentials WHERE store_id = ?`).get("sim:tesco") as {
      sealed: string;
    };
    expect(raw.sealed).not.toContain("hunter2plaintext");
  });

  it("secrets() feeds the redaction net, exactly the stored plaintexts", () => {
    vault.connect({ storeId: "sim:tesco", kind: "password", username: "a", secret: "secret-one-value" });
    vault.connect({ storeId: "sim:costco", kind: "token", secret: "secret-two-value" });
    expect(vault.secrets().sort()).toEqual(["secret-one-value", "secret-two-value"]);
  });
});

describe("a wrong or rotated key", () => {
  it("marks the connection broken rather than throwing", () => {
    const db = new DatabaseSync(":memory:");
    const keyA = tmpKeyPath();
    openVault(db, { keyPath: keyA }).connect({ storeId: "sim:tesco", kind: "token", secret: "under-the-old-key" });

    const keyB = tmpKeyPath(); // a different key entirely, same database
    const reopened = openVault(db, { keyPath: keyB });
    const [row] = reopened.list();
    expect(row!.broken).toBe(true);
    expect(reopened.reveal("sim:tesco")).toBeNull();
  });

  it("the same key across a real re-open still decrypts", () => {
    const db = new DatabaseSync(":memory:");
    const keyPath = tmpKeyPath();
    openVault(db, { keyPath }).connect({ storeId: "sim:tesco", kind: "token", secret: "same-key-value" });
    const reopened = openVault(db, { keyPath });
    expect(reopened.reveal("sim:tesco")?.secret).toBe("same-key-value");
  });
});

describe("degradedVault — what a bad key file must not do", () => {
  it("never throws on a read; list and get are just empty", () => {
    const v = degradedVault("permission denied");
    expect(v.list()).toEqual([]);
    expect(v.get("sim:tesco")).toBeNull();
    expect(v.reveal("sim:tesco")).toBeNull();
    expect(v.secrets()).toEqual([]);
    expect(v.forget("sim:tesco")).toBe(false);
  });

  it("connect() throws with the reason, so the panel route can turn it into a clear 503", () => {
    const v = degradedVault("disk full");
    expect(() => v.connect({ storeId: "sim:tesco", kind: "token", secret: "x" })).toThrow(/disk full/);
  });
});

describe("authorizedFetch — the trust boundary an adapter cannot cross", () => {
  it("attaches a bearer token for a token connection, and the adapter never sees the value", async () => {
    const db = new DatabaseSync(":memory:");
    const vault = openVault(db, { keyPath: tmpKeyPath() });
    vault.connect({ storeId: "sim:tesco", kind: "token", secret: "the-bearer-token-value" });

    let sentAuth: string | null = null;
    const base: typeof fetch = async (_input, init) => {
      sentAuth = new Headers(init?.headers).get("authorization");
      return new Response("{}");
    };
    await authorizedFetch(vault, "sim:tesco", base)("https://example.com/x");
    expect(sentAuth).toBe("Bearer the-bearer-token-value");
  });

  it("attaches a cookie for a cookie connection", async () => {
    const db = new DatabaseSync(":memory:");
    const vault = openVault(db, { keyPath: tmpKeyPath() });
    vault.connect({ storeId: "sim:tesco", kind: "cookie", secret: "session=abc123xyz789" });

    let sentCookie: string | null = null;
    const base: typeof fetch = async (_input, init) => {
      sentCookie = new Headers(init?.headers).get("cookie");
      return new Response("{}");
    };
    await authorizedFetch(vault, "sim:tesco", base)("https://example.com/x");
    expect(sentCookie).toBe("session=abc123xyz789");
  });

  it("a password connection attaches nothing -- there is no login step to send it through", async () => {
    const db = new DatabaseSync(":memory:");
    const vault = openVault(db, { keyPath: tmpKeyPath() });
    vault.connect({ storeId: "sim:tesco", kind: "password", username: "me", secret: "hunter2plaintext" });

    let sawHeaders: Headers | null = null;
    const base: typeof fetch = async (_input, init) => {
      sawHeaders = new Headers(init?.headers);
      return new Response("{}");
    };
    await authorizedFetch(vault, "sim:tesco", base)("https://example.com/x");
    expect([...sawHeaders!.values()].join(" ")).not.toContain("hunter2plaintext");
  });

  it("a store with no connection at all just passes the request through", async () => {
    const db = new DatabaseSync(":memory:");
    const vault = openVault(db, { keyPath: tmpKeyPath() });
    let called = false;
    const base: typeof fetch = async () => {
      called = true;
      return new Response("{}");
    };
    await authorizedFetch(vault, "sim:nothing-here", base)("https://example.com/x");
    expect(called).toBe(true);
  });
});

/**
 * The claim in README's Security section is "there is exactly one function
 * that returns plaintext, and it is called from nowhere except the request
 * interceptor" -- backed by a test, the way every other security claim in this
 * codebase is (see purchase.test.ts's README drift guards). This is that test:
 * `.reveal(` may appear in its own definition and in `authorizedFetch`, and in
 * ANY test file, which is allowed to call it directly to assert on what got
 * stored. Nowhere in production source outside `packages/vault` -- meaning no
 * MCP tool handler, no adapter, and no panel route ever calls it.
 */
describe("reveal() has exactly the call sites README claims", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = resolve(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  it("is called only inside packages/vault, or from a test asserting on it", () => {
    const root = resolve(import.meta.dirname, "../../.."); // repo root from packages/vault/src
    const packagesDir = resolve(root, "packages");
    const offenders: string[] = [];
    for (const file of walk(packagesDir)) {
      const rel = file.replace(packagesDir, "packages").replace(/\\/g, "/");
      if (rel.startsWith("packages/vault/")) continue; // the definition and its own tests
      if (rel.endsWith(".test.ts")) continue; // a test may call it to check what got stored
      const src = readFileSync(file, "utf8");
      if (/\.reveal\(/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
