import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';
import { renameWithRetry } from '../../utils/atomic-write.js';

/**
 * Hook target: DeepSeek Harness (`dsh`). Unlike the JSON-config clients, dsh
 * reads a PER-PROFILE Cordis patch layer: $DSH_HOME/profiles/<name>/
 * cordis.patch.yml (top-level YAML array of id-targeted config override
 * entries; verified against dsh-app-boot 0.2.0 source and the official
 * providers guide). The hook writes one custom provider route inside the
 * `llm-pi-ai` adapter's `providers` dict; the route key is the hook marker.
 *
 * Multi-profile by design: the Desktop app resolves profiles/desktop, the
 * web UI profiles/web, headless its own — hooking only one left the others
 * on direct connections and the client appeared unhooked in practice.
 * setup hooks every profile directory that exists; none exist → create the
 * canonical `web`. Status is hooked when ANY profile carries the route.
 */
const DSH_PROVIDER_KEY = 'omnicell-router';

/** Patch entry selectors accepted when locating the pi-ai adapter section. */
const PIAI_SELECTORS = new Set(['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']);

const PATCH_FILENAME = 'cordis.patch.yml';

/** Placeholder credential — dsh refuses a route with neither apiKeyEnv nor
 *  an Authorization header; the gateway may still 401 without a real key
 *  when client API-key auth is enabled (same contract as the pi adapter). */
const DSH_FALLBACK_API_KEY = '***';

const isPiaiEntry = (e: any): boolean =>
  !!e && typeof e === 'object' && (PIAI_SELECTORS.has(e.id) || PIAI_SELECTORS.has(e.name));

/** Bearer value of an existing route's Authorization header, if any. */
const bearerFromHeaders = (headers: any): string | undefined => {
  const auth = typeof headers?.Authorization === 'string' ? headers.Authorization.trim() : '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  return m ? m[1] : undefined;
};

/** The patch file is a top-level YAML array; anything else is not ours to touch. */
const asPatchEntries = (raw: string): any[] | null => {
  try {
    const data = parse(raw);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};

/** URL of the OCR route entry, when it is a usable http(s) baseURL. */
const hookBaseUrl = (entry: any): string | undefined =>
  typeof entry?.baseURL === 'string' && /^https?:\/\//.test(entry.baseURL) ? entry.baseURL : undefined;

/** OCR route inside a parsed patch file, or undefined when that file is not hooked. */
const hookRoute = (entries: any[]): any | undefined =>
  entries.find(isPiaiEntry)?.config?.providers?.[DSH_PROVIDER_KEY];

export class DshClientAdapter implements ClientAdapter {
  name = 'dsh' as const;
  displayName = 'DeepSeek Harness';

  /**
   * The profiles ROOT (not one file): every profile under it is a hook
   * target. Public for test stubbing.
   */
  getConfigPath(): string {
    const env = process.env.DSH_HOME?.trim();
    // dsh expands a leading ~ in DSH_HOME itself; mirror that here.
    const home = !env ? path.join(os.homedir(), '.dsh')
      : env === '~' ? os.homedir()
      : env.startsWith('~/') || env.startsWith('~\\') ? path.join(os.homedir(), env.slice(2))
      : env;
    return path.join(home, 'profiles');
  }

  /** Every existing per-profile patch file, in stable profile-name order. */
  private existingPatchFiles(): string[] {
    const dir = this.getConfigPath();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(dir, e.name, PATCH_FILENAME))
      .filter(f => fs.existsSync(f))
      .sort();
  }

  async getStatus(): Promise<ClientHookStatus> {
    const files = this.existingPatchFiles();
    const exists = files.length > 0;

    let hooked = false;
    let stalePort = false;
    let anyReadable = false;
    let route: any;
    const hookedProfiles: string[] = [];
    for (const file of files) {
      const entries = asPatchEntries(fs.readFileSync(file, 'utf8'));
      if (entries === null) continue;
      anyReadable = true;
      const r = hookRoute(entries);
      const url = hookBaseUrl(r);
      if (!url) continue;
      hooked = true;
      route ??= r;
      hookedProfiles.push(path.basename(path.dirname(file)));
      try {
        if (new URL(url).port !== String(defaultGatewayPort())) stalePort = true;
      } catch {
        /* malformed URL — still counts as hooked, just no freshness claim */
      }
    }

    let details = 'Direct provider connection (dsh catalog or custom routes)';
    if (!exists) {
      details = 'No dsh profile detected (~/.dsh/profiles/*/cordis.patch.yml)';
    } else if (!anyReadable) {
      details = `Profile patch files exist but are unreadable — fix them manually, then re-apply`;
    } else if (hooked) {
      // Port match is a details-text nicety (drift after a gateway port
      // change → re-apply hint); the hooked state itself is key + URL presence.
      details = stalePort
        ? `Routed via OCR gateway in profile(s) ${hookedProfiles.join(', ')} — current port is :${defaultGatewayPort()}, re-apply setup to refresh`
        : `Routed to OmniCellRouter gateway (${hookedProfiles.join(', ')})`;
    }

    const models: any[] = route && Array.isArray(route.models) ? route.models : [];
    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists,
      hooked,
      backupExists: files.some(f => fs.existsSync(`${f}.bak.ocr`)),
      details,
      // dsh has one model picker (session model selector); the first entry is the main slot.
      modelSlots: [{ key: 'main', value: models[0]?.id ? String(models[0].id) : undefined, default: 'auto' }],
      // The fixed auto* alias block (see setup) is router-owned, not a user choice —
      // never echo it back as extra entries.
      extraModels: models.slice(1).map((m: any) => String(m.id)).filter(id => id && !VIRTUAL_AUTO_IDS.has(id)),
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number; extraModels?: string[]; /** Follow mode: the virtual tier subset the selected key's policy admits. */ virtualModels?: string[] }): Promise<{ success: boolean; message: string }> {
    let files = this.existingPatchFiles();

    // No profile initialized yet → create the canonical `web` layer (the file
    // dsh itself bootstraps for `dsh web`).
    if (files.length === 0) {
      const webFile = path.join(this.getConfigPath(), 'web', PATCH_FILENAME);
      fs.mkdirSync(path.dirname(webFile), { recursive: true });
      files = [webFile];
    }

    // Never overwrite a patch file we cannot read as a top-level array — it
    // likely holds the user's own patch entries that a blind write would erase.
    const parsed = new Map<string, any[]>();
    const broken: string[] = [];
    for (const file of files) {
      // The freshly-created scaffold file does not exist on disk yet — empty list.
      const entries = fs.existsSync(file) ? asPatchEntries(fs.readFileSync(file, 'utf8')) : [];
      if (entries === null) broken.push(file);
      else parsed.set(file, entries);
    }
    if (broken.length > 0) {
      return { success: false, message: `Could not parse dsh patch file(s): ${broken.join(', ')} — fix them manually or remove them, then retry.` };
    }

    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const main = options?.models?.main?.trim() || 'auto';
    // Virtual tier block: follow mode scopes it to the subset the selected
    // key's policy admits (`virtualModels`); other callers get the full block.
    // Then the user's extra concrete models. Main stays slot #1; everything
    // is deduped against what is already listed.
    const extras = (options?.extraModels || []).map(id => id.trim()).filter(id => id && id !== main);
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => options.virtualModels!.includes(id))
      : [...VIRTUAL_AUTO_IDS];
    const ids = [main, ...virtuals.filter(id => id !== main && !extras.includes(id)), ...extras];
    const contextWindow = options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;

    // Gateway-issued key wins; else harvest the bearer from any already-hooked
    // profile (port-change re-apply must not demote a real key to placeholder);
    // placeholder only when nothing has one (dsh refuses an unauthenticated route).
    let existingKey: string | undefined;
    for (const entries of parsed.values()) {
      existingKey ??= bearerFromHeaders(hookRoute(entries)?.headers);
    }
    const apiKey = options?.apiKey?.trim() || existingKey || DSH_FALLBACK_API_KEY;

    const names: string[] = [];
    for (const [file, entries] of parsed) {
      const route = {
        displayName: 'OmniCellRouter',
        api: 'openai-completions',
        baseURL: targetUrl,
        // Credentials never live as apiKeyEnv literals — dsh resolves refs per
        // request. An Authorization header is the documented channel for a
        // keyless local gateway (no compat flags needed: the OCR inbound OpenAI
        // surface accepts developer role and max_completion_tokens natively).
        headers: { Authorization: `Bearer ${apiKey}` },
        models: ids.map(id => (contextWindow ? { id, contextWindow } : { id })),
      };
      let entry = entries.find(isPiaiEntry);
      if (entry) {
        // A patch entry replaces the whole plugin config — preserve the user's
        // other providers and fields by mutating in place, never by re-splicing.
        entry.config = entry.config && typeof entry.config === 'object' ? entry.config : {};
        entry.config.providers = entry.config.providers && typeof entry.config.providers === 'object'
          ? entry.config.providers
          : {};
        entry.config.providers[DSH_PROVIDER_KEY] = route;
      } else {
        entries.push({ id: 'llm-pi-ai', config: { providers: { [DSH_PROVIDER_KEY]: route } } });
      }
      createBackup(file);
      this.writeEntries(file, entries);
      names.push(path.basename(path.dirname(file)));
    }

    return {
      success: true,
      message: `dsh profile(s) [${names.join(', ')}] configured to route via OCR (${targetUrl}, model: ${main}${ids.length > 1 ? ` +${ids.length - 1} extra` : ''}${contextWindow ? `, ctx=${contextWindow}` : ''}, key: ${apiKey === DSH_FALLBACK_API_KEY ? 'placeholder' : 'set'}). Backups saved next to each ${PATCH_FILENAME}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const files = this.existingPatchFiles();
    if (files.length === 0) {
      return { success: false, message: `No dsh profile found at ${this.getConfigPath()}` };
    }

    const cleaned: string[] = [];
    const untouched: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      // Restore-then-strip: a backup from a re-setup (port change, console
      // reset-models) contains the hooked file — restoring it alone would leave
      // the client routed while teardown claims success. Stripping the provider
      // key after any restore makes backup contamination harmless by design.
      if (restoreBackup(file)) {
        const entries = asPatchEntries(fs.readFileSync(file, 'utf8'));
        if (entries) {
          this.stripOcrRoute(entries);
          this.writeEntries(file, entries);
        } else failed.push(file);
        cleaned.push(path.basename(path.dirname(file)));
        continue;
      }
      const entries = asPatchEntries(fs.readFileSync(file, 'utf8'));
      if (!entries) {
        failed.push(file);
        continue;
      }
      if (this.stripOcrRoute(entries)) {
        this.writeEntries(file, entries);
        cleaned.push(path.basename(path.dirname(file)));
      } else {
        untouched.push(path.basename(path.dirname(file)));
      }
    }

    if (failed.length > 0) {
      return { success: false, message: `Could not parse dsh patch file(s): ${failed.join(', ')} — fix manually. Profiles already cleaned: ${cleaned.join(', ') || 'none'}.` };
    }
    if (cleaned.length === 0) {
      return { success: true, message: `No OCR hook present in dsh profile(s) (${untouched.join(', ')}); left untouched.` };
    }
    return { success: true, message: `dsh decoupled from OCR in profile(s) [${cleaned.join(', ')}]: provider route '${DSH_PROVIDER_KEY}' removed. Other patch entries and providers untouched.` };
  }

  /**
   * Remove the OCR route from the pi-ai entry in place; returns whether
   * anything changed. The entry is dropped entirely only when it holds no
   * other providers and is pure setup scaffold (selector + empty config).
   */
  private stripOcrRoute(entries: any[]): boolean {
    const index = entries.findIndex(isPiaiEntry);
    if (index === -1) return false;
    const entry = entries[index];
    const providers = entry?.config?.providers;
    if (!providers || typeof providers !== 'object' || providers[DSH_PROVIDER_KEY] === undefined) return false;

    delete providers[DSH_PROVIDER_KEY];
    if (Object.keys(providers).length === 0) {
      delete entry.config.providers;
      const configEmpty = Object.keys(entry.config).length === 0;
      const scaffoldOnly = Object.keys(entry).every(k => k === 'id' || k === 'name' || (k === 'config' && configEmpty));
      if (configEmpty && scaffoldOnly) entries.splice(index, 1);
    }
    return true;
  }

  private writeEntries(configPath: string, entries: any[]): void {
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, stringify(entries), 'utf8');
    try {
      renameWithRetry(tmpPath, configPath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      throw e;
    }
  }
}
