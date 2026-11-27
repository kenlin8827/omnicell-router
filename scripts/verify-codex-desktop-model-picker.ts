/**
 * Sandbox smoke: unified Codex hook → merged catalog → app-server model/list.
 * Never touches the operator's live ~/.codex (uses a temp CODEX_HOME).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { CodexClientAdapter } from '../backend/src/cli/clients/codex.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-codex-desktop-smoke-'));
const configPath = path.join(tmp, 'config.toml');
const catalogPath = path.join(tmp, 'chatgpt-ocr-models.json');
const codexBin = process.env.CODEX_BIN || 'codex';

function fail(msg: string): never {
  console.error('FAIL:', msg);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
}

fs.writeFileSync(configPath, ['model = "gpt-5.4"', 'model_provider = "openai"', ''].join('\n'));

const adapter = new CodexClientAdapter();
adapter.getConfigPath = () => configPath;

const setup = await adapter.setup({
  port: 8787,
  models: { main: 'gpt-5.4' },
  apiKey: 'sk-smoke-codex',
  virtualModels: [],
});
if (!setup.success) fail(`setup failed: ${setup.message}`);
if (!fs.existsSync(catalogPath)) fail(`missing catalog ${catalogPath}`);

const cfg = fs.readFileSync(configPath, 'utf8');
if (!/openai_base_url\s*=/.test(cfg)) fail('config missing openai_base_url');
if (!/model_provider\s*=\s*"openai"/.test(cfg)) fail('config model_provider is not openai');

const onDisk = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
  models: Array<{ slug: string; visibility?: string; hidden?: boolean }>;
};
const expectedVisible = onDisk.models.filter((m) => m.visibility === 'list' && m.hidden !== true);
console.log('sandbox', tmp);
console.log('catalog_on_disk', onDisk.models.length);
console.log('expected_picker_visible', expectedVisible.length);
if (expectedVisible.length === 0) fail('stock catalog empty');

type RpcMsg = {
  id?: number;
  method?: string;
  result?: { data?: Array<{ model: string; hidden?: boolean }>; nextCursor?: string | null };
  error?: { message?: string };
};

const proc = spawn(codexBin, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: tmp },
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

const waitFor = (pred: (msg: RpcMsg) => boolean, label: string, ms = 30000): Promise<RpcMsg> =>
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
      clientInfo: { name: 'ocr_codex_desktop_verify', title: 'OCR Codex Desktop Verify', version: '0.0.1' },
    },
  });
  const init = await waitFor((m) => m.id === 1, 'initialize');
  if (init.error) fail(`initialize error: ${JSON.stringify(init.error)}`);
  send({ method: 'initialized' });

  const all: Array<{ model: string; hidden?: boolean }> = [];
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
    all.push(...(resp.result?.data || []));
    cursor = resp.result?.nextCursor ?? null;
  } while (cursor);

  const visible = all.filter((m) => !m.hidden);
  const slugs = visible.map((m) => m.model);
  console.log('model_list_visible', visible.length);
  console.log('sample', slugs.slice(0, 12).join(', '));

  if (visible.length === 0) fail('model/list returned ZERO picker-visible models');
  const missing = expectedVisible.map((m) => m.slug).filter((s) => !slugs.includes(s));
  if (missing.length > 0) {
    console.error('missing_from_picker', missing.slice(0, 20).join(', '));
    fail(`${missing.length} catalog models missing from model/list`);
  }

  console.log('PASS: Codex desktop sandbox model/list matches stock catalog');
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
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
