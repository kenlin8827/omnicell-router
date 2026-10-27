import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parse, parseDocument, isMap, isSeq, Document, YAMLMap } from 'yaml';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, ClientModelSlot, ModelProfileBinding, VIRTUAL_AUTO_IDS } from '../types.js';
import { resolveClientModelMeta, type ClientModelMeta } from './model-meta.js';
import { renameWithRetry } from '../../utils/atomic-write.js';

/**
 * omp (oh-my-pi, omp.sh) client adapter. Two files:
 *  - `~/.omp/agent/models.yml` — the custom-provider hook. Root accepts ONLY
 *    `providers` (omp validates strictly), so the provider key itself is the
 *    hook marker — the OCR_WATERMARK trick is not safe here. Detection is
 *    host-agnostic: a valid http(s) baseUrl on this key means the client
 *    routes through an OCR gateway. `.yml` wins over `.yaml` (omp's own
 *    precedence); a legacy `models.json` is never touched — omp migrates it
 *    on its next run, and setup refuses rather than shadowing its providers.
 *  - `~/.omp/agent/config.yml` — `modelRoles` (role → model selector), the
 *    analog of pi's settings.json agentOverrides: default + a fixed built-in
 *    role roster, fill-only-absent tier preset, restore-then-strip teardown.
 * All YAML rewrites go through `parseDocument` so the user's comments and
 * unknown fields survive every OCR write.
 */
const OMP_PROVIDER_KEY = 'omnicell-router';

/** Placeholder apiKey — omp requires the field unless auth: none (same contract as pi). */
const OMP_FALLBACK_API_KEY = '***';

/**
 * Router-owned model-role tier mapping for omp's config.yml `modelRoles`
 * (mirrors the gateway's lite/plus/pro/ultra ladder). The role set is omp's
 * documented built-in roster — unlike pi there is nothing to discover, but
 * extensions may add custom roles, so unknown roles already present in
 * modelRoles are still echoed as slots (default: auto) and never swept.
 * `vision` is deliberately absent: image capability is catalog-dependent and
 * omp auto-resolves it; the gateway-side pin would add nothing.
 */
const OMP_ROLE_TIERS: Record<string, string> = {
  smol: 'lite',
  tiny: 'lite',
  commit: 'lite',
  plan: 'pro',
  slow: 'pro',
  designer: 'plus',
  task: 'plus',
  advisor: 'ultra',
};

/** Console-only role context (omp docs wording) — feeds the smart-assign decider. */
const OMP_ROLE_DESCRIPTIONS: Record<string, string> = {
  smol: 'Fast, inexpensive utility work and fast handoff paths',
  tiny: 'Very small online classifications, titles and memory support',
  commit: 'Commit-message generation',
  plan: 'Plan-mode architecture and review',
  slow: 'Thorough reasoning where extra latency is acceptable',
  designer: 'The designer subagent',
  task: 'General subagent work',
  advisor: 'Independent reasoning model used by Advisor',
  vision: 'Image inspection when a vision-capable model is needed',
};

/** Slot order: preset-known roles first, then anything else found in modelRoles. */
const OMP_KNOWN_ROLE_ORDER = [...Object.keys(OMP_ROLE_TIERS), 'vision'];

/** omp thinking-suffix vocabulary a role selector may carry (`provider/id:level`). */
const THINKING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;

/** omp `thinking.efforts` ladder — pi's minus `off` (omp has no off rung). */
const OMP_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** True when a modelRoles value is qualified with the router provider key. */
const isRouterModelRef = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith(`${OMP_PROVIDER_KEY}/`);

/** Bare id of a router-qualified role value (thinking suffix stripped), or undefined when foreign. */
const routerModelBareId = (v: unknown): string | undefined => {
  if (!isRouterModelRef(v)) return undefined;
  return v.slice(OMP_PROVIDER_KEY.length + 1).replace(THINKING_SUFFIX_RE, '');
};

/**
 * Sidecar next to models.yml (`models.yml.ocr-meta.json`) holding the
 * profile-link echo — omp validates both YAML files strictly and rewrites
 * them from its own UI, so the echo must never live inside them. The sidecar
 * is OCR-owned and never read by omp.
 */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
}

function readMeta(configPath: string): { profile?: ModelProfileBinding } {
  try {
    const p = metaPathFor(configPath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // ignore
  }
  return {};
}

function writeMeta(configPath: string, meta: { profile?: ModelProfileBinding }): void {
  try {
    fs.writeFileSync(metaPathFor(configPath), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best effort
  }
}

function removeMeta(configPath: string): void {
  try {
    fs.rmSync(metaPathFor(configPath), { force: true });
  } catch {
    // best effort
  }
}

/** baseUrl of the OCR provider entry, when it is a usable http(s) URL. */
const hookBaseUrl = (entry: any): string | undefined =>
  typeof entry?.baseUrl === 'string' && /^https?:\/\//.test(entry.baseUrl) ? entry.baseUrl : undefined;

/** Parse a YAML file into a Document; null when the file is unreadable, has
 *  YAML errors, or its root is not a mapping (or empty). Never throws. */
function readYamlDocument(p: string): Document | null {
  if (!fs.existsSync(p)) return null;
  try {
    const doc = parseDocument(fs.readFileSync(p, 'utf8'));
    if (doc.errors.length > 0) return null;
    const root = doc.toJS();
    if (root === null || root === undefined) return doc; // empty file — fresh scaffold
    if (typeof root !== 'object' || Array.isArray(root)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Atomic YAML write (same tmp+rename contract as safeWriteJson). */
function writeYamlDocument(p: string, doc: Document): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, String(doc), 'utf8');
  try {
    renameWithRetry(tmpPath, p);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

/** Plain-JS view of a YAML file for status reads (comments irrelevant there). */
function readYamlJs(p: string): Record<string, any> | null {
  if (!fs.existsSync(p)) return null;
  try {
    const data = parse(fs.readFileSync(p, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a top-level key holds a YAMLMap. NB: `doc.set(key, {})` stores the
 * plain JS object RAW on documents with existing content (a later `get`
 * returns a non-node whose `.set` crashes — e.g. a config.yml carrying only
 * omp's own setupVersion/defaultThinkingLevel keys). createNode + set with
 * the node avoids that quirk.
 */
function ensureTopMap(doc: Document, key: string): YAMLMap {
  const existing = doc.get(key);
  if (isMap(existing)) return existing;
  const node = doc.createNode({}) as YAMLMap;
  doc.set(key, node);
  return node;
}

/** Static display names for the fixed auto* alias block (omp picker label). */
const OMP_ALIAS_NAMES: Record<string, string> = {
  auto: 'Auto',
  'lite': 'Lite',
  'plus': 'Plus',
  'pro': 'Pro',
  'ultra': 'Ultra',
};

/**
 * pi thinkingLevelMap → omp `thinking` block. Absent map = permissive full
 * ladder (dynamic targets — the gateway clamps each request to what it can
 * serve); a map filters the rungs the model cannot take. defaultLevel picks
 * the ladder's middle rung so it is always a member of `efforts`.
 */
function ompThinkingBlock(map?: Record<string, string | null>): { mode: 'effort'; efforts: string[]; defaultLevel: string } | undefined {
  const efforts = OMP_EFFORT_LADDER.filter(l => !map || map[l] !== null);
  if (efforts.length === 0) return undefined;
  const defaultLevel = efforts.includes('medium') ? 'medium' : efforts[Math.floor(efforts.length / 2)];
  return { mode: 'effort', efforts: [...efforts], defaultLevel };
}

/** ClientModelMeta (pi vocabulary from model-meta.ts) → one omp models.yml entry. */
function toOmpModelEntry(id: string, m: ClientModelMeta | undefined, contextWindow?: number): Record<string, unknown> {
  if (VIRTUAL_AUTO_IDS.has(id)) {
    // Static alias base + the aggregated tier-member envelope when a registry
    // is live; the thinking ladder stays the permissive full map.
    return {
      id,
      name: OMP_ALIAS_NAMES[id] ?? id,
      ...(m?.contextWindow ? { contextWindow: m.contextWindow } : contextWindow ? { contextWindow } : {}),
      ...(m?.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m?.input ? { input: m.input } : {}),
      ...(m?.cost ? { cost: m.cost } : {}),
      reasoning: true,
      thinking: ompThinkingBlock(),
    };
  }
  if (!m) return { id, ...(contextWindow ? { contextWindow } : {}) };
  return {
    id,
    name: m.name ?? id,
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : contextWindow ? { contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    ...(m.input ? { input: m.input } : {}),
    ...(m.cost ? { cost: m.cost } : {}),
    reasoning: !!m.reasoning,
    ...(m.reasoning ? { thinking: ompThinkingBlock(m.thinkingLevelMap) } : {}),
  };
}

/** Resolve per-id metadata from the live gateway and build the models list. */
async function buildOmpModelEntries(ids: string[], contextWindow?: number): Promise<Record<string, unknown>[]> {
  const meta = await resolveClientModelMeta(ids);
  return ids.map(id => toOmpModelEntry(id, meta[id], contextWindow));
}

/** Resolve the models file inside an omp agent dir: `.yml` wins over
 *  `.yaml` (omp's own precedence); the `.yml` name is the default target. */
export function resolveOmpModelsPath(dir: string): string {
  const yml = path.join(dir, 'models.yml');
  if (fs.existsSync(yml)) return yml;
  const yamlAlt = path.join(dir, 'models.yaml');
  if (fs.existsSync(yamlAlt)) return yamlAlt;
  return yml;
}

export class OmpClientAdapter implements ClientAdapter {
  name = 'omp' as const;
  displayName = 'OMP';

  /** models.yml (or models.yaml when only that exists) — the hook target. */
  getConfigPath(): string {
    return resolveOmpModelsPath(path.join(os.homedir(), '.omp', 'agent'));
  }

  /** config.yml (modelRoles) — derived from the models dir so test redirects isolate it too. */
  getRolesPath(): string {
    return path.join(path.dirname(this.getConfigPath()), 'config.yml');
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    const data = exists ? readYamlJs(configPath) : null;
    const entry = data?.providers?.[OMP_PROVIDER_KEY];
    const url = hookBaseUrl(entry);

    // Port match is only a details-text nicety (drift after a gateway port
    // change → re-apply hint); the hooked state itself is key + URL presence.
    let portFresh = false;
    if (url) {
      try {
        portFresh = new URL(url).port === String(defaultGatewayPort());
      } catch {
        /* malformed URL — leave stale */
      }
    }

    let details = 'Direct provider connection (omp built-in catalog)';
    if (url) {
      details = portFresh
        ? `Routed to OmniCellRouter gateway (${url})`
        : `Routed via OCR gateway URL ${url} — current port is :${defaultGatewayPort()}, re-apply setup to refresh`;
    } else if (!exists) {
      details = 'No omp config file detected (~/.omp/agent/models.yml)';
    }

    const rolesData = readYamlJs(this.getRolesPath());
    const modelRoles: Record<string, any> =
      rolesData?.modelRoles && typeof rolesData.modelRoles === 'object' && !Array.isArray(rolesData.modelRoles)
        ? rolesData.modelRoles
        : {};
    const models: any[] = url && Array.isArray(entry.models) ? entry.models : [];
    if (url) {
      const pinned = Object.keys(modelRoles).filter(role => isRouterModelRef(modelRoles[role])).length;
      if (pinned > 0) details += `; ${pinned} model role(s) pinned via ${this.getRolesPath()}`;
    }

    // Slot roster: the built-in roles plus any custom role already present in
    // modelRoles (extensions can introduce them). Router-owned pins echo as
    // the bare id; foreign values verbatim (thinking suffix included); absent
    // → undefined so the UI seeds the role's preset tier default.
    const roster = [...OMP_KNOWN_ROLE_ORDER];
    for (const role of Object.keys(modelRoles).sort()) {
      if (role !== 'default' && !roster.includes(role)) roster.push(role);
    }
    const modelSlots: ClientModelSlot[] = [
      // omp's main picker is the `default` role; the first provider model is the main slot.
      { key: 'main', value: models[0]?.id ? String(models[0].id) : undefined, default: 'auto' },
    ];
    for (const role of roster) {
      const pinned = modelRoles[role];
      modelSlots.push({
        key: role,
        value: typeof pinned === 'string' && pinned
          ? routerModelBareId(pinned) ?? pinned
          : undefined,
        default: OMP_ROLE_TIERS[role] || 'auto',
        description: OMP_ROLE_DESCRIPTIONS[role],
      });
    }
    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked: !!url,
      backupExists,
      details,
      modelSlots,
      // The fixed auto* alias block (see setup) is router-owned, not a user choice —
      // never echo it back as extra entries.
      extraModels: models.slice(1).map((m: any) => String(m.id)).filter(id => id && !VIRTUAL_AUTO_IDS.has(id)),
      // Profile-link echo from the OCR sidecar — live only while hooked.
      profile: url ? readMeta(configPath).profile : undefined,
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number; extraModels?: string[]; /** Effective role bindings (manual + profile-linked, merged by the console route): role → modelRef. */ agentModels?: Record<string, string>; /** Profile-link echo for the OCR sidecar meta: role → profile-slot key ('' id = un-link). */ profile?: ModelProfileBinding }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const dir = path.dirname(configPath);

    // Legacy models.json: omp migrates it only when no YAML file exists. A
    // fresh models.yml would shadow its providers — refuse and let omp do
    // its own migration on the next run.
    if (
      !fs.existsSync(path.join(dir, 'models.yml')) &&
      !fs.existsSync(path.join(dir, 'models.yaml')) &&
      fs.existsSync(path.join(dir, 'models.json'))
    ) {
      return { success: false, message: `Legacy ${path.join(dir, 'models.json')} detected — run omp once so it migrates the file to models.yml, then retry.` };
    }

    // Never overwrite a models.yml we cannot read — it likely holds the
    // user's own providers that a blind write would erase.
    let doc: Document;
    if (fs.existsSync(configPath)) {
      const parsed = readYamlDocument(configPath);
      if (parsed === null) {
        return { success: false, message: `Could not parse omp config at ${configPath} — fix it manually or remove it, then retry.` };
      }
      doc = parsed;
      createBackup(configPath);
    } else {
      doc = new Document();
    }

    const providers = ensureTopMap(doc, 'providers');

    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const main = options?.models?.main?.trim() || 'auto';

    // Explicit role picks ride along in the models list — omp resolves a
    // modelRoles selector against the provider's declared ids.
    const explicitRoles: Record<string, string> = {};
    for (const [role, raw] of Object.entries(options?.models || {})) {
      if (role === 'main') continue;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || !/^[\w.:-]+(\/[\w.:-]+)*$/.test(value)) continue;
      explicitRoles[role] = value;
    }
    for (const [role, raw] of Object.entries(options?.agentModels || {})) {
      const value = (raw || '').trim();
      if (!value || !/^[\w.:-]+(\/[\w.:-]+)*$/.test(value)) continue;
      explicitRoles[role] = value;
    }
    const explicitRefs = [...new Set(Object.values(explicitRoles).filter(v => !v.includes('/')))];

    // Fixed auto* tier aliases are always exposed (the gateway resolves them
    // natively), then the user's extra concrete models, then any bare
    // explicit-role refs not already listed. Main stays slot #1.
    const extras = (options?.extraModels || []).map(id => id.trim()).filter(id => id && id !== main);
    const ids = [
      main,
      ...[...VIRTUAL_AUTO_IDS].filter(id => id !== main && !extras.includes(id)),
      ...extras,
      ...explicitRefs.filter(id => id !== main && !extras.includes(id)),
    ];
    const contextWindow = options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;
    // Gateway-issued key wins; keep the previous entry's key; placeholder only
    // as last resort (omp needs the field present; the gateway preHandler may
    // still 401 without a real key when adminApiKey auth is enabled).
    const prevEntry = providers.get(OMP_PROVIDER_KEY) as unknown;
    const prevKey = isMap(prevEntry) ? prevEntry.get('apiKey') : undefined;
    const apiKey = options?.apiKey?.trim()
      || (typeof prevKey === 'string' ? prevKey : undefined)
      || OMP_FALLBACK_API_KEY;

    providers.set(OMP_PROVIDER_KEY, {
      baseUrl: targetUrl,
      api: 'openai-completions',
      apiKey,
      models: await buildOmpModelEntries(ids, contextWindow),
    });
    writeYamlDocument(configPath, doc);

    // Model roles (config.yml `modelRoles`) — the analog of pi's subagent
    // overrides. Explicit picks (console slot payload / agentModels) win;
    // the tier preset fills only absent or router-owned-auto roles; the
    // `default` role is claimed only when unset or already router-owned. An
    // unparseable config.yml skips this block (reported in the message);
    // models.yml above is the load-bearing hook.
    const rolesPath = this.getRolesPath();
    let roleNote = '';
    const rolesOnDisk = fs.existsSync(rolesPath);
    const rolesDoc = rolesOnDisk ? readYamlDocument(rolesPath) : new Document();
    if (rolesDoc === null) {
      roleNote = `; model role mapping skipped — ${rolesPath} is not valid YAML`;
    } else {
      if (rolesOnDisk) createBackup(rolesPath);
      const modelRoles = ensureTopMap(rolesDoc, 'modelRoles');

      // Profile un-link ('' id): strip the roles the sidecar says were
      // profile-linked — they fall back to the tier preset below. Manual and
      // foreign pins are never touched.
      const profileIn = options?.profile;
      const meta = readMeta(configPath);
      if (profileIn !== undefined && !profileIn.id && meta.profile?.bindings) {
        for (const role of Object.keys(meta.profile.bindings)) {
          if (isRouterModelRef(modelRoles.get(role))) modelRoles.delete(role);
        }
      }

      // Explicit role map: bare ids are written qualified as
      // `omnicell-router/<id>`; values already carrying a provider prefix are
      // written verbatim (foreign pins keep their provider).
      for (const [role, value] of Object.entries(explicitRoles)) {
        modelRoles.set(role, value.includes('/') ? value : `${OMP_PROVIDER_KEY}/${value}`);
      }
      // Tier preset: fill-only-absent — a foreign pin is never stolen; a
      // router-owned pin refreshes only when it is a preset auto* alias
      // (tier-table updates normalize); a router-owned concrete pick survives.
      for (const role of Object.keys(OMP_ROLE_TIERS)) {
        if (role in explicitRoles) continue;
        const tier = OMP_ROLE_TIERS[role];
        const current = modelRoles.get(role);
        if (typeof current === 'string' && current.length > 0) {
          const bare = routerModelBareId(current);
          if (bare === undefined) continue; // foreign pin — never stolen
          if (!VIRTUAL_AUTO_IDS.has(bare)) continue; // explicit router-owned pick
        }
        modelRoles.set(role, `${OMP_PROVIDER_KEY}/${tier}`);
      }
      // The `default` role IS the main-session model slot — one-click
      // takeover claims it unconditionally with the configured main model.
      // (Unlike pi's conservative defaultProvider claim: in omp, default
      // lives in the same modelRoles map the hook manages, and teardown's
      // restore-then-strip brings back the pre-takeover value — a foreign
      // hand-pick included — from the .bak.ocr backup. Leaving a stale value
      // behind, e.g. omp's old setup-wizard `router/*` residue, would route
      // the main session around the gateway while every other role goes
      // through it.)
      modelRoles.set('default', `${OMP_PROVIDER_KEY}/${main}`);
      writeYamlDocument(rolesPath, rolesDoc);
      // Profile-link echo: recorded AFTER the writes so the sidecar reflects
      // what this setup just applied ('' id clears it — the un-link sweep
      // above already removed the linked roles).
      if (profileIn !== undefined) {
        if (profileIn.id) meta.profile = { id: profileIn.id, bindings: profileIn.bindings || {} };
        else delete meta.profile;
        writeMeta(configPath, meta);
      }
      roleNote = `; ${modelRoles.items.length} model role(s) configured in ${rolesPath}`;
    }

    return {
      success: true,
      message: `omp configured to route via OCR (${targetUrl}, model: ${main}${ids.length > 1 ? ` +${ids.length - 1} extra` : ''}${contextWindow ? `, ctx=${contextWindow}` : ''}, key: ${apiKey === OMP_FALLBACK_API_KEY ? 'placeholder' : 'set'}). Backup saved to ${configPath}.bak.ocr${roleNote}`,
    };
  }

  /**
   * Profile-change write-through: re-resolve the linked roles' slot keys
   * against the JUST-SAVED profile slots and rewrite the linked modelRoles
   * entries WITHOUT a full setup. Only LINKED roles are touched: manual picks
   * and foreign pins stay byte-identical. A slot ref of 'auto' — or a slot
   * the profile no longer defines — strips the role's router-owned entry
   * (inherit the tier preset). A no-diff save writes nothing.
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
    const data = readYamlJs(configPath);
    if (!hookBaseUrl(data?.providers?.[OMP_PROVIDER_KEY])) {
      return { success: false, message: 'omp is not hooked — nothing to refresh' };
    }
    const rolesPath = this.getRolesPath();
    const rolesDoc = readYamlDocument(rolesPath);
    if (rolesDoc === null) {
      return { success: false, message: `Could not parse omp config at ${rolesPath} — fix it manually, then retry` };
    }
    const modelRoles = ensureTopMap(rolesDoc, 'modelRoles');

    // Desired end-state per LINKED role: resolved ref, or null = strip the
    // entry (slot missing / 'auto' inherit). Untagged roles never appear
    // here — write-through cannot see or touch them.
    const desired: Record<string, string | null> = {};
    let skipped = 0;
    for (const [role, slotKey] of Object.entries(tags || {})) {
      const ref = (slots || {})[slotKey];
      if (!ref || ref === 'auto') {
        desired[role] = null;
        skipped++;
        continue;
      }
      desired[role] = ref;
    }

    // Diff guard against the live roles — an unrelated config save must not
    // rewrite this file.
    const changed = Object.entries(desired).some(([role, ref]) => {
      const current = modelRoles.get(role);
      const currentBare = routerModelBareId(current) ?? (typeof current === 'string' ? current : undefined);
      return (ref || '') !== (currentBare || '');
    });
    const meta = readMeta(configPath);
    const stableEcho = (o: Record<string, string>) =>
      JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
    const echoSame =
      meta.profile?.id === profileId && stableEcho(meta.profile?.bindings || {}) === stableEcho(tags || {});
    if (!changed && echoSame) {
      return { success: true, message: 'omp profile links already up to date' };
    }

    createBackup(rolesPath);
    let applied = 0;
    for (const [role, ref] of Object.entries(desired)) {
      if (ref === null) {
        if (isRouterModelRef(modelRoles.get(role))) modelRoles.delete(role);
        continue;
      }
      modelRoles.set(role, ref.includes('/') ? ref : `${OMP_PROVIDER_KEY}/${ref}`);
      applied++;
    }
    // Prune emptied nodes (mirrors stripModelRoles).
    if (modelRoles.items.length === 0) rolesDoc.delete('modelRoles');
    writeYamlDocument(rolesPath, rolesDoc);

    // Expose the linked refs in the omp provider models list (idempotent
    // add — omp resolves a modelRoles selector against the provider's
    // declared ids). Only MISSING ids are added; existing entries are never
    // rewritten — a profile save must not stomp hand-edited records.
    const refs = [...new Set(Object.values(desired).filter((v): v is string => !!v))];
    if (refs.length > 0) {
      const doc = readYamlDocument(configPath);
      const providers = doc !== null ? (doc.get('providers') as unknown) : undefined;
      const entry = isMap(providers) ? (providers.get(OMP_PROVIDER_KEY) as unknown) : undefined;
      if (doc !== null && entry && isMap(entry)) {
        const modelsSeq = entry.get('models') as unknown;
        const listed: any[] = isSeq(modelsSeq) ? modelsSeq.toJSON() : [];
        const known = new Set(listed.map((m: any) => String(m?.id ?? '')).filter(Boolean));
        const missing = await buildOmpModelEntries(refs.filter(ref => !known.has(ref)));
        if (missing.length > 0) {
          entry.set('models', [...listed, ...missing]);
          writeYamlDocument(configPath, doc);
        }
      }
    }

    meta.profile = { id: profileId, bindings: tags || {} };
    writeMeta(configPath, meta);
    return {
      success: true,
      message: `omp profile links refreshed (${applied} role(s)${skipped > 0 ? `, ${skipped} inherit` : ''})`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    // Model roles live in config.yml — cleaned on every teardown path (even
    // when models.yml is already gone) so no router residue survives.
    const roleNote = this.stripModelRoles();
    // The profile-link sidecar is OCR-owned: it dies with the hook.
    removeMeta(configPath);

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}${roleNote}` };
    }

    // Restore-then-strip: a backup from a re-setup (port change, console
    // reset-models) contains the hooked file — restoring it alone would leave
    // the client routed while teardown claims success. Stripping the provider
    // key after any restore makes backup contamination harmless by design.
    if (restoreBackup(configPath)) {
      const restored = readYamlDocument(configPath);
      if (restored !== null) {
        this.stripProvider(restored);
        writeYamlDocument(configPath, restored);
      }
      return {
        success: true,
        message: `omp configuration restored from backup (${configPath}.bak.ocr)${roleNote}`,
      };
    }

    const doc = readYamlDocument(configPath);
    if (doc === null) {
      return { success: false, message: `Could not parse omp config at ${configPath}${roleNote}` };
    }

    if (this.stripProvider(doc)) {
      writeYamlDocument(configPath, doc);
      return { success: true, message: `omp decoupled from OCR: provider '${OMP_PROVIDER_KEY}' removed. Other providers untouched.${roleNote}` };
    }

    return { success: true, message: `No OCR hook present in ${configPath}; left untouched.${roleNote}` };
  }

  /** Remove the OCR provider from a models document in place; true when changed. */
  private stripProvider(doc: Document): boolean {
    const providers = doc.get('providers');
    if (!isMap(providers) || providers.get(OMP_PROVIDER_KEY) === undefined) return false;
    providers.delete(OMP_PROVIDER_KEY);
    if (providers.items.length === 0) doc.delete('providers');
    return true;
  }

  /**
   * Remove router-owned modelRoles entries from config.yml (values qualified
   * with the `omnicell-router/` prefix). Restore-then-strip like models.yml:
   * a backup written by a re-setup contains the pins, so restoring alone
   * would leave them behind. The user's own roles survive; an emptied
   * modelRoles node is pruned, and a config.yml that ends up completely
   * empty (fresh-install case) is removed outright.
   */
  private stripModelRoles(): string {
    const rolesPath = this.getRolesPath();
    const hadBackup = fs.existsSync(`${rolesPath}.bak.ocr`);
    if (!fs.existsSync(rolesPath) && !hadBackup) return '';
    if (hadBackup) restoreBackup(rolesPath);
    const doc = readYamlDocument(rolesPath);
    if (doc === null) {
      return `; model roles NOT cleaned (${rolesPath} is not valid YAML)`;
    }
    const modelRoles = doc.get('modelRoles') as unknown;
    let removed = 0;
    if (isMap(modelRoles)) {
      for (const item of [...modelRoles.items] as unknown as { key?: { value?: unknown }; value?: { value?: unknown } }[]) {
        const key = String(item.key?.value ?? '');
        if (isRouterModelRef(item.value?.value)) {
          modelRoles.delete(key);
          removed++;
        }
      }
      if (modelRoles.items.length === 0) doc.delete('modelRoles');
    }
    if (removed > 0) {
      if (((doc.contents as unknown as { items?: unknown[] } | null)?.items ?? []).length === 0) {
        try {
          fs.unlinkSync(rolesPath);
        } catch {
          writeYamlDocument(rolesPath, doc); // unlink failed (file lock) — at least drop the residue
        }
      } else {
        writeYamlDocument(rolesPath, doc);
      }
    }
    return removed > 0 ? `; removed ${removed} router-owned model role(s) from ${rolesPath}` : '';
  }
}
