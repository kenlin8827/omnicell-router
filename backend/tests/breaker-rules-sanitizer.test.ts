import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { loadConfig, defaultConfigYaml } from '../src/config/index.js';
import { resolveBreakerRules } from '../src/resilience/index.js';
import {
  BreakerStateStore,
  DEFAULT_BREAKER_PERSIST_DEBOUNCE_MS,
} from '../src/resilience/breaker-state.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { BreakerStateFile, CircuitBreakerConfig } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 10 (invariant 5, sanitizer side):
 * `rules`, its family maps AND each rule object merge KEY-BY-KEY with
 * default-when-missing = today's behavior, at every level (a nested-object
 * replacement would silently drop defaults against the shallow top-level
 * merge). YAML-null means UNSET, not zero. Cross-field clamps: maxProbes >= 1,
 * successThreshold <= maxProbes (minCalls <= windowSize is pinned in
 * breaker-rules-mincalls.test.ts). persistence.debounceMs reaches the
 * BreakerStateStore (the boot path passes config.circuitBreaker.persistence
 * .debounceMs — index.ts; the store honoring the value is pinned here).
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-sanitizer-'));
let n = 0;

function cfgFrom(yamlText: string): CircuitBreakerConfig {
  const p = path.join(dir, `c${n++}.yaml`);
  fs.writeFileSync(p, yamlText, 'utf8');
  return loadConfig(p).circuitBreaker!;
}

function sandboxPaths(): CredentialPaths {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-sanitize-store-'));
  const ocrHome = path.join(d, 'ocr-home');
  return {
    configDir: path.join(d, 'config', 'opencode'),
    dataDir: path.join(d, 'data', 'opencode'),
    authJsonPath: path.join(d, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(d, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(d, 'config', 'opencode', 'installed.version'),
    ocrHome,
    serviceJsonCandidates: [path.join(d, 'config', 'opencode', 'service.json')],
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('key-by-key merge at every level (invariant 5)', () => {
  it('partial `rules` (trip only) keeps the counting + recovery family defaults', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    trip:\n      quota:\n        cooldownMs: 7000\n');
    // Family map defaults survive:
    expect(c.rules?.counting?.serverErrors?.enabled).toBe(true);
    expect(c.rules?.counting?.unknownErrors?.enabled).toBe(true);
    expect(c.rules?.counting?.clientErrors?.enabled).toBe(false);
    expect(c.rules?.recovery?.onCanaryFailure).toBe('backoff');
    // Sibling rule objects survive:
    expect(c.rules?.trip?.auth?.enabled).toBe(true);
    expect(c.rules?.trip?.auth?.markSuspect).toBe(true);
    expect(c.rules?.trip?.rateLimit?.enabled).toBe(true);
    expect(c.rules?.trip?.consecutiveFailures?.enabled).toBe(true);
    expect(c.rules?.trip?.failureRate?.enabled).toBe(true);
    // The written leaf wins:
    expect(c.rules?.trip?.quota?.cooldownMs).toBe(7000);
    // Same-rule sibling defaults survive inside the touched rule object:
    expect(c.rules?.trip?.quota?.enabled).toBe(true);
    expect(c.rules?.trip?.quota?.scope).toBe('auto');
  });

  it('partial family map (counting.clientErrors only) keeps its sibling classes', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    counting:\n      clientErrors:\n        enabled: true\n');
    expect(c.rules?.counting?.clientErrors?.enabled).toBe(true);
    expect(c.rules?.counting?.serverErrors?.enabled).toBe(true);
    expect(c.rules?.counting?.unknownErrors?.enabled).toBe(true);
    expect(c.rules?.trip?.quota?.enabled).toBe(true);
  });

  it('partial single rule object keeps every one of its own defaults', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    trip:\n      rateLimit:\n        hardTripAboveMs: 4000\n');
    expect(c.rules?.trip?.rateLimit?.enabled).toBe(true);
    expect(c.rules?.trip?.rateLimit?.scope).toBe('auto');
    expect(c.rules?.trip?.rateLimit?.minCooldownMs).toBeUndefined(); // numeric stays UNSET = auto
    expect(c.rules?.trip?.rateLimit?.hardTripAboveMs).toBe(4000);
  });

  it('a null rules/family value (bare YAML key) falls back to defaults, not {}', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    trip:\n');
    expect(c.rules?.trip?.quota?.enabled).toBe(true);
    expect(c.rules?.trip?.failureRate?.enabled).toBe(true);
  });

  it('YAML-null numeric params mean UNSET, not 0', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    trip:\n      quota:\n        cooldownMs:\n        enabled: true\n');
    expect(c.rules?.trip?.quota?.cooldownMs).toBeUndefined();
    expect(resolveBreakerRules(c).trip.quota.cooldownMs).toBe(12 * 3600 * 1000); // global fallback intact
  });

  it('junk values fall back at the boundary; the valid sibling key survives', () => {
    const c = cfgFrom(
      'circuitBreaker:\n  rules:\n    trip:\n      auth:\n        markSuspect: "yes please"\n        cooldownMs: 500\n',
    );
    expect(c.rules?.trip?.auth?.markSuspect).toBe(true); // non-boolean -> today's default
    expect(c.rules?.trip?.auth?.cooldownMs).toBe(500);
  });

  it('garbage enums fall back to today\u2019s behavior', () => {
    const c = cfgFrom(
      'circuitBreaker:\n  rules:\n    trip:\n      quota:\n        scope: galaxy\n    recovery:\n      onCanaryFailure: teleport\n',
    );
    expect(c.rules?.trip?.quota?.scope).toBe('auto');
    expect(c.rules?.recovery?.onCanaryFailure).toBe('backoff');
    const r = resolveBreakerRules(c);
    expect(r.trip.quota.scope).toBe('auto');
    expect(r.recovery.onCanaryFailure).toBe('backoff');
  });

  it('unknown keys inside the rules tree are dropped (round-trip hygiene)', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    trip:\n      quota:\n        bogus: 1\n        enabled: false\n');
    expect(c.rules?.trip?.quota).not.toHaveProperty('bogus');
    expect(c.rules?.trip?.quota?.enabled).toBe(false); // the valid sibling key still lands
  });

  it('booleans materialize but numeric params stay UNSET so later global-knob edits still propagate', () => {
    const c = cfgFrom('circuitBreaker:\n  failureThreshold: 7\n  rules:\n    trip:\n      consecutiveFailures:\n        enabled: true\n');
    expect(c.rules?.trip?.consecutiveFailures?.threshold).toBeUndefined(); // not frozen into the tree
    expect(resolveBreakerRules(c).trip.consecutiveFailures.threshold).toBe(7); // knob propagates ("auto")
  });
});

describe('halfOpen cross-field clamps (invariant 5)', () => {
  it('maxProbes < 1 clamps to 1 (0 would starve the prober budget)', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    recovery:\n      halfOpen:\n        maxProbes: 0\n');
    expect(c.rules?.recovery?.halfOpen?.maxProbes).toBe(1);
    expect(resolveBreakerRules(c).recovery.halfOpen.maxProbes).toBe(1);
  });

  it('successThreshold clamps to the explicit maxProbes', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    recovery:\n      halfOpen:\n        maxProbes: 4\n        successThreshold: 9\n');
    expect(c.rules?.recovery?.halfOpen?.successThreshold).toBe(4);
    expect(resolveBreakerRules(c).recovery.halfOpen.successThreshold).toBe(4);
  });

  it('successThreshold clamps to the GLOBAL halfOpenMaxProbes when maxProbes is unset', () => {
    const c = cfgFrom('circuitBreaker:\n  halfOpenMaxProbes: 2\n  rules:\n    recovery:\n      halfOpen:\n        successThreshold: 5\n');
    expect(c.rules?.recovery?.halfOpen?.maxProbes).toBeUndefined(); // stays UNSET = auto
    expect(c.rules?.recovery?.halfOpen?.successThreshold).toBe(2); // against the effective budget
    expect(resolveBreakerRules(c).recovery.halfOpen.successThreshold).toBe(2);
  });

  it('the resolver re-clamps configs that skipped the sanitizer (defense in depth)', () => {
    const r = resolveBreakerRules({
      rules: { recovery: { halfOpen: { maxProbes: 0, successThreshold: 7 } } },
    } as unknown as CircuitBreakerConfig);
    expect(r.recovery.halfOpen.maxProbes).toBe(1);
    expect(r.recovery.halfOpen.successThreshold).toBe(1);
  });

  it('an unsatisfiable threshold cannot pin HALF_OPEN end-to-end: clamped batch closes on the first success', () => {
    const c = cfgFrom('circuitBreaker:\n  rules:\n    recovery:\n      halfOpen:\n        maxProbes: 3\n        successThreshold: 0\n');
    expect(c.rules?.recovery?.halfOpen?.successThreshold).toBe(1); // floor 1
    expect(resolveBreakerRules(c).recovery.halfOpen.successThreshold).toBe(1);
  });
});

describe('persistence.debounceMs reaches the breaker-state store', () => {
  it('absent section -> default 1000; custom value survives the sanitizer', () => {
    expect(cfgFrom('circuitBreaker:\n  enabled: true\n').persistence?.debounceMs).toBe(1000);
    expect(DEFAULT_BREAKER_PERSIST_DEBOUNCE_MS).toBe(1000);
    const c = cfgFrom('circuitBreaker:\n  persistence:\n    debounceMs: 2500\n');
    expect(c.persistence?.debounceMs).toBe(2500);
    expect(cfgFrom('circuitBreaker:\n  persistence:\n    debounceMs: -9\n').persistence?.debounceMs).toBe(1000);
  });

  it('a store built with that value flushes on its own debounce (no explicit flush)', async () => {
    const paths = sandboxPaths();
    const store = new BreakerStateStore({ paths, debounceMs: 20 });
    let builds = 0;
    store.requestSave(() => {
      builds++;
      return { version: 1, savedAt: 0, models: [], pairs: [] } as BreakerStateFile;
    });
    expect(fs.existsSync(store.filePath)).toBe(false); // debounced, not immediate

    for (let i = 0; i < 50 && !fs.existsSync(store.filePath); i++) await sleep(20);
    expect(fs.existsSync(store.filePath)).toBe(true); // the configured debounce fired the write
    expect(builds).toBe(1); // thunk evaluated once at flush time

    store.flush(); // nothing pending anymore
    expect(builds).toBe(1);
  });

  it('the first mutation arms the timer; later mutations only replace the snapshot thunk', async () => {
    const paths = sandboxPaths();
    const store = new BreakerStateStore({ paths, debounceMs: 30 });
    let latest = 0;
    store.requestSave(() => ({ version: 1, savedAt: latest, models: [], pairs: [] }) as BreakerStateFile);
    latest = 42; // coalesced storm: the thunk is replaced, the timer is NOT re-armed
    store.requestSave(() => ({ version: 1, savedAt: latest, models: [], pairs: [] }) as BreakerStateFile);
    for (let i = 0; i < 50 && !fs.existsSync(store.filePath); i++) await sleep(20);
    const written = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    expect(written.savedAt).toBe(42); // evaluated at flush time -> latest truth
  });
});

describe('legacy shape equivalence (byte-for-byte promise)', () => {
  it('a minimal legacy config resolves to exactly the rules-less resolution', () => {
    const c = cfgFrom('port: 3000\ncircuitBreaker:\n  failureThreshold: 5\n');
    expect(resolveBreakerRules(c)).toEqual(
      (() => {
        const clone = { ...c, rules: undefined };
        return resolveBreakerRules(clone);
      })(),
    );
    const lr = resolveBreakerRules(c);
    expect(lr.trip.consecutiveFailures.threshold).toBe(5); // global knob inherited
    expect(lr.counting.serverErrors.enabled).toBe(true);
    expect(lr.counting.clientErrors.enabled).toBe(false);
    expect(lr.counting.rateLimitErrors.minCooldownMs).toBe(30_000); // min(60s, initial 30s)
    expect(lr.trip.rateLimit.minCooldownMs).toBe(1000); // today's hardcoded floor
    expect(lr.trip.rateLimit.hardTripAboveMs).toBe(2000); // retry default
    expect(lr.trip.failureRate.failureRate).toBe(0.5); // global default pinned by value
    expect(lr.trip.failureRate.windowSize).toBe(20);
    expect(lr.trip.consecutiveFailures.maxCooldownMs).toBe(5 * 3600 * 1000);
    expect(lr.trip.consecutiveFailures.cooldownMultiplier).toBe(2);
    expect(lr.recovery.halfOpen).toEqual({ maxProbes: 1, successThreshold: 1, maxWaitMs: 0 });
    expect(lr.shadow).toBe(false);
  });

  it('the shipped template round-trips: a fresh config.yaml resolves identically to no config at all', () => {
    const p = path.join(dir, 'template.yaml');
    fs.writeFileSync(p, defaultConfigYaml(), 'utf8');
    const fresh = loadConfig(p);
    expect(resolveBreakerRules(fresh.circuitBreaker, fresh.retry)).toEqual(resolveBreakerRules(undefined, undefined));
    expect(fresh.circuitBreaker?.persistence?.debounceMs).toBe(1000);
  });

  it('the template self-documents the rules tree (operators see the knobs)', () => {
    const doc = parse(defaultConfigYaml()) as any;
    expect(Object.keys(doc.circuitBreaker.rules)).toEqual(['counting', 'trip', 'recovery']);
    expect(doc.circuitBreaker.rules.trip.failureRate.enabled).toBe(true);
    expect(doc.circuitBreaker.shadow).toBe(false);
    expect(doc.circuitBreaker.persistence.debounceMs).toBe(1000);
  });
});
