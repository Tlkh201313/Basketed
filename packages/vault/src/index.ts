import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * The credential vault (§2).
 *
 * One rule shapes every line of this file: **the model must never be able to
 * read a stored secret**, and no amount of prompt injection, tool-argument
 * cleverness or shell access from the agent's side should change that.
 *
 * How that is enforced, in order of how much it matters:
 *
 *   1. There is exactly one function that returns plaintext -- `reveal()` --
 *      and nothing on the MCP surface calls it. Tools receive a
 *      pre-authenticated `fetch` (see `authorizedFetch`), never a credential.
 *      `AdapterCtx` has no field a secret could travel in, so even a
 *      third-party adapter cannot ask for one.
 *   2. The write path is the panel, which is behind the per-process token
 *      printed on the server's own console. An agent can reach the port; it
 *      cannot read that console.
 *   3. Everything the panel reads back -- `list()`, `get()` -- is metadata.
 *      There is no route, anywhere, that serves ciphertext or plaintext.
 *   4. Every stored value is registered with the redactor, so if some future
 *      code path does echo one, it is caught on the way out and raises an
 *      alarm rather than shipping the secret to a transcript.
 *
 * At rest: AES-256-GCM under a 32-byte key in a file mode 0600 next to the
 * database. That key file is the thing to protect; losing it costs the stored
 * connections and nothing else, which is why a decrypt failure is reported as
 * "reconnect this store" rather than thrown.
 */

/**
 * `password` is deliberately absent (S19): there is no field anywhere in
 * Basketed that accepts a retailer password, so a kind that could only have
 * come from one is a kind nothing can create.
 */
export type CredentialKind = "token" | "cookie" | "session";

/**
 * What a `session` credential seals: the exact headers a signed-in browser
 * sent, lifted from the store's own API call (S21).
 *
 * One string was enough while every store's credential was one header. Tesco's
 * is not -- its basket API authenticates on `authorization` AND
 * `customer-uuid` together, and a bearer alone returns a basket that is not
 * yours. Rather than teach the vault about retailers, the capture side names
 * the headers and the vault carries whatever it was handed.
 */
export interface SessionSecret {
  /** Header name (lower-case) -> value. Sent verbatim, in this order. */
  headers: Record<string, string>;
  /** Unix ms this stops working, when the store said so (a JWT `exp`). */
  expiresAt?: number;
  /**
   * How to get a fresh one without asking the human again.
   *
   * Every session Basketed holds today is a snapshot that dies in hours, and
   * that is the single biggest reason a connected store stops working. Two
   * shapes, because the retailers studied split cleanly in two:
   *
   *   - `"endpoint"` replays an OAuth refresh against the store's own token
   *     endpoint. This is what thehesiod/costco-mcp (MIT) does with Azure AD
   *     B2C, and it works with no browser open at all.
   *   - `"browser"` asks the Basketed extension to read the session again out
   *     of the browser the human is still signed into. It needs no endpoint,
   *     no client id and no guessing -- which is why it is the default for
   *     retailers that publish no refresh contract. The reference MCPs cannot
   *     do this: they have no live browser. We do.
   */
  refresh?: SessionRefresh;
}

export type SessionRefresh =
  | {
      via: "endpoint";
      url: string;
      /** Form fields posted verbatim. The refresh token lives here. */
      body: Record<string, string>;
      /** Which JSON field of the response carries the new access token. */
      tokenField: string;
      /** Which header that token becomes, and how it is formatted. */
      header: string;
      prefix?: string;
    }
  | {
      via: "browser";
      /** Which store's connect flow can re-read this. Always the store's own id. */
      storeId: string;
    };

export function encodeSession(session: SessionSecret): string {
  return JSON.stringify(session);
}

/**
 * Parse a sealed session envelope.
 *
 * Returns null rather than throwing on anything malformed: a credential that
 * will not parse must degrade to "no credential attached" and let the retailer
 * answer 401, not take a request down with an exception from inside the
 * interceptor's closure.
 */
export function decodeSession(raw: string): SessionSecret | null {
  try {
    const parsed = JSON.parse(raw) as SessionSecret;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.headers || typeof parsed.headers !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** What the panel is allowed to see: everything except the secret itself. */
export interface Connection {
  storeId: string;
  kind: CredentialKind;
  /** The account this connects as -- an email, a username. Never a secret. */
  username: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /**
   * True when the stored bytes could not be decrypted with the current key.
   * The connection is dead and has to be made again; nothing is silently
   * treated as absent, because "your Tesco login quietly stopped working"
   * is exactly the failure a shopping agent must never paper over.
   */
  broken: boolean;
  /**
   * Unix ms this session stops working, when the store said so. Null for a
   * credential that carries no expiry -- which is not the same as "never
   * expires", only "did not say".
   */
  expiresAt: number | null;
  /**
   * True once that moment has passed. Held separately from `broken` because
   * the fixes differ: a broken credential lost its key, an expired one just
   * needs the browser to look again.
   */
  expired: boolean;
}

export interface RevealedCredential {
  kind: CredentialKind;
  username: string | null;
  secret: string;
}

export interface Vault {
  /** Metadata for every stored connection. Never a secret. */
  list(): Connection[];
  get(storeId: string): Connection | null;
  /** Store (or replace) the credential for a store. Returns metadata only. */
  connect(input: {
    storeId: string;
    kind: CredentialKind;
    username?: string | null;
    secret: string;
  }): Connection;
  /** Forget one store's credential. Returns false if there was nothing to forget. */
  forget(storeId: string): boolean;
  /**
   * The one door to plaintext, and the reason this file is worth reading.
   *
   * Call sites are audited: `authorizedFetch` in this module, and nothing
   * else in the workspace. A test asserts that -- see `vault.test.ts`.
   */
  reveal(storeId: string): RevealedCredential | null;
  /** Every stored plaintext, for the redaction net to watch. */
  secrets(): string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  store_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  username     TEXT,
  -- iv | tag | ciphertext, base64. There is no route that serves this column.
  sealed       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

export function defaultKeyPath(): string {
  return process.env["BASKETED_KEY"] ?? resolve(homedir(), ".basketed", "master.key");
}

/**
 * Read the master key, creating it on first use.
 *
 * Mode 0600 at creation AND on every read: a key that was written world-
 * readable once stays world-readable forever otherwise. On Windows the mode
 * bits are advisory, which is worth knowing but not worth skipping -- the file
 * still lands under the user's profile.
 */
function masterKey(keyPath: string): Buffer {
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* advisory on Windows; not a reason to refuse to run */
  }
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`Master key at ${keyPath} is not 32 bytes. Delete it to mint a new one (connections are lost).`);
  }
  return key;
}

function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function unseal(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, or bytes that were tampered with. Either way this credential
    // is gone -- say so rather than returning something half-trusted.
    return null;
  }
}

export interface VaultOptions {
  /** Where the 32-byte master key lives. Defaults to ~/.basketed/master.key. */
  keyPath?: string;
  /** Called with every stored plaintext, so the redactor can watch for it. */
  watch?: (secret: string) => void;
}

/**
 * A vault that refuses every write and answers every read with "nothing here".
 *
 * Returned by `openVault` in place of throwing. The purchase gate, product
 * search and every MCP tool are unrelated to this file -- a bad key file, a
 * read-only `~/.basketed`, or a corrupted `master.key` must degrade the
 * Connect-stores page, not take the whole server down with it. `reason` is
 * logged once at startup and echoed back on every write attempt, so "why can't
 * I connect a store" has an answer instead of a silent no-op.
 */
export function degradedVault(reason: string): Vault {
  const refuse = (): never => {
    throw new Error(`Credential vault unavailable: ${reason}`);
  };
  return {
    list: () => [],
    get: () => null,
    connect: refuse,
    forget: () => false,
    reveal: () => null,
    secrets: () => [],
  };
}

export function openVault(db: DatabaseSync, opts: VaultOptions = {}): Vault {
  db.exec(SCHEMA);
  const key = masterKey(opts.keyPath ?? defaultKeyPath());

  function row(storeId: string): Record<string, unknown> | undefined {
    return db.prepare(`SELECT * FROM credentials WHERE store_id = ?`).get(storeId) as
      | Record<string, unknown>
      | undefined;
  }

  function view(r: Record<string, unknown>): Connection {
    // One unseal for both answers: whether the bytes still decrypt, and what
    // the session said about its own lifetime. Doing it twice would double
    // the crypto on every list() for no gain.
    const plain = unseal(key, String(r["sealed"]));
    const kind = String(r["kind"]) as CredentialKind;
    const session = plain !== null && kind === "session" ? decodeSession(plain) : null;
    const expiresAt = session?.expiresAt ?? null;
    return {
      storeId: String(r["store_id"]),
      kind,
      username: r["username"] === null || r["username"] === undefined ? null : String(r["username"]),
      createdAt: Number(r["created_at"]),
      lastUsedAt: r["last_used_at"] === null || r["last_used_at"] === undefined ? null : Number(r["last_used_at"]),
      broken: plain === null,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= Date.now(),
    };
  }

  // Watch what is already stored, so a process that never touches a connection
  // still has the net up for it.
  if (opts.watch) {
    for (const r of db.prepare(`SELECT kind, sealed FROM credentials`).all() as Array<Record<string, unknown>>) {
      const plain = unseal(key, String(r["sealed"]));
      if (!plain) continue;
      if (String(r["kind"]) === "session") {
        const session = decodeSession(plain);
        for (const value of Object.values(session?.headers ?? {})) opts.watch(value);
        continue;
      }
      opts.watch(plain);
    }
  }

  return {
    list() {
      const rows = db.prepare(`SELECT * FROM credentials ORDER BY created_at DESC`).all() as Array<
        Record<string, unknown>
      >;
      return rows.map(view);
    },

    get(storeId) {
      const r = row(storeId);
      return r ? view(r) : null;
    },

    connect({ storeId, kind, username = null, secret }) {
      if (!secret) throw new Error("A connection needs a secret.");
      const now = Date.now();
      db.prepare(
        `INSERT INTO credentials (store_id, kind, username, sealed, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(store_id) DO UPDATE SET
           kind = excluded.kind,
           username = excluded.username,
           sealed = excluded.sealed,
           created_at = excluded.created_at,
           last_used_at = NULL`,
      ).run(storeId, kind, username, seal(key, secret), now);
      // Same rule as secrets(): watch the header values, not the envelope.
      if (kind === "session") {
        const session = decodeSession(secret);
        for (const value of Object.values(session?.headers ?? {})) opts.watch?.(value);
      } else {
        opts.watch?.(secret);
      }
      return view(row(storeId)!);
    },

    forget(storeId) {
      return db.prepare(`DELETE FROM credentials WHERE store_id = ?`).run(storeId).changes > 0;
    },

    reveal(storeId) {
      const r = row(storeId);
      if (!r) return null;
      const secret = unseal(key, String(r["sealed"]));
      if (secret === null) return null;
      db.prepare(`UPDATE credentials SET last_used_at = ? WHERE store_id = ?`).run(Date.now(), storeId);
      return {
        kind: String(r["kind"]) as CredentialKind,
        username: r["username"] === null || r["username"] === undefined ? null : String(r["username"]),
        secret,
      };
    },

    secrets() {
      const rows = db.prepare(`SELECT kind, sealed FROM credentials`).all() as Array<Record<string, unknown>>;
      const out: string[] = [];
      for (const r of rows) {
        const plain = unseal(key, String(r["sealed"]));
        if (plain === null) continue;
        // A session seals several secrets in one envelope. The redaction net
        // watches for the VALUES: the envelope is a shape no response body
        // will ever contain, so registering it would be a rule that cannot
        // fire -- and would leave the real secrets unwatched.
        if (String(r["kind"]) === "session") {
          const session = decodeSession(plain);
          if (session) out.push(...Object.values(session.headers));
          continue;
        }
        out.push(plain);
      }
      return out;
    },
  };
}

/**
 * The interceptor that makes the trust boundary real.
 *
 * An adapter is handed the returned `fetch` and nothing else. It cannot read
 * the credential, cannot log it, and cannot pass it anywhere -- the header is
 * attached inside this closure, on the way out, after the adapter has finished
 * describing the request it wants.
 *
 * A `session` attaches the whole header set it was sealed with, because one
 * header is not always the credential: Tesco's basket wants `authorization`
 * and `customer-uuid` together. The vault never interprets them -- the capture
 * side named them, and this closure only sets them.
 */
export function authorizedFetch(vault: Vault, storeId: string, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const cred = vault.reveal(storeId);
    if (!cred) return base(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (cred.kind === "token") headers.set("authorization", `Bearer ${cred.secret}`);
    else if (cred.kind === "cookie") headers.set("cookie", cred.secret);
    else if (cred.kind === "session") {
      const session = decodeSession(cred.secret);
      // An envelope that will not parse attaches nothing, so the retailer
      // answers 401 and the panel says "reconnect" -- rather than an
      // exception thrown from inside the one closure an adapter cannot see.
      if (!session) return base(input, init);
      // Verbatim, in the order the browser sent them. The vault does not know
      // or care what any of these mean.
      for (const [name, value] of Object.entries(session.headers)) headers.set(name, value);
    } else return base(input, init);

    return base(input, { ...init, headers });
  };
}
