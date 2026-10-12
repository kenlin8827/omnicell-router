/**
 * End-to-end capture sanity check: boot the server in mock mode with
 * capture enabled, fire one chat completion, dump the resulting JSONL.
 * Run: bun backend/scripts/e2e-capture-check.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OCR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-e2e-capture-'));

const { loadConfig } = await import('../src/config/index.js');
const { createServer } = await import('../src/server.js');

const config = loadConfig();
// Pin auth keys so the e2e check works regardless of the user's disk config.
config.adminApiKey = 'e2e-admin-key';
config.apiKeys = [{ key: 'e2e-client-key', name: 'e2e' } as any];
config.requestCapture = {
  enabled: true,
  dir: path.join(process.env.OCR_HOME, 'capture'),
  retentionDays: 1,
  maxTotalMB: 64,
  maxBodyBytes: 64 * 1024,
};

const { app } = createServer(config, true); // mockMode
await app.ready();

const res = await app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers: { authorization: 'Bearer e2e-client-key', 'x-session-id': 'sess_e2e_capture' },
  payload: { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
});
console.log('HTTP', res.statusCode);

// Wait briefly for async recordEvent writes to flush.
await new Promise(r => setTimeout(r, 300));
await app.close();

const dir = config.requestCapture.dir!;
const dateDir = fs.readdirSync(dir)[0];
const file = path.join(dir, dateDir, fs.readdirSync(path.join(dir, dateDir))[0]);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
console.log(`\n=== ${lines.length} events in ${path.basename(file)} ===`);
for (const l of lines) {
  const ev = JSON.parse(l);
  console.log(`\n--- ${ev.direction}/${ev.phase} span=${ev.spanId} trace=${ev.traceId.slice(0, 12)} model=${ev.model} status=${ev.status}`);
  console.log('reqLine :', ev.wire.requestLine || '(empty)');
  console.log('reqHdrs :', JSON.stringify(ev.wire.requestHeaders));
  console.log('reqBody :', String(ev.wire.requestBody).slice(0, 120));
  console.log('resLine :', ev.wire.responseLine || '(empty)');
  console.log('resHdrs :', JSON.stringify(ev.wire.responseHeaders));
  console.log('resBody :', String(ev.wire.responseBody).slice(0, 160));
}
fs.rmSync(process.env.OCR_HOME, { recursive: true, force: true });
