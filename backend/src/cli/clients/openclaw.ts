import path from 'node:path';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import { applyEdits, modify, parse, type JSONPath, type ParseError } from 'jsonc-parser';
import {
  ClientAdapter,
  restoreBackup,
  describeBackup,
  defaultGatewayPort,
} from './base.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { openclawConfigPath } from '../paths.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';
import { resolveClientModelMeta, type ClientModelMeta } from './model-meta.js';

/**
 * Vendor-truth config resolution: `openclaw config file --json` prints the path
 * the OpenClaw CLI itself will use (OPENCLAW_CONFIG_PATH, OPENCLAW_HOME and named
 * profiles all honored — the vendor resolves its home dir, we cannot reproduce
 * that from os.homedir()). The static ~/.openclaw guess in cli/paths.ts is only
 * the fallback for a machine where the CLI is missing or fails. Cached for the
 * process lifetime: the resolution spawns a subprocess and callers hit it on
 * every setup/teardown/status.
 */
let vendorPathCache: string | null | undefined;
function vendorConfigPath(): Promise<string | null> {
  if (vendorPathCache !== undefined) return Promise.resolve(vendorPathCache);
  return new Promise((resolve) => {
    // `exec` (cmd /c) not `execFile`: the CLI is commonly an app-execution
    // alias (a 0-byte reparse point in WindowsApps) that direct spawns —
    // notably Bun's — cannot execute (ENOENT). The shell resolves it.
    exec('openclaw config file --json', { timeout: 5000 }, (err, stdout) => {
      if (err) {
        vendorPathCache = null;
      } else {
        try {
          const parsed = JSON.parse(stdout) as { path?: unknown };
          vendorPathCache = typeof parsed.path === 'string' && parsed.path ? parsed.path : null;
        } catch {
          vendorPathCache = null;
        }
      }
      resolve(vendorPathCache);
    });
  });
}

/**
 * Hook target: OpenClaw's `openclaw.json` — the path the vendor CLI itself
 * reports (`openclaw config file --json`, honoring OPENCLAW_CONFIG_PATH /
 * OPENCLAW_HOME / named profiles), falling back to the static
 * `~/.openclaw/openclaw.json` guess in cli/paths.ts when the CLI is absent.
 *
 * OpenClaw validates its config against a STRICT schema — an unknown key makes
 * the gateway refuse to start — so this adapter writes ONLY documented keys:
 *
 *   models.providers.omnicell-router = { baseUrl, apiKey, api: 'openai-completions', models: [...] }
 *   agents.defaults.model.primary   = 'omnicell-router/<model id>'
 *
 * Adapter state (the previous primary pin) lives in a SIDECAR file, never in
 * the config: an `_ocr_*` marker key would be exactly the unknown key the
 * schema rejects. The file is JSON5 (comments + trailing commas) and is edited
 * text-level through jsonc-parser, so the user's comments and formatting
 * survive; a file this parser cannot read (e.g. unquoted keys) is REFUSED, not
 * rewritten.
 */
export class OpenClawClientAdapter implements ClientAdapter {
  name = 'openclaw' as const;
  hookKind = 'config' as const;
  displayName = 'OpenClaw';

  versionCmd = ['openclaw', '--version'];

  /** Provider entry this adapter owns inside `models.providers`. */
  private static readonly PROVIDER_ID = 'omnicell-router';

  getConfigPath(): string {
    return openclawConfigPath();
  }
  /** Resolved hook target: vendor CLI answer when available, else the static
   *  guess. Overridable seam — tests pin this instead of the vendor probe. */
  async resolveConfigPath(): Promise<string> {
    return (await vendorConfigPath()) ?? this.getConfigPath();
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const configPath = await this.resolveConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'No OpenClaw configuration detected';
    let mainValue: string | undefined;
    let extras: string[] | undefined;
    let parsed: any;

    if (exists) {
      const data = parsed = readConfig(configPath);
      if (data === null) {
        details = 'Config present but could not be parsed as JSON/JSONC — fix it manually, then re-apply';
      } else {
        const provider = data?.models?.providers?.[OpenClawClientAdapter.PROVIDER_ID];
        if (isPlainObject(provider) && typeof provider.baseUrl === 'string') {
          hooked = true;
          details = `Routed to OmniCellRouter gateway (${provider.baseUrl}, openai-completions)`;
          const primary = data?.agents?.defaults?.model?.primary;
          const prefix = `${OpenClawClientAdapter.PROVIDER_ID}/`;
          if (typeof primary === 'string' && primary.startsWith(prefix)) {
            mainValue = primary.slice(prefix.length);
          }
          const entries = Array.isArray(provider.models) ? provider.models : [];
          extras = entries
            .map(m => (isPlainObject(m) && typeof m.id === 'string' ? m.id : ''))
            .filter(id => id && !VIRTUAL_AUTO_IDS.has(id) && id !== mainValue);
        } else {
          details = 'Active with native providers';
        }
      }
    }

    const strip = (ref: unknown): string | undefined =>
      typeof ref === 'string' && ref.startsWith(`${OpenClawClientAdapter.PROVIDER_ID}/`)
        ? ref.slice(OpenClawClientAdapter.PROVIDER_ID.length + 1)
        : undefined;
    const fallbacks = Array.isArray(parsed?.agents?.defaults?.model?.fallbacks)
      ? parsed.agents.defaults.model.fallbacks
      : [];

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [
        { key: 'main', value: mainValue, default: 'auto' },
        { key: 'fallback', value: strip(fallbacks[0]), default: '' },
        { key: 'utility', value: strip(parsed?.agents?.defaults?.utilityModel), default: '' },
        { key: 'decision', value: strip(parsed?.agents?.defaults?.decisionModel), default: '' },
      ],
      extraModels: extras,
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    apiKey?: string;
    extraModels?: string[];
    /** Follow mode: the virtual tier subset the selected key's policy admits. */
    virtualModels?: string[];
  }): Promise<{ success: boolean; message: string }> {
    const configPath = await this.resolveConfigPath();
    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      return {
        success: false,
        message: 'OpenClaw takeover requires a gateway API key (it is written into models.providers.omnicell-router)',
      };
    }

    const exists = fs.existsSync(configPath);
    let data: any = {};
    if (exists) {
      data = readConfig(configPath);
      if (data === null) {
        return {
          success: false,
          message: `Could not parse ${configPath} as JSON/JSONC (JSON5 unquoted keys or single quotes are not editable safely); refusing to overwrite`,
        };
      }
      const shapeError = this.validateShape(data);
      if (shapeError) return { success: false, message: shapeError };
    }
    const main = options?.models?.main?.trim() || 'auto';
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => options.virtualModels!.includes(id))
      : [...VIRTUAL_AUTO_IDS];
    const rawExtras = (options?.extraModels || []).map(id => (id || '').trim()).filter(Boolean);
    const concreteExtras = [...new Set(rawExtras.filter(id => !VIRTUAL_AUTO_IDS.has(id)))];
    // List order mirrors the gateway's /v1/models view exactly: tiers first,
    // then combos + registered rows in the key's effective order. The main
    // slot pins `model.primary` and does NOT jump the list — the client's
    // switcher should read like the console's model catalog. Custom mode is
    // the exception: when the user's chip list contains tier entries, their
    // positions are deliberate and the list is written verbatim.
    const listed = Array.isArray(options?.virtualModels)
      ? [...new Set([...virtuals, ...concreteExtras])]
      : rawExtras.some(id => VIRTUAL_AUTO_IDS.has(id))
        ? [...new Set(rawExtras)]
        : [...new Set([...virtuals, ...concreteExtras])];
    const ids = listed.includes(main) ? listed : [main, ...listed];
    const meta = await resolveClientModelMeta(ids);
    const providerNode = {
      baseUrl: targetUrl,
      apiKey,
      api: 'openai-completions',
      models: ids.map(id => modelEntry(id, meta[id])),
    };
    const primaryRef = `${OpenClawClientAdapter.PROVIDER_ID}/${main}`;

    // Secondary slots: a concrete value pins `omnicell-router/<value>`; 'auto'
    // or empty clears the node (decision disabled, no fallback, no utility
    // override — the frontend auto-fills untouched slots with 'auto'). Absent
    // keys leave that slot untouched. The sidecar keeps the FIRST pre-hook
    // value per slot (lost-sidecar safe, same rule as primary).
    const slotRef = (raw: string | undefined): string | undefined | null => {
      const v = raw?.trim();
      if (v === undefined) return undefined; // untouched
      if (v === '' || v === 'auto') return null; // clear
      return `${OpenClawClientAdapter.PROVIDER_ID}/${v}`;
    };
    const sidecar = readMeta(configPath);
    const owned = (v: string) => v.startsWith(`${OpenClawClientAdapter.PROVIDER_ID}/`);
    const fallbackRef = slotRef(options?.models?.fallback);
    const utilityRef = slotRef(options?.models?.utility);
    const decisionRef = slotRef(options?.models?.decision);
    const previousUtility = sidecar.previousUtility
      ?? (data?.agents?.defaults?.utilityModel !== undefined && !owned(String(data.agents.defaults.utilityModel))
        ? data.agents.defaults.utilityModel
        : undefined);
    const previousDecision = sidecar.previousDecision
      ?? (data?.agents?.defaults?.decisionModel !== undefined && !owned(String(data.agents.defaults.decisionModel))
        ? data.agents.defaults.decisionModel
        : undefined);

    // Previous model node: keep the FIRST value seen across repeat setups;
    // a value this adapter owns (lost sidecar) is never "restored" on
    // teardown. The vendor's string shorthand is migrated to {primary} by
    // the hook, so the whole original node is what teardown puts back.
    const modelNode = data?.agents?.defaults?.model;
    const ownedModel = isPlainObject(modelNode)
      ? typeof modelNode.primary === 'string' && owned(modelNode.primary)
      : typeof modelNode === 'string' && owned(modelNode);
    const previousModel = sidecar.previousModel ?? (modelNode !== undefined && !ownedModel ? modelNode : undefined);

    backupOnce(configPath);
    const modelPatch = isPlainObject(modelNode) ? { ...modelNode } : {};
    modelPatch.primary = primaryRef;
    if (fallbackRef !== undefined) {
      modelPatch.fallbacks = fallbackRef === null ? undefined : [fallbackRef];
    }
    const edits: { path: JSONPath; value: unknown }[] = [
      { path: ['models', 'providers', OpenClawClientAdapter.PROVIDER_ID], value: providerNode },
      { path: ['agents', 'defaults', 'model'], value: modelPatch },
    ];
    if (utilityRef !== undefined) {
      edits.push({ path: ['agents', 'defaults', 'utilityModel'], value: utilityRef ?? undefined });
    }
    if (decisionRef !== undefined) {
      edits.push({ path: ['agents', 'defaults', 'decisionModel'], value: decisionRef ?? undefined });
    }
    patch(configPath, edits);
    writeMeta(configPath, { previousModel, previousUtility, previousDecision });

    const backupNote = describeBackup(configPath);
    return {
      success: true,
      message: `OpenClaw configured to route via OCR (${targetUrl}, ${ids.length} model entr${ids.length === 1 ? 'y' : 'ies'}, primary: ${primaryRef}).${backupNote}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = await this.resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    const restored = restoreBackup(configPath);
    const data = readConfig(configPath);
    if (data === null) {
      return { success: false, message: `Could not parse OpenClaw config at ${configPath}` };
    }

    // Restore-then-strip: a backup taken during a repeat setup may already
    // carry the hook, and the no-backup path has nothing to restore from.
    const meta = readMeta(configPath);
    const modelNode = data?.agents?.defaults?.model;
    const ownedModel = isPlainObject(modelNode)
      ? typeof modelNode.primary === 'string' && modelNode.primary.startsWith(`${OpenClawClientAdapter.PROVIDER_ID}/`)
      : typeof modelNode === 'string' && modelNode.startsWith(`${OpenClawClientAdapter.PROVIDER_ID}/`);
    // The hook owns the model node only while it carries our primary; after a
    // backup restore the pre-hook value is already back verbatim and any
    // rewrite would only reformat the user's file.
    const modelEdits: { path: JSONPath; value: unknown }[] = [];
    if (ownedModel && typeof modelNode === 'string') {
      // Migrated shorthand with a lost sidecar: the pre-hook form is gone, drop the node.
      modelEdits.push({ path: ['agents', 'defaults', 'model'], value: undefined });
    } else if (ownedModel) {
      modelEdits.push({ path: ['agents', 'defaults', 'model'], value: meta.previousModel ?? {} });
    } else if (meta.previousModel !== undefined && !restored) {
      modelEdits.push({ path: ['agents', 'defaults', 'model'], value: meta.previousModel });
    }

    const teardownEdits: { path: JSONPath; value: unknown }[] = [
      { path: ['models', 'providers', OpenClawClientAdapter.PROVIDER_ID], value: undefined },
      ...modelEdits,
    ];
    // Secondary slots: a sidecar value goes back verbatim; an owned value
    // with a lost sidecar is dropped. Values the user wrote after the hook
    // are left alone only when they are not ours.
    for (const key of ['utilityModel', 'decisionModel'] as const) {
      const previous = key === 'utilityModel' ? meta.previousUtility : meta.previousDecision;
      const current = data?.agents?.defaults?.[key];
      if (previous !== undefined) {
        teardownEdits.push({ path: ['agents', 'defaults', key], value: previous });
      } else if (typeof current === 'string' && current.startsWith(`${OpenClawClientAdapter.PROVIDER_ID}/`)) {
        teardownEdits.push({ path: ['agents', 'defaults', key], value: undefined });
      }
    }

    patch(configPath, teardownEdits);
    this.removeEmptyNodes(configPath);
    try {
      fs.unlinkSync(metaPathFor(configPath));
    } catch {
      // best effort — a stale sidecar only affects repeat-setup bookkeeping
    }

    return {
      success: true,
      message: restored
        ? `OpenClaw configuration restored from backup (${configPath}.bak.ocr)`
        : 'OpenClaw configuration decoupled from OCR. Reverted to standard configuration.',
    };
  }

  /** Our write paths assume these parents are objects; refuse a hand-edited
   *  scalar instead of letting the JSONC editor clobber the user's value. */
  private validateShape(data: any): string | null {
    for (const [label, value] of [
      ['models', data?.models],
      ['models.providers', data?.models?.providers],
      ['agents', data?.agents],
      ['agents.defaults', data?.agents?.defaults],
    ] as const) {
      if (value !== undefined && !isPlainObject(value)) {
        return `OpenClaw config node '${label}' must be an object — fix it manually, then re-apply`;
      }
    }
    const model = data?.agents?.defaults?.model;
    // Vendor-legal string shorthand (`agents.defaults.model: "x/y"`) is
    // migrated on setup; only a non-string non-object scalar is uneditable.
    if (model !== undefined && !isPlainObject(model) && typeof model !== 'string') {
      return "OpenClaw config node 'agents.defaults.model' must be an object or a model string — fix it manually, then re-apply";
    }
    if (model?.primary !== undefined && typeof model.primary !== 'string') {
      return "OpenClaw config node 'agents.defaults.model.primary' must be a string — fix it manually, then re-apply";
    }
    return null;
  }

  /** Drop containers this adapter emptied, so teardown never leaves `{}`
   *  shells behind (they are schema-valid, but they are residue). */
  private removeEmptyNodes(configPath: string): void {
    let data = readConfig(configPath);
    const models = data?.models;
    if (isPlainObject(models) && isPlainObject(models.providers) && Object.keys(models.providers).length === 0) {
      patch(configPath, [{ path: ['models', 'providers'], value: undefined }]);
      data = readConfig(configPath);
      if (isPlainObject(data?.models) && Object.keys(data!.models).length === 0) {
        patch(configPath, [{ path: ['models'], value: undefined }]);
      }
    }

    data = readConfig(configPath);
    const defaults = isPlainObject(data?.agents) ? data!.agents.defaults : undefined;
    const model = isPlainObject(defaults) ? defaults.model : undefined;
    if (!isPlainObject(model) || Object.keys(model).length > 0) return;

    patch(configPath, [{ path: ['agents', 'defaults', 'model'], value: undefined }]);
    data = readConfig(configPath);
    const nextDefaults = isPlainObject(data?.agents) ? data!.agents.defaults : undefined;
    if (!isPlainObject(nextDefaults) || Object.keys(nextDefaults).length > 0) return;

    patch(configPath, [{ path: ['agents', 'defaults'], value: undefined }]);
    data = readConfig(configPath);
    if (isPlainObject(data?.agents) && Object.keys(data!.agents).length === 0) {
      patch(configPath, [{ path: ['agents'], value: undefined }]);
    }
  }
}

/** Display name for the OpenClaw picker. Tier aliases (auto/lite/…) stay the
 *  bare alias — they are routing slots, and the registry's resolved backing
 *  model would name five slots identically. Registered ids are
 *  `<upstream>/<model>`, and one OCR provider entry serves many upstreams —
 *  five "GLM 5.3" rows are indistinguishable by name alone — so their display
 *  name carries the upstream namespace: "GLM 5.3 · zhipuai-coding-plan". */
function displayName(id: string, meta: ClientModelMeta | undefined): string {
  if (VIRTUAL_AUTO_IDS.has(id)) return id;
  const name = meta?.name?.trim();
  if (!name || name === id) return id;
  const cut = id.lastIndexOf('/');
  return cut > 0 ? `${name} · ${id.slice(0, cut)}` : name;
}

/**
 * One `models.providers.<id>.models[]` entry. Gateway metadata (display name,
 * context window, output cap, pricing, reasoning/input support) rides along
 * when the live registry can resolve the id — same resolver the pi/kimi
 * adapters use; an unresolved id (standalone CLI) gets the minimal documented
 * shape. `name` is schema-required (min 1 char). Registered ids are
 * `<upstream>/<model>`, and one OCR provider entry serves many upstreams —
 * five "GLM 5.3" rows are indistinguishable by name alone — so the display
 * name carries the upstream namespace as a suffix: "GLM 5.3 · zhipuai-coding-plan".
 */
function modelEntry(id: string, meta: ClientModelMeta | undefined): Record<string, any> {
  const entry: Record<string, any> = { id, name: displayName(id, meta) };
  if (meta?.reasoning) entry.reasoning = true;
  if (meta?.input?.length) entry.input = [...meta.input];
  if (meta?.contextWindow) entry.contextWindow = meta.contextWindow;
  if (meta?.maxTokens) entry.maxTokens = meta.maxTokens;
  if (meta?.cost) {
    entry.cost = {
      input: meta.cost.input,
      output: meta.cost.output,
      cacheRead: meta.cost.cacheRead,
      cacheWrite: meta.cost.cacheWrite ?? 0,
    };
  }
  return entry;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Tolerant JSON/JSONC read: comments and trailing commas survive; a parse
 *  error (or a JSON5-ism jsonc-parser does not accept) returns null. */
function readConfig(configPath: string): any | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const errors: ParseError[] = [];
    const parsed = parse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parsed === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Recursive mkdir raises EEXIST on Windows when the target (or a component
 *  of it) already exists as a junction/symlink to a directory — a layout
 *  OpenClaw installs legitimately use. Treat "already there AND is a real
 *  directory" as success; anything else still surfaces. */
function ensureConfigDir(configPath: string): void {
  const dir = path.dirname(configPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
    if (code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw e;
  }
}

/** Text-level edit(s) — jsonc-parser computes the minimal spans, so comments
 *  and unrelated formatting are preserved. Atomic tmp+rename. A `undefined`
 *  (delete) edit whose path is absent is skipped: jsonc-parser cannot compute
 *  a deletion for a node that does not exist. */
function patch(configPath: string, edits: { path: JSONPath; value: any }[]): void {
  let raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  for (const edit of edits) {
    if (edit.value === undefined) {
      const parsed = parse(raw, undefined, { allowTrailingComma: true });
      if (getPath(parsed, edit.path) === undefined) continue;
    }
    raw = applyEdits(raw, modify(raw, edit.path, edit.value, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
  }
  ensureConfigDir(configPath);
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, raw, 'utf8');
  try {
    renameWithRetry(tmpPath, configPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

/** Resolve a JSONPath against a parsed document; undefined when absent. */
function getPath(data: any, jsonPath: JSONPath): any {
  let cur: any = data;
  for (const seg of jsonPath) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg as string];
  }
  return cur;
}

/** First pre-hook snapshot wins: a repeat setup must never overwrite the
 *  backup with an already-hooked config. */
function backupOnce(configPath: string): void {
  const backupPath = `${configPath}.bak.ocr`;
  if (!fs.existsSync(configPath) || fs.existsSync(backupPath)) return;
  try {
    fs.copyFileSync(configPath, backupPath);
  } catch {
    // best effort — setup proceeds; teardown falls back to strip-in-place
  }
}

/** Sidecar (outside openclaw.json — the strict schema rejects unknown keys). */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
}

type SidecarMeta = { previousModel?: unknown; previousUtility?: unknown; previousDecision?: unknown };

function readMeta(configPath: string): SidecarMeta {
  try {
    const p = metaPathFor(configPath);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
      if (!isPlainObject(parsed)) return {};
      const out: SidecarMeta = {};
      if (parsed.previousModel !== undefined) out.previousModel = parsed.previousModel;
      if (parsed.previousUtility !== undefined) out.previousUtility = parsed.previousUtility;
      if (parsed.previousDecision !== undefined) out.previousDecision = parsed.previousDecision;
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function writeMeta(configPath: string, meta: SidecarMeta): void {
  try {
    fs.writeFileSync(metaPathFor(configPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  } catch {
    // best effort
  }
}