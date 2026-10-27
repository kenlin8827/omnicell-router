import { describe, expect, it, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RateLimiter,
  apiKeySubject,
  credentialSubject,
  parseDuration,
  compileRules,
  validateRateLimitRules,
  getRateLimiter,
  setRateLimiterForTests,
} from '../src/ratelimit/rate-limiter.js';
import { selectCredential, credentialSpreadIndex } from '../src/pipeline/credential-selection.js';
import {
  RateLimitEventLog,
  openRateLimitEventStore,
  getRateLimitEventLog,
  setRateLimitEventLogForTests,
  type RateLimitEventInput,
} from '../src/ratelimit/event-log.js';
import { CircuitBreakerManager } from '../src/resilience/index.js';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { loadConfig, getRuntimeConfigRef, resolveRateLimit, defaultConfigYaml } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { CallCredential } from '../src/providers/base.js';
import type { ModelRegistration, RouterConfig } from '../src/config/types.js';
import type { ConversationSession } from '../src/session/session-manager.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { ProviderRegistry } from '../src/providers/registry.js';

/**
 * Sliding-window rate limiting — engine semantics (fake clock), selection
 * shaping, config plumbing, the wire-level 429, and the credential overlay route.
 *
 * File-scoped OCR_HOME sandbox: the overlay-route test calls saveConfig for
 * real (upsert/clear semantics are worth pinning end to end), and every
 * loadConfig() in this file must resolve against the sandbox, never the
 * operator's live config.yaml.
 */
const RL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rl-home-'));
process.env.OCR_HOME = RL_HOME;
// Owns its home → declares its book-set name (the runner's tripwire name
// `itest` exists only in the runner's own sandbox home).
process.env.OCR_ENV = 'default';
afterAll(() => {
  // Windows can briefly hold the last config.yaml write handle (EBUSY) —
  // cleanup must never fail the file; an orphaned temp dir is acceptable.
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(RL_HOME, { recursive: true, force: true });
      return;
    } catch {
      // retry
    }
  }
});

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

// ─── duration syntax ─────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('accepts integer and fractional amounts with ms/s/m/h/d units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(5 * M);
    expect(parseDuration('1h')).toBe(H);
    expect(parseDuration('1d')).toBe(D);
    expect(parseDuration(' 2m ')).toBe(2 * M);
    expect(parseDuration('1.5m')).toBe(90_000);
  });

  it('rejects everything else (numbers, bare digits, unknown units, zero)', () => {
    expect(parseDuration(60)).toBeUndefined();
    expect(parseDuration('60')).toBeUndefined();
    expect(parseDuration('1w')).toBeUndefined();
    expect(parseDuration('0m')).toBeUndefined();
    expect(parseDuration('-5s')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

// ─── rule compilation ────────────────────────────────────────────────────────

describe('compileRules', () => {
  it('splits a co-located entry into independent constraints sharing the window', () => {
    const out = compileRules([{ window: '1m', requests: 10, tokens: 50000 }], 'subject-x');
    expect(out.length).toBe(2);
    expect(out.map((c) => c.countable).sort()).toEqual(['requests', 'tokens']);
    expect(out.every((c) => c.windowMs === M)).toBe(true);
  });

  it('drops invalid entries with a warning, keeps the valid ones', () => {
    const out = compileRules(
      [
        { window: '1x', requests: 5 }, // bad duration
        { window: '5m' }, // no countable
        { window: '5m', requests: -3 }, // negative cap
        'garbage',
        { window: '1h', requests: 100 }, // the one survivor
      ],
      'subject-y'
    );
    expect(out.length).toBe(1);
    expect(out[0].windowMs).toBe(H);
    expect(out[0].limit).toBe(100);
  });

  it('keeps the FIRST definition of a duplicated (window, countable) pair', () => {
    const out = compileRules([{ window: '1m', requests: 10 }, { window: '1m', requests: 999 }], 'subject-z');
    expect(out.length).toBe(1);
    expect(out[0].limit).toBe(10);
  });
});

// ─── engine semantics (fake clock) ───────────────────────────────────────────

function limiterWith(rules: { id: string; limits: unknown }[], credentials?: Record<string, { keyHashPrefix: string; limits: unknown }[]>): RateLimiter {
  const rl = new RateLimiter();
  rl.reload({
    apiKeys: rules.map((r) => ({ ...r })) as never,
    credentials: credentials as never,
  } as unknown as RouterConfig);
  return rl;
}

describe('RateLimiter — requests window (true sliding)', () => {
  const t0 = 1_700_000_000_000;

  it('admits up to the cap, then denies with the binding rule and a countdown', () => {
    const rl = limiterWith([{ id: 'k1', limits: [{ window: '1m', requests: 3 }] }]);
    for (let i = 0; i < 3; i++) expect(rl.tryDispatch(apiKeySubject('k1'), t0).allowed).toBe(true);
    const v = rl.tryDispatch(apiKeySubject('k1'), t0 + 10);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.limitedBy).toBe('requests');
      expect(v.rule).toBe('1m/requests');
      expect(v.retryAfterMs).toBe(M - 10);
    }
  });

  it('re-opens exactly as the OLDEST event ages out — not on bucket boundaries', () => {
    const rl = limiterWith([{ id: 'k2', limits: [{ window: '1m', requests: 2 }] }]);
    rl.tryDispatch(apiKeySubject('k2'), t0);
    rl.tryDispatch(apiKeySubject('k2'), t0 + 20_000);
    // full at +30s
    expect(rl.tryDispatch(apiKeySubject('k2'), t0 + 30_000).allowed).toBe(false);
    // the first event expires at +60s (ts <= cutoff prunes): admissible again
    expect(rl.tryDispatch(apiKeySubject('k2'), t0 + 60_000).allowed).toBe(true);
    // now the 20s event + the new one are live; the +60s admission left one slot
    expect(rl.tryDispatch(apiKeySubject('k2'), t0 + 61_000).allowed).toBe(false);
  });

  it('a DENIED tryDispatch consumes nothing (a retry storm cannot extend its own lockout)', () => {
    const rl = limiterWith([{ id: 'k3', limits: [{ window: '1m', requests: 1 }] }]);
    expect(rl.tryDispatch(apiKeySubject('k3'), t0).allowed).toBe(true);
    for (let at = t0 + 1; at < t0 + M; at += 5_000) expect(rl.tryDispatch(apiKeySubject('k3'), at).allowed).toBe(false);
    // exactly one event (t0) exists — denied attempts never entered the log
    expect(rl.tryDispatch(apiKeySubject('k3'), t0 + M).allowed).toBe(true);
  });

  it('peek() answers without consuming', () => {
    const rl = limiterWith([{ id: 'k4', limits: [{ window: '1m', requests: 2 }] }]);
    for (let i = 0; i < 5; i++) expect(rl.peek(apiKeySubject('k4'), t0).allowed).toBe(true);
    expect(rl.tryDispatch(apiKeySubject('k4'), t0).allowed).toBe(true);
  });

  it('dispatch() counts unconditionally — forced-through traffic keeps the window honest', () => {
    const rl = limiterWith([{ id: 'k5', limits: [{ window: '1m', requests: 1 }] }]);
    rl.dispatch(apiKeySubject('k5'), t0);
    rl.dispatch(apiKeySubject('k5'), t0 + 10); // forced pass (last candidate / keep-bound)
    const v = rl.peek(apiKeySubject('k5'), t0 + 60_000);
    expect(v.allowed).toBe(false); // only the +10s event survived the cutoff
    if (!v.allowed) expect(v.retryAfterMs).toBe(10 + M - 60_000);
  });
});

describe('RateLimiter — tokens & costUsd windows', () => {
  const t0 = 1_700_000_000_000;

  it('token usage fills the window; retryAfter = when enough usage ages out', () => {
    const rl = limiterWith([{ id: 'kt', limits: [{ window: '1m', tokens: 1000 }] }]);
    rl.recordUsage(apiKeySubject('kt'), { tokens: 600 }, t0 + 10_000);
    rl.recordUsage(apiKeySubject('kt'), { tokens: 600 }, t0 + 20_000);
    const v = rl.tryDispatch(apiKeySubject('kt'), t0 + 30_000);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.limitedBy).toBe('tokens');
      expect(v.rule).toBe('1m/tokens');
      // expiring the first 600 (at +70s) brings the sum back under 1000
      expect(v.retryAfterMs).toBe(10_000 + M - 30_000);
    }
    expect(rl.tryDispatch(apiKeySubject('kt'), t0 + 70_001).allowed).toBe(true);
  });

  it('costUsd budget behaves like any window and re-opens by time', () => {
    const rl = limiterWith([{ id: 'kc', limits: [{ window: '1d', costUsd: 5 }] }]);
    expect(rl.tryDispatch(apiKeySubject('kc'), t0).allowed).toBe(true);
    rl.recordUsage(apiKeySubject('kc'), { costUsd: 4.99 }, t0);
    expect(rl.tryDispatch(apiKeySubject('kc'), t0 + 1).allowed).toBe(true); // 4.99 < 5 — slack
    rl.recordUsage(apiKeySubject('kc'), { costUsd: 0.02 }, t0 + 1);
    const v = rl.tryDispatch(apiKeySubject('kc'), t0 + 1_000);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.limitedBy).toBe('costUsd');
      expect(v.rule).toBe('1d/costUsd');
    }
  });

  it('recordUsage is a NO-OP for subjects without rules (degeneracy promise)', () => {
    const rl = limiterWith([{ id: 'kd', limits: [{ window: '1m', tokens: 100 }] }]);
    rl.recordUsage(apiKeySubject('ghost'), { tokens: 9_999_999, costUsd: 500 });
    expect(rl.isTracked(apiKeySubject('ghost'))).toBe(false);
    expect(rl.peek(apiKeySubject('ghost')).allowed).toBe(true);
  });
});

describe('RateLimiter — multi-rule combination', () => {
  const t0 = 1_700_000_000_000;

  it('one event fills BOTH windows; limitedBy = latest to open, retryAfter = max', () => {
    const rl = limiterWith([{ id: 'km', limits: [{ window: '1m', requests: 1 }, { window: '1d', requests: 1 }] }]);
    expect(rl.tryDispatch(apiKeySubject('km'), t0).allowed).toBe(true);
    const v = rl.tryDispatch(apiKeySubject('km'), t0 + 10);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe('1d/requests'); // the 1m wall opens first but is not the bottleneck
      expect(v.retryAfterMs).toBe(D - 10);
    }
    // past the minute but inside the day — STILL denied (the long window decides)
    expect(rl.tryDispatch(apiKeySubject('km'), t0 + M + 1).allowed).toBe(false);
  });

  it('burst guard + quota guard on the same countable cascade cleanly', () => {
    const rl = limiterWith([{ id: 'kb', limits: [{ window: '1m', requests: 2 }, { window: '5m', requests: 4 }] }]);
    const subj = apiKeySubject('kb');
    rl.tryDispatch(subj, t0);
    rl.tryDispatch(subj, t0 + 1);
    // 1m window full at once...
    expect(rl.tryDispatch(subj, t0 + 2).allowed).toBe(false);
    // ...but the 5m window only has 2 of 4: after the minute clears, it admits again
    expect(rl.tryDispatch(subj, t0 + M + 1).allowed).toBe(true); // 3 of 5m
    expect(rl.tryDispatch(subj, t0 + M + 2).allowed).toBe(true); // 4 of 5m — full
    const v = rl.tryDispatch(subj, t0 + M + 3);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe('5m/requests');
  });
});

describe('RateLimiter — resetWindows (admin escape hatch)', () => {
  const t0 = 1_700_000_000_000;

  it('resets one subject\'s windows so a full budget reopens; other subjects untouched', () => {
    const rl = limiterWith([{ id: 'kr', limits: [{ window: '1d', requests: 1 }] }]);
    const subj = apiKeySubject('kr');
    expect(rl.tryDispatch(subj, t0).allowed).toBe(true);
    expect(rl.tryDispatch(subj, t0 + 1).allowed).toBe(false);

    // Unknown subject: no-op, reports 0.
    expect(rl.resetWindows(apiKeySubject('nope'))).toBe(0);
    // Still full.
    expect(rl.tryDispatch(subj, t0 + 2).allowed).toBe(false);

    // The reset: budget reopens immediately.
    expect(rl.resetWindows(subj)).toBe(1);
    expect(rl.tryDispatch(subj, t0 + 3).allowed).toBe(true);
  });

  it('a rule label narrows the reset to one constraint of the subject', () => {
    const rl = limiterWith([{ id: 'kn', limits: [{ window: '1m', requests: 1 }, { window: '1d', requests: 1 }] }]);
    const subj = apiKeySubject('kn');
    rl.tryDispatch(subj, t0); // fills BOTH walls
    expect(rl.tryDispatch(subj, t0 + 1).allowed).toBe(false); // denied attempts are not counted

    // Reset only the 1m wall — the 1d budget stays consumed.
    expect(rl.resetWindows(subj, '1m/requests')).toBe(1);
    expect(rl.tryDispatch(subj, t0 + 2).allowed).toBe(false);

    // Reset the 1d rule too — admitted again.
    expect(rl.resetWindows(subj, '1d/requests')).toBe(1);
    expect(rl.tryDispatch(subj, t0 + 3).allowed).toBe(true);
  });

  it('an unmatched rule label resets nothing (0) and leaves the window full', () => {
    const rl = limiterWith([{ id: 'ko', limits: [{ window: '1m', requests: 1 }] }]);
    const subj = apiKeySubject('ko');
    rl.tryDispatch(subj, t0);
    expect(rl.resetWindows(subj, '5m/requests')).toBe(0);
    expect(rl.tryDispatch(subj, t0 + 1).allowed).toBe(false);
  });
});

describe('RateLimiter — reload lifecycle', () => {
  const t0 = 1_700_000_000_000;

  it('reloads keep the event log for surviving constraints (cap edits preserve history)', () => {
    const rules = [{ id: 'kr', limits: [{ window: '1m', requests: 10 }] }];
    const rl = limiterWith(rules);
    for (let i = 0; i < 5; i++) rl.tryDispatch(apiKeySubject('kr'), t0);
    rl.reload({
      apiKeys: [{ id: 'kr', limits: [{ window: '1m', requests: 5 }] }],
    } as unknown as RouterConfig);
    // history survived: 5 events, new cap 5 → full
    expect(rl.tryDispatch(apiKeySubject('kr'), t0 + 1).allowed).toBe(false);
  });

  it('a removed rule drops its window; re-adding starts fresh', () => {
    const rl = limiterWith([{ id: 'kx', limits: [{ window: '1m', requests: 1 }] }]);
    expect(rl.tryDispatch(apiKeySubject('kx'), t0).allowed).toBe(true);
    expect(rl.tryDispatch(apiKeySubject('kx'), t0).allowed).toBe(false);
    rl.reload({ apiKeys: [{ id: 'kx' }] } as unknown as RouterConfig);
    expect(rl.isTracked(apiKeySubject('kx'))).toBe(false);
    expect(rl.tryDispatch(apiKeySubject('kx'), t0).allowed).toBe(true);
    rl.reload({ apiKeys: [{ id: 'kx', limits: [{ window: '1m', requests: 1 }] }] } as unknown as RouterConfig);
    // constraint re-created → the old window was garbage-collected → fresh
    expect(rl.tryDispatch(apiKeySubject('kx'), t0).allowed).toBe(true);
    expect(rl.tryDispatch(apiKeySubject('kx'), t0).allowed).toBe(false);
  });

  it('snapshot() reports the live sum per armed constraint', () => {
    const rl = limiterWith([{ id: 'ks', limits: [{ window: '1m', requests: 4 }, { window: '1d', tokens: 100 }] }]);
    rl.tryDispatch(apiKeySubject('ks'), t0);
    rl.recordUsage(apiKeySubject('ks'), { tokens: 30 }, t0);
    const snap = rl.snapshot(t0);
    expect(snap.length).toBe(2);
    const req = snap.find((s) => s.rule === '1m/requests')!;
    expect(req.used).toBe(1);
    expect(req.limit).toBe(4);
    expect(req.retryAfterMs).toBe(0);
    const tok = snap.find((s) => s.rule === '1d/tokens')!;
    expect(tok.used).toBe(30);
  });
});

// ─── config file pass-through (hand-written YAML) ───────────────────────────

describe('config plumbing — credentials:/limits survive the loadConfig round trip', () => {
  it('loadConfig() exposes credentials: and per-key limits; reload() compiles both subjects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rl-cfg-'));
    const cfgPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'credentials:',
        '  anthropic:',
        '    - keyHashPrefix: "ab12cd34ef56"',
        '      limits:',
        '        - { window: 1m, requests: 10 }',
        '        - { window: 1m, tokens: 50000 }',
        '        - { window: 1d, requests: 800 }',
        'apiKeys:',
        '  - id: key-abc',
        '    name: YAML Client',
        '    key: sk-ocr-yaml',
        '    enabled: true',
        '    createdAt: "2026-01-01T00:00:00.000Z"',
        '    limits:',
        '      - { window: 1m, requests: 30 }',
        '      - { window: 1d, costUsd: 5 }',
        '',
      ].join('\n'),
      'utf8'
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.credentials?.anthropic?.[0]?.keyHashPrefix).toBe('ab12cd34ef56');
    expect(cfg.credentials?.anthropic?.[0]?.limits?.length).toBe(3);
    expect(cfg.apiKeys?.[0]?.limits?.length).toBe(2);
    // YAML 1.1 resolved `1m`/`1d` stay STRINGS (duration contract).
    expect(typeof cfg.credentials?.anthropic?.[0]?.limits?.[0]?.window).toBe('string');

    const rl = new RateLimiter();
    rl.reload(cfg);
    expect(rl.isTracked(credentialSubject('anthropic', 'ab12cd34ef56'))).toBe(true);
    expect(rl.isTracked(apiKeySubject('key-abc'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── validateRateLimitRules (console PUT payloads) ──────────────────────────

describe('validateRateLimitRules', () => {
  it('accepts valid shapes and normalizes the window string', () => {
    const r = validateRateLimitRules([{ window: ' 5m ', requests: 30 }, { window: '1d', costUsd: 5 }]);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual([{ window: '5m', requests: 30 }, { window: '1d', costUsd: 5 }]);
  });

  it('accepts an explicit empty list (clear all caps)', () => {
    expect(validateRateLimitRules([])).toEqual({ value: [] });
  });

  it('rejects absent-shape errors loudly instead of dropping silently', () => {
    expect(validateRateLimitRules('nope').error).toBeDefined();
    expect(validateRateLimitRules([{ window: '10x', requests: 1 }]).error).toBeDefined();
    expect(validateRateLimitRules([{ window: '1m' }]).error).toBeDefined(); // no countable
    expect(validateRateLimitRules([{ window: '1m', requests: -1 }]).error).toBeDefined();
    expect(validateRateLimitRules([{ window: '1m', requests: 5, tpm: 9 }]).error).toContain('tpm');
    expect(validateRateLimitRules([42]).error).toBeDefined();
  });
});

// ─── selection shaping (spreadCapped predicate) ─────────────────────────────

const PROVIDER = 'anthropic';
const MODEL: ModelRegistration = {
  id: 'anthropic/claude-test',
  provider: PROVIDER,
  upstreamModel: 'claude-test',
  tier: 'plus',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};
const cred = (key: string, label: string): CallCredential => ({ key, keyHashPrefix: keyHashPrefix(key), label });
const chain = [cred('sk-rl-one', 'one'), cred('sk-rl-two', 'two'), cred('sk-rl-three', 'three')];

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rl-sel-'));
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

describe('selectCredential — rate-limit shaping', () => {
  it('a new-session spread prefers credentials with slack over the hash pick', () => {
    const cb = makeManager();
    // Without the predicate, the spread hash decides; WITH it, only 'two' has
    // slack → the placement lands there deterministically.
    const sel = selectCredential(session('s-capped'), MODEL, chain, cb, {
      sessionId: 's-capped',
      spreadCapped: (p) => p !== chain[1].keyHashPrefix,
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[1].keyHashPrefix);
  });

  it('KEEP-BOUND IRON LAW: a bound session is kept even when its credential is capped', () => {
    const cb = makeManager();
    const sel = selectCredential(session('s-keep', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's-keep',
      spreadCapped: () => true, // every credential capped
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[0].keyHashPrefix);
    expect(sel.forcedMove).toBe(false);
    expect(sel.bind).toBeUndefined(); // never moved → nothing to persist
  });

  it('all credentials capped re-opens the filter (shaping must not starve the provider)', () => {
    const cb = makeManager();
    const noFilter = selectCredential(session('s-all'), MODEL, chain, cb, { sessionId: 's-all' });
    const allCapped = selectCredential(session('s-all'), MODEL, chain, cb, {
      sessionId: 's-all',
      spreadCapped: () => true,
    });
    expect(allCapped.credential?.keyHashPrefix).toBe(noFilter.credential?.keyHashPrefix);
    expect(allCapped.credential).toBeDefined();
  });

  it('forced-failover landing prefers a slack credential over the chain head', () => {
    const cb = makeManager();
    cb.tripPair(MODEL.id, chain[0].keyHashPrefix, { cooldownMs: 600000 }, PROVIDER); // bound head is out
    const sel = selectCredential(session('s-move', { boundKeyHashPrefix: chain[0].keyHashPrefix }), MODEL, chain, cb, {
      sessionId: 's-move',
      spreadCapped: (p) => p === chain[1].keyHashPrefix, // next head 'two' is capped
    });
    expect(sel.credential?.keyHashPrefix).toBe(chain[2].keyHashPrefix);
    expect(sel.forcedMove).toBe(true);
  });
});

// ─── wire level: 429 + Retry-After on the inference surfaces ────────────────

describe('inbound enforcement — server 429', () => {
  const baseConfig = loadConfig();
  const rlKey = {
    id: 'key-rl',
    name: 'Metered Client',
    key: 'sk-ocr-rate-limited',
    enabled: true,
    createdAt: new Date().toISOString(),
    limits: [{ window: '1m', requests: 2 }],
  };
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1',
    webAuth: { enabled: false },
    adminApiKey: 'master-rl-key',
    apiKeys: [rlKey],
  };
  const { app } = createServer(testConfig, true);

  const call = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: `hello ${Math.random()}` }] },
    });

  it('admits until the requests cap, then answers 429 with Retry-After', async () => {
    // Explicit rule-table load at EXECUTION time: createServer's boot reload
    // runs at collection, and a later describe's createServer (the overlay
    // route section) would otherwise have replaced the singleton's table.
    getRateLimiter().reload(testConfig);
    expect((await call('sk-ocr-rate-limited')).statusCode).toBe(200);
    expect((await call('sk-ocr-rate-limited')).statusCode).toBe(200);
    const res = await call('sk-ocr-rate-limited');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const body = res.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.message).toContain('1m/requests');
  });

  it('the master admin key is never metered, and /v1/models browsing does not burn quota', async () => {
    const models = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-ocr-rate-limited' },
    });
    expect(models.statusCode).not.toBe(429); // over-limit key can still list models
    const admin = await call('master-rl-key');
    expect(admin.statusCode).not.toBe(429);
  });

  it('GET /api/admin/ratelimit exposes the armed windows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/ratelimit' });
    expect(res.statusCode).toBe(200);
    const win = res.json().windows.find((w: { subject: string }) => w.subject === apiKeySubject('key-rl'));
    expect(win.rule).toBe('1m/requests');
    expect(win.limit).toBe(2);
    expect(win.used).toBe(2); // two admitted; the denied attempt consumed nothing
  });

  it('GET /api/admin/ratelimit/events records the inbound denial', async () => {
    // Fresh ledger at EXECUTION time (same singleton-replacement hazard as the
    // rule table above), then push the key past its armed cap once more.
    setRateLimitEventLogForTests(new RateLimitEventLog());
    getRateLimiter().reload(testConfig);
    expect((await call('sk-ocr-rate-limited')).statusCode).toBe(429);
    const res = await app.inject({ method: 'GET', url: '/api/admin/ratelimit/events' });
    expect(res.statusCode).toBe(200);
    const events = res.json().events;
    expect(events.length).toBe(1); // repeats inside the coalesce window fold into one
    const e = events[0];
    expect(e.direction).toBe('inbound');
    expect(e.kind).toBe('denied');
    expect(e.subject).toBe(apiKeySubject('key-rl'));
    expect(e.rule).toBe('1m/requests');
    expect(e.limitedBy).toBe('requests');
    expect(e.apiKeyName).toBe('Metered Client');
    expect(e.retryAfterMs).toBeGreaterThan(0);
  });

  it('POST /api/admin/ratelimit/events/clear wipes the ledger', async () => {
    // The denial above left an entry; the clear must empty the read view.
    expect((await app.inject({ method: 'GET', url: '/api/admin/ratelimit/events' })).json().events.length).toBeGreaterThan(0);
    const res = await app.inject({ method: 'POST', url: '/api/admin/ratelimit/events/clear' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe(true);
    const after = await app.inject({ method: 'GET', url: '/api/admin/ratelimit/events' });
    expect(after.json().events).toEqual([]);
  });
});

// ─── credential overlay route — PUT /api/admin/credentials/limits (real save) ─────

describe('credential limits overlay route', () => {
  const baseConfig = loadConfig();
  const { app } = createServer(
    { ...baseConfig, host: '127.0.0.1', webAuth: { enabled: false } } as RouterConfig,
    true
  );

  const put = (payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/admin/credentials/limits', payload: payload as any });

  it('arms an overlay entry, persists it, and reloads the engine', async () => {
    const res = await put({
      provider: 'anthropic',
      keyHashPrefix: 'ab12cd34ef56',
      limits: [{ window: '1m', requests: 10 }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.windows[0]?.rule).toBe('1m/requests');
    expect(getRateLimiter().isTracked(credentialSubject('anthropic', 'ab12cd34ef56'))).toBe(true);
    const disk = loadConfig();
    expect(disk.credentials?.anthropic?.[0]?.limits?.[0]?.requests).toBe(10);
  });

  it('upserts the same prefix (second write replaces, never appends)', async () => {
    await put({ provider: 'anthropic', keyHashPrefix: 'AB12CD34EF56', limits: [{ window: '5m', tokens: 5000 }] });
    const res = await put({ provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1m', requests: 3 }] });
    expect(res.statusCode).toBe(200);
    const disk = loadConfig();
    expect(disk.credentials?.anthropic?.length).toBe(1);
    expect(disk.credentials?.anthropic?.[0]?.limits).toEqual([{ window: '1m', requests: 3 }]);
  });

  it('null or [] clears the entry and un-arms the subject', async () => {
    await put({ provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1d', costUsd: 5 }] });
    expect(getRateLimiter().isTracked(credentialSubject('anthropic', 'ab12cd34ef56'))).toBe(true);
    const res = await put({ provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56', limits: null });
    expect(res.statusCode).toBe(200);
    const disk = loadConfig();
    expect(disk.credentials?.anthropic).toBeUndefined();
    expect(getRateLimiter().isTracked(credentialSubject('anthropic', 'ab12cd34ef56'))).toBe(false);
  });

  it('rejects malformed provider/prefix/rule shapes with 400 and writes nothing', async () => {
    const before = JSON.stringify(loadConfig().credentials ?? {});
    const bad = [
      { provider: '', keyHashPrefix: 'ab12cd34ef56', limits: [] },
      { provider: 'anthropic', keyHashPrefix: 'not-hex!!', limits: [] },
      { provider: 'anthropic', keyHashPrefix: 'ab', limits: [] }, // too short
      { provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1x', requests: 1 }] },
      { provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56', limits: 'nope' },
      { provider: 'anthropic', keyHashPrefix: 'ab12cd34ef56' }, // missing limits is a caller error, never a silent clear
    ];
    for (const payload of bad) {
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
    expect(JSON.stringify(loadConfig().credentials ?? {})).toBe(before);
  });

  it('the runtime config ref follows every credentials write (overlay badge freshness)', async () => {
    // withCredentialHealth reads the runtime ref for the per-row caps badge —
    // after this route's saveConfig the snapshot must carry the new entry,
    // or the dialog re-seeds a stale draft and the operator concludes the
    // save failed (advisor finding #1 regression pin).
    await put({ provider: 'openai', keyHashPrefix: 'cafe1234beef', limits: [{ window: '1h', tokens: 1000 }] });
    const ref = getRuntimeConfigRef();
    expect(ref?.credentials?.openai?.[0]?.keyHashPrefix).toBe('cafe1234beef');
    expect(ref?.credentials?.openai?.[0]?.limits?.[0]?.tokens).toBe(1000);
    await put({ provider: 'openai', keyHashPrefix: 'cafe1234beef', limits: null });
    expect(getRuntimeConfigRef()?.credentials?.openai).toBeUndefined();
  });
});

// ─── identity normalization (hand-edited YAML hygiene) ──────────────────────

describe('prefix case normalization', () => {
  it('an upper-case hand-written prefix arms the LOWER-case subject call sites use', () => {
    const rl = new RateLimiter();
    rl.reload({
      credentials: { anthropic: [{ keyHashPrefix: 'AB12CD34EF56', limits: [{ window: '1m', requests: 1 }] }] },
    } as unknown as RouterConfig);
    // registry/credential prefixes are sha256 hex slices — always lower-case;
    // a case-mismatched subject would be a silent dead rule.
    expect(rl.isTracked(credentialSubject('anthropic', 'ab12cd34ef56'))).toBe(true);
    expect(rl.tryDispatch(credentialSubject('anthropic', 'ab12cd34ef56')).allowed).toBe(true);
    expect(rl.tryDispatch(credentialSubject('anthropic', 'ab12cd34ef56')).allowed).toBe(false);
  });
});

function makeRlFixture() {
  const base = loadConfig();
  const config = {
    ...base,
    models: [],
    tiers: base.tiers ?? {},
    combos: [{ id: 'rl-combo', models: ['rl/alpha', 'rl/beta'] }],
    session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
    circuitBreaker: { ...base.circuitBreaker, enabled: true, failureThreshold: 1000, initialCooldownMs: 600_000 },
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false);
  const alpha: ModelRegistration = {
    id: 'rl/alpha',
    provider: 'rlp',
    upstreamModel: 'alpha',
    tier: 'plus',
    isDefaultInTier: true,
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
  const beta: ModelRegistration = {
    id: 'rl/beta',
    provider: 'rlq',
    upstreamModel: 'beta',
    tier: 'plus',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
  const chainAlpha = [cred('sk-rl-alpha-a', 'a'), cred('sk-rl-alpha-b', 'b')];
  const chainBeta = [cred('sk-rl-beta-a', 'a')];
  const seenByAlpha: (string | undefined)[] = [];
  const stub = (name: string, sink?: (p: string | undefined) => void) => ({
    name,
    async createCompletion(
      _req: ChatCompletionRequest,
      model: ModelRegistration,
      _ctx: unknown,
      credential?: CallCredential
    ): Promise<ChatCompletionResponse> {
      sink?.(credential?.keyHashPrefix);
      return {
        id: `ok-${name}`,
        object: 'chat.completion',
        created: 1,
        model: model.upstreamModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      } as ChatCompletionResponse;
    },
  });
  registry.registerProvider('rlp', stub('rlp', (p) => seenByAlpha.push(p)) as never, chainAlpha);
  registry.registerProvider('rlq', stub('rlq') as never, chainBeta);
  registry.registerModel(alpha, true);
  registry.registerModel(beta);
  const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
  return { config, registry, orchestrator, chainAlpha, chainBeta, seenByAlpha };
}

describe('outbound shaping — executeCandidatePool', () => {
  // Each case swaps in a FRESH singleton limiter (call sites read
  // getRateLimiter() per decision, not a captured reference) — event windows
  // never leak between tests.
  it('a new session spreads onto the slack credential while the capped sibling waits', async () => {
    const { config, orchestrator, chainAlpha, seenByAlpha } = makeRlFixture();
    setRateLimiterForTests(new RateLimiter());
    const rl = getRateLimiter();
    rl.reload({
      ...config,
      credentials: {
        // cap BOTH alpha credentials to 1 request; consume the one the spread
        // would pick, so the predicate lands the session on the other.
        rlp: [
          { keyHashPrefix: chainAlpha[0].keyHashPrefix, limits: [{ window: '1m', requests: 1 }] },
          { keyHashPrefix: chainAlpha[1].keyHashPrefix, limits: [{ window: '1m', requests: 1 }] },
        ],
      },
    } as unknown as RouterConfig);
    // NOTE the combo wire: sessionMode 'bypass' never creates a session entry
    // (no bind to persist), so shaping is asserted on the credential that
    // SERVED; the bind seam is pinned by the keep-bound case below.
    const sessionId = 'sess-rl-spread';
    const first = chainAlpha[credentialSpreadIndex(sessionId, chainAlpha.length)];
    rl.dispatch(credentialSubject('rlp', first.keyHashPrefix)); // the hash pick is already at cap
    setRateLimitEventLogForTests(new RateLimitEventLog());
    const turn = { model: 'rl-combo', messages: [{ role: 'user', content: 'shaping' }] } as ChatCompletionRequest;
    const res = await orchestrator.process(turn, { headers: { 'x-session-id': sessionId } });
    expect(res.modelUsed).toBe('rl/alpha'); // shaped WITHIN the provider (slack sibling)
    const slack = first.keyHashPrefix === chainAlpha[0].keyHashPrefix ? chainAlpha[1] : chainAlpha[0];
    expect(res.servedCredentialPrefix).toBe(slack.keyHashPrefix);
    expect(seenByAlpha[seenByAlpha.length - 1]).toBe(slack.keyHashPrefix);
    // The capped sibling the spread actually steered around is in the ledger.
    const shaped = getRateLimitEventLog().list().find((e) => e.kind === 'shaped');
    expect(shaped).toBeDefined();
    expect(shaped!.subject).toBe(credentialSubject('rlp', first.keyHashPrefix));
    expect(shaped!.direction).toBe('outbound');
    expect(shaped!.note).toBe('spread selection');
    expect(shaped!.noteCode).toBe('spread');
  });

  it('every alpha credential full → the candidate is skipped and the next provider serves', async () => {
    const { config, orchestrator, chainAlpha, seenByAlpha } = makeRlFixture();
    setRateLimiterForTests(new RateLimiter());
    const rl = getRateLimiter();
    rl.reload({
      ...config,
      credentials: {
        rlp: [
          { keyHashPrefix: chainAlpha[0].keyHashPrefix, limits: [{ window: '1m', requests: 1 }] },
          { keyHashPrefix: chainAlpha[1].keyHashPrefix, limits: [{ window: '1m', requests: 1 }] },
        ],
      },
    } as unknown as RouterConfig);
    rl.dispatch(credentialSubject('rlp', chainAlpha[0].keyHashPrefix));
    rl.dispatch(credentialSubject('rlp', chainAlpha[1].keyHashPrefix));
    setRateLimitEventLogForTests(new RateLimitEventLog());
    const turn = { model: 'rl-combo', messages: [{ role: 'user', content: 'cross-provider' }] } as ChatCompletionRequest;
    const res = await orchestrator.process(turn, { headers: { 'x-session-id': 'sess-rl-skip' } });
    expect(res.modelUsed).toBe('rl/beta'); // alpha skipped while beta remained
    expect(seenByAlpha.length).toBe(0);
    // The event ledger tells the shaping story: the candidate skipped at the
    // outbound gate. No `shaped` events here — every alpha member is capped,
    // so the slack filter re-opens (shaping must not starve the provider).
    const events = getRateLimitEventLog().list();
    expect(events.some((e) => e.direction === 'outbound' && e.kind === 'skipped' && e.subject.startsWith('credential:rlp:'))).toBe(true);
    expect(events.some((e) => e.kind === 'shaped')).toBe(false);
  });

  it('keep-bound: a capped bound credential is FORCED THROUGH, never rebound', async () => {
    const { config, orchestrator, chainAlpha, seenByAlpha } = makeRlFixture();
    setRateLimiterForTests(new RateLimiter()); // clean slate for turn 1 too
    const rl = getRateLimiter();
    // Explicit model (not a combo): the session entry EXISTS (applyRatchet
    // initializes it) and turn 1 persists the affinity bind — that binding is
    // exactly what a cap must NOT move.
    const turn = { model: 'rl/alpha', messages: [{ role: 'user', content: 'keep me bound' }] } as ChatCompletionRequest;
    const sessionId = 'sess-rl-keep';
    const first = await orchestrator.process(turn, { headers: { 'x-session-id': sessionId } });
    expect(first.modelUsed).toBe('rl/alpha');
    const bound = orchestrator.getSessionManager().getSession(sessionId)?.boundKeyHashPrefix;
    expect(bound).toBeDefined();
    expect(seenByAlpha[seenByAlpha.length - 1]).toBe(bound);

    // arm the cap and spend the window from outside (the first turn ran
    // before any rule existed — the degeneracy promise, no hidden count)
    rl.reload({
      ...config,
      credentials: { rlp: [{ keyHashPrefix: bound, limits: [{ window: '1m', requests: 1 }] }] },
    } as unknown as RouterConfig);
    rl.dispatch(credentialSubject('rlp', bound));
    expect(rl.peek(credentialSubject('rlp', bound)).allowed).toBe(false);
    setRateLimitEventLogForTests(new RateLimitEventLog());
    const before = seenByAlpha.length;
    const second = await orchestrator.process(
      { ...turn, messages: [{ role: 'user', content: 'keep me bound 2' }] } as ChatCompletionRequest,
      { headers: { 'x-session-id': sessionId } }
    );
    expect(second.modelUsed).toBe('rl/alpha'); // forced through — NO rebind
    expect(orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix).toBe(bound);
    expect(seenByAlpha.length).toBe(before + 1);
    expect(seenByAlpha[before]).toBe(bound);
    // The override is visible in the ledger: at-cap but force-through, keep-bound note.
    const forced = getRateLimitEventLog().list().find((e) => e.kind === 'forced');
    expect(forced).toBeDefined();
    expect(forced!.subject).toBe(credentialSubject('rlp', bound));
    expect(forced!.note).toBe('keep-bound session');
    expect(forced!.noteCode).toBe('keep-bound');
  });

  it('completed turns record token usage onto the serving credential ledger', async () => {
    const { config, orchestrator, chainAlpha } = makeRlFixture();
    setRateLimiterForTests(new RateLimiter());
    const rl = getRateLimiter();
    rl.reload({
      ...config,
      credentials: { rlp: chainAlpha.map((c) => ({ keyHashPrefix: c.keyHashPrefix, limits: [{ window: '1d', tokens: 120 }] })) },
    } as unknown as RouterConfig);
    const turn = { model: 'rl/alpha', messages: [{ role: 'user', content: 'usage' }] } as ChatCompletionRequest;
    const res = await orchestrator.process(turn, { headers: { 'x-session-id': 'sess-rl-usage' } });
    const prefix = res.servedCredentialPrefix ?? chainAlpha[0].keyHashPrefix;
    const v = rl.peek(credentialSubject('rlp', prefix));
    expect(v.allowed).toBe(false); // 150 tokens > 120 budget
    if (!v.allowed) expect(v.limitedBy).toBe('tokens');
  });
});

// ─── inbound grace — bounded in-place wait before the 429 ────────────────────

describe('inbound grace — bounded wait', () => {
  const baseConfig = loadConfig();
  const mk = (id: string, window: string) => ({
    id,
    name: `Grace ${id}`,
    key: `sk-ocr-${id}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    limits: [{ window, requests: 1 }],
  });
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1',
    webAuth: { enabled: false },
    adminApiKey: 'master-grace',
    apiKeys: [mk('key-grace-short', '500ms'), mk('key-grace-long', '3s'), mk('key-grace-race', '1s')],
    rateLimit: { inboundGraceMs: 1000 },
  };
  const { app } = createServer(testConfig, true);

  const call = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: `hello ${Math.random()}` }] },
    });

  // Fresh singleton + own rule table at EXECUTION time (collection-time
  // createServer reloads from other describes replace the table beforehand).
  const fresh = () => {
    setRateLimiterForTests(new RateLimiter());
    getRateLimiter().reload(testConfig);
  };

  it('a denial that reopens within the budget is slept out and re-admitted', async () => {
    fresh();
    expect((await call('sk-ocr-key-grace-short')).statusCode).toBe(200);
    const t0 = Date.now();
    const res = await call('sk-ocr-key-grace-short');
    const elapsed = Date.now() - t0;
    expect(res.statusCode).toBe(200); // no user-visible 429 for a sub-second blip
    expect(elapsed).toBeGreaterThanOrEqual(100); // slept at the gate, not fast-failed
    expect(elapsed).toBeLessThan(2000);
  });

  it('grace does not change the per-window admission count (the re-admission lands in the NEXT window)', async () => {
    fresh();
    await call('sk-ocr-key-grace-short'); // admits at t0
    const waited = await call('sk-ocr-key-grace-short'); // sleeps past the expiry, admits
    expect(waited.statusCode).toBe(200);
    const snap = await app.inject({ method: 'GET', url: '/api/admin/ratelimit' });
    const win = snap.json().windows.find((w: { subject: string }) => w.subject === apiKeySubject('key-grace-short'));
    expect(win.used).toBe(1); // one event per window — the wait only defers, never doubles
  });

  it('a denial beyond the budget still fast-fails with a fresh Retry-After', async () => {
    fresh();
    expect((await call('sk-ocr-key-grace-long')).statusCode).toBe(200);
    const t0 = Date.now();
    const res = await call('sk-ocr-key-grace-long');
    const elapsed = Date.now() - t0;
    expect(res.statusCode).toBe(429);
    expect(elapsed).toBeLessThan(300); // retryAfter ≈ 3s > grace: no sleep
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(2);
  });

  it('sleepers race one freed slot: one admitted, the peer 429s after the SINGLE re-check (never a loop)', async () => {
    fresh();
    expect((await call('sk-ocr-key-grace-race')).statusCode).toBe(200);
    const t0 = Date.now();
    const [b, c] = await Promise.all([call('sk-ocr-key-grace-race'), call('sk-ocr-key-grace-race')]);
    const elapsed = Date.now() - t0;
    expect([b.statusCode, c.statusCode].sort()).toEqual([200, 429]);
    // The loser returned right after its one grace wait (~1s + slack) — a
    // second sleep would push the pair past this bound.
    expect(elapsed).toBeLessThan(1700);
    const loser = b.statusCode === 429 ? b : c;
    expect(Number(loser.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('inbound grace — disabled (inboundGraceMs = 0)', () => {
  const baseConfig = loadConfig();
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1',
    webAuth: { enabled: false },
    adminApiKey: 'master-grace-off',
    apiKeys: [
      {
        id: 'key-grace-off',
        name: 'Grace Off',
        key: 'sk-ocr-grace-off',
        enabled: true,
        createdAt: new Date().toISOString(),
        limits: [{ window: '500ms', requests: 1 }],
      },
    ],
    rateLimit: { inboundGraceMs: 0 },
  };
  const { app } = createServer(testConfig, true);

  const call = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: `hello ${Math.random()}` }] },
    });

  it('zero budget fast-fails even a sub-second denial (pre-grace behavior preserved)', async () => {
    setRateLimiterForTests(new RateLimiter());
    getRateLimiter().reload(testConfig);
    expect((await call('sk-ocr-grace-off')).statusCode).toBe(200);
    const t0 = Date.now();
    const res = await call('sk-ocr-grace-off');
    expect(res.statusCode).toBe(429);
    expect(Date.now() - t0).toBeLessThan(300);
  });
});

describe('inbound grace — an aborted client never burns the freed slot', () => {
  const baseConfig = loadConfig();
  const abortKey = {
    id: 'key-grace-abort',
    name: 'Grace Abort',
    key: 'sk-ocr-grace-abort',
    enabled: true,
    createdAt: new Date().toISOString(),
    limits: [{ window: '500ms', requests: 1 }],
  };
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1',
    webAuth: { enabled: false },
    adminApiKey: 'master-grace-abort',
    apiKeys: [abortKey],
    rateLimit: { inboundGraceMs: 1000 },
  };
  const { app } = createServer(testConfig, true);

  it('disconnect during the sleep: Bun cannot detect it pre-write — the request is answered anyway (no hang, slot may burn)', async () => {
    // Runtime reality (probed): Bun fires NO res/socket close on a mid-handler
    // client abort and req.raw.destroyed is true for LIVE requests too, so
    // "skip the re-check for a gone client" is only observable on Node. The
    // gate must therefore ALWAYS answer the woken request — a live client is
    // never hijacked into a hang; an aborted one may consume the freed slot
    // (0 on Node, 1 on Bun) and the write is silently dropped. The invariant
    // kept is the one that matters: nobody hangs.
    testConfig.apiKeys = [abortKey];
    testConfig.webAuth = { enabled: false };
    testConfig.adminApiKey = 'master-grace-abort';
    setRateLimiterForTests(new RateLimiter());
    getRateLimiter().reload(testConfig);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const body = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'abort me' }] });
    const headers = { authorization: 'Bearer sk-ocr-grace-abort', 'content-type': 'application/json' };
    try {
      const first = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body });
      expect(first.status).toBe(200); // consumes the only slot at t0
      const ac = new AbortController();
      const pending = fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body, signal: ac.signal }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 700));
      const snap = await app.inject({ method: 'GET', url: '/api/admin/ratelimit' });
      const win = snap.json().windows.find((w: { subject: string }) => w.subject === apiKeySubject('key-grace-abort'));
      expect([0, 1]).toContain(win.used); // Node skips the re-check (0); Bun answers blindly (1)
    } finally {
      await app.close();
    }
  });
});

describe('inbound grace — a LIVE client gets answered over a real socket', () => {
  // Regression: `req.raw.destroyed` is TRUE for a perfectly live request once
  // Fastify has parsed the body (IncomingMessage auto-destroys at EOF). The
  // grace gate must NOT read that as "client gone" — doing so hijacked the
  // reply and hung the live client until its own timeout. Only a real socket
  // reproduces it (app.inject's mock req.raw never destroys), so this test
  // listens on an ephemeral port and asserts the slept request ANSWERS.
  const baseConfig = loadConfig();
  const liveKey = {
    id: 'key-grace-live',
    name: 'Grace Live',
    key: 'sk-ocr-grace-live',
    enabled: true,
    createdAt: new Date().toISOString(),
    limits: [{ window: '500ms', requests: 1 }],
  };
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1',
    webAuth: { enabled: false },
    adminApiKey: 'master-grace-live',
    apiKeys: [liveKey],
    rateLimit: { inboundGraceMs: 1000 },
  };
  const { app } = createServer(testConfig, true);

  it('a capped-but-live request is grace-admitted and receives a response (no hang)', async () => {
    testConfig.apiKeys = [liveKey];
    testConfig.webAuth = { enabled: false };
    testConfig.adminApiKey = 'master-grace-live';
    setRateLimiterForTests(new RateLimiter());
    getRateLimiter().reload(testConfig);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const body = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'answer me' }] });
    const headers = { authorization: 'Bearer sk-ocr-grace-live', 'content-type': 'application/json' };
    try {
      const first = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body });
      expect(first.status).toBe(200); // consumes the only slot
      // Second request while the window is full: retryAfter (~500ms) fits the
      // 1000ms grace, so the gate sleeps then re-admits. The client never
      // disconnects — it MUST get a response, not hang.
      const t0 = Date.now();
      const second = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body });
      const status = await second.status; // resolves only if the reply was sent
      expect(status).toBe(200);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // actually slept at the gate
    } finally {
      await app.close();
    }
  });
});

// ─── rateLimit config resolution ─────────────────────────────────────────────

describe('resolveRateLimit', () => {
  const P = { persist: { enabled: true } };
  it('absent or junk falls back to the default; valid values clamp to [0, MAX]', () => {
    expect(resolveRateLimit({})).toEqual({ inboundGraceMs: 1000, ...P });
    expect(resolveRateLimit({ rateLimit: {} })).toEqual({ inboundGraceMs: 1000, ...P });
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: '1000' } })).toEqual({ inboundGraceMs: 1000, ...P }); // quoted = junk
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: -5 } })).toEqual({ inboundGraceMs: 1000, ...P });
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: 0 } })).toEqual({ inboundGraceMs: 0, ...P }); // explicit disable
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: 1500 } })).toEqual({ inboundGraceMs: 1500, ...P });
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: 99999 } })).toEqual({ inboundGraceMs: 2000, ...P });
    // unknown keys are dropped (round-trip hygiene)
    expect(resolveRateLimit({ rateLimit: { inboundGraceMs: 1500, bogus: 1 } })).toEqual({ inboundGraceMs: 1500, ...P });
  });

  it('persist.enabled defaults to true; only an explicit false disables', () => {
    expect(resolveRateLimit({ rateLimit: { persist: {} } }).persist).toEqual({ enabled: true });
    expect(resolveRateLimit({ rateLimit: { persist: { enabled: 'yes' } } }).persist).toEqual({ enabled: true }); // junk = default
    expect(resolveRateLimit({ rateLimit: { persist: { enabled: false } } }).persist).toEqual({ enabled: false });
    expect(resolveRateLimit({ rateLimit: { persist: 'junk' } }).persist).toEqual({ enabled: true });
  });

  it('the default config template ships the knobs', () => {
    expect(defaultConfigYaml()).toContain('inboundGraceMs');
    expect(defaultConfigYaml()).toContain('persist');
  });
});

// ─── event log — triggered-decision ledger (unit + admin route) ─────────────

describe('RateLimitEventLog', () => {
  const ev = (over: Partial<RateLimitEventInput> = {}): RateLimitEventInput => ({
    direction: 'inbound',
    kind: 'denied',
    subject: 'apikey:k1',
    rule: '1m/requests',
    limitedBy: 'requests',
    retryAfterMs: 500,
    ...over,
  });

  it('keeps a repeat of the same subject+kind+rule inside the window as ONE coalesced entry', () => {
    const log = new RateLimitEventLog();
    log.record(ev(), 1_000);
    log.record(ev({ retryAfterMs: 300 }), 2_000);
    log.record(ev(), 12_500); // more than 10s after lastTs=2_000 → new entry
    const list = log.list();
    expect(list.length).toBe(2);
    expect(list[0].count).toBe(1); // newest first
    expect(list[0].ts).toBe(12_500);
    expect(list[1].count).toBe(2);
    expect(list[1].lastTs).toBe(2_000);
    expect(list[1].retryAfterMs).toBe(300); // refreshed by the latest repeat
  });

  it('does NOT coalesce across subject, kind, or rule', () => {
    const log = new RateLimitEventLog();
    log.record(ev(), 1_000);
    log.record(ev({ subject: 'apikey:k2' }), 1_001);
    log.record(ev({ kind: 'skipped', direction: 'outbound' }), 1_002);
    log.record(ev({ rule: '5m/tokens', limitedBy: 'tokens' }), 1_003);
    expect(log.list().length).toBe(4);
  });

  it('is a bounded ring — the oldest entries evict past capacity, never the newest', () => {
    const log = new RateLimitEventLog();
    for (let i = 0; i < 520; i++) log.record(ev({ subject: `apikey:k${i}` }), 1_000 + i);
    const list = log.list();
    expect(list.length).toBe(500);
    expect(list[0].subject).toBe('apikey:k519'); // newest survived
    expect(list.some((e) => e.subject === 'apikey:k19')).toBe(false); // oldest 20 evicted
  });

  it('clear() empties the ledger', () => {
    const log = new RateLimitEventLog();
    log.record(ev());
    log.clear();
    expect(log.list()).toEqual([]);
  });
});

describe('RateLimitEventLog — SQLite mirror (persist)', () => {
  const ev = (over: Partial<RateLimitEventInput> = {}): RateLimitEventInput => ({
    direction: 'inbound',
    kind: 'denied',
    subject: 'apikey:k1',
    rule: '1m/requests',
    limitedBy: 'requests',
    retryAfterMs: 500,
    ...over,
  });
  const DIR = path.join(RL_HOME, 'rl-store');

  it('survives a simulated restart: coalesced UPSERTs replay intact', async () => {
    const store1 = await openRateLimitEventStore(DIR);
    if (!store1) return; // non-bun runtime — memory-only mode, nothing to assert
    const log1 = new RateLimitEventLog();
    expect(log1.attachStore(store1)).toBe(0);
    log1.record(ev({ subject: 'apikey:a' }), 1_000);
    log1.record(ev({ subject: 'apikey:a' }), 2_000); // coalesces → same row UPSERTed
    log1.record(ev({ subject: 'apikey:b', direction: 'outbound', kind: 'skipped' }), 3_000);
    expect(log1.list().length).toBe(2);
    store1.close();

    const store2 = await openRateLimitEventStore(DIR);
    const log2 = new RateLimitEventLog();
    expect(store2 && log2.attachStore(store2)).toBe(2);
    const list = log2.list(); // newest first
    expect(list[0].subject).toBe('apikey:b');
    expect(list[1].subject).toBe('apikey:a');
    expect(list[1].count).toBe(2); // the coalesced repeat survived the restart
    expect(list[1].lastTs).toBe(2_000);
    store2?.close();
  });

  it('trims the durable mirror together with the ring', async () => {
    const store = await openRateLimitEventStore(DIR);
    if (!store) return;
    const log = new RateLimitEventLog();
    log.attachStore(store);
    for (let i = 0; i < 520; i++) log.record(ev({ subject: `apikey:t${i}` }), 10_000 + i);
    const rows = store.loadRecent(1000); // oldest first
    expect(rows.length).toBe(500);
    expect(rows[rows.length - 1].subject).toBe('apikey:t519'); // newest survived
    store.close();
  });

  it('clear() empties the mirror too (trace-store precedent)', async () => {
    const store = await openRateLimitEventStore(DIR);
    if (!store) return;
    const log = new RateLimitEventLog();
    log.attachStore(store);
    log.record(ev());
    log.clear();
    expect(store.loadRecent(10)).toEqual([]);
    store.close();
  });
});


// ─── raw-YAML save is a config save too (runtime view + limiter follow) ──────

describe('raw-YAML save syncs the whole runtime auth view', () => {
  it('POST /api/admin/config/raw refreshes apiKeys/credentials AND arms the limiter', async () => {
    setRateLimiterForTests(new RateLimiter());
    const fresh = getRateLimiter();
    const { app } = createServer(
      { ...loadConfig(), host: '127.0.0.1', webAuth: { enabled: false } } as RouterConfig,
      true
    );
    const yaml = [
      'port: 3000',
      'credentials:',
      '  gemini:',
      '    - keyHashPrefix: "deadbeef1234"',
      '      limits:',
      '        - { window: 1m, requests: 7 }',
      'apiKeys:',
      '  - id: key-raw',
      '    name: Raw Client',
      '    key: sk-ocr-raw-1',
      '    enabled: true',
      '    createdAt: "2026-01-01T00:00:00.000Z"',
      '    limits:',
      '      - { window: 1m, requests: 3 }',
      '',
    ].join('\n');
    const res = await app.inject({ method: 'POST', url: '/api/admin/config/raw', payload: { yaml } });
    expect(res.statusCode).toBe(200);
    // The module docstring promises "a key edited via the UI OR THE YAML
    // EDITOR" follows immediately — both writers must land in the SAME sync
    // routine (advisor D3: pre-fix saveRawConfig left runtimeConfigRef stale).
    const ref = getRuntimeConfigRef();
    expect(ref?.credentials?.gemini?.[0]?.keyHashPrefix).toBe('deadbeef1234');
    expect(ref?.apiKeys?.find((k) => k.id === 'key-raw')?.limits?.[0]?.requests).toBe(3);
    expect(fresh.isTracked(credentialSubject('gemini', 'deadbeef1234'))).toBe(true);
    expect(fresh.isTracked(apiKeySubject('key-raw'))).toBe(true);
  });
});

// ─── decision-wire metering (/v1/systemone fills key windows from usage) ─────

describe('decision-wire metering', () => {
  const SYS_REQ = {
    state: { ticket: 'T-1', content: 'Paid twice, fix please.' },
    questions: {
      escalate: { type: 'noul', instructions: 'Needs escalation?' },
    },
  } as any;

  it('completed decisions record protocol usage onto the calling key, and the cap then 429s', async () => {
    // REAL (non-mock) registry against a fake upstream: the decision wire
    // converts through a chat call, so usage must flow — prompt 120 +
    // completion 80 = 200 tokens per decision, cap 1m/tokens 300 → the THIRD
    // call is the one that 429s under the admission-time estimate (chars/4 of
    // the payload, ~40 here): call two fits (200 live + est < 300), call three
    // does not (400 live + est ≥ 300, with OR without the still-held
    // reservations — the UPPER bound is release-timing independent). The lower
    // bound and the third-call 429 DO assume both reply-close hooks have fired
    // (release + usage recording both run on close): pre-close, used ≈ 2·est
    // and the third call would still be admitted.
    const answers = JSON.stringify({ answers: { escalate: { noul: 0.4 } } });
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          id: 'u',
          object: 'chat.completion',
          created: 1,
          model: 'u',
          choices: [{ index: 0, message: { role: 'assistant', content: answers }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
        }),
    });
    try {
      setRateLimiterForTests(new RateLimiter());
      const rl = getRateLimiter();
      const config = {
        ...loadConfig(),
        host: '127.0.0.1',
        webAuth: { enabled: false },
        adminApiKey: 'master-dec',
        models: [
          {
            id: 'dec/model',
            provider: 'dec-chat',
            upstreamModel: 'u',
            tier: 'plus',
            supportedReasoningEfforts: ['none'],
            pricing: { input: 1, output: 2, cacheRead: 0 },
          },
        ],
        systemone: { defaultModel: 'dec/model' },
        requestCapture: { enabled: false },
        session: { enabled: false },
        tracePersist: { enabled: false },
        apiKeys: [
          {
            id: 'key-dec',
            name: 'Dec Client',
            key: 'sk-ocr-dec',
            enabled: true,
            createdAt: new Date().toISOString(),
            limits: [{ window: '1m', tokens: 300 }],
          },
        ],
      } as unknown as RouterConfig;
      const decChat = {
        name: 'dec-chat',
        type: 'openai-compatible' as const,
        baseUrl: `http://localhost:${upstream.port}`,
        apiKey: 'sk-test',
        timeoutMs: 5000,
      };
      const { app } = createServer(config, false, undefined, undefined, [decChat]);
      rl.reload(config); // execution-time rule load (collection-order, see inbound note)

      const call = () =>
        app.inject({
          method: 'POST',
          url: '/v1/systemone',
          headers: { authorization: 'Bearer sk-ocr-dec' },
          // model explicit: the omitted-model branch resolves against the
          // DISK systemone.defaultModel (sandbox file), not the boot config.
          payload: { ...SYS_REQ, model: 'dec/model' },
        });

      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      const win = rl.snapshot().find((w) => w.subject === apiKeySubject('key-dec'));
      // 2 decisions × 200 protocol tokens, PLUS whatever admission estimates
      // are still held (the close-release is asynchronous under inject) —
      // live usage alone is exactly 400.
      const est = Math.ceil(JSON.stringify({ ...SYS_REQ, model: 'dec/model' }).length / 4);
      expect(win?.used).toBeGreaterThanOrEqual(400);
      expect(win?.used).toBeLessThanOrEqual(400 + 2 * est);

      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.param).toBe('tokens');
    } finally {
      upstream.stop();
    }
  });
});

// ─── write-only windows stay bounded (review MAJOR-1 regression pin) ─────────

describe('prune-on-add', () => {
  it('a window that is NEVER read still discards expired events', () => {
    const rl = new RateLimiter();
    rl.reload({
      credentials: { p: [{ keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1m', requests: 5 }] }] },
    } as unknown as RouterConfig);
    const subject = credentialSubject('p', 'ab12cd34ef56');
    const t0 = 1_700_000_000_000;
    // 60 dispatches, one per minute: the decision wire is dispatch/recordUsage-
    // ONLY (no peek by frozen contract) — pre-fix this window grew forever.
    for (let i = 0; i < 60; i++) rl.dispatch(subject, t0 + i * 60_000);
    const win = (rl as unknown as { windows: Map<string, { events: unknown[]; head: number }> })
      .windows.get(`${subject}|60000|requests`);
    expect(win).toBeDefined();
    expect((win!.events.length - win!.head)).toBeLessThanOrEqual(2); // only the live minute
  });
});

// ─── bounded-memory degradation (MAX_WINDOW_EVENTS regression pin) ───────────

describe('window event cap', () => {
  it('a window past MAX_WINDOW_EVENTS drops its OLDEST live events and under-counts', () => {
    const rl = new RateLimiter();
    rl.reload({
      credentials: { p: [{ keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1d', requests: 5 }] }] },
    } as unknown as RouterConfig);
    const subject = credentialSubject('p', 'ab12cd34ef56');
    const t0 = 1_700_000_000_000;
    // Sustained saturation far past the cap: each dispatch advances ts so the
    // events stay live (1d window) — only the cap can evict them.
    const N = 100_001;
    for (let i = 0; i < N; i++) rl.dispatch(subject, t0 + i);
    const win = (rl as unknown as { windows: Map<string, { events: unknown[]; head: number }> })
      .windows.get(`${subject}|86400000|requests`);
    expect(win).toBeDefined();
    expect(win!.events.length - win!.head).toBeLessThanOrEqual(100_000);
    // Oldest dropped => sum = N - evicted; the window UNDER-counts (never over).
    const v = rl.peek(subject, t0 + N);
    expect(v.allowed).toBe(false); // far past the requests:5 cap either way
    if (!v.allowed) {
      // Exact values — the eviction is deterministic: 100,000 events survive
      // (t0+1 .. t0+100000), sum = 100,000, and msUntilBelow expires
      // 99,996 of them to get under requests:5, so the answer points at the
      // event at t0+99996: 86,400,000 - (100,001 - 99,996) = 86,400,000 - 5.
      // A regression that evicted MORE events would change both numbers.
      expect(v.used).toBe(100_000);
      expect(v.retryAfterMs).toBe(86_400_000 - 5);
    }
  });
});

// ─── durable window checkpoints (rateLimit.persist — restart continuity) ─────

describe('window checkpoint round-trip', () => {
  interface Row { key: string; data: string }
  function fakeStore() {
    const rows = new Map<string, string>();
    return {
      save(key: string, data: string) { rows.set(key, data); },
      loadAll(): Row[] { return [...rows].map(([key, data]) => ({ key, data })); },
      deleteStale(keep: string[]) {
        const k = new Set(keep);
        for (const key of [...rows.keys()]) if (!k.has(key)) rows.delete(key);
      },
      close() {},
      rows,
    };
  }

  it('checkpoint → new limiter rehydrates the SAME live sum (1d budget survives a restart)', () => {
    const store = fakeStore();
    const t0 = 1_700_000_000_000;
    // Lifetime 1: burn a token window on an explicit wall-clock timeline.
    const rl1 = limiterWith([{ id: 'kc', limits: [{ window: '1d', tokens: 1000 }] }]);
    rl1.attachWindowStore(store, t0);
    rl1.recordUsage(apiKeySubject('kc'), { tokens: 600 }, t0 + 10_000);
    rl1.recordUsage(apiKeySubject('kc'), { tokens: 300 }, t0 + 20_000);
    rl1.checkpoint();
    expect(store.rows.size).toBe(1);

    // Lifetime 2: a fresh engine on a DIFFERENT timebase origin — only the
    // wall-clock checkpoint carries the budget across.
    const rl2 = limiterWith([{ id: 'kc', limits: [{ window: '1d', tokens: 1000 }] }]);
    expect(rl2.attachWindowStore(store, t0 + 40_000)).toBe(1);
    // 900/1000 live after the restart — the window rehydrated, not reset.
    expect(rl2.peek(apiKeySubject('kc'), t0 + 40_000).allowed).toBe(true);
    // One more 600 fills it: the pre-restart usage is genuinely in the window.
    rl2.recordUsage(apiKeySubject('kc'), { tokens: 600 }, t0 + 41_000);
    expect(rl2.peek(apiKeySubject('kc'), t0 + 42_000).allowed).toBe(false);
    // …and it reopens as the PRE-RESTART usage ages out (t0+10s event).
    expect(rl2.peek(apiKeySubject('kc'), t0 + 10_000 + 86_400_000 + 1).allowed).toBe(true);
  });

  it('a stale checkpoint row (constraint removed) is skipped and GCed at the next checkpoint', () => {
    const store = fakeStore();
    const t0 = 1_700_000_000_000;
    const rl1 = limiterWith([{ id: 'kd', limits: [{ window: '1m', requests: 5 }] }]);
    rl1.attachWindowStore(store, t0);
    rl1.dispatch(apiKeySubject('kd'), t0);
    rl1.checkpoint();
    expect(store.rows.size).toBe(1);

    // Lifetime 2: the rule is gone entirely.
    const rl2 = limiterWith([]); // no limits anywhere
    expect(rl2.attachWindowStore(store, t0)).toBe(0);
    rl2.checkpoint();
    expect(store.rows.size).toBe(0); // GCed
  });

  it('a corrupted checkpoint row is skipped (fail-open), not fatal', () => {
    const store = fakeStore();
    store.save('apikey:kc|86400000|tokens', '{not json');
    const rl = limiterWith([{ id: 'kc', limits: [{ window: '1d', tokens: 1000 }] }]);
    expect(rl.attachWindowStore(store, 0)).toBe(0);
    expect(rl.peek(apiKeySubject('kc')).allowed).toBe(true); // fresh window
  });
});

// ─── upstream-429 feedback (penalize — provider-declared wait shapes the pool) ──

describe('upstream-429 cooldown', () => {
  const t0 = 1_700_000_000_000;
  const subject = credentialSubject('p', 'ab12cd34ef56');
  const limiter = () => {
    const rl = new RateLimiter();
    rl.reload({
      credentials: { p: [{ keyHashPrefix: 'ab12cd34ef56', limits: [{ window: '1m', requests: 100 }] }] },
    } as unknown as RouterConfig);
    return rl;
  };

  it('a penalized credential is denied until the declared wait elapses, then GCed on touch', () => {
    const rl = limiter();
    rl.penalize(subject, 60_000, t0);
    const v = rl.peek(subject, t0 + 1);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe('upstream-429');
      expect(v.retryAfterMs).toBe(60_000 - 1);
    }
    // window math resumes exactly at the deadline
    expect(rl.peek(subject, t0 + 60_000).allowed).toBe(true);
  });

  it('penalties clamp to [1s, 1d] and stack by max', () => {
    const rl = limiter();
    rl.penalize(subject, 30 * 86_400_000, t0); // pathological header
    const v = rl.peek(subject, t0);
    if (!v.allowed) expect(v.retryAfterMs).toBeLessThanOrEqual(86_400_000);
    rl.penalize(subject, 5_000, t0); // shorter — does not extend
    expect(rl.peek(subject, t0 + 86_400_000).allowed).toBe(true);
  });

  it('reload drops cooldowns of constraints that no longer exist', () => {
    const rl = limiter();
    rl.penalize(subject, 60_000, t0);
    rl.reload({} as unknown as RouterConfig);
    expect(rl.peek(subject, t0).allowed).toBe(true);
  });
});

// ─── admission-time token pre-reservation (estimate cannot blow the cap) ──────

describe('token pre-reservation', () => {
  const t0 = 1_700_000_000_000;

  it('an estimate larger than the remaining budget is denied BEFORE dispatch', () => {
    const rl = limiterWith([{ id: 'kr', limits: [{ window: '1m', tokens: 1000 }] }]);
    expect(rl.tryDispatchWithEstimate(apiKeySubject('kr'), 600, t0).allowed).toBe(true);
    // 600 committed + 500 estimate > 1000 — the second admission waits
    const v = rl.tryDispatchWithEstimate(apiKeySubject('kr'), 500, t0 + 1);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.limitedBy).toBe('tokens');
      expect(v.limit).toBe(1000);
      // used = the POST-admission sum the check tested: 600 committed + 500 estimate
      expect(v.used).toBe(1100);
    }
    // …and a denied estimate consumed NO request slot and NO reservation
    // (399 still fits: the 600 reservation from the first admission holds)
    expect(rl.tryDispatchWithEstimate(apiKeySubject('kr'), 399, t0 + 2).allowed).toBe(true);
  });

  it('releaseEstimate reconciles: window nets to ACTUAL usage, failed turns leave nothing', () => {
    const rl = limiterWith([{ id: 'ks', limits: [{ window: '1m', tokens: 1000 }] }]);
    expect(rl.tryDispatchWithEstimate(apiKeySubject('ks'), 600, t0).allowed).toBe(true);
    rl.recordUsage(apiKeySubject('ks'), { tokens: 300 }, t0 + 10); // actual < estimate
    rl.releaseEstimate(apiKeySubject('ks'), 600); // terminal reconcile
    // net = 300 actual — 699 more fits (700 would exactly hit the cap)
    expect(rl.tryDispatchWithEstimate(apiKeySubject('ks'), 699, t0 + 12).allowed).toBe(true);
    expect(rl.tryDispatchWithEstimate(apiKeySubject('ks'), 10, t0 + 13).allowed).toBe(false);
  });
});
