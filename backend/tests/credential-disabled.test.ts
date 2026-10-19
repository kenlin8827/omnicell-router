import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore, suspectCredentialId } from '../src/resilience/credential-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { selectCredential } from '../src/pipeline/credential-selection.js';
import type { CallCredential } from '../src/providers/base.js';
import type { ModelRegistration } from '../src/config/types.js';

/**
 * Operator takedown (DISABLED) — the durable, reversible, non-destructive lever
 * between a temporary breaker trip and deleting the key.
 *
 * What is under test is the LIFECYCLE difference from SUSPECT: set only by an
 * operator, cleared only by an operator. Cooldown expiry, a breaker reset and
 * every reconnect/Push gesture must leave it in place — a routine credential
 * write silently restoring a deliberate takedown is the failure this design
 * exists to avoid. Enforcement is asserted through the shared out-of-service
 * predicate the router reads (`isPairOut`), so no consumer can skip it by
 * reimplementing the rule.
 */

function tmpPaths(tag: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-disabled-${tag}-`));
  return {
    configDir: path.join(dir, 'config'),
    dataDir: path.join(dir, 'data'),
    authJsonPath: path.join(dir, 'data', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'installed.version'),
    ocrHome: dir,
  };
}

const model = { id: 'anthropic/claude-x', provider: 'anthropic' } as unknown as ModelRegistration;

function managerWith(store: CredentialStateStore): CircuitBreakerManager {
  const cb = new CircuitBreakerManager({}, () => 1, store);
  cb.registerModel(model as never);
  cb.registerModel({ id: 'anthropic/claude-y', provider: 'anthropic' } as never);
  return cb;
}

function chain(...prefixes: string[]): CallCredential[] {
  return prefixes.map((keyHashPrefix) => ({ keyHashPrefix, label: `acct-${keyHashPrefix}`, key: `raw-${keyHashPrefix}` }));
}

describe('CredentialStateStore — disabled limb', () => {
  it('disable / isDisabled / enable round-trip and persists to the state file', () => {
    const paths = tmpPaths('roundtrip');
    const store = new CredentialStateStore({ paths, now: () => 1000 });
    expect(store.isDisabled('anthropic', 'a1')).toBe(false);

    expect(store.disable('anthropic', 'a1', 'quota burned')).toBe(true);
    expect(store.isDisabled('anthropic', 'a1')).toBe(true);
    expect(store.getDisabled('anthropic', 'a1')?.reason).toBe('quota burned');

    // The file is the durable part: a fresh store over the same paths must see it.
    const reloaded = new CredentialStateStore({ paths, now: () => 2000 });
    expect(reloaded.isDisabled('anthropic', 'a1')).toBe(true);

    expect(reloaded.enable('anthropic', 'a1')).toBe(true);
    expect(reloaded.isDisabled('anthropic', 'a1')).toBe(false);
    expect(reloaded.enable('anthropic', 'a1')).toBe(false); // nothing to lift
  });

  it('is keyed by (provider, keyHash) — the same key under two providers is two flags', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('two-providers'), now: () => 1 });
    store.disable('anthropic', 'shared', '');
    expect(store.isDisabled('anthropic', 'shared')).toBe(true);
    expect(store.isDisabled('openai', 'shared')).toBe(false);
  });

  it('is INDEPENDENT of suspect: clearing suspect never lifts a takedown, and vice versa', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('independent'), now: () => 1 });
    store.mark('anthropic', 'k1', '401 confirmed-bad');
    store.disable('anthropic', 'k1', 'operator parked it');

    // The reconnect / Push gesture clears SUSPECT only.
    store.clear('anthropic', 'k1');
    expect(store.isSuspect('anthropic', 'k1')).toBe(false);
    expect(store.isDisabled('anthropic', 'k1')).toBe(true);

    // And the other direction.
    store.mark('anthropic', 'k1', '401 again');
    store.enable('anthropic', 'k1');
    expect(store.isDisabled('anthropic', 'k1')).toBe(false);
    expect(store.isSuspect('anthropic', 'k1')).toBe(true);
  });

  it('a file without the disabled section loads clean, and the section is written only when used', () => {
    const paths = tmpPaths('legacy');
    const file = path.join(paths.ocrHome, 'suspect-credentials.json');
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        credentials: {
          [suspectCredentialId('anthropic', 'old')]: { providerId: 'anthropic', keyHashPrefix: 'old', reason: 'legacy', markedAt: 5 },
        },
      })
    );
    const store = new CredentialStateStore({ paths, now: () => 9 });
    expect(store.isSuspect('anthropic', 'old')).toBe(true);
    expect(store.listDisabled()).toEqual([]);

    // No takedown -> no `disabled` key at all, so an older reader parses unchanged.
    store.mark('anthropic', 'fresh', 'x');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).disabled).toBeUndefined();

    store.disable('anthropic', 'fresh', '');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).disabled).toBeDefined();
  });
});

describe('isPairOut — the shared out-of-service gate', () => {
  it('a disabled credential is out for EVERY model of its provider, no breaker involved', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('cb-all'), now: () => 1 });
    store.disable('anthropic', 'k1', '');
    const cb = managerWith(store);

    expect(cb.isPairOut('anthropic/claude-x', 'k1')).toBe(true);
    expect(cb.isPairOut('anthropic/claude-y', 'k1')).toBe(true);
    // Availability aggregates over the chain: one live prefix keeps the model up.
    expect(cb.modelAvailability('anthropic/claude-x', ['k1', 'k2']).available).toBe(true);
    expect(cb.modelAvailability('anthropic/claude-x', ['k1']).available).toBe(false);
  });

  it('a cooldown reset does NOT bring a taken-down credential back', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('cb-reset'), now: () => 1 });
    const cb = managerWith(store);
    cb.tripPair('anthropic/claude-x', 'k1', { cooldownMs: 1000 }, 'anthropic');
    store.disable('anthropic', 'k1', '');

    cb.resetScoped('anthropic/claude-x', 'k1');
    expect(cb.getPairBreaker('anthropic/claude-x', 'k1')?.getState()).toBe('CLOSED');
    expect(cb.isPairOut('anthropic/claude-x', 'k1')).toBe(true);
  });
});

describe('selectCredential — takedown is absolute, failover is not', () => {
  const ctx = { sessionId: 's-1', now: () => 1 };

  it('spreads new sessions only over live credentials', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('sel-spread'), now: () => 1 });
    store.disable('anthropic', 'k2', '');
    const cb = managerWith(store);
    for (let i = 0; i < 24; i++) {
      const sel = selectCredential(undefined, model, chain('k1', 'k2', 'k3'), cb, { ...ctx, sessionId: `s-${i}` });
      expect(sel.credential?.keyHashPrefix).not.toBe('k2');
    }
  });

  it('forces a session bound to a now-disabled credential onto a live one', () => {
    const store = new CredentialStateStore({ paths: tmpPaths('sel-bound'), now: () => 1 });
    store.disable('anthropic', 'k1', '');
    const cb = managerWith(store);
    const bound = { boundKeyHashPrefix: 'k1', lastActiveAt: 1 } as never;
    const sel = selectCredential(bound, model, chain('k1', 'k2'), cb, ctx);
    expect(sel.credential?.keyHashPrefix).toBe('k2');
    expect(sel.forcedMove).toBe(true);
    expect(sel.bind).toEqual({ keyHashPrefix: 'k2', forced: true });
  });

  it('single-credential degeneracy does NOT bypass the takedown', () => {
    // That path serves the boot-baked key with no selector: returning
    // 'single-credential' here would route traffic the operator just parked.
    const store = new CredentialStateStore({ paths: tmpPaths('sel-single'), now: () => 1 });
    store.disable('anthropic', 'only', '');
    const cb = managerWith(store);
    const sel = selectCredential(undefined, model, chain('only'), cb, ctx);
    expect(sel.credential).toBeUndefined();
    expect(sel.reason).toBe('all-disabled');
  });

  it("'all-unhealthy' (a health guess) still forces; 'all-disabled' (a decision) never does", () => {
    const live = managerWith(new CredentialStateStore({ paths: tmpPaths('sel-unhealthy'), now: () => 1 }));
    live.tripPair('anthropic/claude-x', 'k1', { cooldownMs: 60000 }, 'anthropic');
    live.tripPair('anthropic/claude-x', 'k2', { cooldownMs: 60000 }, 'anthropic');
    expect(selectCredential(undefined, model, chain('k1', 'k2'), live, ctx).reason).toBe('all-unhealthy');

    const store = new CredentialStateStore({ paths: tmpPaths('sel-ald'), now: () => 1 });
    store.disable('anthropic', 'k1', '');
    store.disable('anthropic', 'k2', '');
    const off = managerWith(store);
    expect(selectCredential(undefined, model, chain('k1', 'k2'), off, ctx).reason).toBe('all-disabled');
  });
});
