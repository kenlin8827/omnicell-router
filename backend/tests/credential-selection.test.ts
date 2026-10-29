import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialSpreadIndex,
  weightedSpreadIndex,
  DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS,
  selectCredential,
} from '../src/pipeline/credential-selection.js';
import { CircuitBreakerManager } from '../src/resilience/index.js';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
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
    new CredentialStateStore({ paths: sandboxPaths() })
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
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain.slice(0, 1), cb, {
      sessionId: 's1',
    });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('single-credential');
    expect(sel.bind).toBeUndefined();
  });

  it('no chain at all -> undefined + no-chain reason', () => {
    const cb = makeManager();
    const sel = selectCredential(session('s1'), MODEL, undefined, cb, { sessionId: 's1' });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('no-chain');
  });
});

describe('keep-when-healthy / no rebalancing', () => {
  it('bound credential is kept even though it is NOT the active head', () => {
    const cb = makeManager();
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    expect(sel.forcedMove).toBe(false);
    expect(sel.bind).toBeUndefined();
  });

  it('reordering the chain (active head moves onto the binding) changes nothing', () => {
    const cb = makeManager();
    const reordered = [chain[1], chain[0], chain[2]];
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, reordered, cb, {
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
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
  });
});

describe('FORCED failover (bound credential is out)', () => {
  it('OPEN bound pair breaker -> first healthy in chain order, forced rebind, forcedMove', () => {
    const cb = makeManager();
    trip(cb, chain[1].keyHashPrefix);
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[0].keyHashPrefix); // active head first
    expect(sel.bind).toEqual({ keyHashPrefix: chain[0].keyHashPrefix, forced: true });
    expect(sel.forcedMove).toBe(true);
  });

  it('SUSPECT bound credential -> forced move too (administrative state is OUT, not cooldown)', () => {
    const cb = makeManager();
    cb.getCredentialStateStore().mark(PROVIDER, chain[0].keyHashPrefix, 'confirmed-bad key');
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    expect(sel.bind?.forced).toBe(true);
    expect(sel.forcedMove).toBe(true);
  });

  it('never switches back after the old credential recovers (no switch-back logic exists)', () => {
    const cb = makeManager();
    // K1 was bound, tripped, moved to K2 (simulating the persisted rebind):
    trip(cb, chain[0].keyHashPrefix);
    const moved = selectCredential(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(moved.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
    cb.resetScoped(MODEL.id, chain[0].keyHashPrefix); // old credential fully recovered
    const after = selectCredential(session('s1', { boundKeyHashPrefix: chain[1].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(after.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix); // stays on K2
    expect(after.bind).toBeUndefined();
    expect(after.forcedMove).toBe(false);
  });
});

describe('absent / expired / stale binding -> new-session spread', () => {
  it('deterministic: same sessionId re-spreads to the same credential across calls and managers', () => {
    const cb1 = makeManager();
    const cb2 = makeManager();
    const a = selectCredential(session('sess-42'), MODEL, chain, cb1, { sessionId: 'sess-42' });
    const b = selectCredential(session('sess-42'), MODEL, chain, cb2, { sessionId: 'sess-42' });
    expect(a.credential?.keyHashPrefix).toBe(chain[credentialSpreadIndex('sess-42', 3)].keyHashPrefix);
    expect(b.credential?.keyHashPrefix).toBe(a.credential?.keyHashPrefix);
    expect(a.bind).toEqual({ keyHashPrefix: a.credential!.keyHashPrefix, forced: false });
    expect(a.forcedMove).toBe(false);
  });

  it('spreads ACROSS sessions (hash indexes the healthy pool, cold prefix = nothing to lose)', () => {
    const cb = makeManager();
    const picks = new Set<string>();
    for (const id of ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g', 's-h']) {
      const sel = selectCredential(session(id), MODEL, chain, cb, { sessionId: id });
      picks.add(sel.credential!.keyHashPrefix);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('TTL-idle binding (window config) is treated ABSENT and rebound FORCED', () => {
    const cb = makeManager();
    const window = DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS;
    const s = session('s1', {
      boundKeyHashPrefix: chain[2].keyHashPrefix,
      lastActiveAt: 1_000_000,
    });
    // Inside the window: kept even though it is NOT the spread pick (no rebalance).
    const inside = selectCredential(s, MODEL, chain, cb, { sessionId: 's1', now: () => 1_000_000 + window - 1 });
    expect(inside.credential?.keyHashPrefix).toBe(chain[2].keyHashPrefix);
    // One ms past the window: re-select as if new, forced overwrite of the stale value.
    const idle = selectCredential(s, MODEL, chain, cb, { sessionId: 's1', now: () => 1_000_000 + window + 1 });
    expect(idle.credential?.keyHashPrefix).toBe(chain[credentialSpreadIndex('s1', 3)].keyHashPrefix);
    expect(idle.bind).toEqual({ keyHashPrefix: idle.credential!.keyHashPrefix, forced: true });
    expect(idle.forcedMove).toBe(false); // the cache was gone — this is not a failover move
  });

  it('stale binding (prefix unknown to this boot chain) recovers at the selection boundary', () => {
    const cb = makeManager();
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: 'f'.repeat(12) }), MODEL, chain, cb, {
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
    const sel = selectCredential(session('s1'), MODEL, chain, cb, { sessionId: 's1' });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('all-unhealthy');
    expect(sel.bind).toBeUndefined();
  });

  it('all out while BOUND: same undefined + reason (no move, legacy force applies)', () => {
    const cb = makeManager();
    for (const c of chain) cb.getCredentialStateStore().mark(PROVIDER, c.keyHashPrefix, 'bad');
    const sel = selectCredential(session('s1', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's1',
    });
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('all-unhealthy');
    expect(sel.forcedMove).toBe(false);
  });

  it('suspect credential never enters the spread pool', () => {
    const cb = makeManager();
    cb.getCredentialStateStore().mark(PROVIDER, chain[0].keyHashPrefix, 'dead key');
    for (const id of ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-7', 's-8', 's-9', 's-10', 's-11', 's-12']) {
      const sel = selectCredential(session(id), MODEL, chain, cb, { sessionId: id });
      expect(sel.credential?.keyHashPrefix).not.toBe(chain[0].keyHashPrefix);
    }
    // and the spread indexes the FILTERED pool (2 healthy, not the 3-entry chain)
    const sel = selectCredential(session('s-1'), MODEL, chain, cb, { sessionId: 's-1' });
    expect(sel.credential?.keyHashPrefix).toBe([chain[1], chain[2]][credentialSpreadIndex('s-1', 2)].keyHashPrefix);
  });
});

describe('weighted new-session spread', () => {
  const wchain: CallCredential[] = [
    { ...cred('sk-w-a', 'a'), weight: 3 },
    { ...cred('sk-w-b', 'b'), weight: 1 },
  ];

  it('uniform weights agree with the unweighted spread exactly (back-compat)', () => {
    for (const id of ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6', 'u-7', 'u-8']) {
      expect(weightedSpreadIndex(id, [1, 1, 1])).toBe(credentialSpreadIndex(id, 3));
    }
    // and a 2-entry pool agrees with the resolver's pre-weight landing
    for (const id of ['u-9', 'u-10', 'u-11']) {
      expect(weightedSpreadIndex(id, [1, 1])).toBe(credentialSpreadIndex(id, 2));
    }
  });

  it('weight w occupies w consecutive slots: [3,1] maps slots 0-2 → index 0, slot 3 → index 1', () => {
    const ids = Array.from({ length: 64 }, (_, i) => `slot-${i}`);
    for (const id of ids) {
      const idx = weightedSpreadIndex(id, [3, 1]);
      expect(idx === 0 || idx === 1).toBe(true);
      // determinism: same id, same answer
      expect(weightedSpreadIndex(id, [3, 1])).toBe(idx);
    }
    // proportionality smoke over the same id set: 3:1 lands near 75% (hash
    // uniformity, tolerance generous enough to never flake)
    const heavy = ids.filter((id) => weightedSpreadIndex(id, [3, 1]) === 0).length;
    expect(heavy / ids.length).toBeGreaterThan(0.55);
    expect(heavy / ids.length).toBeLessThan(0.9);
  });

  it('selectCredential lands on the weighted slot and binds non-forced', () => {
    const cb = makeManager();
    const sel = selectCredential(session('w-sess'), MODEL, wchain, cb, { sessionId: 'w-sess' });
    expect(sel.credential?.keyHashPrefix).toBe(wchain[weightedSpreadIndex('w-sess', [3, 1])].keyHashPrefix);
    expect(sel.bind).toEqual({ keyHashPrefix: sel.credential!.keyHashPrefix, forced: false });
    expect(sel.forcedMove).toBe(false);
  });

  it('forced-failover landing ignores weights — chain order outranks the heavy row', () => {
    const cb = makeManager();
    // heavy row (weight 3) is the bound-and-bad one; the landing must be the
    // chain head (weight 1), never the weighted favorite.
    const heavyBad: CallCredential[] = [
      { ...cred('sk-w-light', 'light'), weight: 1 },
      { ...cred('sk-w-heavy', 'heavy'), weight: 3 },
    ];
    cb.getCredentialStateStore().mark(PROVIDER, heavyBad[1].keyHashPrefix, 'dead key');
    const sel = selectCredential(
      session('w-fail', { boundKeyHashPrefix: heavyBad[1].keyHashPrefix }),
      MODEL,
      heavyBad,
      cb,
      { sessionId: 'w-fail' }
    );
    expect(sel.credential?.keyHashPrefix).toBe(heavyBad[0].keyHashPrefix);
    expect(sel.forcedMove).toBe(true);
  });
});
