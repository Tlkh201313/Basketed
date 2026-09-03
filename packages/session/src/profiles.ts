import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "patchright";
import { DEFAULT_ARGS, HARMFUL_ARGS, STEALTH_ARGS, USER_AGENT } from "@basketed/adapters";

/**
 * One Chromium profile per store, owned by Basketed, kept forever (S23).
 *
 * This is the part that makes a sign-in one-time. The retailer's cookies,
 * local storage and refresh tokens live in `~/.basketed/profiles/<store>`
 * exactly as they would in the shopper's own browser, so the retailer's own
 * frontend renews them the way it always does. The first sign-in happens in a
 * VISIBLE window -- a human is the only thing that gets past a captcha or a
 * one-time code, and we never pretend otherwise. Every later use is headless.
 *
 * Chromium refuses to open the same profile twice (SingletonLock), so each
 * store gets one context at a time and a queue in front of it. A headed
 * request finding a headless context closes it and relaunches headed; a
 * headless request finding a headed one just borrows the window.
 */

export function profilesRoot(): string {
  return process.env.BASKETED_PROFILES ?? join(homedir(), ".basketed", "profiles");
}

export function profileDir(storeId: string): string {
  return join(profilesRoot(), storeId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export interface ProfileHandle {
  context: BrowserContext;
  headed: boolean;
}

interface Slot {
  handle: ProfileHandle | null;
  /** Tail of the per-store queue. */
  tail: Promise<unknown>;
  idleTimer: NodeJS.Timeout | null;
  onClosed: Array<() => void>;
}

export interface OpenOptions {
  headed: boolean;
  /** Called when the human closes the window (or the browser dies). */
  onClosed?: () => void;
}

export interface ProfilesOptions {
  headlessIdleMs?: number;
  log?: (line: string) => void;
}

export class Profiles {
  readonly #slots = new Map<string, Slot>();
  readonly #idleMs: number;
  readonly #log: (line: string) => void;

  constructor(opts: ProfilesOptions = {}) {
    this.#idleMs = opts.headlessIdleMs ?? 120_000;
    this.#log = opts.log ?? (() => {});
  }

  #slot(id: string): Slot {
    let s = this.#slots.get(id);
    if (!s) {
      s = { handle: null, tail: Promise.resolve(), idleTimer: null, onClosed: [] };
      this.#slots.set(id, s);
    }
    return s;
  }

  isOpen(id: string): boolean {
    return this.#slot(id).handle !== null;
  }

  /**
   * A profile is a directory Chromium has actually written to, not merely one
   * that exists: `state.json` alone (a session renewed from its cookie jar,
   * with no browser of ours behind it) is not a profile to drive.
   */
  hasProfile(id: string): boolean {
    const dir = profileDir(id);
    return existsSync(join(dir, "Default")) || existsSync(join(dir, "Local State"));
  }

  /**
   * Run `fn` with the store's context, serialised against every other user
   * of that store. Headless contexts close themselves after `headlessIdleMs`
   * of nobody holding them; headed ones stay until `close` or the human.
   */
  async with<T>(id: string, opts: OpenOptions, fn: (h: ProfileHandle) => Promise<T>): Promise<T> {
    const slot = this.#slot(id);
    const run = slot.tail.then(
      async () => {
        const h = await this.#acquire(id, slot, opts);
        try {
          return await fn(h);
        } finally {
          this.#armIdle(id, slot);
        }
      },
      async () => {
        const h = await this.#acquire(id, slot, opts);
        try {
          return await fn(h);
        } finally {
          this.#armIdle(id, slot);
        }
      },
    );
    slot.tail = run.catch(() => {});
    return run;
  }

  /** Acquire without queueing behind anyone -- used by the login loop, which holds the window for minutes. */
  async open(id: string, opts: OpenOptions): Promise<ProfileHandle> {
    const slot = this.#slot(id);
    const h = await this.#acquire(id, slot, opts);
    if (opts.onClosed) slot.onClosed.push(opts.onClosed);
    return h;
  }

  async #acquire(id: string, slot: Slot, opts: OpenOptions): Promise<ProfileHandle> {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    if (slot.handle) {
      if (opts.headed && !slot.handle.headed) {
        await this.#close(id, slot);
      } else {
        return slot.handle;
      }
    }
    const dir = profileDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* Windows: advisory */
    }
    const headed = opts.headed;
    this.#log(`session: launch ${id} ${headed ? "headed" : "headless"}`);
    const context = await chromium.launchPersistentContext(dir, {
      headless: !headed,
      channel: "chromium",
      args: [...DEFAULT_ARGS, ...STEALTH_ARGS],
      ignoreDefaultArgs: HARMFUL_ARGS,
      userAgent: USER_AGENT,
      viewport: headed ? null : { width: 1440, height: 900 },
      locale: "en-US",
      serviceWorkers: "allow",
    });
    const handle: ProfileHandle = { context, headed };
    slot.handle = handle;
    context.on("close", () => {
      if (slot.handle === handle) {
        slot.handle = null;
        const fns = slot.onClosed.splice(0);
        for (const fn of fns) {
          try {
            fn();
          } catch {
            /* observer */
          }
        }
      }
    });
    return handle;
  }

  #armIdle(id: string, slot: Slot): void {
    if (!slot.handle || slot.handle.headed) return;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      void this.#close(id, slot);
    }, this.#idleMs);
    slot.idleTimer.unref();
  }

  async #close(id: string, slot: Slot): Promise<void> {
    const h = slot.handle;
    if (!h) return;
    slot.handle = null;
    slot.onClosed.splice(0);
    this.#log(`session: close ${id}`);
    try {
      await h.context.close();
    } catch {
      /* already gone */
    }
  }

  async close(id: string): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot) return;
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    await this.#close(id, slot);
  }

  /** Close the context and delete the directory. The sealed vault copy is the caller's to forget. */
  async destroy(id: string): Promise<boolean> {
    await this.close(id);
    const dir = profileDir(id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#slots.keys()].map((id) => this.close(id)));
  }
}
