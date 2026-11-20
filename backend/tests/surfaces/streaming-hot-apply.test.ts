import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveRawConfig } from '../../src/config/index.js';
import { applyStreamingPosture } from '../../src/pipeline/streaming-posture.js';
import { createServer } from '../../src/server.js';
import { SCHEMA_VERSION } from '../../src/config/schema.js';

/**
 * The streaming posture is HOT-APPLIED (ADR-0008 §1): both save handlers call
 * `applyStreamingPosture` beside `applyDirectivesConfig`, and every request
 * reads it once at admission. This test boots the REAL server (mock registry, no
 * upstream) and proves the operator promise end-to-end — flip `client.mode`
 * through the raw-YAML save path and the very next request follows, with no
 * restart. It deliberately does not re-test the gate itself (surface-chat.test.ts
 * owns deny/always/allow) nor the migration (config-migration.test.ts).
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-stream-hot-'));
const envDir = path.join(sandbox, 'home', 'envs', 'default');
const configPath = path.join(envDir, 'config.yaml');
const yamlFor = (mode: 'allow' | 'deny' | 'always') => `schemaVersion: ${SCHEMA_VERSION}
client:
  host: 127.0.0.1
upstream:
  streaming:
    client:
      mode: ${mode}
`;

fs.mkdirSync(envDir, { recursive: true });
fs.writeFileSync(configPath, yamlFor('deny'));
fs.writeFileSync(path.join(envDir, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));
process.env.OCR_HOME = path.join(sandbox, 'home');
process.env.OCR_ENV = 'default';

let app: ReturnType<typeof createServer>['app'];
let base = '';

async function chat(stream: boolean): Promise<{ status: number; type: string | null }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream }),
  });
  await res.text();
  return { status: res.status, type: res.headers.get('content-type') };
}

/** Exactly what the save handlers do after a successful write. */
function saveAndApply(mode: 'allow' | 'deny' | 'always'): void {
  const result = saveRawConfig(yamlFor(mode));
  if (!result.success) throw new Error(result.error);
  applyStreamingPosture(loadConfig().streaming);
}

describe('streaming posture — hot apply through the console save path', () => {
  beforeAll(async () => {
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    ({ app } = createServer(config, true));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    // The sandbox lives under the isolated runner's TMP, which it owns and
    // removes; deleting it here races the server's config-file watcher on
    // Windows (EBUSY) and buys nothing.
    await app.close();
  });

  it('a mode change lands on the NEXT request — no restart', async () => {
    expect((await chat(true)).status).toBe(400); // deny, as booted
    expect((await chat(false)).status).toBe(200); // JSON still flows

    saveAndApply('allow');
    const streamed = await chat(true);
    expect(streamed.status).toBe(200);
    expect(streamed.type).toContain('text/event-stream');

    saveAndApply('deny');
    expect((await chat(true)).status).toBe(400); // and back again, same process
  });

  it('always answers a JSON ask in SSE', async () => {
    saveAndApply('always');
    const res = await chat(false);
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/event-stream');
    saveAndApply('deny');
  });
});
