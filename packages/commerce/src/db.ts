import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Persistence for the purchase gate (§5).
 *
 * `node:sqlite` rather than better-sqlite3: no native build step, which is not
 * a style preference -- the build machine is Windows, and a compile step on
 * first run is exactly the sort of thing that eats an hour you do not have.
 * It needs Node >= 22, which is why `engines.node` says so.
 */

export function defaultDbPath(): string {
  return process.env["BASKETED_DB"] ?? resolve(homedir(), ".basketed", "basketed.db");
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  -- Bound server-side from the verified session, NEVER from anything the
  -- agent supplied. Possession of the handle is not authentication
  -- (2026-07-28 State Handle Hijacking); the principal is what authorises.
  principal      TEXT NOT NULL,
  state          TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  cart_id        TEXT,
  -- sha256 over the canonical cart. Recomputed at confirm; a mismatch means
  -- the price moved after the human looked at it, and that needs a new human.
  cart_hash      TEXT NOT NULL,
  cart_json      TEXT NOT NULL,
  total_value    REAL NOT NULL,
  total_currency TEXT NOT NULL,
  -- The 6-digit console code is stored ONLY as a salted hash. It is a
  -- short-lived shared secret between the server console and the human, and
  -- it is never written anywhere it could be read back.
  code_hash      TEXT NOT NULL,
  code_salt      TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  approved_at    INTEGER,
  approved_channel TEXT,
  -- The exact total the human was shown, so the record says what they agreed
  -- to rather than what the cart says now.
  approved_total TEXT,
  consumed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  approval_id    TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  state          TEXT NOT NULL,
  -- 'unknown' whenever the route ends at a URL a human completes themselves.
  -- Rendering that as "Ordered" would be the most damaging bug we could ship.
  outcome        TEXT NOT NULL,
  total_value    REAL,
  total_currency TEXT,
  handoff_url    TEXT,
  route_rung     INTEGER,
  cart_json      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id  TEXT NOT NULL,
  amount_home  REAL NOT NULL,
  home_currency TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_at ON spend (at);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  -- Approval ids are never written here. Audit rows carry a short
  -- fingerprint instead, which is enough to correlate and useless to replay.
  detail TEXT NOT NULL
);
`;

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export type Db = DatabaseSync;
