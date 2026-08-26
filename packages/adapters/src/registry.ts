import type { SourcingMode, StoreRow, StoreStatus } from "@basketed/core";
import type { StoreAdapter } from "./types.js";
import { overclaimedTiers } from "./types.js";

export interface RegistryFilter {
  country?: string;
  category?: string;
  mode?: SourcingMode;
  connectedOnly?: boolean;
  capabilities?: string[];
}

/**
 * The store registry (§4).
 *
 * Registration is where the honesty constraint is enforced: an adapter whose
 * manifest claims a tier it does not implement is rejected outright rather
 * than logged. A capability list nobody checks is marketing, and this project's
 * entire pitch is that ours is not.
 */
export class StoreRegistry {
  #adapters = new Map<string, StoreAdapter>();
  #status = new Map<string, StoreStatus>();

  register(adapter: StoreAdapter, status: StoreStatus = "ready"): void {
    const overclaimed = overclaimedTiers(adapter);
    if (overclaimed.length) {
      throw new Error(
        `Adapter "${adapter.manifest.id}" claims capabilities it does not implement: ${overclaimed.join(", ")}. ` +
          `An adapter may never claim a tier it fakes.`,
      );
    }
    if (this.#adapters.has(adapter.manifest.id)) {
      throw new Error(`Duplicate store id "${adapter.manifest.id}".`);
    }
    this.#adapters.set(adapter.manifest.id, adapter);
    this.#status.set(adapter.manifest.id, status);
  }

  get(id: string): StoreAdapter | undefined {
    return this.#adapters.get(id);
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  all(): StoreAdapter[] {
    return [...this.#adapters.values()];
  }

  setStatus(id: string, status: StoreStatus): void {
    this.#status.set(id, status);
  }

  /**
   * Rows for list_stores. A store with a missing provider key still appears,
   * flagged `needs_key` -- it never silently vanishes, and it never silently
   * degrades to simulated data. A store's mode does not change behind the
   * user's back.
   */
  list(filter: RegistryFilter = {}): StoreRow[] {
    return this.all()
      .map((a) => ({ ...a.manifest, status: this.#status.get(a.manifest.id) ?? "ready" }))
      .filter((row) => {
        if (filter.country && row.country !== filter.country.toUpperCase()) return false;
        if (filter.category && !row.categories.includes(filter.category as never)) return false;
        if (filter.mode && row.mode !== filter.mode) return false;
        if (filter.connectedOnly && row.status !== "ready") return false;
        if (filter.capabilities?.length) {
          const have = new Set(row.capabilities);
          if (!filter.capabilities.every((c) => have.has(c as never))) return false;
        }
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Adapters that can actually serve a search, honouring an explicit store list. */
  searchable(stores?: string[]): StoreAdapter[] {
    const wanted = stores?.length ? new Set(stores) : null;
    return this.all().filter((a) => {
      if (!a.manifest.capabilities.includes("discovery")) return false;
      if (!wanted) return true;
      // Accept either the full namespaced id or the bare domain/name.
      return wanted.has(a.manifest.id) || (a.manifest.domain ? wanted.has(a.manifest.domain) : false);
    });
  }
}
