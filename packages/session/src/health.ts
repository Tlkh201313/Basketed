import { isAuxKey, type Vault } from "@basketed/vault";
import type { SessionManager } from "./login.js";

/**
 * The background check that keeps "connected" honest.
 *
 * Every six hours (first pass twenty seconds after boot, so a restart shows
 * fresh pills within a minute), each store that has both a sealed session
 * and a profile directory is probed HEADLESS. Live -> re-sealed, so the vault
 * snapshot follows the profile's renewed tokens. Expired or challenged -> the
 * registry pill flips, and the panel says so. Nothing here ever opens a
 * window: a human's attention is asked for in the panel, never grabbed.
 *
 * Off under `BASKETED_NO_SESSION_CHECK=1` and when the CLI runs on snapshots.
 */

export interface HealthOptions {
  vault: Vault;
  intervalMs?: number;
  initialDelayMs?: number;
  perStoreMs?: number;
  log?: (line: string) => void;
}

export interface HealthScheduler {
  runNow(): Promise<void>;
  stop(): void;
}

export function healthDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BASKETED_NO_SESSION_CHECK === "1";
}

export function startHealthScheduler(sessions: SessionManager, opts: HealthOptions): HealthScheduler {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 20_000;
  const perStoreMs = opts.perStoreMs ?? 90_000;
  const log = opts.log ?? (() => {});
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function pass(): Promise<void> {
    const ids = opts.vault
      .list()
      .filter(
        (c) =>
          !isAuxKey(c.storeId) &&
          !c.broken &&
          sessions.loginFor(c.storeId) &&
          (sessions.hasProfile(c.storeId) || sessions.hasJar(c.storeId)),
      )
      .map((c) => c.storeId);
    for (const id of ids) {
      if (stopped) return;
      const outcome = await Promise.race([
        sessions.checkSession(id).then((h) => h.session_state),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), perStoreMs).unref()),
      ]);
      log(`session: health ${id} -> ${outcome}`);
    }
  }

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void scheduler.runNow().finally(() => schedule(intervalMs));
    }, ms);
    timer.unref();
  };

  const scheduler: HealthScheduler = {
    runNow() {
      if (!running) {
        running = pass()
          .catch((err) => log(`session: health pass failed: ${(err as Error).message}`))
          .finally(() => {
            running = null;
          });
      }
      return running;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };

  schedule(initialDelayMs);
  return scheduler;
}
