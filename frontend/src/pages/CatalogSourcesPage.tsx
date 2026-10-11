import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudDownload, Plus, RefreshCw, Trash2, Lock, LockOpen, Globe, Eye, ChevronDown, ChevronRight, Database, Info, Braces, Copy, Pencil } from 'lucide-react';
import {
  api,
  opencodeApi,
  type CatalogSourceView,
  type CatalogSourceDataResponse,
  type CatalogSourceDataProviderRecord,
  type CatalogSourceDataModelRecord,
  type OcrCatalogProvider,
} from '../lib/api';
import { ModelEditDialog } from '../components/ModelEditDialog';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { classifyTierDetailed, DEFAULT_TIER_MATCH, type ResolvedTierMatch, type TierMatchCfg, type TierReasonCode } from '../lib/tierMatch';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

const TIER_REASON_KEYS: Record<TierReasonCode, string> = {
  name: 'catalogPage.ocrTierWhyName',
  flag: 'catalogPage.ocrTierWhyReasoning',
  cost: 'catalogPage.ocrTierWhyCost',
  unclassified: 'catalogPage.ocrTierWhyUnclassified',
};

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
        border: '1px solid var(--border)',
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
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  lineHeight: 1.55,
  color: 'var(--text-main)',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid var(--border)',
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
  onEdit?: (m: CatalogSourceDataModelRecord) => void;
}> = ({ models, showSource, providerId, lockedIds, onToggleLock, onEdit }) => {
  const lockKey = (mid: string): string => (providerId ? `${providerId}||${mid}` : mid);
  const isLocked = (mid: string): boolean => Boolean(lockedIds?.has(lockKey(mid)));
  const { t } = useI18n();
  const head: React.CSSProperties = {
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--text-dim)',
    padding: '2px 6px 4px 0',
    textAlign: 'left',
  };
  const cell: React.CSSProperties = { fontSize: '11px', color: 'var(--text-main)', padding: '3px 6px 3px 0' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: MODEL_GRID }}>
      <div style={head}>{t('catalogPage.dataColModel')}</div>
      <div style={head}>{t('catalogPage.dataColName')}</div>
      <div style={head}>{t('catalogPage.dataColInput')}</div>
      <div style={head}>{t('catalogPage.dataColOutput')}</div>
      <div style={head}>{t('catalogPage.dataColCtx')}</div>
      {models.map((m) => (
        <React.Fragment key={m.id}>
          <div style={{ ...cell, fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>
            {m.id}
            {onEdit && (
              <button
                onClick={() => onEdit(m)}
                title={t('op.pmEdit')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle', color: 'var(--accent)' }}
              >
                <Pencil size={9} />
              </button>
            )}
            {onToggleLock ? (
              <button
                onClick={() => onToggleLock(m)}
                title={isLocked(m.id) ? t('models.unlockHint') : t('models.lockHint')}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  marginLeft: 8,
                  display: 'inline-flex',
                  verticalAlign: 'middle',
                  color: isLocked(m.id) ? 'var(--accent-amber)' : 'var(--text-dim)',
                }}
              >
                {isLocked(m.id) ? <Lock size={9} /> : <LockOpen size={9} />}
              </button>
            ) : (
              isLocked(m.id) && (
                <span title={t('models.lockHint')} style={{ display: 'inline-flex', color: 'var(--accent-amber)', marginLeft: 4, verticalAlign: 'middle' }}>
                  <Lock size={9} />
                </span>
              )
            )}
            {m.tier && (
              <span
                title={t('catalogPage.ocrEditTier')}
                style={{
                  marginLeft: 6,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '0 5px',
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  color: m.tier === 'lite' ? 'var(--accent-emerald)' : m.tier === 'pro' || m.tier === 'ultra' ? 'var(--accent-violet)' : 'var(--accent)',
                }}
              >
                {m.tier}
              </span>
            )}
          </div>
          <div style={{ ...cell, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.name || '—'}
            {showSource && m.source && (
              <span style={{ marginLeft: 5, fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 5px' }}>
                {m.source}
              </span>
            )}
          </div>
          <div style={cell}>{fmtPrice(m.cost?.input)}</div>
          <div style={cell}>{fmtPrice(m.cost?.output)}</div>
          <div style={cell}>{m.limit?.context ? m.limit.context.toLocaleString() : '—'}</div>
        </React.Fragment>
      ))}
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
  useBodyScrollLock(true);

  useEffect(() => {
    opencodeApi.catalogSourceData(source.id).then(setData).catch((e: any) => setError(e.message));
  }, [source.id]);

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
        background: 'rgba(0, 0, 0, 0.85)',
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
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
              {isProviderSource ? (
                providers.length === 0 ? (
                  <div style={{ ...fieldLabel, padding: '24px 0', textAlign: 'center' }}>{t('catalogPage.dataEmpty')}</div>
                ) : (
                  providers.slice(0, MAX_RENDER).map((p) => {
                    const open = expanded.has(p.id);
                    const ms = p.models ?? [];
                    return (
                      <div key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <div
                          onClick={() => toggle(p.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 4px', cursor: 'pointer', userSelect: 'none' }}
                        >
                          {open ? <ChevronDown size={13} color="var(--text-dim)" /> : <ChevronRight size={13} color="var(--text-dim)" />}
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
                          <div style={{ paddingLeft: '22px', paddingBottom: '8px' }}>
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
 * definitions first, opencode baseline, extension enrichments — the OCR truth. */
const OcrCatalogModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
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
  useBodyScrollLock(true);

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
    let list = data?.providers ?? [];
    if (onlyLocked) {
      // 只看已锚定：仅保留含锁定模型的 provider，模型行也只显示锁定的
      list = list
        .map((p) => ({ ...p, models: p.models.filter((m) => lockedIds.has(`${p.id}||${m.id}`)) }))
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
  }, [data, q, onlyLocked, lockedIds]);

  const totalModels = React.useMemo(() => (data?.providers ?? []).reduce((n, p) => n + p.models.length, 0), [data]);

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

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
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
            <button
              onClick={onClose}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
            >
              ✕
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
              <button
                onClick={() => setOnlyLocked((v) => !v)}
                title={t('catalogPage.ocrOnlyLockedHint')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  color: onlyLocked ? 'var(--accent-amber)' : 'var(--text-dim)',
                  border: `1px solid ${onlyLocked ? 'var(--accent-amber)' : 'var(--border)'}`,
                  background: onlyLocked ? 'rgba(245,158,11,0.12)' : 'transparent',
                }}
              >
                <Lock size={10} />
                {t('catalogPage.ocrLocked', { n: lockedIds.size })}
              </button>
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
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
              {providers.length === 0 ? (
                <div style={{ ...dim, padding: '24px 0', textAlign: 'center' }}>
                  {onlyLocked ? t('catalogPage.ocrNoLocked') : t('catalogPage.dataEmpty')}
                </div>
              ) : (
                providers.slice(0, MAX_RENDER).map((p) => {
                  const open = expanded.has(p.id);
                  return (
                    <div key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <div
                        onClick={() => toggle(p.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 4px', cursor: 'pointer', userSelect: 'none' }}
                      >
                        {open ? <ChevronDown size={13} color="var(--text-dim)" /> : <ChevronRight size={13} color="var(--text-dim)" />}
                        <span style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-main)' }}>{p.id}</span>
                        {p.name && p.name !== p.id && (
                          <span style={{ ...dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        )}
                        <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                          {p.sources.map((s) => (
                            <span key={s} style={{ fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 5px' }}>
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
                        <div style={{ paddingLeft: '22px', paddingBottom: '8px' }}>
                          <ModelTable
                            models={p.models.slice(0, MAX_RENDER)}
                            showSource
                            providerId={p.id}
                            lockedIds={lockedIds}
                            onToggleLock={(m) => void handleToggleLock(m, p.id)}
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
    </div>,
    document.body
  );
};

/** Aggregate-override editor (OCR Catalog viewer): edits land in
 * catalog/overrides.json and win over sourced values — a separate editing
 * plane from opencode.jsonc definitions (which /providers manages). */
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
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  useBodyScrollLock(true);

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
        if (e.limit?.context != null) setContextLimit(String(e.limit.context));
        if (e.limit?.output != null) setOutputLimit(String(e.limit.output));
      })
      .catch(() => undefined);
  }, [target.providerId, target.modelId]);

  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };

  const save = async () => {
    setSaving(true);
    try {
      // Partial-patch semantics: overrides merge key-by-key over the catalog
      // (overrides-store.ts), so ONLY send fields the user actually filled —
      // blanks mean "keep the catalog value", never an implicit 0.
      const entry: Record<string, any> = {};
      if (name.trim()) entry.name = name.trim();
      const cost: Record<string, number> = {};
      if (num(costInput) !== undefined) cost.input = num(costInput)!;
      if (num(costOutput) !== undefined) cost.output = num(costOutput)!;
      if (Object.keys(cost).length > 0) entry.cost = cost;
      const limit: Record<string, number> = {};
      if (num(contextLimit) !== undefined) limit.context = num(contextLimit)!;
      if (num(outputLimit) !== undefined) limit.output = num(outputLimit)!;
      if (Object.keys(limit).length > 0) entry.limit = limit;
      // tier membership moved to the /tiers member lists — this
      // modal no longer writes overrides.tier (existing values are kept and
      // honored once by the import/seed).
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

  const fieldLabel: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '5px' };

  // Preview of the backend smart match. The effective config (user `match`
  // rules merged over the built-in baseline) comes from /tier-pools; the
  // static DEFAULT mirror is only the offline fallback — never re-implement
  // the heuristic here (it would drift from providers/tier-match.ts).
  //
  // r.match is declared `Partial<Record<Tier, TierMatchCfg>>` on the wire
  // (TierPoolsResponse.match? in lib/api.ts); layer the partial over the
  // baseline so any missing tier falls back to the built-in default — both
  // for preview correctness and to keep `match[tier].X` from blowing up when
  // a tier is absent in the live payload. We only overlay KEYS that are
  // actually present (not just set to `undefined`); the backend's
  // resolveTierMatch omits unset fields, but defensive copying costs nothing.
  const mergeMatch = (wire: Partial<Record<keyof ResolvedTierMatch, Partial<TierMatchCfg>>> | undefined): ResolvedTierMatch => {
    const out = {} as ResolvedTierMatch;
    (['lite', 'plus', 'pro', 'ultra'] as const).forEach((tier) => {
      const base = { ...DEFAULT_TIER_MATCH[tier] };
      const patch = wire?.[tier];
      if (patch) {
        for (const k of Object.keys(patch) as (keyof TierMatchCfg)[]) {
          const v = (patch as Record<string, unknown>)[k];
          if (v !== undefined) (base as Record<string, unknown>)[k] = v;
        }
      }
      out[tier] = base;
    });
    return out;
  };
  const [matchCfg, setMatchCfg] = useState<ResolvedTierMatch | null>(null);
  useEffect(() => {
    api
      .getTierPools()
      .then((r) => setMatchCfg(mergeMatch(r.match as Partial<Record<keyof ResolvedTierMatch, TierMatchCfg>> | undefined)))
      .catch(() => setMatchCfg(null));
  }, []);
  // Until the live config lands (or if the request fails), fall back to the
  // static baseline. After the load, mergeMatch guarantees every tier is a
  // real object — so match[tier].patterns never throws on the preview.
  const sug = classifyTierDetailed(cur.id, cur.cost?.input, cur.reasoning === true, matchCfg ?? DEFAULT_TIER_MATCH);
  const suggest = { tier: sug.tier, why: [t(TIER_REASON_KEYS[sug.reason])] };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 210,
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
          maxWidth: '460px',
          padding: '22px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-main)' }}>{t('catalogPage.ocrEditTitle')}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}>
            ✕
          </button>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>{t('catalogPage.ocrEditHint')}</div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--accent)' }}>
          {target.providerId}/{target.modelId}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div>
            <label style={fieldLabel}>{t('catalogPage.dataColName')}</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>
          <div>
            <label style={fieldLabel}>{t('catalogPage.ocrEditTier')}</label>
            <div
              style={{
                fontSize: '12px',
                padding: '6px 10px',
                border: '1px solid var(--card-border)',
                borderRadius: 6,
                color: 'var(--text-muted)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {suggest.tier}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>
              {t('catalogPage.ocrEditTierSuggested', { tier: suggest.tier })}
              {suggest.why.length > 0 ? ` —— ${suggest.why.join(' / ')}` : ''}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>{t('catalogPage.ocrEditTierRestart')}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <label style={fieldLabel}>{t('catalogPage.dataColInput')}</label>
              <input type="number" step="any" min={0} value={costInput} onChange={(e) => setCostInput(e.target.value)} className="input" />
            </div>
            <div>
              <label style={fieldLabel}>{t('catalogPage.dataColOutput')}</label>
              <input type="number" step="any" min={0} value={costOutput} onChange={(e) => setCostOutput(e.target.value)} className="input" />
            </div>
            <div>
              <label style={fieldLabel}>{t('catalogPage.dataColCtx')}</label>
              <input type="number" step="any" min={0} value={contextLimit} onChange={(e) => setContextLimit(e.target.value)} className="input" />
            </div>
            <div>
              <label style={fieldLabel}>{t('catalogPage.dataColOutputLimit')}</label>
              <input type="number" step="any" min={0} value={outputLimit} onChange={(e) => setOutputLimit(e.target.value)} className="input" />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '4px' }}>
            {hasOverride && (
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void restore()}>
                {t('catalogPage.ocrEditRestore')}
              </button>
            )}
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
              <button type="button" className="btn" onClick={onClose}>
                {t('catalogPage.close')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {t('catalogPage.ocrEditSave')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
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
        background: 'rgba(0, 0, 0, 0.85)',
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
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', resize: 'vertical' }}
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
  const [showOcr, setShowOcr] = useState(false);
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

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <CloudDownload size={18} color="var(--accent)" />
          <span>{t('catalogPage.title')}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn" onClick={() => setShowOcr(true)}>
            <Database size={14} />
            <span>{t('catalogPage.ocrView')}</span>
          </button>
          <button className="btn" onClick={handleRefreshAll} disabled={refreshingAll}>
            <RefreshCw size={14} style={refreshingAll ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
            <span>{refreshingAll ? t('catalogPage.refreshing') : t('catalogPage.refreshAll')}</span>
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} />
            <span>{t('catalogPage.addSource')}</span>
          </button>
        </div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '4px' }}>
        {t('catalogPage.subtitle')}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '12px' }}>
        {t('catalogPage.subtitleMerge')}
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '12px', flexWrap: 'wrap' }}
        title={t('catalogPage.syncIntervalHint')}
      >
        <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'help' }}>
          {t('catalogPage.syncIntervalLabel')}
          <Info size={12} color="var(--text-dim)" />
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

      {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} onAdded={() => void load()} />}
      {viewSource && <DataViewerModal source={viewSource} onClose={() => setViewSource(null)} />}
      {showOcr && <OcrCatalogModal onClose={() => setShowOcr(false)} />}
    </div>
  );
};
