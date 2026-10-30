import { dueMarketplaces, probeMarketplace } from './marketplaces.js';
import { harvestAll } from '../plugin/catalog.js';

/**
 * Rescan scheduler for operator git-marketplaces (ADR-0015 §D6).
 *
 * One process-level timer, armed only when at least one source has `rescan.enabled` — an operator
 * who never arms one pays nothing. A tick probes each due source; a probe failure is recorded by
 * simply not moving the snapshot (the next tick retries), while a successful probe appends the diff
 * to the snapshot file. A rescan NEVER touches installed copies: reporting is its whole contract.
 */
export class MarketplaceRescanScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight guard: a slow probe must not stack a second probe of the same source. */
  private running = false;

  constructor(
    private readonly tickIntervalMs = 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // Background scans swallow scheduling errors — the next tick retries.
      });
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const due = dueMarketplaces();
    if (due.length === 0) return;
    this.running = true;
    try {
      let probed = false;
      for (const { entry } of due) {
        await probeMarketplace(entry, this.fetchImpl);
        probed = true;
      }
      // A refreshed snapshot changes catalog rows: every harness's index re-reads it, or sibling
      // tabs keep serving the pre-rescan rows until an unrelated mutation.
      if (probed) harvestAll();
    } finally {
      this.running = false;
    }
  }
}
