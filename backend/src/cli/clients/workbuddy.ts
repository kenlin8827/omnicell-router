import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  ClientAdapter,
  ClientActionResult,
  createBackup,
  describeBackup,
  restoreBackup,
  safeReadJson,
  safeWriteJson,
  defaultGatewayPort,
} from './base.js';
import { resolveClientModelMeta } from './model-meta.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';

/**
 * `vendor` is the hook marker. WorkBuddy validates every custom-model row
 * against a schema and reads the file as `{ models, availableModels }` (or a
 * bare array), so a foreign top-level key like OCR_WATERMARK is not safe —
 * the whole config would be rejected. `vendor` is a free-form display label,
 * which makes it the only durable ownership field available on a row. The id
 * itself must stay the gateway modelRef (it is sent upstream verbatim).
 */
const OCR_VENDOR = 'OmniCellRouter';

/** WorkBuddy requires a non-empty apiKey before a custom row is selectable. */
const FALLBACK_API_KEY = '***';

/**
 * Folder names the shipped editions read, in active-edition priority:
 * China/desktop builds use `.workbuddy`, the international build
 * `.workbuddy-ai`, and `.codebuddy` is the legacy folder current builds still
 * accept. The vendor also honours `WORKBUDDY_DATA_FOLDER_NAME` as the folder
 * name itself, so a renamed user config dir wins over all three guesses.
 */
const CONFIG_DIRS = ['.workbuddy', '.workbuddy-ai', '.codebuddy'] as const;

/** Candidate models.json paths in active-edition priority order. */
export function workbuddyConfigCandidates(): string[] {
  const override = process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim();
  if (override) return [path.join(path.resolve(override), 'models.json')];
  const folder = process.env.WORKBUDDY_DATA_FOLDER_NAME?.trim();
  if (folder) return [path.join(os.homedir(), folder, 'models.json')];
  return CONFIG_DIRS.map(dir => path.join(os.homedir(), dir, 'models.json'));
}

/**
 * One config file, resolved the way the client itself resolves it. A file that
 * already exists is the strongest evidence of the ACTIVE edition (a stale
 * legacy folder may still be present); an existing folder with no file is next;
 * otherwise the declared default is used and created on first write. Never
 * writes to more than one path — two hooked files would disagree on the model
 * set and teardown could not own both. The candidate list is a parameter so the
 * ordering contract is testable without touching the real home directory.
 */
export function resolveWorkbuddyConfigPath(candidates: string[] = workbuddyConfigCandidates()): string {
  const withFile = candidates.find(p => fs.existsSync(p));
  if (withFile) return withFile;
  const withDir = candidates.find(p => fs.existsSync(path.dirname(p)));
  return withDir || candidates[0];
}

interface WorkBuddyFile {
  /** Parsed root — either the `{ models, ... }` object or the bare array. */
  root: any;
  isArray: boolean;
  models: any[];
  /** Present only when the on-disk file explicitly declares the key. */
  availableModels?: string[];
}

const isRecord = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A row owned by OCR: the vendor marker plus a usable http(s) endpoint. */
const isOcrEntry = (m: unknown): m is Record<string, any> =>
  isRecord(m) && m.vendor === OCR_VENDOR &&
  typeof m.url === 'string' && /^https?:\/\//.test(m.url);

/** Read without throwing — getAllClientStatuses fans this out through Promise.all. */
function readFile(configPath: string): WorkBuddyFile | null {
  // WorkBuddy treats an empty/whitespace-only file as "no custom models" and
  // keeps running, so setup must accept it instead of refusing to overwrite.
  try {
    if (fs.readFileSync(configPath, 'utf8').trim() === '') {
      return { root: {}, isArray: false, models: [] };
    }
  } catch {
    return null;
  }
  const root = safeReadJson(configPath);
  if (root === null) return null;
  if (Array.isArray(root)) {
    // Keep every entry VERBATIM — a malformed user row (string / null) is the
    // user's data, and setup/teardown must write it back untouched; `isOcrEntry`
    // alone decides ownership.
    return { root, isArray: true, models: root };
  }
  if (!isRecord(root)) return null;
  const models = Array.isArray(root.models) ? root.models : [];
  const availableModels = Array.isArray(root.availableModels)
    ? root.availableModels.filter((v: unknown): v is string => typeof v === 'string')
    : undefined;
  return { root, isArray: false, models, availableModels };
}

export class WorkBuddyClientAdapter implements ClientAdapter {
  name = 'workbuddy' as const;
  hookKind = 'config' as const;
  displayName = 'WorkBuddy';

  getConfigPath(): string {
    return resolveWorkbuddyConfigPath();
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    const parsed = exists ? readFile(configPath) : null;
    const managed = (parsed?.models ?? []).filter(isOcrEntry);
    const hooked = managed.length > 0;

    let details = 'Direct WorkBuddy model connection (built-in + user custom models)';
    if (hooked) {
      const url = String(managed[0].url);
      let portFresh = false;
      try {
        portFresh = new URL(url).port === String(defaultGatewayPort());
      } catch {
        /* malformed URL — report as stale */
      }
      details = portFresh
        ? `Routed to OmniCellRouter gateway (${url}, ${managed.length} model${managed.length === 1 ? '' : 's'})`
        : `Routed via OCR gateway URL ${url} — current port is :${defaultGatewayPort()}, re-apply setup to refresh`;
    } else if (!exists) {
      details = `No WorkBuddy config file detected (${configPath})`;
    } else if (parsed === null) {
      details = `WorkBuddy config exists but could not be parsed as JSON — fix it manually, then re-apply (${configPath})`;
    }

    const ids = managed.map(m => String(m.id ?? '')).filter(Boolean);
    const main = ids[0];
    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [{ key: 'main', value: main, default: 'auto' }],
      // The virtual tier block is router-owned, never echoed as user extras.
      extraModels: ids.slice(1).filter(id => !VIRTUAL_AUTO_IDS.has(id)),
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    apiKey?: string;
    contextWindow?: number;
    extraModels?: string[];
    /** Follow mode: the virtual tier subset the selected key's policy admits. */
    virtualModels?: string[];
  }): Promise<ClientActionResult> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    // WorkBuddy normalizes a base URL to `<base>/chat/completions` when
    // useCustomProtocol is off, so the /v1 root is the correct spelling; a
    // full /v1/chat/completions path is stripped and re-appended to the same
    // thing. Never set CODEBUDDY_BASE_URL — the client appends /v2 to it.
    const targetUrl = `http://127.0.0.1:${port}/v1`;

    let file: WorkBuddyFile = { root: {}, isArray: false, models: [] };
    if (fs.existsSync(configPath)) {
      const parsed = readFile(configPath);
      if (parsed === null) {
        return {
          success: false,
          message: `Could not parse WorkBuddy config at ${configPath} — fix it manually or remove it, then retry.`,
        };
      }
      file = parsed;
      createBackup(configPath);
    }

    const main = options?.models?.main?.trim() || 'auto';
    const extras = (options?.extraModels || [])
      .map(id => (id || '').trim())
      .filter(id => id && id !== main && !VIRTUAL_AUTO_IDS.has(id));
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => options.virtualModels!.includes(id))
      : [...VIRTUAL_AUTO_IDS];
    const ids = [...new Set([
      main,
      ...virtuals.filter(id => id !== main && !extras.includes(id)),
      ...extras,
    ])];
    const contextWindow = options?.contextWindow && options?.contextWindow > 0
      ? Math.floor(options.contextWindow)
      : undefined;
    // Keep the key of a previous OCR row when re-applying; the placeholder is
    // the last resort (WorkBuddy greys out a row whose apiKey is empty).
    const previousKey = file.models.find(isOcrEntry)?.apiKey;
    const apiKey = options?.apiKey?.trim()
      || (typeof previousKey === 'string' ? previousKey : '')
      || FALLBACK_API_KEY;

    // Capability envelope from the live gateway catalog (model-meta.ts):
    // image input is claimed only when the id's resolved members ALL declare
    // it (virtual-meta.ts intersection rule — a vision-incapable failover
    // member would 400 the attachment). Without injected deps (standalone
    // CLI) every id resolves to nothing and image stays false, the legacy
    // conservative claim. Tool calling is required for agent turns; the
    // gateway serves it for every routed model, so it stays pinned true.
    const meta = await resolveClientModelMeta(ids);
    const entry = (id: string): Record<string, unknown> => ({
      id,
      name: id,
      vendor: OCR_VENDOR,
      url: targetUrl,
      apiKey,
      useCustomProtocol: false,
      supportsToolCall: true,
      supportsImages: Array.isArray(meta[id]?.input) && meta[id].input!.includes('image'),
      ...(contextWindow ? { maxInputTokens: contextWindow } : {}),
    });

    // Merge, never overwrite: the user's own rows (Ollama, other gateways,
    // hand-edited fields) keep their positions and are never rewritten.
    const kept = file.models.filter(m => !isOcrEntry(m));
    const nextModels = [...kept, ...ids.map(entry)];
    // An explicit availableModels list REPLACES the product's built-in model
    // set, so add one only when the file already declares it. When absent the
    // client itself unions custom ids into the built-in list — injecting the
    // key there would silently hide every built-in model.
    const hadAvailable = !file.isArray && file.availableModels !== undefined;
    if (file.isArray) {
      safeWriteJson(configPath, nextModels);
    } else {
      file.root.models = nextModels;
      if (hadAvailable) {
        file.root.availableModels = [...new Set([...file.availableModels!, ...ids])];
      }
      safeWriteJson(configPath, file.root);
    }

    const backupNote = describeBackup(configPath);
    return {
      success: true,
      message: `WorkBuddy configured to route via OCR (${targetUrl}, ${ids.length} model${ids.length === 1 ? '' : 's'}, key: ${apiKey === FALLBACK_API_KEY ? 'placeholder' : 'set'}).${backupNote} Reopen WorkBuddy's model picker to see the new rows.`,
    };
  }

  async teardown(): Promise<ClientActionResult> {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    // Restore-then-strip: a backup taken during a REPEAT setup snapshots an
    // already-hooked file, so restoring alone would leave the rows behind.
    const restored = restoreBackup(configPath);
    const file = readFile(configPath);
    if (file === null) {
      return { success: false, message: `Could not parse WorkBuddy config at ${configPath}` };
    }

    const removedIds = new Set(file.models.filter(isOcrEntry).map(m => String(m.id ?? '')).filter(Boolean));
    const kept = file.models.filter(m => !isOcrEntry(m));
    // An id the user also uses for their own row must survive teardown.
    const survivingIds = new Set(kept.map(m => String(m.id ?? '')));
    const ownedIds = [...removedIds].filter(id => !survivingIds.has(id));

    if (file.isArray) {
      safeWriteJson(configPath, kept);
    } else {
      file.root.models = kept;
      if (Array.isArray(file.availableModels)) {
        file.root.availableModels = file.availableModels.filter(id => !ownedIds.includes(id));
      }
      safeWriteJson(configPath, file.root);
    }

    const suffix = restored ? ` (restored from ${configPath}.bak.ocr)` : '';
    return {
      success: true,
      message:
        removedIds.size > 0
          ? `WorkBuddy decoupled from OCR: ${removedIds.size} managed row(s) removed, other custom models untouched${suffix}`
          : restored
            // The restore itself repaired the file (a pre-hook snapshot) — it
            // was NOT left untouched, and edits made after setup were rolled
            // back with it.
            ? `WorkBuddy decoupled from OCR: ${configPath} restored from backup.`
            : `No OCR hook present in ${configPath}; left untouched.`,
    };
  }
}
