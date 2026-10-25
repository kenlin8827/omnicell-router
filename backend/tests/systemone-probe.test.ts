import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { probeSystemoneDefault } from '../src/surfaces/systemone-probe.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * The System One default-model probe fires the REAL /v1/systemone fallback path (model omitted →
 * `systemone.defaultModel`): the same admission gates an omitted-model client request meets, over
 * a one-question noul payload. Unset config → the surface's own 400 condition, reported without a
 * call; an unknown id → the surface's 404, reported with its body snippet.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sysone-probe-'));
process.env.OCR_HOME = path.join(sandbox, 'home');
// This file owns its home → declare its book-set name too (the runner injects `itest`).
process.env.OCR_ENV = 'default';
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
const BASE_CONFIG =
  'port: 3000\nhost: 127.0.0.1\nmodels: []\n' +
  'apiKeys:\n  - id: key-test\n    name: test\n    key: sk-ocr-internal-test\n    enabled: true\n    createdAt: "2026-01-01T00:00:00.000Z"\n';

function writeSysoneConfig(defaultModel?: string): void {
  const section = defaultModel === undefined ? '' : `systemone:\n  defaultModel: ${defaultModel}\n`;
  fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), BASE_CONFIG + section, 'utf8');
}

const OK_BODY = JSON.stringify({
  model: 'my-decision-model',
  answers: { probe: { type: 'noul', noul: 0.5 } },
});

describe('probeSystemoneDefault', () => {
  it('reports not_configured without a call when systemone.defaultModel is unset', async () => {
    writeSysoneConfig(undefined);
    expect(loadConfig().systemone?.defaultModel).toBeUndefined();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('unset config means no call');
    }) as unknown as typeof fetch;
    try {
      const probe = await probeSystemoneDefault();
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('not_configured');
      expect(probe.configured).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fires the omitted-model surface path and echoes the served model', async () => {
    writeSysoneConfig('my-decision-model');
    let askedBody = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      askedBody = String(init?.body);
      return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const probe = await probeSystemoneDefault();
      expect(probe.ok).toBe(true);
      expect(probe.model).toBe('my-decision-model');
      expect(probe.configured).toBe('my-decision-model');
      // The probe MUST omit `model` — the fallback path is the thing under test.
      const parsed = JSON.parse(askedBody) as { model?: string; questions: Record<string, { type: string }> };
      expect(parsed.model).toBeUndefined();
      expect(Object.values(parsed.questions)[0]?.type).toBe('noul');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('carries the surface error body when the model is not registered', async () => {
    writeSysoneConfig('ghost-model');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: 'model_not_found', message: "Model 'ghost-model' not found." }),
        { status: 404 }
      )) as unknown as typeof fetch;
    try {
      const probe = await probeSystemoneDefault();
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('upstream');
      expect(probe.error).toContain('404');
      expect(probe.error).toContain('not found');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('rides the pending selection as model when an override is given', async () => {
    writeSysoneConfig('saved-model');
    let askedBody = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      askedBody = String(init?.body);
      return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const probe = await probeSystemoneDefault('pending-model');
      expect(probe.ok).toBe(true);
      expect(probe.model).toBe('my-decision-model');
      // The pending value rides as an explicit model — the gate chain a save would produce.
      expect((JSON.parse(askedBody) as { model: string }).model).toBe('pending-model');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports not_configured for a cleared picker without a call', async () => {
    writeSysoneConfig('saved-model');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('cleared picker means no call');
    }) as unknown as typeof fetch;
    try {
      const probe = await probeSystemoneDefault('');
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('not_configured');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('systemone probe route', () => {
  it('returns the probe verdict over /api/admin/systemone/probe', async () => {
    writeSysoneConfig('my-decision-model');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/admin/systemone/probe', payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; model?: string; configured: string };
      expect(body.ok).toBe(true);
      expect(body.model).toBe('my-decision-model');
      expect(body.configured).toBe('my-decision-model');
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
