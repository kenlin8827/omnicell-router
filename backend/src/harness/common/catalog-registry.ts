import type { HarnessHostId, HarnessKind, HarnessSourceView, TrustTier } from '../types.js';
import { registerBrowseView } from './market.js';
import type { BrowseResult } from './market.js';

/**
 * Definition of a catalog source registration (ADR-0015).
 * Declares a built-in or native marketplace catalog bound to a harness or cross-harness.
 */
export interface CatalogRegistration {
  /** Target harness runtime, or undefined for cross-harness sources (e.g. skills). */
  harness?: HarnessHostId;
  /** Unique source identifier, e.g. 'pi-dev', 'clawhub'. */
  id: string;
  /** Showcase catalog grouping ('pi.dev', 'default', 'enterprise', etc.). */
  catalog: string;
  /** Display label for the source. */
  label: string;
  /** Kinds of artifacts this source offers ('plugin' | 'skill'). */
  kinds: readonly HarnessKind[];
  /** Trust tier ('official' | 'community' | 'local'). */
  trust: TrustTier;
  /** Authentication requirements. */
  auth?: 'none' | 'oidc';
  /** Whether the source is enabled. */
  enabled?: boolean;
  /** Whether the source supports live remote browsing. */
  browsable?: boolean;
  /** Compatible host harness ids (defaults to [harness] if harness is provided). */
  hosts?: readonly HarnessHostId[];
  /** Upstream sort orderings supported. */
  sorts?: readonly string[];
  /** Remote catalog browse function. */
  browse?: (q: string, limit?: number, page?: number, sort?: string, fetchImpl?: typeof fetch) => Promise<BrowseResult>;
  /** Whether this is a built-in official registry. */
  builtin?: boolean;
}

/**
 * Catalog Registry for managing built-in and native harness catalogs.
 */
export class CatalogRegistry {
  private registrations = new Map<string, CatalogRegistration>();

  /**
   * Register a catalog source.
   * Automatically synchronizes with the browse views registry.
   */
  register(entry: CatalogRegistration): void {
    const view: HarnessSourceView = {
      id: entry.id,
      catalog: entry.catalog,
      label: entry.label,
      kinds: [...entry.kinds],
      trust: entry.trust,
      auth: entry.auth ?? 'none',
      enabled: entry.enabled ?? true,
      browsable: entry.browsable ?? true,
      hosts: entry.hosts ? [...entry.hosts] : entry.harness ? [entry.harness] : undefined,
      sorts: entry.sorts ? [...entry.sorts] : undefined,
      browse: entry.browse,
    };
    this.registrations.set(entry.id, {
      ...entry,
      auth: entry.auth ?? 'none',
      enabled: entry.enabled ?? true,
      browsable: entry.browsable ?? true,
      hosts: view.hosts,
    });
    registerBrowseView(view);
  }

  /** Retrieve a registered source by its unique ID. */
  get(id: string): CatalogRegistration | undefined {
    return this.registrations.get(id);
  }

  /**
   * List registered sources matching the optional harness and kind filter.
   */
  list(harness?: HarnessHostId, kind?: HarnessKind): CatalogRegistration[] {
    return [...this.registrations.values()].filter((reg) => {
      if (kind && !reg.kinds.includes(kind)) return false;
      if (harness) {
        if (reg.hosts && !reg.hosts.includes(harness)) return false;
        if (reg.harness && reg.harness !== harness) return false;
      }
      return true;
    });
  }

  /**
   * Get distinct catalog groupings available for a given harness and kind.
   */
  getCatalogs(harness?: HarnessHostId, kind?: HarnessKind): { id: string; label: string; isOfficial?: boolean }[] {
    const sources = this.list(harness, kind);
    const catalogs = new Map<string, { id: string; label: string; isOfficial?: boolean }>();
    for (const s of sources) {
      if (!catalogs.has(s.catalog)) {
        catalogs.set(s.catalog, {
          id: s.catalog,
          label: s.catalog === s.id ? s.label : s.catalog,
          isOfficial: s.trust === 'official',
        });
      }
    }
    return [...catalogs.values()];
  }

  /** Clear all registrations (for testing). */
  clear(): void {
    this.registrations.clear();
  }
}

/** Global catalog registry singleton. */
export const catalogRegistry = new CatalogRegistry();
