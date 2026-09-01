import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProductId } from "./ids.js";
import { stateDir } from "./state-dir.js";

/**
 * What an adapter remembers about the ids it has minted, kept across restarts.
 *
 * Every scrape adapter mints an opaque id at search time and needs the native
 * one (an ASIN, a TCIN, a Tesco tpnb) to answer `detail` or `buildCart` later.
 * That was a plain Map on the adapter instance, which made a hard rule out of
 * an accident of process lifetime: an id was only usable by the same process
 * that minted it. In practice a person searches, goes to look at something
 * else, and comes back after their editor has restarted the stdio server --
 * and every id they are holding now answers "search first, then request
 * detail", which reads as the tool being broken.
 *
 * So the map is written to ~/.basketed/ids/<store>.json. Three properties
 * matter:
 *
 *  - It is a CACHE, never a source of truth. Anything that cannot be loaded
 *    is dropped, and a miss is the same "search first" it always was.
 *  - Every row is re-verified against the current id key on load. A key that
 *    was regenerated invalidates its ids, and rows signed by the old one must
 *    not survive that -- otherwise a forged id could be smuggled in by
 *    editing the file, which is exactly what the HMAC exists to prevent.
 *  - It is bounded. An unbounded on-disk map of every product ever searched
 *    would grow without limit on a machine nobody prunes.
 */

/** Rows per store. A few thousand searches' worth; ~200 KB of JSON at most. */
const MAX_ROWS = 2000;

interface Persisted<T> {
  version: 1;
  store: string;
  rows: Array<[string, T]>;
}

export interface IdCacheOptions {
  /** Override the directory. Tests only -- production reads BASKETED_STATE_DIR. */
  dir?: string;
  maxRows?: number;
}

/*
 * Every cache this process has made, so exit can write them all.
 *
 * The batching timer below is deliberately unreffed, which means a process
 * that finishes its work inside the batch window exits before the write. That
 * is not the rare case it sounds like: the common shape is a client that
 * starts the stdio server, runs one search, and is restarted by the editor
 * minutes later. Every id from that search was lost, so the very next
 * `get_product_detail` answered "search first" -- which reads as the tool
 * being broken, and is exactly the failure persisting the cache was for.
 *
 * A WeakRef set, because a cache the adapter has dropped should not be kept
 * alive by the exit hook.
 */
const LIVE = new Set<WeakRef<{ flush(): void }>>();
let hookInstalled = false;

/** Write every live cache. Safe to call more than once; each is a no-op if clean. */
export function flushAllIdCaches(): void {
  for (const ref of LIVE) {
    const cache = ref.deref();
    if (!cache) {
      LIVE.delete(ref);
      continue;
    }
    try {
      cache.flush();
    } catch {
      // One store's cache failing to write must not stop the others.
    }
  }
}

function installExitHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  // `exit` only, and only synchronous work inside it: this fires on the way
  // out of a stdio server whose stdin just closed, where nothing asynchronous
  // will ever be given a turn. `beforeExit` does not run on an explicit
  // process.exit() and would miss the case this is here for.
  process.on("exit", flushAllIdCaches);
}

export class IdCache<T> {
  readonly #store: string;
  readonly #max: number;
  readonly #dir: string | null;
  #rows = new Map<string, T>();
  #loaded = false;
  #dirty = false;

  constructor(store: string, opts: IdCacheOptions = {}) {
    this.#store = store;
    this.#max = opts.maxRows ?? MAX_ROWS;
    this.#dir = opts.dir ?? null;
    LIVE.add(new WeakRef(this));
    installExitHook();
  }

  #file(): string {
    return join(this.#dir ?? join(stateDir(), "ids"), `${this.#store.replace(/[^a-z0-9]+/gi, "-")}.json`);
  }

  /**
   * Read from disk once, lazily.
   *
   * Lazily because a process that only ever searches never needs it, and
   * paying a file read per adapter at startup would slow the common case to
   * help the rare one.
   */
  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    let parsed: Persisted<T>;
    try {
      parsed = JSON.parse(readFileSync(this.#file(), "utf8")) as Persisted<T>;
    } catch {
      return; // No file, unreadable, or not JSON. All mean "empty cache".
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.rows)) return;
    for (const row of parsed.rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      // The signature check, not a formality: this file is editable by any
      // process running as this user, and an unverified row would let one
      // hand an adapter a native id it never minted.
      const verified = parseProductId(row[0], [this.#store]);
      if (!verified) continue;
      this.#rows.set(row[0], row[1] as T);
    }
  }

  get(id: string): T | undefined {
    this.#load();
    const hit = this.#rows.get(id);
    if (hit === undefined) return undefined;
    // Re-insert so the least recently USED row is the one evicted, not the
    // least recently written: a product looked at repeatedly should survive.
    this.#rows.delete(id);
    this.#rows.set(id, hit);
    return hit;
  }

  set(id: string, value: T): this {
    this.#load();
    this.#rows.delete(id);
    this.#rows.set(id, value);
    while (this.#rows.size > this.#max) {
      const oldest = this.#rows.keys().next().value;
      if (oldest === undefined) break;
      this.#rows.delete(oldest);
    }
    this.#dirty = true;
    this.#schedule();
    return this;
  }

  has(id: string): boolean {
    this.#load();
    return this.#rows.has(id);
  }

  get size(): number {
    this.#load();
    return this.#rows.size;
  }

  #timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Batch writes.
   *
   * One search mints up to a page of ids in a tight loop; writing the whole
   * file per row would turn one search into forty file writes. The timer is
   * unreffed so a stdio server that has finished its work still exits at once
   * -- losing the last few seconds of a cache is not a failure.
   */
  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, 250);
    this.#timer.unref?.();
  }

  /** Write now. Safe to call at any time; a no-op when nothing changed. */
  flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const file = this.#file();
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      const payload: Persisted<T> = { version: 1, store: this.#store, rows: [...this.#rows.entries()] };
      // Sibling then rename: another process reading this file must never see
      // a half-written one, and rename within a directory is atomic.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf8");
      renameSync(tmp, file);
    } catch {
      // A cache that cannot be written is still a working cache in memory.
      // Nothing here is worth failing a search over.
    }
  }
}
