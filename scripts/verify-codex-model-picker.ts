/**
 * Verify the same model list Codex `/model` uses: fresh app-server + model/list.
 * Uses the operator's live ~/.codex (already OCR-hooked) unless CODEX_HOME is set.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexBin = process.env.CODEX_BIN || 'codex';
const catalogPath = path.join(home, 'omnicell-router-models.json');
const configPath = path.join(home, 'config.toml');

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

if (!fs.existsSync(configPath)) fail(`missing ${configPath}`);
const cfg = fs.readFileSync(configPath, 'utf8');
const hooked =
  /openai_base_url\s*=\s*"?http:\/\/127\.0\.0\.1:\d+\/v1/.test(cfg) ||
  /model_provider\s*=\s*"omnicell-router"/.test(cfg);
if (!hooked) fail('config is not OCR-hooked (need openai_base_url or legacy omnicell-router)');
if (!/model_catalog_json\s*=/.test(cfg)) fail('config missing model_catalog_json');
if (!fs.existsSync(catalogPath)) fail(`missing catalog ${catalogPath}`);

const onDisk = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
  models: Array<{ slug: string; visibility?: string; hidden?: boolean }>;
};
const expectedVisible = onDisk.models.filter(
  (m) => m.visibility === 'list' && m.hidden !== true,
);
console.log('home', home);
console.log('bin', codexBin);
console.log('catalog_on_disk', onDisk.models.length);
console.log('expected_picker_visible', expectedVisible.length);

type RpcMsg = {
  id?: number;
  method?: string;
  result?: { data?: Array<{ model: string; displayName?: string; hidden?: boolean }>; nextCursor?: string | null };
  error?: { code?: number; message?: string };
};

const proc = spawn(codexBin, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: home },
  windowsHide: true,
});

const rl = readline.createInterface({ input: proc.stdout! });
const send = (message: unknown) => {
  proc.stdin!.write(`${JSON.stringify(message)}\n`);
};

let stderr = '';
proc.stderr?.on('data', (d) => {
  stderr += String(d);
});

const waitFor = (pred: (msg: RpcMsg) => boolean, label: string, ms = 20000): Promise<RpcMsg> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}; stderr=${stderr.slice(0, 800)}`));
    }, ms);
    const onLine = (line: string) => {
      let msg: RpcMsg;
      try {
        msg = JSON.parse(line) as RpcMsg;
      } catch {
        return;
      }
      if (!pred(msg)) return;
      cleanup();
      resolve(msg);
    };
    const cleanup = () => {
      clearTimeout(timer);
      rl.off('line', onLine);
    };
    rl.on('line', onLine);
  });

const exitPromise = new Promise<number>((resolve) => {
  proc.on('exit', (code) => resolve(code ?? -1));
});

try {
  send({
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'ocr_verify', title: 'OCR Verify', version: '0.0.1' },
    },
  });
  const init = await waitFor((m) => m.id === 1, 'initialize');
  if (init.error) fail(`initialize error: ${JSON.stringify(init.error)}`);
  send({ method: 'initialized' });

  const all: Array<{ model: string; displayName?: string; hidden?: boolean }> = [];
  let cursor: string | null | undefined = null;
  let page = 0;
  do {
    page += 1;
    const id = 100 + page;
    send({
      method: 'model/list',
      id,
      params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
    });
    const resp = await waitFor((m) => m.id === id, `model/list page ${page}`);
    if (resp.error) fail(`model/list error: ${JSON.stringify(resp.error)}`);
    const data = resp.result?.data || [];
    all.push(...data);
    cursor = resp.result?.nextCursor ?? null;
  } while (cursor);

  const visible = all.filter((m) => !m.hidden);
  const slugs = visible.map((m) => m.model);
  console.log('model_list_visible', visible.length);
  console.log('sample', slugs.slice(0, 12).join(', '));

  const missing = expectedVisible.map((m) => m.slug).filter((s) => !slugs.includes(s));
  const unexpectedEmpty = visible.length === 0;
  if (unexpectedEmpty) fail('model/list returned ZERO picker-visible models');
  if (missing.length > 0) {
    console.error('missing_from_picker', missing.slice(0, 20).join(', '));
    fail(`${missing.length} catalog models missing from model/list`);
  }

  // Spot-check OCR tiers + at least one concrete follow model.
  for (const need of ['auto', 'pro', 'lite']) {
    if (!slugs.includes(need)) fail(`expected tier '${need}' in picker`);
  }

  console.log('PASS: fresh app-server model/list matches catalog (picker-visible)');
  console.log(
    'NOTE: ChatGPT Desktop may still hide custom slugs via its online allowlist; CLI /model uses this list.',
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  try {
    proc.stdin?.end();
  } catch {
    /* ignore */
  }
  proc.kill();
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);
}
