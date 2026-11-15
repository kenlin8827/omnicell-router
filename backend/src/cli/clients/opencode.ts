import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  describeBackup,
  restoreBackup,
  safeReadJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';
import {
  ROUTER_PROVIDER_ID,
  getOpenCodeConfigPath,
  patchJsonc,
  readJsonc,
} from '../../opencode/user-config.js';
import { readProviderDefsFile, writeProviderDefs } from '../../opencode/provider-defs.js';
import { materializeDefs } from '../../opencode/credentials/def-materialize.js';
import { reloadOpencodeService } from '../../opencode/credentials/opencode-v2-store.js';
import { resolveDefaultPaths } from '../../opencode/credentials/paths.js';

/**
 * OpenCode client adapter.
 *
 * OpenCode v2 config schema notes:
 *  - Custom/static providers live under the *plural* `providers` node — opencode v2's
 *    native slot, decoded against the v2 schema (the singular `provider` node is the
 *    retired v1 slot: same name, wrong decoder, silent whole-node drops):
 *      "providers": { "<id>": { "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": ... }, "models": {...} } }
 *  - The file is JSONC (comments allowed) — every write must be a
 *    comment-preserving text-level edit (see opencode/user-config.ts).
 *  - The default model is selected via the top-level `model` key ("provider/model-id").
 */

/** Sidecar that remembers the user's previous default model across setup/teardown. */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
}

function readMeta(configPath: string): { previousModel?: string } {
  try {
    const p = metaPathFor(configPath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // ignore
  }
  return {};
}

function writeMeta(configPath: string, meta: { previousModel?: string }): void {
  try {
    // Legacy v1 key from the removed model-profile mechanism (ADR-0031) —
    // dropped on every write so old sidecars converge clean.
    delete (meta as Record<string, unknown>).profile;
    fs.writeFileSync(metaPathFor(configPath), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best effort
  }
}

/** Valid agent name usable as an opencode.jsonc agent-node key. */
function isValidAgentName(name: string): boolean {
  return Boolean(name) && /^[A-Za-z0-9][A-Za-z0-9._\-]*$/.test(name);
}

/**
 * Agent-node homes in opencode.jsonc. Writes ALWAYS land in the v2-native
 * plural `agents` — the singular `agent` node is the retired v1 home, and a
 * v1 binary could not use this hook anyway (the defs materialization writes
 * the v2 plural `providers`, which v1 never reads). The singular node appears
 * in sweeps only as GHOST CLEANUP: older OCR builds wrote it, and setup /
 * teardown remove exactly those router-owned values while leaving the user's
 * own entries untouched.
 */
const AGENT_SLOT = 'agents';
const AGENT_SLOT_GHOST = 'agent';

/** Drop every router-owned `agent(s).<name>.model` override in BOTH nodes. */
function sweepRouterAgentModels(configPath: string): void {
  for (const slot of [AGENT_SLOT, AGENT_SLOT_GHOST]) {
    const node = (readJsonc(configPath) as any)?.[slot];
    if (!node || typeof node !== 'object') continue;
    for (const [name, def] of Object.entries(node as Record<string, unknown>)) {
      const model = (def as any)?.model;
      if (typeof model === 'string' && model.startsWith(`${ROUTER_PROVIDER_ID}/`)) {
        patchJsonc(configPath, [slot, name, 'model'], undefined);
      }
    }
  }
}

function buildRouterProviderNode(port: number, model?: string, extraModels?: string[], apiKey?: string, virtualModels?: string[]): any {
  const targetUrl = `http://127.0.0.1:${port}/v1`;
  const modelEntry = (label: string) => ({ name: label });
  // Virtual tier block: follow mode scopes it to the subset the selected key's
  // policy admits (`virtualModels`); every other caller gets the full block.
  const virtuals = Array.isArray(virtualModels)
    ? [...VIRTUAL_AUTO_IDS].filter(id => virtualModels.includes(id))
    : [...VIRTUAL_AUTO_IDS];
  const models: Record<string, { name: string }> = Object.fromEntries(
    virtuals.map(id => [id, modelEntry(id === 'auto' ? 'Auto' : id[0].toUpperCase() + id.slice(1))])
  );
  // Pin a concrete registered model: expose it in the client's model picker.
  if (model && model !== 'auto' && !['lite','plus','pro','ultra'].includes(model)) {
    models[model] = modelEntry(`Pinned: ${model}`);
  }
  // Additional concrete models so the user can switch freely inside OpenCode.
  for (const m of extraModels || []) {
    const id = (m || '').trim();
    if (id && !models[id]) models[id] = modelEntry(id);
  }
  return {
    name: 'OmniCellRouter',
    package: '@opencode/ai/providers/openai-compatible',
    settings: {
      baseURL: targetUrl,
      // Gateway-issued key when the user picks one; the placeholder works
      // only if config.apiKeys contains it.
      apiKey: apiKey || 'ocr-local-token',
    },
    models,
  };
}

export class OpenCodeClientAdapter implements ClientAdapter {
  name = 'opencode' as const;
  hookKind = 'config' as const;
  displayName = 'OpenCode';

  getConfigPath(): string {
    return getOpenCodeConfigPath();
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Not configured';

    if (exists) {
      // Tolerant read: JSONC first (comments-safe), plain-JSON fallback.
      const data = readJsonc(configPath) ?? safeReadJson(configPath);
      if (data) {
        const routerEntry = data.providers?.[ROUTER_PROVIDER_ID];
        if (routerEntry?.settings?.baseURL) {
          hooked = true;
          details = `Routed to OmniCellRouter gateway (${routerEntry.settings.baseURL})`;
        } else {
          details = 'Active with native providers';
        }
      } else {
        details = 'Config file present (unparsed/empty)';
      }
    } else {
      details = 'No OpenCode configuration detected';
    }

    // Current slot values: strip the `omnicell-router/` namespace prefix
    const hookedData = hooked ? ((readJsonc(configPath) as any) || {}) : null;
    const stripPrefix = (v: any): string | undefined =>
      typeof v === 'string' && v.startsWith(`${ROUTER_PROVIDER_ID}/`)
        ? v.slice(ROUTER_PROVIDER_ID.length + 1)
        : undefined;

    // Extra concrete models exposed in the provider's switcher (non-virtual entries)
    const mainId = stripPrefix(hookedData?.model);
    const providerModels = hookedData?.providers?.[ROUTER_PROVIDER_ID]?.models;
    const extraModels =
      providerModels && typeof providerModels === 'object'
        ? Object.keys(providerModels).filter(k => !VIRTUAL_AUTO_IDS.has(k) && k !== mainId)
        : undefined;

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      // The dedicated subagent slot is retired — every agent (general
      // included) links through the agent inventory table instead.
      modelSlots: [{ key: 'main', value: mainId, default: 'auto' }],
      extraModels,
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    extraModels?: string[];
    /** Follow mode: the virtual tier subset the selected key's policy admits. */
    virtualModels?: string[];
    apiKey?: string;
    /** Effective agent bindings (manual picks): agent name → modelRef ('auto'/'' = inherit default). */
    agentModels?: Record<string, string>;
  }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const main = options?.models?.main?.trim() || 'auto';
    const extraModels = (options?.extraModels || []).map(s => (s || '').trim()).filter(Boolean);
    const apiKey = options?.apiKey?.trim() || undefined;
    const agentModels = options?.agentModels;

    // 1. Safety snapshot: ONE .bak.ocr of the pre-takeover file, restored by
    //    teardown and never overwritten by a re-setup (see createBackup).
    if (fs.existsSync(configPath)) {
      createBackup(configPath);
    }

    // 2. Register the router provider as a DEFS entry (OCR-owned truth) and
    //    materialize the defs file into the client config immediately — setup is
    //    an explicit user action, so the write bypasses the sync toggles. The
    //    materialized slot REPLACES the whole `providers` node (the client copy
    //    of the defs truth), and the legacy-slot twin cleanup stays (opencode
    //    reads both, but only one may exist). Agent refs are part of the
    //    exposed model set — opencode validates `agent.<name>.model` against
    //    this provider's `models` map.
    const agentRefs = Object.values(agentModels || {}).map(r => (r || '').trim()).filter(r => r && r !== 'auto');
    const exposedExtras = [...extraModels, ...agentRefs];
    const defsPaths = resolveDefaultPaths();
    const defs = readProviderDefsFile(defsPaths)?.providers ?? {};
    writeProviderDefs(
      { ...defs, [ROUTER_PROVIDER_ID]: buildRouterProviderNode(port, main, exposedExtras, apiKey, options?.virtualModels) },
      defsPaths
    );
    materializeDefs(defsPaths, configPath);
    // Setup changed the client's defs (router node + exposed model set): a
    // RUNNING service registers config-declared providers only on reload, so
    // tell it now instead of leaving the new provider invisible until restart.
    // Best-effort — "no service running" is the common case on setup.
    await reloadOpencodeService(defsPaths);
    if (readJsonc(configPath)?.provider?.[ROUTER_PROVIDER_ID]) {
      patchJsonc(configPath, ['provider', ROUTER_PROVIDER_ID], undefined);
    }

    // 3. Point the default model at the router (record previous for teardown)
    const current = readJsonc(configPath) || {};
    const previousModel = current?.model;
    const targetModel = `${ROUTER_PROVIDER_ID}/${main}`;
    const meta = readMeta(configPath);
    // Record the user's ORIGINAL model only — a router-prefixed value is an
    // intermediate from a previous takeover (e.g. re-setup with a different
    // main) and must never become the teardown restore target.
    if (previousModel && previousModel !== targetModel && !String(previousModel).startsWith(`${ROUTER_PROVIDER_ID}/`)) {
      meta.previousModel = previousModel;
    }
    patchJsonc(configPath, ['model'], targetModel);

    // 4. Agent bindings — the payload present (even empty) means the console
    //    form is engaged: sweep router-owned overrides first (both node
    //    spellings, so a re-apply leaves no ghosts), then write each binding
    //    into the agent home (the config node overrides same-name agents
    //    defined in agent(s)/\*.md). A bare `ocr setup opencode` (CLI) passes
    //    no payload and never touches the agent node — manually pinned native
    //    models are never stolen.
    const hasAgentPayload = agentModels !== undefined;
    let applied = 0;
    if (hasAgentPayload) {
      sweepRouterAgentModels(configPath);
      for (const [name, ref] of Object.entries(agentModels || {})) {
        const r = (ref || '').trim();
        if (!isValidAgentName(name) || !r || r === 'auto') continue; // 'auto' = inherit the default model
        patchJsonc(configPath, [AGENT_SLOT, name, 'model'], `${ROUTER_PROVIDER_ID}/${r}`);
        applied++;
      }
    }
    writeMeta(configPath, meta);

    return {
      success: true,
      message: `OpenCode routed to OCR gateway (http://127.0.0.1:${port}/v1, main: ${targetModel}${hasAgentPayload ? `, agents: ${applied}` : ''}).${describeBackup(configPath)}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    // The defs entry must go too — otherwise the next materialization revives
    // the router node against teardown's intent (defs are the truth the client
    // copy converges to).
    const defsPaths = resolveDefaultPaths();
    const defs = readProviderDefsFile(defsPaths)?.providers ?? {};
    if (Object.hasOwn(defs, ROUTER_PROVIDER_ID)) {
      const next = { ...defs };
      delete next[ROUTER_PROVIDER_ID];
      writeProviderDefs(next, defsPaths);
    }

    // If backup exists, restore it directly (full revert, comments included)
    if (restoreBackup(configPath)) {
      writeMeta(configPath, readMeta(configPath)); // legacy profile key stripped by the writer
      return {
        success: true,
        message: `OpenCode configuration restored from backup (${configPath}.bak.ocr)`,
      };
    }

    // Otherwise surgically remove our provider node + default-model override
    const data = readJsonc(configPath);
    if (!data) {
      return { success: false, message: `Could not parse OpenCode config at ${configPath}` };
    }

    if (data.providers?.[ROUTER_PROVIDER_ID]) {
      patchJsonc(configPath, ['providers', ROUTER_PROVIDER_ID], undefined);
    }
    // A legacy-slot twin from an older build is removed too — teardown must not
    // leave a router node behind in either slot.
    if (data.provider?.[ROUTER_PROVIDER_ID]) {
      patchJsonc(configPath, ['provider', ROUTER_PROVIDER_ID], undefined);
    }

    // Converge the client copy to the defs truth (the router def was removed
    // above) — the surgical path leaves no drift the next materialization
    // would resurrect. A running service must forget the router provider too:
    // the reload is the only way it re-reads config.
    materializeDefs(defsPaths, configPath);
    await reloadOpencodeService(defsPaths);

    // Restore the user's original default whenever the current one is any
    // router ref (not just router/auto — re-setups may leave router/pro,
    // router/<pinned model> etc.).
    if (typeof data.model === 'string' && data.model.startsWith(`${ROUTER_PROVIDER_ID}/`)) {
      const { previousModel } = readMeta(configPath);
      if (previousModel) {
        patchJsonc(configPath, ['model'], previousModel);
      } else {
        patchJsonc(configPath, ['model'], undefined);
      }
    }

    // Remove every agent model override that points at the router — both node
    // spellings (v2 `agents` / the singular `agent` ghost home), manual links
    // included.
    sweepRouterAgentModels(configPath);
    writeMeta(configPath, readMeta(configPath)); // legacy profile key stripped by the writer

    return {
      success: true,
      message: 'OpenCode configuration reverted successfully. OCR gateway decoupled.',
    };
  }
}
