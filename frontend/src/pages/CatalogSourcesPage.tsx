import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudDownload, Plus, RefreshCw, Trash2, Lock, LockOpen, Globe, Eye, EyeOff, ChevronDown, ChevronRight, Database, Braces, Copy, Pencil, Check, Loader2 } from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { ProviderLogo } from '../components/ProviderLogo';
import {
  opencodeApi,
  type CatalogSourceView,
  type CatalogSourceDataResponse,
  type CatalogSourceDataProviderRecord,
  type CatalogSourceDataModelRecord,
  type OcrCatalogProvider,
  type NpmVocabularyEntry,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { Chip, EffortChips } from '../components/Chip';
import { VariantListEditor } from '../components/VariantListEditor';
import { ModalityPicker } from '../components/ModalityPicker';
import { Dialog } from '../components/Dialog';
import { Field, FieldRow, FormSection } from '../components/Form';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { EFFORT_LADDER, effectiveEffortLadder, effortOptionList } from '../lib/effort';

import { FONT_MONO } from '../lib/fonts';
/**
 * /catalog — remote catalog source management: view sync state (origin +
 * last-sync time), manually add sources, toggle, delete and force-refresh.
 * Mutations apply live (no gateway restart) and persist to config.yaml.
 * Disabled sources stay viewable and manually refreshable — disabling only
 * excludes them from the aggregated OCR catalog (and from auto-sync).
 */

const GRID = 'minmax(170px, 1fr) minmax(200px, 1.8fr) 205px 60px 72px minmax(180px, 1fr) auto';

const fmtTime = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : '—');

/** Auto-sync period presets (ms) offered in the console selector. */
const INTERVAL_PRESETS: { ms: number; key: string }[] = [
  { ms: 1_800_000, key: 'catalogPage.iv30m' },
  { ms: 3_600_000, key: 'catalogPage.iv1h' },
  { ms: 21_600_000, key: 'catalogPage.iv6h' },
  { ms: 43_200_000, key: 'catalogPage.iv12h' },
  { ms: 86_400_000, key: 'catalogPage.iv24h' },
  { ms: 604_800_000, key: 'catalogPage.iv7d' },
];

const StatusBadge: React.FC<{ source: CatalogSourceView }> = ({ source }) => {
  const { t } = useI18n();
  if (!source.enabled) {
    return (
      <span style={{ fontSize: '11px', color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--text-dim)', flexShrink: 0 }} />
        {t('catalogPage.statusDisabled')}
      </span>
    );
  }
  const map: Record<CatalogSourceView['origin'], { color: string; label: string }> = {
    network: { color: 'var(--accent-emerald)', label: t('catalogPage.statusNetwork') },
    cache: { color: 'var(--accent)', label: t('catalogPage.statusCache') },
    stale: { color: 'var(--accent-amber)', label: t('catalogPage.statusStale') },
    none: { color: 'var(--accent-rose)', label: t('catalogPage.statusNone') },
  };
  const { color, label } = map[source.origin];
  return (
    <span style={{ fontSize: '11px', color, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
};

/** Source-identity brand label (user-facing type column) — falls back to the technical type label. */
const SOURCE_BRAND: Record<string, string> = {
  opencode: 'Opencode',
  'models-dev': 'Opencode',
  openrouter: 'OpenRouter',
};

const TypeBadge: React.FC<{ source: CatalogSourceView }> = ({ source }) => {
  const { t } = useI18n();
  const label =
    SOURCE_BRAND[source.id] ??
    (source.type === 'provider-catalog'
      ? t('catalogPage.typeProviderCatalog')
      : source.type === 'model-list'
        ? t('catalogPage.typeModelList')
        : source.type === 'custom'
          ? t('catalogPage.typeCustom')
          : t('catalogPage.typeOpenAICompatible'));
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid var(--card-border)',
        color: 'var(--text-dim)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'inline-block',
      }}
      title={label}
    >
      {label}
    </span>
  );
};

const fmtPrice = (v?: number): string => (typeof v === 'number' ? '$' + v.toFixed(3) : '—');

const MODEL_GRID = 'minmax(200px, 2fr) minmax(130px, 1.3fr) 84px 84px 88px';

/** Pretty-JSON above this char count freezes <pre> layout (~100k+ line boxes); render a
 * newline-bounded prefix instead. Keep the "300 KB" copy in catalogPage.jsonTruncated in sync. */
const JSON_RENDER_CAP = 300_000;

const fmtSize = (n: number): string => (n >= 1_048_576 ? (n / 1_048_576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

/** Shared raw-JSON view style for the catalog viewer modals. */
const JSON_PRE: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: '10px',
  lineHeight: 1.55,
  color: 'var(--text-main)',
  background: 'var(--well-bg)',
  border: '1px solid var(--card-border)',
  borderRadius: '6px',
  padding: '10px 12px',
  margin: 0,
  overflow: 'auto',
  flex: 1,
  minHeight: 0,
  whiteSpace: 'pre',
  userSelect: 'text',
};

/** Compact model detail table (provider drill-down + flat model-list sources).
 *  lockedIds holds fully-qualified `providerId||modelId` keys (providerId prop
 *  required for lock display/toggling). */
const ModelTable: React.FC<{
  models: CatalogSourceDataModelRecord[];
  showSource?: boolean;
  providerId?: string;
  lockedIds?: Set<string>;
  onToggleLock?: (m: CatalogSourceDataModelRecord) => void;
  /** Hide / show from the model catalog — writes overrides.json (see ModelsPage). */
  onToggleHidden?: (m: CatalogSourceDataModelRecord) => void;
  onEdit?: (m: CatalogSourceDataModelRecord) => void;
}> = ({ models, showSource, providerId, lockedIds, onToggleLock, onToggleHidden, onEdit }) => {
  const lockKey = (mid: string): string => (providerId ? `${providerId}||${mid}` : mid);
  const isLocked = (mid: string): boolean => Boolean(lockedIds?.has(lockKey(mid)));
  const { t } = useI18n();
  const head: React.CSSProperties = {
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--text-dim)',
    padding: '2px 6px 4px 0',
    textAlign: 'left',
    borderBottom: '1px solid var(--divider)',
  };
  // Grid cells tile the row: the divider goes on EVERY cell to form one
  // continuous line. lineHeight pinned to an integer (22+6 padding = 28px,
  // multiple of 4) so hairlines snap to device pixels at 125%/150% scaling.
  const cell: React.CSSProperties = { fontSize: '11px', color: 'var(--text-main)', padding: '3px 6px 3px 0', lineHeight: '22px', borderBottom: '1px solid var(--divider)' };
  const iconBtn = (color: string, title: string, onClick: () => void, node: React.ReactNode, marginLeft: number): React.ReactElement => (
    <button
      onClick={onClick}
      title={title}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft, display: 'inline-flex', verticalAlign: 'middle', color }}
    >
      {node}
    </button>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: MODEL_GRID }}>
      <div style={head}>{t('catalogPage.dataColModel')}</div>
      <div style={head}>{t('catalogPage.dataColName')}</div>
      <div style={head}>{t('catalogPage.dataColInput')}</div>
      <div style={head}>{t('catalogPage.dataColOutput')}</div>
      <div style={head}>{t('catalogPage.dataColCtx')}</div>
      {models.map((m) => {
        const hidden = m.disabled === true;
        // hidden models stay listed here (that is how you find and restore
        // them) but the row reads as out-of-routing at a glance
        const rcell: React.CSSProperties = hidden ? { ...cell, opacity: 0.55 } : cell;
        return (
        <React.Fragment key={m.id}>
          <div style={{ ...rcell, fontFamily: FONT_MONO, fontSize: '10px' }}>
            {m.id}
            {hidden && (
              <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--card-border)', borderRadius: 999, padding: '0 5px' }}>
                {t('models.hiddenBadge')}
              </span>
            )}
            {onEdit &&
              iconBtn('var(--accent)', t('op.pmEdit'), () => onEdit(m), <Pencil size={9} />, 6)}
            {onToggleHidden
              ? iconBtn(
                  hidden ? 'var(--text-dim)' : 'var(--text-dim)',
                  hidden ? t('models.showInCatalog') : t('models.hideFromCatalog'),
                  () => onToggleHidden(m),
                  hidden ? <EyeOff size={9} /> : <Eye size={9} />,
                  8,
                )
              : hidden && (
                  <span title={t('models.hideFromCatalog')} style={{ display: 'inline-flex', color: 'var(--text-dim)', marginLeft: 8, verticalAlign: 'middle' }}>
                    <EyeOff size={9} />
                  </span>
                )}
            {onToggleLock
              ? iconBtn(
                  isLocked(m.id) ? 'var(--accent-amber)' : 'var(--text-dim)',
                  isLocked(m.id) ? t('models.unlockHint') : t('models.lockHint'),
                  () => onToggleLock(m),
                  isLocked(m.id) ? <Lock size={9} /> : <LockOpen size={9} />,
                  8,
                )
              : isLocked(m.id) && (
                  <span title={t('models.lockHint')} style={{ display: 'inline-flex', color: 'var(--accent-amber)', marginLeft: 4, verticalAlign: 'middle' }}>
                    <Lock size={9} />
                  </span>
                )}
          </div>
          <div style={{ ...rcell, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.name || '—'}
            {showSource && m.source && (
              <span style={{ marginLeft: 5, fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--card-border)', borderRadius: 999, padding: '0 5px' }}>
                {m.source}
              </span>
            )}
          </div>
          <div style={rcell}>{fmtPrice(m.cost?.input)}</div>
          <div style={rcell}>{fmtPrice(m.cost?.output)}</div>
          <div style={rcell}>{m.limit?.context ? m.limit.context.toLocaleString() : '—'}</div>
        </React.Fragment>
        );
      })}
    </div>
  );
};

/** Read-only viewer of one source's in-memory catalog payload (≡ the on-disk cache file). */
const DataViewerModal: React.FC<{ source: CatalogSourceView; onClose: () => void }> = ({ source, onClose }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<CatalogSourceDataResponse | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showJson, setShowJson] = useState(false);
  const [logoMap, setLogoMap] = useState<Record<string, string>>({});
  useBodyScrollLock(true);

  useEffect(() => {
    opencodeApi.catalogSourceData(source.id).then(setData).catch((e: any) => setError(e.message));
  }, [source.id]);

  // provider id → logo URL (OCR catalog view); logos are decorative, failures ignored
  useEffect(() => {
    (async () => {
      try {
        const res = await opencodeApi.listProviders();
        const map: Record<string, string> = {};
        for (const p of res?.providers || []) if (p.id && p.logo) map[p.id] = p.logo;
        setLogoMap(map);
      } catch {
        // decorative only — keep the initials fallback
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const MAX_RENDER = 300;

  const providers = React.useMemo(() => {
    const list = data?.providers ?? [];
    if (!q) return list;
    return list
      .map((p): CatalogSourceDataProviderRecord | null => {
        const self = p.id.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q);
        const models = self
          ? p.models ?? []
          : (p.models ?? []).filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
        if (!self && models.length === 0) return null;
        return { ...p, models };
      })
      .filter((x): x is CatalogSourceDataProviderRecord => x !== null);
  }, [data, q]);

  const flatModels = React.useMemo(() => {
    const list = data?.models ?? [];
    if (!q) return list;
    return list.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
  }, [data, q]);

  const jsonText = React.useMemo(() => {
    if (!data) return null;
    const full = JSON.stringify(data, null, 2);
    if (full.length <= JSON_RENDER_CAP) return { text: full, full, fullLength: 0 };
    const cut = full.lastIndexOf('\n', JSON_RENDER_CAP);
    return { text: cut > 0 ? full.slice(0, cut) : full.slice(0, JSON_RENDER_CAP), full, fullLength: full.length };
  }, [data]);

  const copyJson = async () => {
    if (!jsonText) return;
    try {
      await navigator.clipboard.writeText(jsonText.full);
      toast.success(t('catalogPage.jsonCopied', { size: fmtSize(jsonText.full.length) }));
    } catch (err: any) {
      toast.error('Copy failed: ' + err.message);
    }
  };

  const isProviderSource = (data?.providers?.length ?? 0) > 0;
  const totalCount = isProviderSource ? providers.length : flatModels.length;
  const truncated = totalCount > MAX_RENDER;
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fieldLabel: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--text-dim)',
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '920px',
          maxHeight: '85vh',
          padding: '20px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {t('catalogPage.dataTitle')}:
            <span style={{ color: 'var(--accent)' }}>{source.id}</span>
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              className="btn"
              onClick={() => setShowJson((v) => !v)}
              style={{ fontSize: '11px', padding: '3px 10px', ...(showJson ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}) }}
            >
              <Braces size={12} />
              <span>{showJson ? t('catalogPage.viewStructured') : t('catalogPage.viewJson')}</span>
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-dim)', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
          <span>{source.url}</span>
          <span>
            {t('catalogPage.dataFetchedAt', {
              time: data?.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : t('catalogPage.neverSynced'),
            })}
          </span>
          {data && (
            <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
              {isProviderSource
                ? t('catalogPage.dataProviders', { n: (data.providers ?? []).length })
                : t('catalogPage.dataModelsN', { n: (data.models ?? []).length })}
            </span>
          )}
        </div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--accent-rose)', color: 'var(--accent-rose)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        {!error && !data && <div style={{ ...fieldLabel, padding: '24px 0', textAlign: 'center' }}>{t('catalogPage.dataLoading')}</div>}

        {data && !showJson && (
          <>
            <input
              type="text"
              className="input"
              placeholder={t('catalogPage.dataSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, borderTop: '1px solid var(--divider)', paddingTop: '8px' }}>
              {isProviderSource ? (
                providers.length === 0 ? (
                  <div style={{ ...fieldLabel, padding: '24px 0', textAlign: 'center' }}>{t('catalogPage.dataEmpty')}</div>
                ) : (
                  providers.slice(0, MAX_RENDER).map((p) => {
                    const open = expanded.has(p.id);
                    const ms = p.models ?? [];
                    return (
                      <div key={p.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                        <div
                          onClick={() => toggle(p.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '9px 4px', cursor: 'pointer', userSelect: 'none' }}
                        >
                          {open ? <ChevronDown size={13} color="var(--text-dim)" /> : <ChevronRight size={13} color="var(--text-dim)" />}
                          <ProviderLogo providerId={p.id} logoMap={logoMap} size={24} />
                          <span style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-main)' }}>{p.id}</span>
                          {p.name && p.name !== p.id && (
                            <span style={{ fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.name}
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-dim)', flexShrink: 0 }}>
                            {ms.length} {t('catalogPage.dataModelsUnit')}
                          </span>
                        </div>
                        {open && ms.length > 0 && (
                          <div style={{ paddingLeft: '32px', paddingBottom: '8px' }}>
                            <ModelTable models={ms.slice(0, MAX_RENDER)} />
                          </div>
                        )}
                      </div>
                    );
                  })
                )
              ) : flatModels.length === 0 ? (
                <div style={{ ...fieldLabel, padding: '24px 0', textAlign: 'center' }}>{t('catalogPage.dataEmpty')}</div>
              ) : (
                <ModelTable models={flatModels.slice(0, MAX_RENDER)} />
              )}
              {truncated && (
                <div style={{ fontSize: '11px', color: 'var(--accent-amber)', padding: '10px 4px' }}>
                  {t('catalogPage.dataTruncated', { n: MAX_RENDER })}
                </div>
              )}
            </div>
          </>
        )}
        {data && showJson && (
          <>
            {jsonText && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--accent-amber)' }}>
                  {jsonText.fullLength > 0 ? t('catalogPage.jsonTruncated', { size: fmtSize(jsonText.fullLength) }) : ''}
                </div>
                <button className="btn" style={{ fontSize: '11px', padding: '3px 10px', flexShrink: 0 }} onClick={() => void copyJson()}>
                  <Copy size={12} />
                  <span>{t('catalogPage.copyJson')}</span>
                </button>
              </div>
            )}
            {jsonText && <pre style={JSON_PRE}>{jsonText.text}</pre>}
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

/** Read-only viewer of the FULL aggregated catalog (list() output): local config
 * definitions first, opencode baseline, extension enrichments — the OCR truth.
 * Rendered as the "aggregated catalog" TAB of the sources page; it is a
 * discovery/reference surface, so /models stays the maintenance plane. */
const OcrCatalogPanel: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<{ providers: OcrCatalogProvider[] } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());
  const [showJson, setShowJson] = useState(false);
  const [editTarget, setEditTarget] = useState<{ providerId: string; modelId: string; current: CatalogSourceDataModelRecord } | null>(null);
  const [onlyLocked, setOnlyLocked] = useState(false);
  const [onlyHidden, setOnlyHidden] = useState(false);

  const loadData = useCallback(async () => {
    const [d, l] = await Promise.all([opencodeApi.ocrCatalog(), opencodeApi.lockedCatalogModels().catch(() => null)]);
    setData(d);
    if (l) setLockedIds(new Set(l.lockedModels));
  }, []);

  useEffect(() => {
    loadData().catch((e: any) => setError(e.message));
  }, [loadData]);

  const handleToggleLock = async (m: CatalogSourceDataModelRecord, providerId: string) => {
    const key = `${providerId}||${m.id}`;
    const locked = !lockedIds.has(key);
    try {
      await opencodeApi.toggleCatalogModelLock(key, locked);
      const res = await opencodeApi.lockedCatalogModels();
      setLockedIds(new Set(res.lockedModels));
      await loadData();
      toast.success(locked ? t('models.lockedToast', { id: key }) : t('models.unlockedToast', { id: key }));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  /** Hide / show from the model catalog — the SAME writer as the model list
   *  (overrides.json), so either surface shows what the routing pool will do. */
  const handleToggleHidden = async (m: CatalogSourceDataModelRecord, providerId: string) => {
    const hidden = m.disabled !== true;
    try {
      await opencodeApi.putCatalogOverride(providerId, m.id, { disabled: hidden });
      await loadData();
      toast.info(t(hidden ? 'models.hiddenToast' : 'models.shownToast', { id: `${providerId}/${m.id}` }));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  const q = query.trim().toLowerCase();
  const MAX_RENDER = 300;

  const hiddenCount = React.useMemo(
    () => (data?.providers ?? []).reduce((n, p) => n + p.models.filter((m) => m.disabled === true).length, 0),
    [data]
  );

  const providers = React.useMemo(() => {
    let list = data?.providers ?? [];
    if (onlyLocked || onlyHidden) {
      // narrow to the flagged models only (both filters compose: locked ∩ hidden)
      list = list
        .map((p) => ({
          ...p,
          models: p.models.filter(
            (m) =>
              (!onlyLocked || lockedIds.has(`${p.id}||${m.id}`)) && (!onlyHidden || m.disabled === true)
          ),
        }))
        .filter((p) => p.models.length > 0);
    }
    if (!q) return list;
    return list
      .map((p) => {
        const self = p.id.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q);
        const models = self
          ? p.models
          : p.models.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
        return self || models.length > 0 ? { ...p, models } : null;
      })
      .filter((x): x is OcrCatalogProvider => x !== null);
  }, [data, q, onlyLocked, onlyHidden, lockedIds]);

  const totalModels = React.useMemo(() => (data?.providers ?? []).reduce((n, p) => n + p.models.length, 0), [data]);

  // provider id → logo URL straight from the aggregated catalog payload (already
  // rewritten to the local logo proxy by the backend); decorative only.
  const logoMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of data?.providers ?? []) if (p.logo) map[p.id] = p.logo;
    return map;
  }, [data]);

  const jsonText = React.useMemo(() => {
    if (!data) return null;
    const full = JSON.stringify({ providers: data.providers }, null, 2);
    if (full.length <= JSON_RENDER_CAP) return { text: full, full, fullLength: 0 };
    const cut = full.lastIndexOf('\n', JSON_RENDER_CAP);
    return { text: cut > 0 ? full.slice(0, cut) : full.slice(0, JSON_RENDER_CAP), full, fullLength: full.length };
  }, [data]);

  const copyJson = async () => {
    if (!jsonText) return;
    try {
      await navigator.clipboard.writeText(jsonText.full);
      toast.success(t('catalogPage.jsonCopied', { size: fmtSize(jsonText.full.length) }));
    } catch (err: any) {
      toast.error('Copy failed: ' + err.message);
    }
  };
  const truncated = providers.length > MAX_RENDER;
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const dim: React.CSSProperties = { fontSize: '11px', color: 'var(--text-dim)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Database size={16} color="var(--accent)" />
            {t('catalogPage.ocrTitle')}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              className="btn"
              onClick={() => setShowJson((v) => !v)}
              style={{ fontSize: '11px', padding: '3px 10px', ...(showJson ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}) }}
            >
              <Braces size={12} />
              <span>{showJson ? t('catalogPage.viewStructured') : t('catalogPage.viewJson')}</span>
            </button>
          </div>
        </div>

        <div style={{ ...dim, lineHeight: 1.6 }}>{t('catalogPage.ocrHint')}</div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--accent-rose)', color: 'var(--accent-rose)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        {!error && !data && <div style={{ ...dim, padding: '24px 0', textAlign: 'center' }}>{t('catalogPage.dataLoading')}</div>}

        {data && (
          <>
            <div style={{ display: 'flex', gap: '14px', fontSize: '11px', alignItems: 'center' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{t('catalogPage.dataProviders', { n: data.providers.length })}</span>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{t('catalogPage.dataModelsN', { n: totalModels })}</span>
              <Chip
                label={
                  <>
                    <Lock size={10} />
                    {t('catalogPage.ocrLocked', { n: lockedIds.size })}
                  </>
                }
                pressed={onlyLocked}
                tone="amber"
                title={t('catalogPage.ocrOnlyLockedHint')}
                onToggle={() => setOnlyLocked((v) => !v)}
              />
              <Chip
                label={
                  <>
                    <EyeOff size={10} />
                    {t('catalogPage.ocrHidden', { n: hiddenCount })}
                  </>
                }
                pressed={onlyHidden}
                title={t('catalogPage.ocrOnlyHiddenHint')}
                onToggle={() => setOnlyHidden((v) => !v)}
              />
            </div>
          </>
        )}
        {data && !showJson && (
          <>
            <input
              type="text"
              className="input"
              placeholder={t('catalogPage.dataSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, borderTop: '1px solid var(--divider)', paddingTop: '8px' }}>
              {providers.length === 0 ? (
                <div style={{ ...dim, padding: '24px 0', textAlign: 'center' }}>
                  {onlyLocked
                    ? t('catalogPage.ocrNoLocked')
                    : onlyHidden
                      ? t('catalogPage.ocrNoHidden')
                      : t('catalogPage.dataEmpty')}
                </div>
              ) : (
                providers.slice(0, MAX_RENDER).map((p) => {
                  const open = expanded.has(p.id);
                  return (
                    <div key={p.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                      <div
                        onClick={() => toggle(p.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '9px 4px', cursor: 'pointer', userSelect: 'none' }}
                      >
                        {open ? <ChevronDown size={13} color="var(--text-dim)" /> : <ChevronRight size={13} color="var(--text-dim)" />}
                        <ProviderLogo providerId={p.id} logoMap={logoMap} size={24} />
                        <span style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-main)' }}>{p.id}</span>
                        {p.name && p.name !== p.id && (
                          <span style={{ ...dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        )}
                        <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                          {p.sources.map((s) => (
                            <span key={s} style={{ fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--card-border)', borderRadius: 999, padding: '0 5px' }}>
                              {s}
                            </span>
                          ))}
                        </span>
                        {p.custom && (
                          <span style={{ fontSize: 9, color: 'var(--accent-amber)', border: '1px solid var(--accent-amber)', borderRadius: 999, padding: '0 5px', flexShrink: 0 }}>
                            {t('catalogPage.ocrLocal')}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', ...dim, flexShrink: 0 }}>
                          {p.models.length} {t('catalogPage.dataModelsUnit')}
                        </span>
                      </div>
                      {open && p.models.length > 0 && (
                        <div style={{ paddingLeft: '32px', paddingBottom: '8px' }}>
                          <ModelTable
                            models={p.models.slice(0, MAX_RENDER)}
                            showSource
                            providerId={p.id}
                            lockedIds={lockedIds}
                            onToggleLock={(m) => void handleToggleLock(m, p.id)}
                            onToggleHidden={(m) => void handleToggleHidden(m, p.id)}
                            onEdit={(m) => setEditTarget({ providerId: p.id, modelId: m.id, current: m })}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              {truncated && (
                <div style={{ fontSize: '11px', color: 'var(--accent-amber)', padding: '10px 4px' }}>
                  {t('catalogPage.dataTruncated', { n: MAX_RENDER })}
                </div>
              )}
            </div>
          </>
        )}
        {data && showJson && (
          <>
            {jsonText && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--accent-amber)' }}>
                  {jsonText.fullLength > 0 ? t('catalogPage.jsonTruncated', { size: fmtSize(jsonText.fullLength) }) : ''}
                </div>
                <button className="btn" style={{ fontSize: '11px', padding: '3px 10px', flexShrink: 0 }} onClick={() => void copyJson()}>
                  <Copy size={12} />
                  <span>{t('catalogPage.copyJson')}</span>
                </button>
              </div>
            )}
            {jsonText && <pre style={JSON_PRE}>{jsonText.text}</pre>}
          </>
        )}
        {editTarget && (
          <OcrEditModal
            target={editTarget}
            onClose={() => setEditTarget(null)}
            onSaved={() => {
              void loadData();
              void opencodeApi
                .lockedCatalogModels()
                .then((l) => setLockedIds(new Set(l.lockedModels)))
                .catch(() => undefined);
            }}
          />
        )}
    </div>
  );
};

/** Aggregate-override editor (OCR Catalog viewer): edits land in
 * catalog/overrides.json and win over sourced values — a separate editing
 * plane from defs-file definitions (which /providers manages). */
const OcrEditModal: React.FC<{
  target: { providerId: string; modelId: string; current: CatalogSourceDataModelRecord };
  onClose: () => void;
  onSaved: () => void;
}> = ({ target, onClose, onSaved }) => {
  const { t } = useI18n();
  const toast = useToast();
  const cur = target.current;
  const [name, setName] = useState(cur.name ?? '');
  const [costInput, setCostInput] = useState(cur.cost?.input != null ? String(cur.cost.input) : '');
  const [costOutput, setCostOutput] = useState(cur.cost?.output != null ? String(cur.cost.output) : '');
  const [contextLimit, setContextLimit] = useState(cur.limit?.context != null ? String(cur.limit.context) : '');
  const [outputLimit, setOutputLimit] = useState(cur.limit?.output != null ? String(cur.limit.output) : '');
  // Capability switches show the CURRENT effective value (override first, then
  // the aggregated catalog value) — WYSIWYG. Save diffs every field against
  // this open-time effective value: changed fields land in the override,
  // untouched fields keep following source refreshes.
  const [caps, setCaps] = useState<Record<'tool_call' | 'reasoning' | 'temperature', boolean>>({
    tool_call: cur.tool_call === true,
    reasoning: cur.reasoning === true,
    temperature: cur.temperature === true,
  });
  // Open-time baseline of the switches, captured AFTER the override fetch
  // resolves (it can overwrite `caps`). The save diff compares against THIS,
  // not the raw catalog field: a Switch has no "unset" position, so
  // `cur.reasoning === undefined` initializes it to false, and diffing that
  // against the raw `undefined` reported every untouched model as changed and
  // silently pinned `reasoning: false` / `temperature: false` as a sticky
  // override on the next source sync.
  const [capsBaseline, setCapsBaseline] = useState<Record<'tool_call' | 'reasoning' | 'temperature', boolean>>({
    tool_call: cur.tool_call === true,
    reasoning: cur.reasoning === true,
    temperature: cur.temperature === true,
  });
  const [efforts, setEfforts] = useState<string[]>(effectiveEffortLadder(cur));
  const [npm, setNpm] = useState(cur.npm ?? '');
  // npm options come from the backend-owned vocabulary (single source of
  // truth with wireFor; api.ts caches the fetch process-lifetime). The
  // hardcoded list below is only the fetch-failed fallback.
  const [npmVocab, setNpmVocab] = useState<NpmVocabularyEntry[]>([]);
  useEffect(() => {
    opencodeApi.getNpmVocabulary().then(setNpmVocab).catch(() => {});
  }, []);
  const [cacheRead, setCacheRead] = useState(cur.cost?.cache_read != null ? String(cur.cost.cache_read) : '');
  const [cacheWrite, setCacheWrite] = useState(cur.cost?.cache_write != null ? String(cur.cost.cache_write) : '');
  const [modIn, setModIn] = useState<string[]>(cur.modalities?.input ?? []);
  const [modOut, setModOut] = useState<string[]>(cur.modalities?.output ?? []);
  const [variants, setVariants] = useState<{ id: string; effort: string }[]>(cur.variants ?? []);
  const [defaultEffort, setDefaultEffort] = useState<string>(cur.defaultEffort ?? '');
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    opencodeApi
      .getCatalogOverride(target.providerId, target.modelId)
      .then((res) => {
        const e = res.entry;
        if (!e) return;
        setHasOverride(true);
        if (e.name !== undefined) setName(String(e.name));
        if (e.cost?.input != null) setCostInput(String(e.cost.input));
        if (e.cost?.output != null) setCostOutput(String(e.cost.output));
        if (e.cost?.cache_read != null) setCacheRead(String(e.cost.cache_read));
        if (e.cost?.cache_write != null) setCacheWrite(String(e.cost.cache_write));
        if (e.limit?.context != null) setContextLimit(String(e.limit.context));
        if (e.limit?.output != null) setOutputLimit(String(e.limit.output));
        if (e.reasoningEfforts !== undefined) setEfforts(e.reasoningEfforts);
        if (e.npm !== undefined) setNpm(String(e.npm));
        if (e.variants !== undefined) setVariants(e.variants);
        if (e.defaultEffort !== undefined) setDefaultEffort(e.defaultEffort ?? '');
        if (e.modalities?.input) setModIn(e.modalities.input);
        if (e.modalities?.output) setModOut(e.modalities.output);
        setCaps((c) => ({
          tool_call: e.tool_call !== undefined ? e.tool_call : c.tool_call,
          reasoning: e.reasoning !== undefined ? e.reasoning : c.reasoning,
          temperature: e.temperature !== undefined ? e.temperature : c.temperature,
        }));
        setCapsBaseline({
          tool_call: e.tool_call !== undefined ? e.tool_call : cur.tool_call === true,
          reasoning: e.reasoning !== undefined ? e.reasoning : cur.reasoning === true,
          temperature: e.temperature !== undefined ? e.temperature : cur.temperature === true,
        });
      })
      .catch(() => undefined);
  }, [target.providerId, target.modelId]);

  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };

  const save = async () => {
    // A default effort outside the declared levels would be pinned onto every
    // Backstop for data this form did not produce (e.g. hand-edited
    // overrides.json): a default effort outside the declared levels would be
    // pinned onto every routed request. Picking a default auto-checks its
    // level, so this only fires on pre-existing mismatches. An empty ladder
    // declares no explicit levels → skip.
    if (defaultEffort && efforts.length > 0 && !efforts.includes(defaultEffort)) {
      toast.error(t('catalogPage.ocrDefaultEffortNotInLadder', { effort: defaultEffort }));
      return;
    }
    setSaving(true);
    try {
      // Partial-patch semantics: overrides merge key-by-key over the catalog
      // (overrides-store.ts), so ONLY send fields the user actually filled —
      // blanks mean "keep the catalog value", never an implicit 0.
      const entry: Record<string, any> = {};
      // WYSIWYG diff: a field lands in the override ONLY when the value on
      // screen differs from the effective value at open time (`cur` — the
      // aggregated catalog view already includes prior overrides). Untouched
      // fields keep following source refreshes; blanks never imply 0.
      const changed = (v: unknown, base: unknown): boolean => JSON.stringify(v ?? null) !== JSON.stringify(base ?? null);
      if (name.trim() && changed(name.trim(), cur.name)) entry.name = name.trim();
      const cost: Record<string, number> = {};
      if (num(costInput) !== undefined && changed(num(costInput), cur.cost?.input)) cost.input = num(costInput)!;
      if (num(costOutput) !== undefined && changed(num(costOutput), cur.cost?.output)) cost.output = num(costOutput)!;
      if (num(cacheRead) !== undefined && changed(num(cacheRead), cur.cost?.cache_read)) cost.cache_read = num(cacheRead)!;
      if (num(cacheWrite) !== undefined && changed(num(cacheWrite), cur.cost?.cache_write)) cost.cache_write = num(cacheWrite)!;
      if (Object.keys(cost).length > 0) entry.cost = cost;
      const limit: Record<string, number> = {};
      if (num(contextLimit) !== undefined && changed(num(contextLimit), cur.limit?.context)) limit.context = num(contextLimit)!;
      if (num(outputLimit) !== undefined && changed(num(outputLimit), cur.limit?.output)) limit.output = num(outputLimit)!;
      if (Object.keys(limit).length > 0) entry.limit = limit;
      if (caps.tool_call !== capsBaseline.tool_call) entry.tool_call = caps.tool_call;
      if (caps.reasoning !== capsBaseline.reasoning) entry.reasoning = caps.reasoning;
      if (caps.temperature !== capsBaseline.temperature) entry.temperature = caps.temperature;
      const ladderNow = EFFORT_LADDER.filter((l) => efforts.includes(l));
      if (changed(ladderNow, effectiveEffortLadder(cur))) entry.reasoningEfforts = ladderNow;
      if (npm.trim() && changed(npm.trim(), cur.npm)) entry.npm = npm.trim();
      if (changed(variants.filter((v) => v.id.trim() && v.effort), cur.variants ?? [])) {
        entry.variants = variants.filter((v) => v.id.trim() && v.effort).map((v) => ({ id: v.id.trim(), effort: v.effort }));
      }
      if (changed(defaultEffort || null, cur.defaultEffort ?? null)) {
        entry.defaultEffort = defaultEffort || null; // '' = clear the override (follow catalog/def)
      }
      const mod: Record<string, string[]> = {};
      if (changed(modIn, cur.modalities?.input ?? [])) mod.input = modIn;
      if (changed(modOut, cur.modalities?.output ?? [])) mod.output = modOut;
      if (Object.keys(mod).length > 0) entry.modalities = mod;
      // Tier membership is NOT edited here — it lives in the /tiers member
      // lists, the single source of routing membership.
      await opencodeApi.putCatalogOverride(target.providerId, target.modelId, entry);
      toast.success(t('catalogPage.ocrEditSaved'));
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    try {
      await opencodeApi.removeCatalogOverride(target.providerId, target.modelId);
      toast.success(t('catalogPage.ocrEditRestored'));
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  const spin: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

  return (
    <Dialog
      title={t('catalogPage.ocrEditTitle')}
      subtitle={
        <>
          <span>{t('catalogPage.ocrEditHint')}</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--accent)' }}>
            {target.providerId}/{target.modelId}
          </span>
        </>
      }
      footerLeft={
        hasOverride ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void restore()}>
            {t('catalogPage.ocrEditRestore')}
          </button>
        ) : undefined
      }
      footerRight={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('catalogPage.close')}
          </button>
          <button type="submit" form="ocr-edit-form" className="btn btn-primary" disabled={saving}>
            {saving ? <Loader2 size={12} style={spin} /> : <Check size={12} />}
            <span>{t('catalogPage.ocrEditSave')}</span>
          </button>
        </>
      }
      onClose={onClose}
      closeLabel={t('catalogPage.close')}
      width={660}
    >
      <form
        id="ocr-edit-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        {/* Same canonical order as the model editor: identity → capability →
            limits → cost → reasoning → variants → integration. */}
        <FormSection title={t('form.identity')}>
          <Field label={t('catalogPage.dataColName')}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </Field>
        </FormSection>

        <FormSection title={t('form.capability')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
            {([
              ['tool_call', t('catalogPage.capToolCall')],
              ['reasoning', t('catalogPage.capReasoning')],
              ['temperature', t('catalogPage.capTemperature')],
            ] as const).map(([key, label]) => (
              <label key={key} className="form-switch">
                <Switch
                  checked={caps[key]}
                  onChange={(v) => setCaps((c) => ({ ...c, [key]: v }))}
                  ariaLabel={key}
                  size="sm"
                />
                {label}
              </label>
            ))}
          </div>
          <Field label={t('catalogPage.ocrEditModalities')}>
            <ModalityPicker
              input={modIn}
              output={modOut}
              onChange={({ input, output }) => { setModIn(input); setModOut(output); }}
              inputLabel={t('catalogPage.ocrEditModIn')}
              outputLabel={t('catalogPage.ocrEditModOut')}
            />
          </Field>
        </FormSection>

        <FormSection title={t('form.limits')}>
          <FieldRow>
            <Field label={t('catalogPage.dataColCtx')}>
              <input type="number" step="any" min={0} value={contextLimit} onChange={(e) => setContextLimit(e.target.value)} className="input" />
            </Field>
            <Field label={t('catalogPage.dataColOutputLimit')}>
              <input type="number" step="any" min={0} value={outputLimit} onChange={(e) => setOutputLimit(e.target.value)} className="input" />
            </Field>
          </FieldRow>
        </FormSection>

        <FormSection title={t('form.cost')}>
          <FieldRow columns={4}>
            <Field label={t('catalogPage.dataColInput')}>
              <input type="number" step="any" min={0} value={costInput} onChange={(e) => setCostInput(e.target.value)} className="input" />
            </Field>
            <Field label={t('catalogPage.dataColOutput')}>
              <input type="number" step="any" min={0} value={costOutput} onChange={(e) => setCostOutput(e.target.value)} className="input" />
            </Field>
            <Field label={t('catalogPage.dataColCacheRead')}>
              <input type="number" step="any" min={0} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} className="input" />
            </Field>
            <Field label={t('catalogPage.dataColCacheWrite')}>
              <input type="number" step="any" min={0} value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} className="input" />
            </Field>
          </FieldRow>
        </FormSection>

        <FormSection title={t('form.reasoning')}>
          <Field label={t('catalogPage.ocrEditDefaultEffort')}>
            <Combobox
              value={defaultEffort}
              // picking a default auto-checks that level, so the default is
              // always one of the levels this model declares
              onChange={(v) => {
                setDefaultEffort(v);
                if (v && !efforts.includes(v)) setEfforts((prev) => [...prev, v]);
              }}
              options={effortOptionList(t, EFFORT_LADDER, ' — ')}
            />
          </Field>
          <Field label={t('catalogPage.ocrEditEfforts')}>
            {/* un-checking the level the default points at clears the default */}
            <EffortChips
              value={efforts}
              onChange={(next) => {
                setEfforts(next);
                if (defaultEffort && !next.includes(defaultEffort)) setDefaultEffort('');
              }}
            />
          </Field>
        </FormSection>

        <FormSection title={t('form.variants')}>
          <VariantListEditor
            value={variants}
            onChange={setVariants}
            addLabel={t('catalogPage.ocrEditAddVariant')}
            removeLabel={t('catalogPage.ocrEditRemoveVariant')}
            options={effortOptionList(t, EFFORT_LADDER, ' — ')}
          />
        </FormSection>

        <FormSection title={t('form.integration')}>
          <Field label={t('catalogPage.ocrEditNpm')} hint={t('catalogPage.ocrEditNpmHint')}>
            <Combobox
              value={npm}
              onChange={(v) => setNpm(v)}
              options={[
                { value: '', label: t('catalogPage.ocrEditNpmFollow') },
                ...(npmVocab.length > 0
                  ? npmVocab.map((e) => ({ value: e.alias, label: e.alias, meta: e.wire }))
                  : [
                      { value: '@ai-sdk/openai-compatible', label: '@ai-sdk/openai-compatible', meta: 'OpenAI Chat' },
                      { value: '@ai-sdk/openai', label: '@ai-sdk/openai', meta: 'OpenAI Responses' },
                      { value: '@ai-sdk/anthropic', label: '@ai-sdk/anthropic', meta: 'Anthropic' },
                      { value: '@ai-sdk/google', label: '@ai-sdk/google', meta: 'Gemini' },
                      { value: '@ai-sdk/typesafe-ai', label: '@ai-sdk/typesafe-ai', meta: 'TypeSafe Decision' },
                    ]),
              ]}
            />
          </Field>
        </FormSection>
      </form>
    </Dialog>
  );
};

const AddSourceModal: React.FC<{
  onClose: () => void;
  onAdded: (source: CatalogSourceView) => void;
}> = ({ onClose, onAdded }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [id, setId] = useState('');
  const [type, setType] = useState('provider-catalog');
  const [url, setUrl] = useState('');
  const [priority, setPriority] = useState('50');
  const [enabled, setEnabled] = useState(true);
  const [mapText, setMapText] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useBodyScrollLock(true);

  const typeOptions = [
    { value: 'provider-catalog', label: t('catalogPage.typeProviderCatalog') },
    { value: 'model-list', label: t('catalogPage.typeModelList') },
    { value: 'openai-compatible', label: t('catalogPage.typeOpenAICompatible') },
    { value: 'custom', label: t('catalogPage.typeCustom') },
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !url.trim() || !type) {
      setError(t('catalogPage.warnRequired'));
      return;
    }
    let map: Record<string, any> | undefined;
    if (type === 'custom') {
      try {
        map = JSON.parse(mapText || '{}');
      } catch {
        setError(t('catalogPage.mapInvalid'));
        return;
      }
      if (!map?.id) {
        setError(t('catalogPage.mapNeedId'));
        return;
      }
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await opencodeApi.addCatalogSource({
        id: id.trim(),
        type,
        url: url.trim(),
        priority: Number(priority) || undefined,
        enabled,
        map,
      });
      toast.success(t('catalogPage.added'));
      onAdded(res.source);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldLabel: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--text-dim)',
    display: 'block',
    marginBottom: '6px',
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '500px',
          padding: '24px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>{t('catalogPage.addTitle')}</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--accent-rose)',
              color: 'var(--accent-rose)',
              fontSize: '12px',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={fieldLabel}>{t('catalogPage.fieldId')}</label>
            <input
              type="text"
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('catalogPage.fieldIdPlaceholder')}
              className="input"
            />
          </div>
          <div>
            <label style={fieldLabel}>{t('catalogPage.fieldType')}</label>
            <Combobox value={type} onChange={setType} options={typeOptions} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={fieldLabel}>{t('catalogPage.fieldUrl')}</label>
            <input
              type="text"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('catalogPage.fieldUrlPlaceholder')}
              className="input"
            />
          </div>
          <div>
            <label style={fieldLabel}>{t('catalogPage.fieldPriority')}</label>
            <input
              type="number"
              min={1}
              max={999}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="input"
            />
          </div>
          {type === 'custom' && (
            <div>
              <label style={fieldLabel}>{t('catalogPage.mapLabel')}</label>
              <textarea
                value={mapText}
                onChange={(e) => setMapText(e.target.value)}
                placeholder={t('catalogPage.mapPlaceholder')}
                className="input"
                rows={6}
                style={{ fontFamily: FONT_MONO, fontSize: '11px', resize: 'vertical' }}
              />
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('catalogPage.mapHint')}</div>
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
            <span>{t('catalogPage.fieldEnabled')}</span>
            <Switch checked={enabled} onChange={setEnabled} />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" className="btn" onClick={onClose}>
              {t('catalogPage.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              <Plus size={14} />
              <span>{t('catalogPage.submit')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};

export const CatalogSourcesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [sources, setSources] = useState<CatalogSourceView[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [viewSource, setViewSource] = useState<CatalogSourceView | null>(null);
  const [tab, setTab] = useState<'sources' | 'catalog'>('sources');
  const [syncIntervalMs, setSyncIntervalMs] = useState<number>(86_400_000);

  const load = useCallback(async () => {
    try {
      const res = await opencodeApi.catalogSources();
      setSources(res.sources);
      setSyncIntervalMs(res.syncIntervalMs);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
      setSources([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markBusy = (id: string, busy: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleRefresh = async (id: string) => {
    markBusy(id, true);
    try {
      await opencodeApi.refreshCatalogSource(id);
      toast.success(t('catalogPage.refreshed', { id }));
      await load();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      markBusy(id, false);
    }
  };

  const handleIntervalChange = async (ms: number) => {
    try {
      await opencodeApi.setCatalogSyncInterval(ms);
      setSyncIntervalMs(ms);
      toast.success(t('catalogPage.syncIntervalSaved'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
      await load();
    }
  };

  const handleRefreshAll = async () => {    setRefreshingAll(true);
    try {
      await opencodeApi.refreshAllCatalogSources();
      toast.success(t('catalogPage.refreshedAll'));
      await load();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleToggle = async (source: CatalogSourceView, enabled: boolean) => {
    try {
      await opencodeApi.toggleCatalogSource(source.id, enabled);
      toast.success(enabled ? t('catalogPage.enabledOn', { id: source.id }) : t('catalogPage.enabledOff', { id: source.id }));
      await load();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
      await load();
    }
  };

  const handleRemove = async (source: CatalogSourceView) => {
    const ok = await confirmDialog({
      title: t('catalogPage.removeTitle'),
      description: t('catalogPage.removeConfirm', { id: source.id }),
      danger: true,
    });
    if (!ok) return;
    try {
      await opencodeApi.removeCatalogSource(source.id);
      toast.success(t('catalogPage.removed'));
      await load();
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  if (sources === null) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  const headCell: React.CSSProperties = {
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-dim)',
    padding: '0 8px 10px 0',
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--text-dim)',
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  });

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <CloudDownload size={18} color="var(--accent)" />
          <span>{t('catalogPage.title')}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {tab === 'sources' && (
            <>
              <button className="btn" onClick={handleRefreshAll} disabled={refreshingAll}>
                <RefreshCw size={14} style={refreshingAll ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
                <span>{refreshingAll ? t('catalogPage.refreshing') : t('catalogPage.refreshAll')}</span>
              </button>
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <Plus size={14} />
                <span>{t('catalogPage.addSource')}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs: sources (editable) · aggregated catalog (read-only discovery). */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--divider)', marginBottom: 12 }}>
        <button style={tabBtn(tab === 'sources')} onClick={() => setTab('sources')}>
          {t('catalogPage.tabSources')}
        </button>
        <button style={tabBtn(tab === 'catalog')} onClick={() => setTab('catalog')}>
          {t('catalogPage.tabCatalog')}
        </button>
      </div>

      {tab === 'catalog' ? (
        <OcrCatalogPanel />
      ) : (
        <>
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '4px' }}>
        {t('catalogPage.subtitle')}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '12px' }}>
        {t('catalogPage.subtitleMerge')}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '12px', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t('catalogPage.syncIntervalLabel')}
          <InfoTip text={t('catalogPage.syncIntervalHint')} />
        </span>
        <Combobox
          value={String(syncIntervalMs)}
          onChange={(v) => void handleIntervalChange(Number(v))}
          options={[
            ...INTERVAL_PRESETS.map((p) => ({ value: String(p.ms), label: t(p.key) })),
            ...(INTERVAL_PRESETS.some((p) => p.ms === syncIntervalMs)
              ? []
              : [{ value: String(syncIntervalMs), label: `${Math.round(syncIntervalMs / 3_600_000)}h` }]),
          ]}
          style={{ width: '180px' }}
        />
      </div>

      {sources.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '13px', padding: '24px 0', textAlign: 'center' }}>
          {t('catalogPage.empty')}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: '1000px', display: 'grid', gridTemplateColumns: GRID, rowGap: '2px', alignItems: 'center' }}>
            <div style={headCell}>{t('catalogPage.colSource')}</div>
            <div style={headCell}>{t('catalogPage.colUrl')}</div>
            <div style={headCell}>{t('catalogPage.colType')}</div>
            <div style={headCell}>{t('catalogPage.colPriority')}</div>
            <div style={headCell}>{t('catalogPage.colRecords')}</div>
            <div style={headCell}>{t('catalogPage.colSync')}</div>
            <div style={{ ...headCell, textAlign: 'right' }}>{t('catalogPage.colActions')}</div>

            {sources.map((s) => (
              <React.Fragment key={s.id}>
                {/* source id + badges */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 8px 10px 0', minWidth: 0 }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-main)' }}>{s.id}</span>
                  {s.builtin && (
                    <span
                      title={t('catalogPage.builtinHint')}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        fontSize: '10px',
                        padding: '1px 7px',
                        borderRadius: '999px',
                        color: 'var(--accent)',
                        border: '1px solid var(--accent)',
                      }}
                    >
                      <Lock size={9} />
                      {t('catalogPage.builtinBadge')}
                    </span>
                  )}
                </div>
                {/* url */}
                <div
                  title={s.url}
                  style={{ fontSize: '12px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '10px 8px 10px 0', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <Globe size={12} style={{ flexShrink: 0 }} />
                  {s.url}
                </div>
                {/* type */}
                <div style={{ padding: '10px 8px 10px 0' }}>
                  <TypeBadge source={s} />
                </div>
                {/* priority */}
                <div style={{ fontSize: '12px', color: 'var(--text-main)', padding: '10px 8px 10px 0' }}>{s.priority}</div>
                {/* records */}
                <div style={{ fontSize: '12px', color: 'var(--text-main)', padding: '10px 8px 10px 0' }}>{s.records.toLocaleString()}</div>
                {/* sync state + last update */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', padding: '10px 8px 10px 0', minWidth: 0 }}>
                  <StatusBadge source={s} />
                  <span
                    title={s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : undefined}
                    style={{ fontSize: '11px', color: 'var(--text-dim)' }}
                  >
                    {s.fetchedAt ? fmtTime(s.fetchedAt) : t('catalogPage.neverSynced')}
                  </span>
                  {s.lastError && (
                    <span title={s.lastError} style={{ fontSize: '10px', color: 'var(--accent-rose)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.lastError}
                    </span>
                  )}
                </div>
                {/* actions */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', padding: '10px 0' }}>
                  <Switch
                    size="sm"
                    checked={s.enabled}
                    disabled={s.builtin}
                    ariaLabel={`${t('catalogPage.colSource')}: ${s.id}`}
                    onChange={(v) => void handleToggle(s, v)}
                  />
                  <button
                    className="btn btn-sm"
                    style={{ padding: '4px 8px' }}
                    onClick={() => setViewSource(s)}
                    title={t('catalogPage.viewData')}
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ padding: '4px 8px' }}
                    onClick={() => void handleRefresh(s.id)}
                    disabled={busyIds.has(s.id)}
                    title={t('catalogPage.refresh')}
                  >
                    <RefreshCw
                      size={13}
                      style={busyIds.has(s.id) ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
                    />
                  </button>
                  {!s.builtin && (
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ padding: '4px 8px' }}
                      onClick={() => void handleRemove(s)}
                      title={t('catalogPage.remove')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
        </>
      )}

      {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} onAdded={() => void load()} />}
      {viewSource && <DataViewerModal source={viewSource} onClose={() => setViewSource(null)} />}
    </div>
  );
};
