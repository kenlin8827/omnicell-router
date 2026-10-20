import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  safeReadJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, ModelProfileBinding, VIRTUAL_AUTO_IDS } from '../types.js';
import {
  ROUTER_PROVIDER_ID,
  getOpenCodeConfigPath,
  patchJsonc,
  readJsonc,
} from '../../opencode/user-config.js';
import { readProviderDefsFile, writeProviderDefs } from '../../opencode/provider-defs.js';
import { materializeDefs } from '../../opencode/credentials/def-materialize.js';
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

/** Sidecar that remembers the user's previous default model across setup/teardown
 *  and echoes the applied model profile (id + agent→slot bindings) for the console. */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
}

function readMeta(configPath: string): { previousModel?: string; profile?: ModelProfileBinding } {
  try {
    const p = metaPathFor(configPath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // ignore
  }
  return {};
}

function writeMeta(configPath: string, meta: { previousModel?: string; profile?: ModelProfileBinding }): void {
  try {
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
 * The agent node a config actually uses — same slot doctrine as the
 * provider/providers decision (opencode v2's native spelling is PLURAL
 * `agents`; singular `agent` is the retired v1 home). Reads/writes must land
 * in the home the user's install uses, or opencode never sees the override.
 * Fresh files get the v2 home; a legacy-only file keeps its singular home
 * (never silently fork definitions into a second node).
 */
const AGENT_SLOT_NATIVE = 'agents';
const AGENT_SLOT_LEGACY = 'agent';

function existingAgentSlot(data: any): string {
  if (data?.[AGENT_SLOT_NATIVE] && typeof data[AGENT_SLOT_NATIVE] === 'object') return AGENT_SLOT_NATIVE;
  if (data?.[AGENT_SLOT_LEGACY] && typeof data[AGENT_SLOT_LEGACY] === 'object') return AGENT_SLOT_LEGACY;
  return AGENT_SLOT_NATIVE;
}

/** Drop every router-owned `agent(s).<name>.model` override in BOTH nodes. */
function sweepRouterAgentModels(configPath: string): void {
  for (const slot of [AGENT_SLOT_NATIVE, AGENT_SLOT_LEGACY]) {
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

function buildRouterProviderNode(port: number, model?: string, extraModels?: string[], apiKey?: string): any {
  const targetUrl = `http://127.0.0.1:${port}/v1`;
  const modelEntry = (label: string) => ({ name: label });
  const models: Record<string, { name: string }> = {
    auto: modelEntry('Auto (intelligent multi-tier routing)'),
    'auto-lite': modelEntry('Force Lite tier'),
    'auto-plus': modelEntry('Force Plus tier'),
    'auto-pro': modelEntry('Force Pro tier'),
    'auto-ultra': modelEntry('Force Ultra tier'),
  };
  // Pin a concrete registered model: expose it in the client's model picker.
  if (model && model !== 'auto' && !model.startsWith('auto-')) {
    models[model] = modelEntry(`Pinned: ${model}`);
  }
  // Additional concrete models so the user can switch freely inside OpenCode.
  for (const m of extraModels || []) {
    const id = (m || '').trim();
    if (id && !models[id]) models[id] = modelEntry(id);
  }
  return {
    name: 'OneCastRouter',
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
  displayName = 'OpenCode';

  getConfigPath(): string {
    return getOpenCodeConfigPath();
  }

  async getStatus(): Promise<ClientHookStatus> {
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
          details = `Routed to OneCastRouter gateway (${routerEntry.settings.baseURL})`;
        } else {
          details = 'Active with native providers';
        }
      } else {
        details = 'Config file present (unparsed/empty)';
      }
    } else {
      details = 'No OpenCode configuration detected';
    }

    // Current slot values: strip the `onecast-router/` namespace prefix
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
      profile: hooked ? readMeta(configPath).profile : undefined,
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    extraModels?: string[];
    apiKey?: string;
    /** Effective agent bindings (manual picks + profile-resolved links, merged by the console route): agent name → modelRef ('auto'/'' = inherit default). */
    agentModels?: Record<string, string>;
    /** Profile-link echo for the sidecar meta: profile id + agent → profile-slot key ('' id = un-link). */
    profile?: ModelProfileBinding;
  }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const main = options?.models?.main?.trim() || 'auto';
    const extraModels = (options?.extraModels || []).map(s => (s || '').trim()).filter(Boolean);
    const apiKey = options?.apiKey?.trim() || undefined;
    const agentModels = options?.agentModels;

    // 1. Safety backup (single rolling .bak.ocr, restorable via teardown)
    if (fs.existsSync(configPath)) {
      createBackup(configPath);
    }

    // 2. Register the router provider as a DEFS entry (OCR-owned truth) and
    //    materialize the defs file into the client config immediately — setup is
    //    an explicit user action, so the write bypasses the sync toggles. The
    //    materialized slot REPLACES the whole `providers` node (the client copy
    //    of the defs truth), and the legacy-slot twin cleanup stays (opencode
    //    reads both, but only one may exist). Model-profile refs are part of the
    //    exposed model set — opencode validates `agent.<name>.model` against
    //    this provider's `models` map.
    const agentRefs = Object.values(agentModels || {}).map(r => (r || '').trim()).filter(r => r && r !== 'auto');
    const exposedExtras = [...extraModels, ...agentRefs];
    const defsPaths = resolveDefaultPaths();
    const defs = readProviderDefsFile(defsPaths)?.providers ?? {};
    writeProviderDefs(
      { ...defs, [ROUTER_PROVIDER_ID]: buildRouterProviderNode(port, main, exposedExtras, apiKey) },
      defsPaths
    );
    materializeDefs(defsPaths, configPath);
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

    // 4. Agent bindings — either payload present (even empty) means the
    //    console form is engaged: sweep router-owned overrides first (both
    //    node spellings, so a re-apply leaves no ghosts), then write each
    //    binding into the agent home (the config node overrides same-name
    //    agents defined in agent(s)/\*.md). `agentModels` carries the
    //    effective refs; `profile` is the link echo (agent → profile-slot
    //    key) that powers profile-change write-throughs. A bare
    //    `ocr setup opencode` (CLI) passes neither and never touches the
    //    agent node — manually pinned native models are never stolen.
    let profileNote = '';
    const profileIn = options?.profile;
    const hasAgentPayload = agentModels !== undefined || profileIn !== undefined;
    let applied = 0;
    if (hasAgentPayload) {
      sweepRouterAgentModels(configPath);
      const slot = existingAgentSlot(readJsonc(configPath));
      for (const [name, ref] of Object.entries(agentModels || {})) {
        const r = (ref || '').trim();
        if (!isValidAgentName(name) || !r || r === 'auto') continue; // 'auto' = inherit the default model
        patchJsonc(configPath, [slot, name, 'model'], `${ROUTER_PROVIDER_ID}/${r}`);
        applied++;
      }
    }
    if (profileIn !== undefined) {
      if (profileIn.id) {
        meta.profile = { id: profileIn.id, bindings: profileIn.bindings || {} };
        profileNote = `, profile: ${profileIn.id} (${applied} agent(s))`;
      } else {
        delete meta.profile;
      }
    }
    writeMeta(configPath, meta);

    return {
      success: true,
      message: `OpenCode routed to OCR gateway (http://127.0.0.1:${port}/v1, main: ${targetModel}${hasAgentPayload ? `, agents: ${applied}` : ''}${profileNote}). Backup at ${configPath}.bak.ocr`,
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
      const meta = readMeta(configPath);
      if (meta.profile) {
        delete meta.profile;
        writeMeta(configPath, meta);
      }
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
    // would resurrect.
    materializeDefs(defsPaths, configPath);

    // Restore the user's original default whenever the current one is any
    // router ref (not just router/auto — re-setups may leave router/auto-pro,
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
    // spellings (v2 `agents` / v1 `agent`), covering the legacy subagent slot
    // ('general') and all model-profile bindings.
    sweepRouterAgentModels(configPath);
    const meta = readMeta(configPath);
    if (meta.profile) {
      delete meta.profile;
      writeMeta(configPath, meta);
    }

    return {
      success: true,
      message: 'OpenCode configuration reverted successfully. OCR gateway decoupled.',
    };
  }

  /**
   * Profile-change write-through: re-resolve the linked agents' slot keys
   * against the JUST-SAVED profile slots and rewrite the config's agent node
   * (plus the provider-def models map) WITHOUT a full setup — a saved profile
   * update propagates to hooked clients automatically. Only router-owned
   * values are touched (sweep-then-write); the user's native pins survive.
   * Tags whose slot the profile no longer defines drop out (their override is
   * swept → the agent inherits the default model). A no-diff save writes
   * nothing (backup churn guard).
   */
  async refreshProfileBindings(
    profileId: string,
    tags: Record<string, string>,
    slots: Record<string, string>
  ): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }
    const data = readJsonc(configPath) as any;
    if (!data?.providers?.[ROUTER_PROVIDER_ID]?.settings?.baseURL) {
      return { success: false, message: 'OpenCode is not hooked — nothing to refresh' };
    }

    // Resolve tags → desired refs; missing slots drop out (skipped count is
    // reported, the tag itself survives so a re-added slot re-links).
    const desired: Record<string, string> = {};
    let skipped = 0;
    for (const [name, slotKey] of Object.entries(tags || {})) {
      const ref = (slots || {})[slotKey];
      if (!ref || !isValidAgentName(name)) {
        skipped++;
        continue;
      }
      desired[name] = ref;
    }

    // Diff guard: compare desired refs against the live agent node values —
    // an unrelated config save must not rewrite this file.
    const stripPrefix = (v: any): string =>
      typeof v === 'string' && v.startsWith(`${ROUTER_PROVIDER_ID}/`)
        ? v.slice(ROUTER_PROVIDER_ID.length + 1)
        : '';
    const slot = existingAgentSlot(data);
    const current: Record<string, string> = {};
    const node = data?.[slot];
    if (node && typeof node === 'object') {
      for (const [name, def] of Object.entries(node as Record<string, unknown>)) {
        const v = stripPrefix((def as any)?.model);
        if (v) current[name] = v;
      }
    }
    const names = new Set([...Object.keys(current), ...Object.keys(desired)]);
    const changed = [...names].some(n => (desired[n] || '') !== (current[n] || ''));
    const meta = readMeta(configPath);
    const echoSame =
      meta.profile?.id === profileId &&
      JSON.stringify(meta.profile?.bindings || {}) === JSON.stringify(tags || {});
    if (!changed && echoSame) {
      return { success: true, message: 'opencode profile links already up to date' };
    }

    createBackup(configPath);
    sweepRouterAgentModels(configPath);
    const liveSlot = existingAgentSlot(readJsonc(configPath));
    let applied = 0;
    for (const [name, ref] of Object.entries(desired)) {
      patchJsonc(configPath, [liveSlot, name, 'model'], `${ROUTER_PROVIDER_ID}/${ref}`);
      applied++;
    }
    // Keep the provider-def models map a superset of the linked refs —
    // opencode validates agent.<name>.model against it. Existing entries
    // (main pin, user extras) are never removed here; the materialized client
    // copy converges immediately so the new refs validate right away.
    const defsPaths = resolveDefaultPaths();
    const defs = readProviderDefsFile(defsPaths)?.providers ?? {};
    const entry = defs[ROUTER_PROVIDER_ID];
    if (entry?.models && typeof entry.models === 'object') {
      const modelsMap = { ...(entry.models as Record<string, unknown>) };
      let added = 0;
      for (const ref of Object.values(desired)) {
        if (!modelsMap[ref]) {
          modelsMap[ref] = { name: ref };
          added++;
        }
      }
      if (added > 0) {
        writeProviderDefs({ ...defs, [ROUTER_PROVIDER_ID]: { ...entry, models: modelsMap } }, defsPaths);
        materializeDefs(defsPaths, configPath);
      }
    }
    meta.profile = { id: profileId, bindings: tags || {} };
    writeMeta(configPath, meta);
    return {
      success: true,
      message: `opencode profile links refreshed (${applied} agent(s)${skipped > 0 ? `, ${skipped} slot(s) missing` : ''})`,
    };
  }
}
