import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountSpreadIndex,
  DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS,
  selectAccount,
} from '../src/pipeline/account-selection.js';
import { CircuitBreakerManager } from '../src/resilience/index.js';
import { AccountStateStore } from '../src/resilience/account-state.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { CallCredential } from '../src/providers/base.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { ConversationSession } from '../src/session/session-manager.js';

/**
 * Decision 7 selection-rule table (unit, no net).
 * Every case pins ONE rule of the resolver; the orchestrator test file covers
 * the wiring (persist-on-success, self-heal continuity, gate passthrough).
 */

const PROVIDER = 'anthropic';
const MODEL: ModelRegistration = {
  id: 'anthropic/claude-test',
  provider: PROVIDER,
  upstreamModel: 'claude-test',
  tier: 'plus',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};

const cred = (key: string, label: string): CallCredential => ({
  key,
  keyHashPrefix: keyHashPrefix(key),
  label,
});
const chain = [cred('sk-sel-one', 'one'), cred('sk-sel-two', 'two'), cred('sk-sel-three', 'three')];

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sel-'));
  return {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
  };
}

function makeManager(): CircuitBreakerManager {
  const mgr = new CircuitBreakerManager(
    { enabled: true, failureThreshold: 1000, initialCooldownMs: 600000 },
    Date.now,
    new AccountStateStore({ paths: sandboxPaths() })
  );
  mgr.registerModel(MODEL);
  return mgr;
}

const session = (id: string, over: Partial<ConversationSession> = {}): ConversationSession => ({
  id,
  maxTier: 'plus',
  pinnedModel: MODEL.id,
  pinnedProvider: PROVIDER,
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  turnCount: 1,
  historyTiers: ['plus'],
  ...over,
});

/** Trip one pair of the model (manual trip = OPEN with cooldown). */
function trip(cb: CircuitBreakerManager, prefix: string): void {
  cb.tripPair(MODEL.id, prefix, { cooldownMs: 600000 }, PROVIDER);
}

describe('chain degeneracy (byte-identical legacy path)', () => {
  it('single-credential chain -> undefined + reason, never a prefix', () => {
    const cb = makeManager();
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain.slice(0, 1), cb, {
      sessionId: 's1',
    });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('single-credential');
    expect(sel.bind).toBeUndefined();
  });

  it('no chain at all -> undefined + no-chain reason', () => {
    const cb = makeManager();
    const sel = selectAccount(session('s1'), MODEL, undefined, cb, { sessionId: 's1' });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('no-chain');
  });
});

describe('keep-when-healthy / no rebalancing', () => {
  it('bound account is kept even though it is NOT the active head', () => {
    const cb = makeManager();
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    expect(sel.forcedMove).toBe(false);
    expect(sel.bind).toBeUndefined();
  });

  it('reordering the chain (active head moves onto the binding) changes nothing', () => {
    const cb = makeManager();
    const reordered = [chain[1], chain[0], chain[2]];
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, reordered, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    expect(sel.bind).toBeUndefined();
  });

  it('least-used rebalancing is banned: head being freshly healthy does not pull the session', () => {
    const cb = makeManager();
    trip(cb, chain[0].keyHashPrefix); // head tripped — session (bound to two) keeps two
    trip(cb, chain[0].keyHashPrefix); // reset later: head recovery must not switch back
    cb.resetScoped(MODEL.id, chain[0].keyHashPrefix);
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
  });
});

describe('FORCED failover (bound account is out)', () => {
  it('OPEN bound pair breaker -> first healthy in chain order, forced rebind, forcedMove', () => {
    const cb = makeManager();
    trip(cb, chain[1].keyHashPrefix);
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[0].keyHashPrefix); // active head first
    expect(sel.bind).toEqual({ keyHashPrefix: chain[0].keyHashPrefix, forced: true });
    expect(sel.forcedMove).toBe(true);
  });

  it('SUSPECT bound account -> forced move too (administrative state is OUT, not cooldown)', () => {
    const cb = makeManager();
    cb.getAccountStateStore().mark(PROVIDER, chain[0].keyHashPrefix, 'confirmed-bad key');
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    expect(sel.bind?.forced).toBe(true);
    expect(sel.forcedMove).toBe(true);
  });

  it('never switches back after the old account recovers (no switch-back logic exists)', () => {
    const cb = makeManager();
    // K1 was bound, tripped, moved to K2 (simulating the persisted rebind):
    trip(cb, chain[0].keyHashPrefix);
    const moved = selectAccount(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(moved.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    cb.resetScoped(MODEL.id, chain[0].keyHashPrefix); // old account fully recovered
    const after = selectAccount(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(after.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix); // stays on K2
    expect(after.bind).toBeUndefined();
    expect(after.forcedMove).toBe(false);
  });
});

describe('absent / expired / stale binding -> new-session spread', () => {
  it('deterministic: same sessionId re-spreads to the same account across calls and managers', () => {
    const cb1 = makeManager();
    const cb2 = makeManager();
    const a = selectAccount(session('sess-42'), MODEL, chain, cb1, { sessionId: 'sess-42' });
    const b = selectAccount(session('sess-42'), MODEL, chain, cb2, { sessionId: 'sess-42' });
    expect(a.credential?.keyHashPrefix).toBe(chain[accountSpreadIndex('sess-42', 3)].keyHashPrefix);
    expect(b.credential?.keyHashPrefix).toBe(a.credential?.keyHashPrefix);
    expect(a.bind).toEqual({ keyHashPrefix: a.credential!.keyHashPrefix, forced: false });
    expect(a.forcedMove).toBe(false);
  });

  it('spreads ACROSS sessions (hash indexes the healthy pool, cold prefix = nothing to lose)', () => {
    const cb = makeManager();
    const picks = new Set<string>();
    for (const id of ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g', 's-h']) {
      const sel = selectAccount(session(id), MODEL, chain, cb, { sessionId: id });
      picks.add(sel.credential!.keyHashPrefix);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('TTL-idle binding (window config) is treated ABSENT and rebound FORCED', () => {
    const cb = makeManager();
    const window = DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS;
    const s = session('s1', {
      boundKeyHashPrefix: chain[2].keyHashPrefix,
      lastActiveAt: 1_000_000,
    });
    // Inside the window: kept even though it is NOT the spread pick (no rebalance).
    const inside = selectAccount(s, MODEL, chain, cb, { sessionId: 's1', now: () => 1_000_000 + window - 1 });
    expect(inside.credential?.keyHashPrefix).toBe(chain[2].keyHashPrefix);
    // One ms past the window: re-select as if new, forced overwrite of the stale value.
    const idle = selectAccount(s, MODEL, chain, cb, { sessionId: 's1', now: () => 1_000_000 + window + 1 });
    expect(idle.credential?.keyHashPrefix).toBe(chain[accountSpreadIndex('s1', 3)].keyHashPrefix);
    expect(idle.bind).toEqual({ keyHashPrefix: idle.credential!.keyHashPrefix, forced: true });
    expect(idle.forcedMove).toBe(false); // the cache was gone — this is not a failover move
  });

  it('stale binding (prefix unknown to this boot chain) recovers at the selection boundary', () => {
    const cb = makeManager();
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: 'f'.repeat(12) }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.forcedMove).toBe(false);
    expect(chain.some((c) => c.keyHashPrefix === sel.credential?.keyHashPrefix)).toBe(true);
    expect(sel.bind).toEqual({ keyHashPrefix: sel.credential!.keyHashPrefix, forced: true });
  });
});

describe('pool exhaustion and suspect skipping', () => {
  it('all prefixes out -> undefined + all-unhealthy reason, NO bind (caller forces legacy)', () => {
    const cb = makeManager();
    for (const c of chain) trip(cb, c.keyHashPrefix);
    const sel = selectAccount(session('s1'), MODEL, chain, cb, { sessionId: 's1' });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('all-unhealthy');
    expect(sel.bind).toBeUndefined();
  });

  it('all out while BOUND: same undefined + reason (no move, legacy force applies)', () => {
    const cb = makeManager();
    for (const c of chain) cb.getAccountStateStore().mark(PROVIDER, c.keyHashPrefix, 'bad');
    const sel = selectAccount(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('all-unhealthy');
    expect(sel.forcedMove).toBe(false);
  });

  it('suspect account never enters the spread pool', () => {
    const cb = makeManager();
    cb.getAccountStateStore().mark(PROVIDER, chain[0].keyHashPrefix, 'dead key');
    for (const id of ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-7', 's-8', 's-9', 's-10', 's-11', 's-12']) {
      const sel = selectAccount(session(id), MODEL, chain, cb, { sessionId: id });
      expect(sel.credential?.keyHashPrefix).not.toBe(chain[0].keyHashPrefix);
    }
    // and the spread indexes the FILTERED pool (2 healthy, not the 3-entry chain)
    const sel = selectAccount(session('s-1'), MODEL, chain, cb, { sessionId: 's-1' });
    expect(sel.credential?.keyHashPrefix).toBe([chain[1], chain[2]][accountSpreadIndex('s-1', 2)].keyHashPrefix);
  });
});
