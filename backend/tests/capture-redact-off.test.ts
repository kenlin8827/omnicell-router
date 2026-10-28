/**
 * `requestCapture.redactSecrets: false` — the operator opt-OUT of capture-side
 * credential redaction. Pins:
 *   • with redactSecrets false, credential-shaped header values persist
 *     VERBATIM in the archive (authorization keeps the raw bearer token);
 *   • default (true) keeps redaction — covered by capture.test.ts /
 *     capture-keyid.test.ts, not re-pinned here.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

const CLIENT_KEY = 'sk-ocr-redact-off-0123456789abcdef';
const MASTER_KEY = 'sk-ocr-redact-off-master';

let tmp: string;
let app: FastifyInstance;
let dateDir: string;

function readEvents(): any[] {
  const dir = path.join(tmp, dateDir);
  if (!fs.existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const ev = JSON.parse(line);
      if (ev.eventType === 'http-exchange') out.push(ev);
    }
  }
  return out;
}

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`capture events did not settle within ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('capture redactSecrets opt-out', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-redactoff-'));
    dateDir = CaptureRecorder.localDateDir(new Date());
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.adminKey = MASTER_KEY;
    config.apiKeys = [
      {
        id: 'key-redact-off',
        name: 'RedactOff Fixture',
        key: CLIENT_KEY,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    config.requestCapture = {
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 64,
      maxBodyBytes: 65536,
      redactSecrets: false,
    };
    app = createServer(config, true).app; // mockMode
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('redactSecrets:false persists the raw authorization value', async () => {
    const marker = `REDACTOFF-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${CLIENT_KEY}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(res.statusCode, 200);

    await waitUntil(() => readEvents().some(e => JSON.stringify(e.wire ?? {}).includes(marker)));
    const reqEv = readEvents().find(e => e.direction === 'client' && e.phase === 'request')!;
    assert.ok(reqEv, 'client request event captured');
    assert.equal(reqEv.wire.requestHeaders['authorization'], `Bearer ${CLIENT_KEY}`,
      'authorization value persists verbatim when redaction is opted out');
  });
});
