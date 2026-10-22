import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  safeReadJson,
  safeWriteJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, ClientModelSlot, ModelProfileBinding, VIRTUAL_AUTO_IDS } from '../types.js';
import { piThinkingLevelMap, resolveClientModelMeta } from './model-meta.js';

/**
 * Provider key written into pi's `~/.pi/agent/models.json` — the key name
 * itself is the hook marker. pi validates models.json against a strict schema
 * (unknown top-level keys fail the whole file), so the OCR_WATERMARK trick
 * used by claude/codex is not safe here. Detection is host-agnostic: a valid
 * http(s) baseUrl on this key means the client routes through an OCR gateway
 * (local loopback, LAN-bound host, or a remote box — all are "hooked").
 */
const PI_PROVIDER_KEY = 'onecast-router';

/** Placeholder apiKey — pi's schema REQUIRES apiKey whenever custom models are declared. */
const PI_FALLBACK_API_KEY = '***';

/**
 * Router-owned subagent tier mapping for pi-subagents
 * (`subagents.agentOverrides.<role>.model` in ~/.pi/agent/settings.json).
 * Full four-tier ladder (mirrors the gateway's lite/plus/pro/ultra):
 * lite = recon & web research, plus = verification & delegation,
 * pro = implementation & review, ultra = the oracle second opinion.
 * This is NOT the roster source — roles are discovered from the installed
 * package, user agent files, and existing pins (see discoverSubagentRoles);
 * this table supplies each known role's recommended tier and doubles as the
 * fallback roster when nothing is discoverable (unusual install layout, older
 * pi-subagents releases that ship no agents/*.md — planner/context-builder
 * are kept for exactly those legacy versions; on current releases they are
 * inert). Discovered roles without an entry here default to the auto
 * cascade. Values are bare auto* aliases — written into settings qualified
 * as `<PI_PROVIDER_KEY>/<alias>` so pi-subagents resolves them exactly.
 */
const PI_SUBAGENT_TIERS: Record<string, string> = {
  scout: 'lite',
  researcher: 'lite',
  delegate: 'plus',
  'evidence-auditor': 'plus',
  'context-builder': 'plus', // legacy builtin (pre-0.7x releases)
  planner: 'pro', // legacy builtin (pre-0.7x releases)
  worker: 'pro',
  reviewer: 'pro',
  oracle: 'ultra',
};

/** Namespace prefix marking a subagent override as router-owned (teardown strips these, only these). */
const SUBAGENT_MODEL_PREFIX = `${PI_PROVIDER_KEY}/`;

/**
 * Sidecar next to models.json (`models.json.ocr-meta.json`) holding the
 * profile-link echo (profile id + role → profile-slot key). The echo must
 * NEVER live in settings.json: a running pi rewrites that file from memory
 * and silently wipes externally-written keys, so any link labels written
 * there would be lost between restarts. models.json itself is also unsafe —
 * pi validates it against a strict schema (unknown top-level keys fail the
 * whole file). The sidecar is OCR-owned and never read by pi.
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

/** Shape-guard for an agentOverrides entry: entries are open objects (pi
 *  stores per-role fields like `thinking` alongside `model`), anything else
 *  is replaced by a fresh object rather than merged into. */
function overrideBase(entry: unknown): Record<string, unknown> {
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>) } : {};
}

/** baseUrl of the OCR provider entry, when it is a usable http(s) URL. */
const hookBaseUrl = (entry: any): string | undefined =>
  typeof entry?.baseUrl === 'string' && /^https?:\/\//.test(entry.baseUrl) ? entry.baseUrl : undefined;

function removeMeta(configPath: string): void {
  try {
    fs.rmSync(metaPathFor(configPath), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Static declarations for the fixed auto* alias block. The aliases are
 * dynamic targets — the actual model (and its real effort support) is
 * resolved per request by the gateway, which clamps to what it can serve and
 * reports the truth via the X-OCR-Thinking-* headers — so the declaration is
 * the permissive full ladder, never a per-model subset.
 */
const PI_ALIAS_META: Record<string, { name: string }> = {
  auto: { name: 'Auto' },
  'lite': { name: 'Lite' },
  'plus': { name: 'Plus' },
  'pro': { name: 'Pro' },
  'ultra': { name: 'Ultra' },
};

/**
 * One models.json entry, with metadata completeness as the point: pi's
 * `/thinking` picker reads `reasoning` + `thinkingLevelMap` (absent → the
 * model reads as non-thinking and no thinking level can be set), the
 * `/model` picker reads `name`, compaction reads `contextWindow` /
 * `maxTokens`, and the cost footer reads `cost`. Sources, in order:
 *  - the fixed auto* aliases: static full-ladder declaration (see
 *    PI_ALIAS_META) + the caller's context window (there is no per-alias
 *    catalog truth);
 *  - concrete ids: resolved against the live gateway registry/catalog
 *    (model-meta.ts) — per-model context window/maxTokens/cost/name beat the
 *    caller's single context window, which stays the fallback for ids with
 *    no catalog record;
 *  - anything unresolved (standalone CLI — no registry to consult): the
 *    bare `{id, contextWindow?}` entry of legacy setups.
 */
async function buildModelEntries(ids: string[], contextWindow?: number): Promise<Record<string, unknown>[]> {
  const meta = await resolveClientModelMeta(ids.filter((id) => !VIRTUAL_AUTO_IDS.has(id)));
  return ids.map((id) => {
    if (VIRTUAL_AUTO_IDS.has(id)) {
      const alias = PI_ALIAS_META[id];
      return {
        id,
        ...(alias?.name ? { name: alias.name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        reasoning: true,
        thinkingLevelMap: piThinkingLevelMap(),
      };
    }
    const m = meta[id];
    if (!m) return { id, ...(contextWindow ? { contextWindow } : {}) };
    return {
      id,
      name: m.name ?? id,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : contextWindow ? { contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m.reasoning ? { reasoning: true, thinkingLevelMap: m.thinkingLevelMap ?? piThinkingLevelMap() } : { reasoning: false }),
      ...(m.input ? { input: m.input } : {}),
      ...(m.cost ? { cost: m.cost } : {}),
    };
  });
}

export class PiClientAdapter implements ClientAdapter {
  name = 'pi' as const;
  displayName = 'Pi Coding Agent';

  getConfigPath(): string {
    return path.join(os.homedir(), '.pi', 'agent', 'models.json');
  }

  /**
   * pi's user settings file — derived from the models.json dir so test
   * redirects of getConfigPath isolate this file too.
   */
  getSettingsPath(): string {
    return path.join(path.dirname(this.getConfigPath()), 'settings.json');
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    const data = exists ? safeReadJson(configPath) : null;
    const entry = data?.providers?.[PI_PROVIDER_KEY];
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

    let details = 'Direct provider connection (built-in pi catalog)';
    if (url) {
      details = portFresh
        ? `Routed to OneCastRouter gateway (${url})`
        : `Routed via OCR gateway URL ${url} — current port is :${defaultGatewayPort()}, re-apply setup to refresh`;
    } else if (!exists) {
      details = 'No pi config file detected (~/.pi/agent/models.json)';
    }

    const overridesRaw = safeReadJson(this.getSettingsPath())?.subagents?.agentOverrides;
    const overrides = overridesRaw && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw) ? overridesRaw : undefined;
    const models: any[] = url && Array.isArray(entry.models) ? entry.models : [];
    if (url) {
      const pinned = overrides
        ? Object.keys(overrides).filter(role => {
            const model = overrides[role]?.model;
            return typeof model === 'string' && model.startsWith(SUBAGENT_MODEL_PREFIX);
          }).length
        : 0;
      if (pinned > 0) details += `; ${pinned} subagent role(s) pinned via ${this.getSettingsPath()}`;
    }
    // Subagent roles surface as extra slots (pi-subagents agentOverrides). A
    // router-owned pin echoes as the bare id (matches the console picker
    // options); a foreign (user-pinned) value echoes verbatim so the UI shows
    // — and round-trips — the manual choice; absent → undefined so the UI
    // seeds the role's preset tier default.
    const modelSlots: ClientModelSlot[] = [
      // Pi has one model picker (/model, --model); the first entry is the main slot.
      { key: 'main', value: models[0]?.id ? String(models[0].id) : undefined, default: 'auto' },
    ];
    for (const role of this.discoverSubagentRoles(overrides)) {
      const pinnedModel = overrides?.[role]?.model;
      modelSlots.push({
        key: role,
        value: typeof pinnedModel === 'string' && pinnedModel
          ? pinnedModel.startsWith(SUBAGENT_MODEL_PREFIX) ? pinnedModel.slice(SUBAGENT_MODEL_PREFIX.length) : pinnedModel
          : undefined,
        default: PI_SUBAGENT_TIERS[role] || 'auto',
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
      // Profile-link echo from the OCR sidecar (models.json.ocr-meta.json) —
      // live only while hooked (teardown deletes the sidecar with the hook).
      profile: url ? readMeta(configPath).profile : undefined,
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number; extraModels?: string[]; /** Effective role bindings (manual + profile-linked, merged by the console route): role → modelRef. */ agentModels?: Record<string, string>; /** Profile-link echo for the OCR sidecar meta: profile id + role → profile-slot key ('' id = un-link: strip the linked roles' overrides). */ profile?: ModelProfileBinding }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    // Never overwrite a models.json we cannot read — it likely holds the
    // user's own providers (Ollama, vLLM, …) that a blind write would erase.
    let data: any = {};
    if (fs.existsSync(configPath)) {
      const parsed = safeReadJson(configPath);
      if (parsed === null) {
        return { success: false, message: `Could not parse pi config at ${configPath} — fix it manually or remove it, then retry.` };
      }
      data = parsed;
      createBackup(configPath);
    }

    if (!data.providers || typeof data.providers !== 'object') data.providers = {};

    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const main = options?.models?.main?.trim() || 'auto';
    // Fixed auto* tier aliases are always exposed (the gateway resolves them
    // natively), then the user's extra concrete models. Main stays slot #1;
    // everything is deduped against what is already listed.
    const extras = (options?.extraModels || []).map(id => id.trim()).filter(id => id && id !== main);
    const ids = [main, ...[...VIRTUAL_AUTO_IDS].filter(id => id !== main && !extras.includes(id)), ...extras];
    const contextWindow = options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;
    // Gateway-issued key wins; keep the previous entry's key; placeholder only
    // as last resort (pi needs the field present; the gateway preHandler may
    // still 401 without a real key when adminApiKey auth is enabled).
    const apiKey = options?.apiKey?.trim() || data.providers[PI_PROVIDER_KEY]?.apiKey || PI_FALLBACK_API_KEY;

    data.providers[PI_PROVIDER_KEY] = {
      baseUrl: targetUrl,
      api: 'openai-completions',
      apiKey,
      models: await buildModelEntries(ids, contextWindow),
    };

    safeWriteJson(configPath, data);

    // Subagent model overrides (pi-subagents `subagents.agentOverrides` in
    // ~/.pi/agent/settings.json). Two sources, explicit first:
    //  - per-role entries in `models` (console slot payload; 'main' excluded):
    //    the picked value wins — bare ids are written qualified as
    //    `onecast-router/<id>`, values already carrying a provider prefix are
    //    written verbatim, and an unchanged echo is a no-op so a manually
    //    pinned non-router model survives untouched;
    //  - the router-owned tier preset fills every remaining role that has no
    //    model (fill-only-absent: a manually pinned non-router model is never
    //    stolen — teardown could not give it back after backup contamination);
    //    already-router-owned values refresh only when they are preset auto*
    //    aliases (tier-table updates normalize), concrete picks survive.
    // The user's other settings keys and per-role fields (thinking, tools, …)
    // are preserved. An unparseable settings file skips this block (reported
    // in the message); models.json above is the load-bearing hook.
    const settingsPath = this.getSettingsPath();
    let subagentNote = '';
    const settingsOnDisk = fs.existsSync(settingsPath);
    const settings = settingsOnDisk ? safeReadJson(settingsPath) : {};
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      subagentNote = `; subagent tier mapping skipped — ${settingsPath} is not valid JSON`;
    } else {
      if (settingsOnDisk) createBackup(settingsPath);
      if (!settings.subagents || typeof settings.subagents !== 'object' || Array.isArray(settings.subagents)) settings.subagents = {};
      const sub = settings.subagents;
      if (!sub.agentOverrides || typeof sub.agentOverrides !== 'object' || Array.isArray(sub.agentOverrides)) sub.agentOverrides = {};
      const overrides: Record<string, any> = sub.agentOverrides;

      // Profile un-link ('' id): strip the overrides of roles the sidecar says
      // were profile-linked — they fall back to the tier preset below. Manual
      // and foreign pins are never touched.
      const profileIn = options?.profile;
      const meta = readMeta(configPath);
      if (profileIn !== undefined && !profileIn.id && meta.profile?.bindings) {
        for (const role of Object.keys(meta.profile.bindings)) {
          const entry = overrides[role];
          if (
            entry && typeof entry === 'object' && !Array.isArray(entry) &&
            typeof entry.model === 'string' && entry.model.startsWith(SUBAGENT_MODEL_PREFIX)
          ) {
            if (Object.keys(entry).length === 1) delete overrides[role];
            else delete entry.model;
          }
        }
      }

      // Effective role map: explicit picks from `models` plus the
      // console-resolved bindings (`agentModels` — manual + profile-linked
      // merged). Both are explicit: the tier preset below never fills them.
      const explicitRoles = new Set<string>();
      const effectiveRoles: Record<string, string> = {};
      for (const [role, raw] of Object.entries(options?.models || {})) {
        if (role === 'main') continue;
        const value = typeof raw === 'string' ? raw.trim() : '';
        // Multi-segment provider paths are legal model refs (openrouter/org/model).
        if (!value || !/^[\w.:-]+(\/[\w.:-]+)*$/.test(value)) continue;
        effectiveRoles[role] = value;
        explicitRoles.add(role);
      }
      for (const [role, raw] of Object.entries(options?.agentModels || {})) {
        const value = (raw || '').trim();
        if (!value || !/^[\w.:-]+(\/[\w.:-]+)*$/.test(value)) continue;
        effectiveRoles[role] = value;
        explicitRoles.add(role);
      }
      for (const [role, value] of Object.entries(effectiveRoles)) {
        const entry = overrides[role];
        const base = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
        if (base.model === value) continue; // unchanged echo — leave a manual pin byte-identical
        overrides[role] = { ...base, model: value.includes('/') ? value : `${PI_PROVIDER_KEY}/${value}` };
      }
      for (const role of this.discoverSubagentRoles(overrides)) {
        if (explicitRoles.has(role)) continue;
        const tier = PI_SUBAGENT_TIERS[role] || 'auto';
        const entry = overrides[role];
        const base = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
        const current = base.model;
        if (typeof current === 'string' && current.length > 0) {
          if (!current.startsWith(SUBAGENT_MODEL_PREFIX)) continue; // foreign pin — never stolen
          // Router-owned: refresh only preset-vocabulary auto* aliases (tier
          // table updates normalize on re-setup); a router-owned concrete pick
          // (onecast-router/<id>) is an explicit choice and survives.
          if (!VIRTUAL_AUTO_IDS.has(current.slice(SUBAGENT_MODEL_PREFIX.length))) continue;
        }
        overrides[role] = { ...base, model: `${PI_PROVIDER_KEY}/${tier}` };
      }
      safeWriteJson(settingsPath, settings);
      // Profile-link echo: recorded AFTER the writes so the sidecar reflects
      // what this setup just applied ('' id clears it — the un-link sweep
      // above already removed the linked roles' overrides).
      if (profileIn !== undefined) {
        if (profileIn.id) meta.profile = { id: profileIn.id, bindings: profileIn.bindings || {} };
        else delete meta.profile;
        writeMeta(configPath, meta);
      }
      subagentNote = `; ${Object.keys(overrides).length} subagent role(s) configured in ${settingsPath} (restart pi to pick up — a running pi rewrites this file from memory)`;
    }

    return {
      success: true,
      message: `Pi configured to route via OCR (${targetUrl}, model: ${main}${ids.length > 1 ? ` +${ids.length - 1} extra` : ''}${contextWindow ? `, ctx=${contextWindow}` : ''}, key: ${apiKey === PI_FALLBACK_API_KEY ? 'placeholder' : 'set'}). Backup saved to ${configPath}.bak.ocr${subagentNote}`,
    };
  }

  /**
   * Profile-change write-through: re-resolve the linked roles' slot keys
   * against the JUST-SAVED profile slots and rewrite the linked roles'
   * agentOverrides WITHOUT a full setup — a saved profile update propagates
   * to hooked clients automatically. Only LINKED roles are touched: manual
   * picks and foreign pins stay byte-identical, and there is no sweep (pi's
   * per-role override map is additive, unlike opencode's agent node). A slot
   * ref of 'auto' — or a slot the profile no longer defines — strips the
   * role's router-owned override (inherit the tier preset / default). A
   * no-diff save writes nothing.
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
    const data = safeReadJson(configPath);
    if (!hookBaseUrl(data?.providers?.[PI_PROVIDER_KEY])) {
      return { success: false, message: 'Pi is not hooked — nothing to refresh' };
    }
    const settingsPath = this.getSettingsPath();
    const settings = safeReadJson(settingsPath);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      return { success: false, message: `Could not parse pi settings at ${settingsPath} — fix it manually, then retry` };
    }
    if (!settings.subagents || typeof settings.subagents !== 'object' || Array.isArray(settings.subagents)) settings.subagents = {};
    const sub = settings.subagents;
    if (!sub.agentOverrides || typeof sub.agentOverrides !== 'object' || Array.isArray(sub.agentOverrides)) sub.agentOverrides = {};
    const overrides: Record<string, any> = sub.agentOverrides;

    // Desired end-state per LINKED role: resolved ref, or null = strip the
    // override (slot missing / 'auto' inherit). Untagged roles never appear
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

    // Diff guard against the live overrides — an unrelated config save must
    // not rewrite this file.
    const changed = Object.entries(desired).some(([role, ref]) => {
      const current = overrides[role]?.model;
      const currentBare = typeof current === 'string' && current.startsWith(SUBAGENT_MODEL_PREFIX)
        ? current.slice(SUBAGENT_MODEL_PREFIX.length)
        : current;
      return (ref || '') !== (typeof currentBare === 'string' ? currentBare : '');
    });
    const meta = readMeta(configPath);
    const stableEcho = (o: Record<string, string>) =>
      JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
    const echoSame =
      meta.profile?.id === profileId && stableEcho(meta.profile?.bindings || {}) === stableEcho(tags || {});
    if (!changed && echoSame) {
      return { success: true, message: 'pi profile links already up to date' };
    }

    createBackup(settingsPath);
    let applied = 0;
    for (const [role, ref] of Object.entries(desired)) {
      if (ref === null) {
        const entry = overrides[role];
        if (
          entry && typeof entry === 'object' && !Array.isArray(entry) &&
          typeof entry.model === 'string' && entry.model.startsWith(SUBAGENT_MODEL_PREFIX)
        ) {
          if (Object.keys(entry).length === 1) delete overrides[role];
          else delete entry.model;
        }
        continue;
      }
      const base = overrideBase(overrides[role]);
      overrides[role] = { ...base, model: `${PI_PROVIDER_KEY}/${ref}` };
      applied++;
    }
    // Prune emptied nodes (mirrors stripSubagentOverrides).
    if (Object.keys(overrides).length === 0) delete settings.subagents.agentOverrides;
    if (settings.subagents && Object.keys(settings.subagents).length === 0) delete settings.subagents;
    if (Object.keys(settings).length === 0) {
      try {
        fs.rmSync(settingsPath, { force: true });
      } catch {
        safeWriteJson(settingsPath, settings); // unlink failed (file lock) — at least drop the residue
      }
    } else {
      safeWriteJson(settingsPath, settings);
    }

    // Expose the linked refs in the pi provider models list (idempotent add —
    // pi resolves an override's model against the provider's declared ids).
    // Only MISSING ids are added, with full metadata; existing entries are
    // never rewritten — a profile save must not stomp hand-edited records.
    const refs = [...new Set(Object.values(desired).filter((v): v is string => !!v))];
    if (refs.length > 0) {
      const providerModels: any[] = Array.isArray(data.providers[PI_PROVIDER_KEY].models)
        ? data.providers[PI_PROVIDER_KEY].models
        : [];
      const entries = await buildModelEntries(refs);
      let added = 0;
      for (const entry of entries) {
        if (!providerModels.some((m: any) => m?.id === entry.id)) {
          providerModels.push(entry);
          added++;
        }
      }
      if (added > 0) {
        data.providers[PI_PROVIDER_KEY].models = providerModels;
        safeWriteJson(configPath, data);
      }
    }

    meta.profile = { id: profileId, bindings: tags || {} };
    writeMeta(configPath, meta);
    return {
      success: true,
      message: `pi profile links refreshed (${applied} role(s)${skipped > 0 ? `, ${skipped} inherit` : ''})`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    // Subagent overrides live in settings.json — cleaned on every teardown
    // path (even when models.json is already gone) so no router residue survives.
    const subagentNote = this.stripSubagentOverrides();
    // The profile-link sidecar is OCR-owned: it dies with the hook.
    removeMeta(configPath);

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}${subagentNote}` };
    }

    // Restore-then-strip: a backup from a re-setup (port change, console
    // reset-models) contains the hooked file — restoring it alone would leave
    // the client routed while teardown claims success. Stripping the provider
    // key after any restore makes backup contamination harmless by design.
    if (restoreBackup(configPath)) {
      const restored = safeReadJson(configPath);
      if (restored?.providers?.[PI_PROVIDER_KEY]) {
        delete restored.providers[PI_PROVIDER_KEY];
        safeWriteJson(configPath, restored);
      }
      return {
        success: true,
        message: `Pi configuration restored from backup (${configPath}.bak.ocr)${subagentNote}`,
      };
    }

    const data = safeReadJson(configPath);
    if (!data) {
      return { success: false, message: `Could not parse pi config at ${configPath}${subagentNote}` };
    }

    if (data.providers?.[PI_PROVIDER_KEY]) {
      delete data.providers[PI_PROVIDER_KEY];
      safeWriteJson(configPath, data);
      return { success: true, message: `Pi decoupled from OCR: provider '${PI_PROVIDER_KEY}' removed. Other providers untouched.${subagentNote}` };
    }

    return { success: true, message: `No OCR hook present in ${configPath}; left untouched.${subagentNote}` };
  }

  /**
   * Enumerate the subagent roster available on this machine. pi-subagents
   * discovers agents at runtime (builtins ship per package version, users add
   * custom ones), so the slot list is discovered, never assumed:
   *  - builtins: `name:` frontmatter of the installed package's agents/*.md —
   *    `runner:`-frontmatter agents are external-CLI launchers (claude-code,
   *    codex-exec, cursor-agent, …) and are skipped: model overrides don't
   *    route them;
   *  - custom user agents: `name:` frontmatter of ~/.pi/agent/agents/*.md;
   *  - anything already pinned under settings `subagents.agentOverrides`.
   * When neither directory yields anything (fresh machine, unusual install
   * layout) the preset roster is used as fallback. Never throws; order is
   * preset-known roles first, then the rest alphabetically.
   */
  private discoverSubagentRoles(overrides: Record<string, any> | undefined): string[] {
    const found = new Set<string>();
    const agentRoot = path.dirname(this.getConfigPath());
    const scanDirs: { dir: string; isPackage: boolean }[] = [
      { dir: path.join(agentRoot, 'npm', 'node_modules', 'pi-subagents', 'agents'), isPackage: true },
      { dir: path.join(agentRoot, 'agents'), isPackage: false },
    ];
    for (const { dir, isPackage } of scanDirs) {
      let files: string[] = [];
      try {
        if (fs.existsSync(dir)) files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch {
        files = [];
      }
      for (const file of files) {
        let content = '';
        try {
          content = fs.readFileSync(path.join(dir, file), 'utf8');
        } catch {
          continue;
        }
        // Strip a UTF-8 BOM (Windows editors) and unquote the value — external
        // file input must never leak `"scout"`-style keys into settings.json.
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.replace(/^\uFEFF/, ''))?.[1] || '';
        const name = /^[ \t]*name:[ \t]*([^\s]+)/m.exec(frontmatter)?.[1]?.replace(/^['"]|['"]$/g, '');
        if (!name) continue;
        if (isPackage && /^runner:/m.test(frontmatter)) continue; // external-CLI launcher — not model-routed
        found.add(name);
      }
    }
    if (found.size === 0) {
      for (const role of Object.keys(PI_SUBAGENT_TIERS)) found.add(role);
    }
    for (const role of Object.keys(overrides || {})) {
      if (typeof role === 'string' && role) found.add(role);
    }
    const known = Object.keys(PI_SUBAGENT_TIERS).filter(r => found.has(r));
    const rest = [...found].filter(r => !(r in PI_SUBAGENT_TIERS)).sort();
    return [...known, ...rest];
  }

  /**
   * Remove router-owned subagent model overrides from the settings file
   * (`subagents.agentOverrides.<role>.model` values carrying the
   * `onecast-router/` namespace prefix). Restore-then-strip like models.json:
   * a backup written by a re-setup contains the overrides, so restoring alone
   * would leave them behind. The user's own overrides — any role, any field —
   * survive; emptied role objects / agentOverrides / subagents nodes are
   * pruned, and a settings file that ends up completely empty (fresh-install
   * case) is removed outright.
   */
  private stripSubagentOverrides(): string {
    const settingsPath = this.getSettingsPath();
    const hadBackup = fs.existsSync(`${settingsPath}.bak.ocr`);
    if (!fs.existsSync(settingsPath) && !hadBackup) return '';
    if (hadBackup) restoreBackup(settingsPath);
    const data = safeReadJson(settingsPath);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return `; subagent overrides NOT cleaned (${settingsPath} is not valid JSON)`;
    }
    const overrides = data?.subagents?.agentOverrides;
    let removed = 0;
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      for (const role of Object.keys(overrides)) {
        const entry = overrides[role];
        if (
          entry && typeof entry === 'object' && !Array.isArray(entry) &&
          typeof entry.model === 'string' && entry.model.startsWith(SUBAGENT_MODEL_PREFIX)
        ) {
          if (Object.keys(entry).length === 1) delete overrides[role];
          else delete entry.model;
          removed++;
        }
      }
      if (removed > 0) {
        if (Object.keys(overrides).length === 0) delete data.subagents.agentOverrides;
        if (data.subagents && Object.keys(data.subagents).length === 0) delete data.subagents;
        if (Object.keys(data).length === 0) {
          try {
            fs.unlinkSync(settingsPath);
          } catch {
            safeWriteJson(settingsPath, data); // unlink failed (file lock) — at least drop the residue
          }
        } else {
          safeWriteJson(settingsPath, data);
        }
      }
    }
    return removed > 0 ? `; removed ${removed} subagent role override(s) from ${settingsPath}` : '';
  }
}
