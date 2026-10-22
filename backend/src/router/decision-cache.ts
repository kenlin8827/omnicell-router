import { createHash } from 'node:crypto';
import { ReasonParams } from '../types/router.js';

export interface RoutingDecisionCacheEntry {
  targetTier: string;
  confidence: number;
  reason: string;
  reasonCode: string;
  reasonParams?: ReasonParams;
  /**
   * L2-decided effort answer (ADR-0012) — present only on entries
   * recorded while `effortDecision` was on AND the client omitted the
   * field. The cache key namespace splits on that flag, so an entry
   * recorded under one mode is never served under the other.
   */
  effort?: string;
  effortConfidence?: number;
  cachedAt: number;
  hits: number;
}

export interface RoutingCacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  ttlSeconds: number;
  hits: number;
  misses: number;
  hitRatio: number;
}

interface DecisionCacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

const DEFAULTS: DecisionCacheConfig = { enabled: true, ttlSeconds: 1800, maxEntries: 500 };

/**
 * LRU+TTL cache for Layer 2 decision layer decisions.
 * Key = provider::model::sha256(userText). Only successful decisions are
 * stored; a hit skips the external decision layer call (network + token cost).
 * A stale/wrong hit degrades routing quality at worst — it can never
 * contaminate response content (unlike the response cache banned earlier).
 */
export class RoutingDecisionCache {
  private entries = new Map<string, RoutingDecisionCacheEntry>(); // Map iteration order = LRU order
  private hits = 0;
  private misses = 0;
  private config: DecisionCacheConfig;

  constructor(config?: Partial<DecisionCacheConfig>) {
    this.config = {
      enabled: config?.enabled ?? DEFAULTS.enabled,
      ttlSeconds: config?.ttlSeconds ?? DEFAULTS.ttlSeconds,
      maxEntries: config?.maxEntries ?? DEFAULTS.maxEntries,
    };
  }

  /**
   * Hot-apply console knob changes (enabled/ttl/maxEntries). Existing entries
   * survive: TTL is read live per get, maxEntries re-enforces on the next
   * set, and disabling just mutes get/set without destroying the map.
   */
  public applyConfig(config?: Partial<DecisionCacheConfig>): void {
    this.config = {
      enabled: config?.enabled ?? DEFAULTS.enabled,
      ttlSeconds: config?.ttlSeconds ?? DEFAULTS.ttlSeconds,
      maxEntries: config?.maxEntries ?? DEFAULTS.maxEntries,
    };
  }

  public static buildCacheKey(provider: string, model: string, userText: string): string {
    const digest = createHash('sha256').update(userText).digest('hex');
    return `${provider}::${model}::${digest}`;
  }

  public get(key: string): RoutingDecisionCacheEntry | null {
    if (!this.config.enabled) return null;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.cachedAt >= this.config.ttlSeconds * 1000) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }
    // Refresh LRU position + count
    this.entries.delete(key);
    entry.hits++;
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  public set(key: string, value: { targetTier: string; confidence: number; reason: string; reasonCode: string; reasonParams?: ReasonParams; effort?: string; effortConfidence?: number }): void {
    if (!this.config.enabled) return;
    while (this.entries.size >= this.config.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { ...value, cachedAt: Date.now(), hits: 0 });
  }

  public getStats(): RoutingCacheStats {
    const total = this.hits + this.misses;
    return {
      enabled: this.config.enabled,
      entries: this.entries.size,
      maxEntries: this.config.maxEntries,
      ttlSeconds: this.config.ttlSeconds,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? this.hits / total : 0,
    };
  }

  public clear(): void {
    this.entries.clear();
  }
}
