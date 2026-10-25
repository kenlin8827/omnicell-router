import React, { useState, useEffect } from 'react';
import { Sliders, Save, Check, Globe, HardDrive, Archive, Database, ShieldCheck, LogOut, ChevronDown, ChevronRight, Cpu, Waypoints, AtSign, BookOpen, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { sortModelOptions } from '../lib/model-options';
import type { WebAuthConfigView } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_DIRECTIVE_PREFIX } from '../lib/defaults';

// UI mirror of the backend's resolveDirectivePrefix (backend/src/pipeline/
// directives.ts) — the console must display the SAME fallback the gateway
// applies, without a round-trip. Keep in sync with the backend validator.
const DIRECTIVE_PREFIX_SHAPE = /^@[a-z0-9][a-z0-9._:-]*$/;
function resolveDirectivePrefixUi(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_DIRECTIVE_PREFIX;
  const p = raw.trim().toLowerCase();
  if (p.length < 3 || p.length > 32) return DEFAULT_DIRECTIVE_PREFIX;
  if (!DIRECTIVE_PREFIX_SHAPE.test(p)) return DEFAULT_DIRECTIVE_PREFIX;
  if (!/[-._:]$/.test(p)) return DEFAULT_DIRECTIVE_PREFIX;
  return p;
}

export const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);
  // Archive-policy collapsible — set-once values, collapsed by default
  const [policyOpen, setPolicyOpen] = useState(false);
  // `@ocr-*` directive cheat-sheet dialog (opened from the namespace group)
  const [showDirCheat, setShowDirCheat] = useState(false);
  // Registered physical models for the System One default-model picker
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  // Translation picker: tier aliases first (cheap → expensive; `auto` deliberately
  // absent — an internal call must not escalate), then registered models.
  const [translationModelOptions, setTranslationModelOptions] = useState<{ value: string; label: string }[]>([]);
  // Chain-probe in flight (the picker's "test" button).
  const [probing, setProbing] = useState(false);

  // Console webAuth (dedicated endpoints, NOT part of the whole-config save —
  // the password is hashed server-side and never round-trips through the UI)
  const [waConfig, setWaConfig] = useState<WebAuthConfigView | null>(null);
  const [waEnabled, setWaEnabled] = useState(false);
  const [waUsername, setWaUsername] = useState('');
  // Load-time snapshot of the two server-owned fields, used ONLY to render the
  // dirty badge: without it a pending change looks identical to a saved one,
  // and this block's save is the only writer (see handleSave).
  const [waBase, setWaBase] = useState<{ enabled: boolean; username: string } | null>(null);
  const [waPassword, setWaPassword] = useState('');
  const [waPassword2, setWaPassword2] = useState('');
  const [waSaving, setWaSaving] = useState(false);

  useEffect(() => {
    api.getConfig().then(data => {
      setConfig(data);
      setLoading(false);
    }).catch(console.error);
    api.getWebAuthConfig().then(res => {
      setWaConfig(res.webAuth);
      setWaEnabled(res.webAuth.enabled);
      setWaUsername(res.webAuth.username);
      setWaBase({ enabled: res.webAuth.enabled, username: res.webAuth.username });
    }).catch(console.error);
    // Registered physical models only (kind 'model') — systemone.defaultModel
    // resolves through registry.getModel at request time. The translation
    // picker reuses the same list behind the four tier aliases.
    api.listGatewayModels().then(ms => {
      const models = sortModelOptions(ms.filter(m => m.kind === 'model').map(m => ({ value: m.id, label: m.id })));
      setModelOptions(models);
      setTranslationModelOptions([
        ...['lite', 'plus', 'pro', 'ultra'].map(id => ({ value: id, label: id })),
        ...models,
      ]);
    }).catch(() => {});
  }, []);

  // Pending-change detection for the Console Access block. The password field
  // counts as dirty as soon as it holds text (it never round-trips, so there is
  // no stored value to compare against).
  const waDirty = waBase !== null && (
    waEnabled !== waBase.enabled ||
    waUsername.trim() !== waBase.username.trim() ||
    waPassword !== ''
  );

  const handleWebAuthSave = async () => {
    if (!waConfig || waSaving || !waDirty) return;
    try {
      if (waEnabled && waPassword === '' && !waConfig.hasPassword) {
        toast.error(t('settings.waPasswordRequired'));
        return;
      }
      if (waEnabled && waPassword !== '') {
        if (waPassword !== waPassword2) {
          toast.error(t('settings.waMismatch'));
          return;
        }
        if (waPassword.length < 6) {
          toast.error(t('settings.waTooShort'));
          return;
        }
      }
      setWaSaving(true);
      await api.updateWebAuthConfig({
        enabled: waEnabled,
        username: waUsername.trim(),
        ...(waPassword !== '' ? { password: waPassword } : {}),
      });
      if (waEnabled && waPassword !== '') {
        // Silent self-login: the gate just activated and this browser has no
        // session cookie yet — without it the reload below would lock us out.
        try {
          await api.login(waUsername.trim(), waPassword);
        } catch { /* the login screen will simply show after reload */ }
      }
      toast.success(t('settings.waSaved'));
      window.location.reload();
    } catch (err: any) {
      toast.error(err?.message || t('common.saveFailed'));
    } finally {
      setWaSaving(false);
    }
  };

  const handleWebAuthLogout = async () => {
    const ok = await confirmDialog({
      title: t('settings.waLogoutConfirmTitle'),
      description: t('settings.waLogoutConfirmDesc'),
      confirmLabel: t('settings.waLogout'),
    });
    if (!ok) return;
    try {
      await api.logout();
    } finally {
      window.location.reload();
    }
  };

  const handleSave = async () => {
    try {
      // Console Access (webAuth) is owned EXCLUSIVELY by the dedicated
      // /api/admin/auth/config endpoint: the password is hashed server-side and
      // never round-trips, and the generic path cannot validate "enabled implies
      // a stored hash" (validateWebAuthStartup only runs at boot). Posting a
      // stale page snapshot here would overwrite enabled/username and can brick
      // the console permanently (enabled + no hash = unmatchable login, then a
      // hard boot failure). Strip it — saveConfig preserves the on-disk node.
      const payload: Record<string, unknown> = { ...config };
      delete payload.webAuth;
      await api.saveConfig(payload);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
      if (waDirty) toast.info(t('settings.waUnsavedHint'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  if (loading || !config) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  // The capture master (requestCapture.enabled) is the SINGLE gate: on =
  // full-chain capture everywhere, including /v1/systemone (client pair +
  // the gateway's upstream pair, plus the L2 decision leg). Subordinate
  // sections render ONLY while the master is on — the off state stays a
  // single compact row.
  const captureOn = config.requestCapture?.enabled ?? false;

  // saveConfig posts the whole config and the backend shallow-merges each
  // top-level section, so every write rebuilds the COMPLETE requestCapture
  // node: defaults first, current section next, changed key LAST. Anything
  // left out of the object literal is dropped server-side.
  // (config is untyped `any` page-wide — api.getConfig returns the raw
  // RouterConfig envelope; see frontend/src/lib/api.ts.)
  const patchRequestCapture = (patch: Record<string, unknown>) => setConfig({
    ...config,
    requestCapture: {
      retentionDays: 7,
      maxTotalMB: 2048,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxSessionMB: 512,
      storeMedia: true,
      ...(config.requestCapture || {}),
      ...patch,
    },
  });
  // The TOP-LEVEL `systemone` surface node (SystemoneSurfaceConfig) — a
  // different node from requestCapture.systemone above; same whole-node
  // discipline (spread-preserve, replace wholesale on write).
  const patchSystemoneSurface = (patch: Record<string, unknown>) => setConfig({
    ...config,
    systemone: { ...(config.systemone || {}), ...patch },
  });
  // Same whole-node discipline for `defaultModels` (DefaultModelsConfig) —
  // today only the console's internal translation model.
  const patchDefaultModels = (patch: Record<string, unknown>) => setConfig({
    ...config,
    defaultModels: { ...(config.defaultModels || {}), ...patch },
  });
  // Fires the REAL /v1/systemone fallback path (model omitted → systemone.defaultModel): the
  // System One picker's "test" affordance. Same explicit-click-spends contract as the translation
  // probe; a probe is a real surface request, so the capture ledger records it like any client's.
  const handleSysoneProbe = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const probe = await api.systemoneProbe(config.systemone?.defaultModel ?? '');
      if (probe.ok && probe.model) {
        toast.success(t('settings.sysoneProbeOk', { model: probe.model, ms: String(probe.latencyMs) }));
      } else {
        toast.error(t('settings.sysoneProbeFail', { errors: probe.error || probe.code || 'unknown' }));
      }
    } catch (err: any) {
      toast.error(err?.message || t('common.saveFailed'));
    } finally {
      setProbing(false);
    }
  };
  // Fires the REAL translation chain over a one-line payload (never cached): the picker's
  // "test" affordance. The click is the explicit consent to the one-call spend.
  const handleProbe = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const probe = await api.translationProbe('en', config.defaultModels?.translation ?? '');
      if (probe.ok && probe.model) {
        toast.success(t('settings.probeOk', { model: probe.model, ms: String(probe.latencyMs) }));
      } else {
        const detail =
          probe.attempts?.filter(a => !a.ok).map(a => a.error).filter(Boolean).join(' | ')
          || probe.code
          || 'unknown';
        toast.error(t('settings.probeFail', { errors: detail }));
      }
    } catch (err: any) {
      toast.error(err?.message || t('common.saveFailed'));
    } finally {
      setProbing(false);
    }
  };
  // Same whole-node discipline for `responses`: the
  // section is one flat boolean today, spread-preserve it so future keys
  // survive a save round-trip. Restart-scoped — the surface reads it lazily
  // once per process.
  const patchResponses = (patch: Record<string, unknown>) => setConfig({
    ...config,
    responses: { ...(config.responses || {}), ...patch },
  });
  // Same whole-node discipline for `routeEntries` (ADR-0011 experience table
  // gate) — hot-applied server-side via applyRouteEntriesConfig on every save.
  // Same whole-node discipline for `directives` (ADR-0011 escalation surface):
  // hot-applied server-side via applyDirectivesConfig on every save.
  const patchDirectives = (patch: Record<string, unknown>) => setConfig({
    ...config,
    directives: {
      enabled: true,
      ...(config.directives || {}),
      ...patch,
    },
  });
  // The sheet and hints show the RESOLVED prefix — what the gateway will
  // actually apply after its own validation — never the raw typed text.
  const rawPrefix: unknown = config.directives?.prefix;
  const directivePrefix = resolveDirectivePrefixUi(rawPrefix);
  const prefixInvalid =
    typeof rawPrefix === 'string' && resolveDirectivePrefixUi(rawPrefix) !== rawPrefix.trim().toLowerCase();

  // Cheat-sheet rows for the directive dialog — tokens reflect the LIVE
  // configured prefix, so the sheet stays truthful after a prefix rename.
  const pfx = directivePrefix;
  const dirCheatGroups: Array<{ label: string; rows: Array<[string, string]> }> = [
    {
      label: t('settings.dirCheatGroupStep'),
      rows: [
        [`${pfx}tier-up`, t('settings.dirCheatTierUp')],
        [`${pfx}tier-down`, t('settings.dirCheatTierDown')],
        [`${pfx}effort-up`, t('settings.dirCheatEffortUp')],
        [`${pfx}effort-down`, t('settings.dirCheatEffortDown')],
      ],
    },
    {
      label: t('settings.dirCheatGroupPin'),
      rows: [
        [`${pfx}tier-{lite|plus|pro|ultra}`, t('settings.dirCheatTierPin')],
        [`${pfx}effort-{none…max}`, t('settings.dirCheatEffortPin')],
      ],
    },
    {
      label: t('settings.dirCheatGroupContent'),
      rows: [[`${pfx}continue`, t('settings.dirCheatContinue')]],
    },
  ];

  const patchRouteEntries = (patch: Record<string, unknown>) => setConfig({
    ...config,
    routeEntries: {
      enabled: true,
      snippetEnabled: true,
      maxEntries: 5000,
      ...(config.routeEntries || {}),
      ...patch,
    },
  });

  // In-page nav — same pattern as /tiers (RulesPage): chips sit in the header
  // card and the content below is its own scroll region, so the chips stay
  // visible without any sticky/fixed hacks.
  const NAV = [
    { key: 'net', label: t('settings.navNet'), icon: Globe, color: 'var(--accent)' },
    { key: 'cache', label: t('settings.navCache'), icon: HardDrive, color: 'var(--accent-emerald)' },
    { key: 'capture', label: t('settings.navCapture'), icon: Archive, color: 'var(--accent)' },
    { key: 'responses', label: t('settings.navResponses'), icon: Database, color: 'var(--accent-emerald)' },
    { key: 'defaults', label: t('settings.navDefaults'), icon: Cpu, color: 'var(--accent-violet)' },
    { key: 'routeentries', label: t('settings.navRouteEntries'), icon: Waypoints, color: 'var(--accent-violet)' },
    { key: 'webauth', label: t('settings.navWebAuth'), icon: ShieldCheck, color: 'var(--accent)' },
  ];
  const jumpTo = (key: string) => {
    const el = document.getElementById(`settings-${key}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Grid siblings share a row top, so the scroll may move 0px — the flash
    // guarantees every chip click has visible feedback.
    el.classList.remove('settings-jump-flash');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('settings-jump-flash');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      <div className="card" style={{ flexShrink: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <Sliders size={18} color="var(--accent)" />
            <span>{t('settings.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            {NAV.map(({ key, label, icon: NavIcon, color }) => (
              <button
                key={key}
                className="btn"
                style={{ padding: '4px 10px', fontSize: '11px', color }}
                onClick={() => jumpTo(key)}
              >
                <NavIcon size={12} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={handleSave}>
            <Save size={14} />
            <span>{t('settings.saveBtn')}</span>
          </button>
        </div>

        {savedNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-emerald) 30%, transparent)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{t('settings.savedNotice')}</span>
          </div>
        )}
      </div>

      {/* Internal scroll region (RulesPage pattern): only the cards scroll. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
          {/* Section 1: Server & Network */}
          <div id="settings-net" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Globe size={14} />
              {t('settings.netTitle')}
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.port')}</label>
              <input
                type="number"
                value={config.port || 3000}
                onChange={e => setConfig({ ...config, port: parseInt(e.target.value) || 3000 })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.host')}</label>
              <input
                type="text"
                value={config.host || '0.0.0.0'}
                onChange={e => setConfig({ ...config, host: e.target.value })}
                className="input"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.hostAuthHint')}{' '}
                <button
                  type="button"
                  onClick={() => jumpTo('webauth')}
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: '11px', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {t('settings.hostAuthJump')}
                </button>
              </div>
            </div>
          </div>

          {/* Section 2: Semantic Cache */}
          <div id="settings-cache" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <HardDrive size={14} />
              {t('settings.cacheTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.cacheEnable')}</span>
              <Switch
                checked={config.cache?.enabled ?? true}
                onChange={v => setConfig({ ...config, cache: { ...config.cache, enabled: v } })}
              />
            </label>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheSim')}</label>
              <input
                type="number"
                step="0.05"
                value={config.cache?.similarityThreshold || 0.85}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, similarityThreshold: parseFloat(e.target.value) || 0.85 } })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheTtl')}</label>
              <input
                type="number"
                value={config.cache?.ttlSeconds || 3600}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, ttlSeconds: parseInt(e.target.value) || 3600 } })}
                className="input"
              />
            </div>
          </div>

          {/* Section 3: Request Capture (hot-applied — no restart needed) */}
          <div id="settings-capture" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Archive size={14} />
              {t('settings.capTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.capEnable')}</span>
              <Switch
                checked={config.requestCapture?.enabled ?? false}
                onChange={v => patchRequestCapture({ enabled: v })}
              />
            </label>

            {/* The archive-policy block renders only while the master is on
                (off = compact single row). */}
            {captureOn && (<>
            {/* Archive policy: set-once values — collapsed by default so the
                capture switch stays the focus. The header summarizes current
                values; the privacy warning below stays always visible. */}
            <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
              <button
                type="button"
                onClick={() => setPolicyOpen(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: 'var(--text-main)', fontFamily: 'inherit', textAlign: 'left' }}
              >
                {policyOpen ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{t('settings.capPolicyGroup')}</span>
                {!policyOpen && (
                  // Summary truncates with ellipsis when the card is narrow;
                  // the group title above never wraps (no orphan second line).
                  <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: '11px', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                    {t('settings.capPolicySummary', {
                      days: config.requestCapture?.retentionDays ?? 7,
                      mb: config.requestCapture?.maxTotalMB ?? 2048,
                      ses: config.requestCapture?.maxSessionMB ?? 512,
                      bytes: config.requestCapture?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
                    })}
                  </span>
                )}
              </button>
              {policyOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capRetention')}</label>
                    <input
                      type="number"
                      min="1"
                      value={config.requestCapture?.retentionDays ?? 7}
                      onChange={e => patchRequestCapture({ retentionDays: parseInt(e.target.value) || 7 })}
                      className="input"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capMaxTotal')}</label>
                    <input
                      type="number"
                      min="1"
                      value={config.requestCapture?.maxTotalMB ?? 2048}
                      onChange={e => patchRequestCapture({ maxTotalMB: parseInt(e.target.value) || 2048 })}
                      className="input"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capSession')}</label>
                    <input
                      type="number"
                      min="1"
                      value={config.requestCapture?.maxSessionMB ?? 512}
                      onChange={e => patchRequestCapture({ maxSessionMB: parseInt(e.target.value) || 512 })}
                      className="input"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capMaxBody')}</label>
                    <input
                      type="number"
                      min="1024"
                      step="1024"
                      value={config.requestCapture?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES}
                      onChange={e => patchRequestCapture({ maxBodyBytes: parseInt(e.target.value) || DEFAULT_MAX_BODY_BYTES })}
                      className="input"
                    />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '12px', cursor: 'pointer' }}>
                    <span>{t('settings.capStoreMedia')}</span>
                    <Switch
                      checked={config.requestCapture?.storeMedia ?? true}
                      onChange={v => patchRequestCapture({ storeMedia: v })}
                      ariaLabel={t('settings.capStoreMedia')}
                    />
                  </label>
                </div>
              )}
            </div>
            </>)}
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('settings.capPrivacyHint')}
              <br />
              {t('settings.capHotHint')}
            </div>
          </div>

          {/* Section 5: Responses wire stateful chain */}
          <div id="settings-responses" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Database size={14} />
              {t('settings.respTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.respPersistEnable')}</span>
              <Switch
                checked={config.responses?.persist ?? false}
                onChange={v => patchResponses({ persist: v })}
              />
            </label>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('settings.respPersistHint')}
              <br />
              {t('settings.respRestartHint')}
            </div>
          </div>

          {/* Default models — the picks the gateway itself spends on, in one
              group: the System One protocol surface's fallback
              (`systemone.defaultModel` — it backs /v1/systemone requests sent
              without a model and doubles as the L2 decision layer's fallback
              decision model when classifier.layer2.model is unset; it is a
              protocol-surface default, NOT a routing default-model container)
              and the console's internal translation spend
              (`defaultModels.translation` — the `lite` alias is the tail and
              `auto` never enters the chain unsolicited, ADR-0015). */}
          <div id="settings-defaults" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Cpu size={14} />
              {t('settings.defaultsTitle')}
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                {t('settings.sysoneModelLabel')}
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Combobox
                    value={config.systemone?.defaultModel ?? ''}
                    onChange={(v: string) => patchSystemoneSurface({ defaultModel: v || undefined })}
                    options={modelOptions}
                    clearable
                    placeholder={t('settings.sysoneModelUnset')}
                  />
                </div>
                <button
                  className="btn"
                  onClick={handleSysoneProbe}
                  disabled={probing}
                  style={{ padding: '6px 12px', fontSize: '11px', flexShrink: 0 }}
                >
                  <Zap size={12} />
                  <span>{t('settings.probeBtn')}</span>
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.sysoneModelHint')}
              </div>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                {t('settings.translationModelLabel')}
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Combobox
                    value={config.defaultModels?.translation ?? ''}
                    onChange={(v: string) => patchDefaultModels({ translation: v || undefined })}
                    options={translationModelOptions}
                    clearable
                    placeholder={t('settings.translationModelUnset')}
                  />
                </div>
                <button
                  className="btn"
                  onClick={handleProbe}
                  disabled={probing}
                  style={{ padding: '6px 12px', fontSize: '11px', flexShrink: 0 }}
                >
                  <Zap size={12} />
                  <span>{t('settings.probeBtn')}</span>
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.translationModelHint')}
              </div>
            </div>
          </div>
          {/* Route experience table (routeEntries.*) — hot-applied on save. */}
          <div id="settings-routeentries" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Waypoints size={14} />
              {t('settings.reTitle')}
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
                <span>{t('settings.reEnable')}</span>
                <Switch
                  checked={config.routeEntries?.enabled ?? true}
                  onChange={v => patchRouteEntries({ enabled: v })}
                />
              </label>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.reEnableHint')}
              </div>
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
                <span>{t('settings.reSnippet')}</span>
                <Switch
                  checked={config.routeEntries?.snippetEnabled ?? true}
                  onChange={v => patchRouteEntries({ snippetEnabled: v })}
                />
              </label>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.reSnippetHint')}
              </div>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.reMaxEntries')}</label>
              <input
                type="number"
                min="1"
                value={config.routeEntries?.maxEntries ?? 5000}
                onChange={e => patchRouteEntries({ maxEntries: parseInt(e.target.value, 10) || 5000 })}
                className="input"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.reMaxEntriesHint')}
              </div>
            </div>
          </div>
        {/* `@ocr-*` directive namespace (directives.*) — a GLOBAL surface, not a
            routeEntries knob: the prefix and the master switch govern EVERY
            directive token on BOTH axes (tier + effort) and stay independent of
            the experience table (directives work with it off). */}
        <div id="settings-directives" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <AtSign size={14} />
              {t('settings.dirTitle')}
            </div>
            <button className="btn btn-sm" onClick={() => setShowDirCheat(true)}>
              <BookOpen size={13} />
              <span>{t('settings.dirCheatBtn')}</span>
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
            <span>{t('settings.dirEnable')}</span>
            <Switch
              checked={config.directives?.enabled ?? true}
              onChange={v => patchDirectives({ enabled: v })}
            />
          </label>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.dirPrefix')}</label>
            <input
              value={config.directives?.prefix ?? DEFAULT_DIRECTIVE_PREFIX}
              onChange={e => patchDirectives({ prefix: e.target.value })}
              placeholder={DEFAULT_DIRECTIVE_PREFIX}
              className="input"
              spellCheck={false}
            />
            {prefixInvalid && (
              <div style={{ fontSize: '11px', color: 'var(--accent-amber, #f59e0b)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('settings.dirPrefixInvalid', { prefix: directivePrefix })}
              </div>
            )}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
            {t('settings.dirPrefixHint')}
            <br />
            {t('settings.dirEnableHint')}
            <br />
            {t('settings.reDirectiveHint', { prefix: directivePrefix })}
          </div>
        </div>
        {showDirCheat && (
          <Dialog
            title={t('settings.dirCheatTitle')}
            subtitle={
              <>
                <span>{t('settings.dirCheatRuleLast')}</span>
                <span>{t('settings.dirCheatRuleScrub')}</span>
                <span>{t('settings.dirCheatRuleTurn')}</span>
              </>
            }
            onClose={() => setShowDirCheat(false)}
            closeLabel={t('settings.dirCheatClose')}
            width={560}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12.5, tableLayout: 'fixed' }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--bg-elev)',
                    borderBottom: '1px solid var(--divider)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <th style={{ padding: '8px 12px', width: '46%', whiteSpace: 'nowrap' }}>{t('settings.dirCheatThToken')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('settings.dirCheatThEffect')}</th>
                </tr>
              </thead>
              {dirCheatGroups.map((group) => (
                <tbody key={group.label}>
                  <tr>
                    <td
                      colSpan={2}
                      style={{
                        padding: '10px 12px 4px',
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        color: 'var(--accent-violet)',
                        textTransform: 'uppercase',
                      }}
                    >
                      {group.label}
                    </td>
                  </tr>
                  {group.rows.map(([token, effect]) => (
                    <tr key={token} style={{ borderBottom: '1px solid var(--divider)' }}>
                      <td style={{ padding: '7px 12px', verticalAlign: 'middle' }}>
                        <code
                          style={{
                            fontFamily: 'var(--font-mono, monospace)',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 6,
                            background: 'color-mix(in srgb, var(--accent-violet) 10%, transparent)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {token}
                        </code>
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-main)', verticalAlign: 'middle' }}>{effect}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </Dialog>
        )}
        {/* Console Access (webAuth) — narrow group like the siblings; keeps a
            DEDICATED save flow (it is not hot-applied by the header save), see
            handleWebAuthSave. The dirty badge exists because a pending change
            here is invisible to the header save. */}
        <div id="settings-webauth" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ShieldCheck size={14} />
              <span>{t('settings.waTitle')}</span>
              {waDirty && (
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: '999px',
                    color: 'var(--accent-amber, #f59e0b)',
                    background: 'color-mix(in srgb, var(--accent-amber, #f59e0b) 15%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-amber, #f59e0b) 35%, transparent)',
                  }}
                >
                  {t('settings.waUnsaved')}
                </span>
              )}
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleWebAuthSave}
              disabled={waSaving || !waConfig || !waDirty}
              title={waDirty ? undefined : t('settings.waUnsavedHint')}
              style={waDirty ? { boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)' } : undefined}
            >
              <Save size={13} />
              <span>{t('settings.waSave')}</span>
            </button>
          </div>

          {!waConfig ? (
            <div style={{ color: 'var(--text-dim)', fontSize: '13px' }}>…</div>
          ) : (
            <>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
                <span>{t('settings.waEnable')}</span>
                <Switch
                  checked={waEnabled}
                  disabled={waConfig.forced}
                  onChange={v => setWaEnabled(v)}
                />
              </label>

              {waConfig.forced && (
                <div style={{ fontSize: '11px', color: 'var(--accent-amber, #f59e0b)', lineHeight: 1.6 }}>
                  {t('settings.waForcedHint')}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                    {t('settings.waUsername')}
                  </label>
                  <input
                    type="text"
                    value={waUsername}
                    onChange={e => setWaUsername(e.target.value)}
                    placeholder="admin"
                    className="input"
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                    {t('settings.waNewPassword')}
                  </label>
                  <input
                    type="password"
                    value={waPassword}
                    onChange={e => setWaPassword(e.target.value)}
                    placeholder={waConfig.hasPassword ? t('settings.waKeepPassword') : '••••••'}
                    autoComplete="new-password"
                    className="input"
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                    {t('settings.waConfirm')}
                  </label>
                  <input
                    type="password"
                    value={waPassword2}
                    onChange={e => setWaPassword2(e.target.value)}
                    disabled={waPassword === ''}
                    autoComplete="new-password"
                    className="input"
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  {t('settings.waHint')}
                </div>
                {waConfig.active && (
                  <button className="btn btn-sm" onClick={handleWebAuthLogout}>
                    <LogOut size={13} />
                    <span>{t('settings.waLogout')}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};
