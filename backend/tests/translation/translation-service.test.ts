import { beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { harnessEnvDir } from '../../src/harness/host/manifest.js';
import { registerTranslationRoutes } from '../../src/routes/translation.js';
import {
  getCachedTranslation,
  readCachedTranslations,
  translateDescription,
  translationStoreDir,
} from '../../src/translation/index.js';
import { currentYaml } from '../helpers/current-config.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-translation-service-'));
process.env.OCR_HOME = path.join(sandbox, 'home');
process.env.OCR_ENV = 'default';
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.writeFileSync(
  path.join(ENV_DIR, 'config.yaml'),
  currentYaml(
    'schemaVersion: 3\nclient:\n  port: 3000\n  host: 127.0.0.1\n' +
      '  apiKeys:\n    - id: key-test\n      name: test\n      key: sk-ocr-internal-test\n      enabled: true\n      createdAt: "2026-01-01T00:00:00.000Z"\n'
  ),
  'utf8'
);

beforeEach(() => {
  for (const kind of ['descriptions', 'readme', 'segments']) {
    fs.rmSync(path.join(translationStoreDir(), kind), { recursive: true, force: true });
    fs.rmSync(path.join(harnessEnvDir(), 'i18n', kind), { recursive: true, force: true });
  }
});

describe('shared translation service & canonical routes', () => {
  it('promotes per-file entries lazily from legacy harness/i18n to shared i18n', () => {
    const source = 'Fetch remote MCP schemas safely';
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const legacyFile = path.join(harnessEnvDir(), 'i18n', 'descriptions', `${hash}.zh.json`);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ text: '安全获取远程 MCP Schema', model: 'legacy/model', at: '2026-01-01T00:00:00Z' }),
      'utf8'
    );

    const hit = getCachedTranslation(source, 'zh');
    expect(hit?.text).toBe('安全获取远程 MCP Schema');
    expect(fs.existsSync(path.join(translationStoreDir(), 'descriptions', `${hash}.zh.json`))).toBe(true);
    expect(readCachedTranslations([source], 'zh')[source]?.text).toBe('安全获取远程 MCP Schema');
  });

  it('serves canonical /api/admin/translate* and /api/admin/translations* routes', async () => {
    const source = 'Inspect MCP tool arguments';
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const file = path.join(translationStoreDir(), 'descriptions', `${hash}.zh.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ text: '检查 MCP 工具参数', model: 'seeded/model', at: new Date().toISOString() }),
      'utf8'
    );

    const app = fastify();
    registerTranslationRoutes(app);

    const lookupRes = await app.inject({
      method: 'POST',
      url: '/api/admin/translations',
      payload: { lang: 'zh', texts: [source] },
    });
    expect(lookupRes.statusCode).toBe(200);
    expect(lookupRes.json().translations[source].text).toBe('检查 MCP 工具参数');

    const translateRes = await app.inject({
      method: 'POST',
      url: '/api/admin/translate',
      payload: { lang: 'zh', text: source },
    });
    expect(translateRes.statusCode).toBe(200);
    expect(translateRes.json()).toMatchObject({
      status: 'ok',
      text: '检查 MCP 工具参数',
      cached: true,
      model: 'seeded/model',
    });

    const batchRes = await app.inject({
      method: 'POST',
      url: '/api/admin/translate-batch',
      payload: { lang: 'zh', texts: [source] },
    });
    expect(batchRes.statusCode).toBe(200);
    expect(batchRes.json().results[source].text).toBe('检查 MCP 工具参数');
  });

  it('skips reading and writing disk cache when cache: false is passed', async () => {
    const source = 'Ephemeral external payload';
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const file = path.join(translationStoreDir(), 'descriptions', `${hash}.zh.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ text: '不应命中的缓存', model: 'seeded/model', at: new Date().toISOString() }),
      'utf8'
    );

    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          model: 'ephemeral-model',
          choices: [{ message: { content: '临时外部负载' }, finish_reason: 'stop' }],
        });
      },
    });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/chat/completions')) {
        return prevFetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, init);
      }
      return prevFetch(input, init);
    }) as typeof fetch;

    try {
      const res = await translateDescription(source, 'zh', {
        apiKey: 'sk-caller-key',
        sessionId: 'caller-session-1',
        cache: false,
      });
      expect(res).toEqual({ text: '临时外部负载', cached: false, model: 'ephemeral-model' });
      // Existing disk cache entry was neither read nor overwritten.
      expect(getCachedTranslation(source, 'zh')?.text).toBe('不应命中的缓存');
    } finally {
      globalThis.fetch = prevFetch;
      server.stop(true);
    }
  });
});
