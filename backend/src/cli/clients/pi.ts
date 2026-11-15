import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  describeBackup,
  restoreBackup,
  safeReadJson,
  safeWriteJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, ClientModelSlot, VIRTUAL_AUTO_IDS } from '../types.js';
import { piThinkingLevelMap, resolveClientModelMeta } from './model-meta.js';

/**
 * Provider key written into pi's `~/.pi/agent/models.json` — the key name
 * itself is the hook marker. pi validates models.json against a strict schema
 * (unknown top-level keys fail the whole file), so the OCR_WATERMARK trick
 * used by claude/codex is not safe here. Detection is host-agnostic: a valid
 * http(s) baseUrl on this key means the client routes through an OCR gateway
 * (local loopback, LAN-bound host, or a remote box — all are "hooked").
 */
const PI_PROVIDER_KEY = 'omnicell-router';

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

/** True when a model ref is qualified with the router provider key. */
const isRouterModelRef = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith(`${PI_PROVIDER_KEY}/`);

/** Bare id of a router-qualified ref, or undefined when foreign. */
const routerModelBareId = (v: unknown): string | undefined =>
  isRouterModelRef(v) ? v.slice(PI_PROVIDER_KEY.length + 1) : undefined;

/**
 * Startup thinking level written into pi's settings.json alongside
 * defaultProvider/defaultModel. `medium` is pi's own built-in default — safe
 * for every model: the gateway resolves each request's real model and clamps
 * the requested effort to what it can serve (X-OCR-Thinking-* headers), so a
 * permissive client-side preset never over-drives a weaker rung.
 */
const PI_DEFAULT_THINKING_LEVEL = 'medium';

/**
 * Legacy OCR sidecar next to models.json (`models.json.ocr-meta.json`).
 * Older builds wrote a profile-link echo here; the model-profile mechanism is
 * gone (ADR-0031) — the sidecar is now only DELETED (teardown), never read
 * or written.
 */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
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
 *    PI_ALIAS_META) + the aggregated tier-member envelope from the live
 *    registry (tierAliasDisplayMeta — min limits across the ladder, leader
 *    pricing), falling back to the caller's context window when no registry
 *    is live (standalone CLI — nothing to resolve against);
 *  - concrete ids: resolved against the live gateway registry/catalog
 *    (model-meta.ts) — per-model context window/maxTokens/cost/name beat the
 *    caller's single context window, which stays the fallback for ids with
 *    no catalog record;
 *  - anything unresolved (standalone CLI — no registry to consult): the
 *    bare `{id, contextWindow?}` entry of legacy setups.
 */
async function buildModelEntries(ids: string[], contextWindow?: number): Promise<Record<string, unknown>[]> {
  // Alias ids participate in meta resolution too — the aggregated tier-member
  // envelope (contextWindow/maxTokens/cost/modalities) layers ON TOP of the
  // static alias base below; the ladder stays the permissive full map.
  const meta = await resolveClientModelMeta(ids);
  return ids.map((id) => {
    if (VIRTUAL_AUTO_IDS.has(id)) {
      const alias = PI_ALIAS_META[id];
      const m = meta[id];
      return {
        id,
        ...(alias?.name ? { name: alias.name } : {}),
        // Aggregated member envelope beats the caller's single context window;
        // the caller's value stays the fallback when no registry is live (CLI).
        ...(m?.contextWindow ? { contextWindow: m.contextWindow } : contextWindow ? { contextWindow } : {}),
        ...(m?.maxTokens ? { maxTokens: m.maxTokens } : {}),
        ...(m?.input ? { input: m.input } : {}),
        ...(m?.cost ? { cost: m.cost } : {}),
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
  hookKind = 'config' as const;
  displayName = 'Pi';

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

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
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
        ? `Routed to OmniCellRouter gateway (${url})`
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
            return isRouterModelRef(model);
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
    for (const { name: role, description } of this.discoverSubagentRoles(overrides)) {
      // A USER-pinned slot (pi's own agentOverrides), never the gateway's
      // session pin — different word, different mechanism.
      const userPinnedModel = overrides?.[role]?.model;
      modelSlots.push({
        key: role,
        value: typeof userPinnedModel === 'string' && userPinnedModel
          ? routerModelBareId(userPinnedModel) ?? userPinnedModel
          : undefined,
        default: PI_SUBAGENT_TIERS[role] || 'auto',
        description,
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
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number; extraModels?: string[]; /** Follow mode: the virtual tier subset the selected key's policy admits. */ virtualModels?: string[]; /** Effective role bindings (manual picks): role → modelRef. */ agentModels?: Record<string, string>; }): Promise<{ success: boolean; message: string }> {
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
    // Gateway-issued key wins; keep the previous entry's key; placeholder only
    // as last resort (pi needs the field present; the gateway preHandler may
    // still 401 without a real key when client API-key auth is enabled).
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
    //    `omnicell-router/<id>`, values already carrying a provider prefix are
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

      // Effective role map: explicit picks from `models` plus the
      // console-resolved bindings (`agentModels`). Both are explicit: the
      // tier preset below never fills them.
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
      for (const { name: role } of this.discoverSubagentRoles(overrides)) {
        if (explicitRoles.has(role)) continue;
        const tier = PI_SUBAGENT_TIERS[role] || 'auto';
        const entry = overrides[role];
        const base = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
        const current = base.model;
        if (typeof current === 'string' && current.length > 0) {
          const bare = routerModelBareId(current);
          if (bare === undefined) continue; // foreign pin — never stolen
          // Router-owned: refresh only
          // preset-vocabulary auto* aliases (tier table updates normalize on
          // re-setup); a router-owned concrete pick is an explicit choice and
          // survives.
          if (!VIRTUAL_AUTO_IDS.has(bare)) continue;
        }
        overrides[role] = { ...base, model: `${PI_PROVIDER_KEY}/${tier}` };
      }
      // Startup defaults: route pi's first screen through OCR. Only claimed
      // when unset or already router-owned — a hand-picked foreign provider
      // (user's own default in settings.json) is never stolen; the model list
      // in models.json still exposes the OCR entries via /model.
      if (!settings.defaultProvider || String(settings.defaultProvider) === PI_PROVIDER_KEY) {
        settings.defaultProvider = PI_PROVIDER_KEY;
        settings.defaultModel = main;
        if (!settings.defaultThinkingLevel) settings.defaultThinkingLevel = PI_DEFAULT_THINKING_LEVEL;
      }
      safeWriteJson(settingsPath, settings);
      subagentNote = `; ${Object.keys(overrides).length} subagent role(s) configured in ${settingsPath} (restart pi to pick up — a running pi rewrites this file from memory)`;
    }

    return {
      success: true,
      message: `Pi configured to route via OCR (${targetUrl}, model: ${main}${ids.length > 1 ? ` +${ids.length - 1} extra` : ''}${contextWindow ? `, ctx=${contextWindow}` : ''}, key: ${apiKey === PI_FALLBACK_API_KEY ? 'placeholder' : 'set'}).${describeBackup(configPath)}${subagentNote}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    // Subagent overrides live in settings.json — cleaned on every teardown
    // path (even when models.json is already gone) so no router residue survives.
    const subagentNote = this.stripSubagentOverrides();
    // The legacy OCR sidecar (a pre-ADR-0031 profile-link echo) dies with the hook.
    removeMeta(configPath);

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}${subagentNote}` };
    }

    // Restore-then-strip: a snapshot written by an older build (a re-setup
    // used to overwrite it with the already-hooked file) may hold the hook,
    // and restoring it alone would leave the client routed while teardown
    // claims success. Stripping the provider key after any restore keeps a
    // legacy snapshot harmless.
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
  private discoverSubagentRoles(overrides: Record<string, any> | undefined): { name: string; description?: string }[] {
    const found = new Map<string, string | undefined>();
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
        // The role's own one-line description, when the agent file carries one.
        // Package files land first, user files second, so a user override's
        // description wins (same precedence as the name itself).
        const description = /^[ \t]*description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]
          ?.trim()
          .replace(/^['"]|['"]$/g, '');
        found.set(name, description || found.get(name));
      }
    }
    if (found.size === 0) {
      for (const role of Object.keys(PI_SUBAGENT_TIERS)) found.set(role, undefined);
    }
    for (const role of Object.keys(overrides || {})) {
      if (typeof role === 'string' && role && !found.has(role)) found.set(role, undefined);
    }
    const known = Object.keys(PI_SUBAGENT_TIERS).filter(r => found.has(r));
    const rest = [...found.keys()].filter(r => !(r in PI_SUBAGENT_TIERS)).sort();
    return [...known, ...rest].map(name => ({ name, description: found.get(name) }));
  }

  /**
   * Remove router-owned subagent model overrides from the settings file
   * (`subagents.agentOverrides.<role>.model` values carrying the
   * `omnicell-router/` namespace prefix). Restore-then-strip like models.json:
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
    // Router-owned startup defaults die with the hook — but only ours: a
    // foreign defaultProvider (user's own pick) is never touched.
    if (data.defaultProvider === PI_PROVIDER_KEY) {
      delete data.defaultProvider;
      delete data.defaultModel;
      if (data.defaultThinkingLevel === PI_DEFAULT_THINKING_LEVEL) delete data.defaultThinkingLevel;
      removed++;
    }
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      for (const role of Object.keys(overrides)) {
        const entry = overrides[role];
        if (
          entry && typeof entry === 'object' && !Array.isArray(entry) &&
          isRouterModelRef(entry?.model)
        ) {
          if (Object.keys(entry).length === 1) delete overrides[role];
          else delete entry.model;
          removed++;
        }
      }
    }
    if (removed > 0) {
      if (overrides && Object.keys(overrides).length === 0) delete data.subagents.agentOverrides;
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
    return removed > 0 ? `; removed ${removed} router-owned setting(s) from ${settingsPath}` : '';
  }
}
