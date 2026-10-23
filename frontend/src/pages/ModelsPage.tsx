import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Cpu, RefreshCw, Search, Brain, Wrench, Eye, EyeOff, AudioLines, Video, Thermometer, Pencil, Zap, Loader2, Lock, LockOpen, Copy } from 'lucide-react';
import { opencodeApi, type OpenCodeModelView } from '../lib/api';
import { useModelTest } from '../lib/useModelTest';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { ModelEditDialog } from '../components/ModelEditDialog';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Chip } from '../components/Chip';
import { fmtLatency, copyToClipboard } from '../lib/format';

import { FONT_MONO } from '../lib/fonts';
type SortKey = 'default' | 'priceAsc' | 'priceDesc' | 'contextDesc' | 'name';

const PAGE_SIZE = 50;
const PAGE_SIZES = [10, 20, 50, 100, 200];

/** 200000 → "200K", 1000000 → "1M" */
const SOURCE_BADGE: Record<string, { color: string; bg: string; labelKey: string }> = {
  opencode: { color: 'var(--accent)', bg: 'var(--accent-bg)', labelKey: 'models.srcOpencode' },
  'models-dev': { color: 'var(--hue-blue)', bg: 'var(--hue-blue-soft)', labelKey: 'models.srcModelsDev' },
  openrouter: { color: 'var(--hue-violet)', bg: 'var(--hue-violet-soft)', labelKey: 'models.srcOpenrouter' },
  config: { color: 'var(--accent-amber)', bg: 'color-mix(in srgb, var(--accent-amber) 12%, transparent)', labelKey: 'models.srcConfig' },
  mapped: { color: '#c084fc', bg: 'rgba(192,132,252,0.12)', labelKey: 'models.srcMapped' },
  'openai-compatible': { color: 'var(--text-dim)', bg: 'var(--chip-bg)', labelKey: 'models.srcOpenaiCompatible' },
  service: { color: 'var(--text-dim)', bg: 'var(--chip-bg)', labelKey: 'models.srcService' },
};

const fmtContext = (n?: number): string => {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};

const fmtPrice = (v?: number): string =>
  typeof v === 'number' && v >= 0 ? `$${v.toFixed(2)}` : '—';

/** Any capability that renders a badge — decides whether the "—" placeholder shows. */
const hasCapability = (m: OpenCodeModelView): boolean =>
  Boolean(
    m.reasoning ||
      m.tool_call ||
      m.attachment ||
      m.temperature ||
      m.modalities?.input?.includes('image') ||
      m.modalities?.input?.includes('audio') ||
      m.modalities?.input?.includes('video')
  );

// Outline badges: transparent fill, border derived from the text hue (the
// bg param is legacy at call sites — kept for signature stability).
const badgeStyle = (color: string, _bg: string): React.CSSProperties => ({
  background: 'transparent',
  color,
  fontSize: '10px',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: '99px',
  border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
});

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: '11px',
  fontWeight: 700,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid var(--divider)',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  // --card-bg is translucent (rgba .72) — flatten against --bg so the sticky
  // header never lets scrolled rows bleed through the titles.
  background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
  zIndex: 1,
};

const tdStyle: React.CSSProperties = {
  padding: '9px 14px',
  borderBottom: '1px solid var(--divider)',
  // Center against the two-line model cell (display name + providerId/modelId).
  verticalAlign: 'middle',
};

export const ModelsPage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [models, setModels] = useState<OpenCodeModelView[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<{ providerId: string; modelId: string } | null>(null);
  const { testingIds, testResults, testOne, isBusy } = useModelTest();
  const toast = useToast();
  // catalog.lockedModels — locally anchored ids whose maintained values remote
  // sources must never overwrite (explicit zeros included).
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState(searchParams.get('provider') || '');
  // Flag filters (same chips as the OCR catalog viewer); compose with each
  // other and with the search / provider filters.
  const [onlyLocked, setOnlyLocked] = useState(false);
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [sort, setSort] = useState<SortKey>('default');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const load = async () => {
    setLoading(true);
    try {
      const [res, lockRes] = await Promise.all([
        opencodeApi.listModels({ maintained: true }),
        opencodeApi.lockedCatalogModels().catch(() => null),
      ]);
      setModels(res.models);
      setSource(res.source);
      if (lockRes) setLockedIds(new Set(lockRes.lockedModels));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Lock key: fully-qualified `providerId||modelId` — same-named models on
   *  different providers lock independently. */
  const rowLockKey = (m: OpenCodeModelView): string => `${m.providerId}||${m.id}`;
  const toggleLock = async (m: OpenCodeModelView) => {
    const key = rowLockKey(m);
    const locked = !lockedIds.has(key);
    try {
      const res = await opencodeApi.toggleCatalogModelLock(key, locked);
      setLockedIds(new Set(res.lockedModels));
      toast.success(locked ? t('models.lockedToast', { id: key }) : t('models.unlockedToast', { id: key }));
      await load(); // aggregation changed — refresh the rendered prices
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  /** Hide / show a model on the CLIENT-facing surfaces.
   *
   *  Writes the OVERRIDE layer (overrides.json) — the model keeps its defs
   *  entry and stays visible here and in the catalog viewer; boot-direct just
   *  leaves it out of the routing pool, so `/v1/models` omits it and no client
   *  request can reach it. The pool is boot-scoped, hence the restart note. */
  const toggleHidden = async (m: OpenCodeModelView) => {
    const hidden = m.disabled !== true;
    try {
      await opencodeApi.putCatalogOverride(m.providerId, m.id, { disabled: hidden });
      await load();
      toast.info(t(hidden ? 'models.hiddenToast' : 'models.shownToast', { id: `${m.providerId}/${m.id}` }));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  const providerOptions = useMemo(() => {
    const map = new Map<string, { id: string; name?: string; connected: boolean; count: number }>();
    for (const m of models) {
      const e = map.get(m.providerId);
      if (e) e.count += 1;
      else map.set(m.providerId, { id: m.providerId, name: m.providerName, connected: m.connected, count: 1 });
    }
    return Array.from(map.values()).sort(
      (a, b) => Number(b.connected) - Number(a.connected) || (a.name || a.id).localeCompare(b.name || b.id)
    );
  }, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = models.filter((m) => {
      if (provider && m.providerId !== provider) return false;
      // flag filter composes with search/provider
      if (onlyLocked && !lockedIds.has(rowLockKey(m))) return false;
      if (onlyHidden && m.disabled !== true) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        m.providerId.toLowerCase().includes(q) ||
        (m.providerName || '').toLowerCase().includes(q)
      );
    });
    const price = (m: OpenCodeModelView) =>
      typeof m.cost?.input === 'number' && m.cost.input >= 0 ? m.cost.input : Infinity;
    switch (sort) {
      case 'priceAsc':
        list = [...list].sort((a, b) => price(a) - price(b));
        break;
      case 'priceDesc':
        list = [...list].sort((a, b) => price(b) - price(a));
        break;
      case 'contextDesc':
        list = [...list].sort((a, b) => (b.limit?.context || 0) - (a.limit?.context || 0));
        break;
      case 'name':
        list = [...list].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        break;
    }
    return list;
  }, [models, query, provider, onlyLocked, onlyHidden, lockedIds, sort]);

  const lockedCount = useMemo(
    () => models.filter((m) => lockedIds.has(rowLockKey(m))).length,
    [models, lockedIds]
  );
  const hiddenCount = useMemo(() => models.filter((m) => m.disabled === true).length, [models]);

  const selectProvider = (id: string) => {
    setProvider(id);
    setPage(1);
    setSearchParams(id ? { provider: id } : {}, { replace: true });
  };

  const pagedModels = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Cpu size={18} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t('models.title')}</span>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '0 0 16px' }}>
          {t('models.desc')}
          {source && <span> · {t('models.source', { source })}</span>}
        </p>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)', color: 'var(--accent-rose)', fontSize: '13px', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {/* ---- Toolbar ---- */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
            <input
              className="input"
              style={{ fontSize: 12, paddingLeft: 30, width: '100%' }}
              placeholder={t('models.search')}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            />
          </div>
          <Combobox
            style={{ fontSize: 12, width: 220, cursor: 'pointer' }}
            value={provider}
            onChange={selectProvider}
            clearable
            options={[
              { value: '', label: t('models.filterAll') },
              ...providerOptions.map((p) => ({
                value: p.id,
                label: p.name || p.id,
                meta: `(${p.count})${p.connected ? '' : ' ·'}`,
              })),
            ]}
          />
          <Combobox
            style={{ fontSize: 12, width: 'auto', cursor: 'pointer' }}
            value={sort}
            onChange={(v) => { setSort(v as SortKey); setPage(1); }}
            options={[
              { value: 'default', label: t('models.sortDefault') },
              { value: 'priceAsc', label: t('models.sortPriceAsc') },
              { value: 'priceDesc', label: t('models.sortPriceDesc') },
              { value: 'contextDesc', label: t('models.sortContextDesc') },
              { value: 'name', label: t('models.sortName') },
            ]}
          />
          <Chip
            label={
              <>
                <Lock size={10} />
                {t('catalogPage.ocrLocked', { n: lockedCount })}
              </>
            }
            pressed={onlyLocked}
            tone="amber"
            title={t('catalogPage.ocrOnlyLockedHint')}
            onToggle={() => { setOnlyLocked((v) => !v); setPage(1); }}
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
            onToggle={() => { setOnlyHidden((v) => !v); setPage(1); }}
          />
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('models.refresh')}</span>
          </button>
        </div>

        {/* ---- Table ---- */}
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
            <thead>
              {/* Integer, multiple-of-4 row heights: at Windows 125%/150%
                  scaling fractional row boundaries make some 1px hairlines
                  land on device-pixel edges (crisp) and some straddle them
                  (blurry) — the alternating sharp/blurry rows reported here. 4 CSS px
                  x 1 / 1.25 / 1.5 are all integers, so every border snaps. */}
              <tr style={{ height: 40 }}>
                <th style={thStyle}>{t('models.thModel')}</th>
                <th style={thStyle}>{t('models.thProvider')}</th>
                <th style={thStyle}>{t('models.thContext')}</th>
                <th style={thStyle}>{t('models.thInput')}</th>
                <th style={thStyle}>{t('models.thOutput')}</th>
                <th style={thStyle}>{t('models.thCapabilities')}</th>
                <th style={thStyle}>{t('models.thSource')}</th>
              </tr>
            </thead>
            <tbody>
              {pagedModels.map((m) => {
                const rowKey = `${m.providerId}/${m.id}`;
                const res = testResults[rowKey];
                return (
                <tr key={rowKey} style={m.disabled === true ? { opacity: 0.5, height: 56 } : { height: 56 }}>
                  <td style={tdStyle}>
                    {(() => {
                      const displayName = m.name || m.id.split('/').pop();
                      // Two-line model cell, unconditionally: display name on the
                      // primary line, the FULL gateway-visible id
                      // (`providerId/modelId` — the registered modelRef) on the
                      // monospace secondary line with its own copy button.
                      // A def whose `name` happens to equal the id (e.g.
                      // `glm-4.6`) is NOT treated as "nameless": branching on
                      // that made row layout depend on cosmetic defs data, so
                      // sibling rows flipped between one and two lines.
                      const mono = FONT_MONO;
                      const copyBtn = (
                        <button
                          style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                          title={t('models.copyFullId')}
                          onClick={async () => {
                            const full = `${m.providerId}/${m.id}`;
                            (await copyToClipboard(full)) ? toast.success(full) : toast.error(t('common.failed'));
                          }}
                        >
                          <Copy size={11} />
                        </button>
                      );
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{displayName}</span>
                            {res && (
                              <span
                                style={{
                                  fontFamily: mono,
                                  fontSize: 10,
                                  whiteSpace: 'nowrap',
                                  color: res.ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                                }}
                                title={res.ok ? `${res.latencyMs} ms` : res.error}
                              >
                                {res.ok ? `✓${fmtLatency(res.latencyMs ?? NaN)}` : '✗'}
                              </span>
                            )}
                            <button
                              style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                              title={testingIds.has(rowKey) ? t('op.testing') : t('op.testBtn')}
                              disabled={isBusy}
                              onClick={() => testOne({ key: rowKey, providerId: m.providerId, modelId: m.id })}
                            >
                              {testingIds.has(rowKey) ? <Loader2 size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={11} />}
                            </button>
                            <button
                              style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0, opacity: m.disabled === true ? 0.6 : 1 }}
                              title={m.disabled === true ? t('models.showInCatalog') : t('models.hideFromCatalog')}
                              disabled={isBusy}
                              onClick={() => void toggleHidden(m)}
                            >
                              {m.disabled === true ? <EyeOff size={11} /> : <Eye size={11} />}
                            </button>
                            {/* editing needs a local def to patch — `m.custom` is a PROVIDER-level flag
                                and would offer the pencil on catalog-filled models, which then
                                fail with "model is not defined for provider". `source === 'config'`
                                is exactly "has a defs-file definition". */}
                            {m.source === 'config' && (
                              <button
                                style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                                title={t('op.pmEdit')}
                                onClick={() => setEditTarget({ providerId: m.providerId, modelId: m.id })}
                              >
                                <Pencil size={11} />
                              </button>
                            )}
                            {m.source === 'config' ? (
                              <button
                                title={lockedIds.has(rowLockKey(m)) ? t('models.unlockHint') : t('models.lockHint')}
                                onClick={() => void toggleLock(m)}
                                style={{
                                  color: lockedIds.has(rowLockKey(m)) ? 'var(--accent-amber)' : 'var(--text-dim)',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: 0,
                                  display: 'inline-flex',
                                  flexShrink: 0,
                                }}
                              >
                                {lockedIds.has(rowLockKey(m)) ? <Lock size={11} /> : <LockOpen size={11} />}
                              </button>
                            ) : (
                              <button
                                title={t('models.lockNeedLocal')}
                                onClick={() => toast.info(t('models.lockNeedLocal'))}
                                style={{ color: 'var(--text-dim)', opacity: 0.55, background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                              >
                                <LockOpen size={11} />
                              </button>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, minWidth: 0 }}>
                            <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>{m.providerId}/{m.id}</span>
                            {copyBtn}
                          </div>
                        </>
                      );
                    })()}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: FONT_MONO, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {m.providerId}
                    {!m.connected && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-dim)' }} title={t('models.notConnected')}>○</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: FONT_MONO, whiteSpace: 'nowrap' }}>{fmtContext(m.limit?.context)}</td>
                  <td style={{ ...tdStyle, fontFamily: FONT_MONO, color: m.cost?.input !== undefined && m.cost.input < 1 ? 'var(--accent-emerald)' : undefined, whiteSpace: 'nowrap' }}>
                    {fmtPrice(m.cost?.input)}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: FONT_MONO, whiteSpace: 'nowrap' }}>{fmtPrice(m.cost?.output)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {m.reasoning && <span style={badgeStyle('var(--hue-violet)', 'var(--hue-violet-soft)')}><Brain size={10} />{t('models.badgeReasoning')}</span>}
                      {m.tool_call && <span style={badgeStyle('var(--accent)', 'var(--accent-bg)')}><Wrench size={10} />{t('models.badgeToolCall')}</span>}
                      {(m.attachment || m.modalities?.input?.includes('image')) && <span style={badgeStyle('var(--hue-emerald)', 'var(--hue-emerald-soft)')}><Eye size={10} />{t('models.badgeVision')}</span>}
                      {m.modalities?.input?.includes('audio') && <span style={badgeStyle('var(--hue-pink)', 'var(--hue-pink-soft)')}><AudioLines size={10} />{t('models.badgeAudio')}</span>}
                      {m.modalities?.input?.includes('video') && <span style={badgeStyle('var(--hue-blue)', 'var(--hue-blue-soft)')}><Video size={10} />{t('models.badgeVideo')}</span>}
                      {m.temperature && <span style={badgeStyle('var(--hue-orange)', 'var(--hue-orange-soft)')}><Thermometer size={10} />{t('models.badgeTemperature')}</span>}
                      {!hasCapability(m) && <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      {m.disabled === true && <span style={badgeStyle('var(--text-dim)', 'var(--chip-bg)')}>{t('models.hiddenBadge')}</span>}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(SOURCE_BADGE[m.source]?.color ?? 'var(--text-dim)', SOURCE_BADGE[m.source]?.bg ?? 'var(--chip-bg)')}>
                      {t(SOURCE_BADGE[m.source]?.labelKey ?? 'models.srcBuiltin')}
                    </span>
                  </td>
                </tr>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>
                    {t('models.empty')}
                    {models.length > 0 && <div style={{ marginTop: 6, fontSize: 11 }}>{t('models.emptyFiltered')}</div>}
                    {/* Empty defs plane: the page is maintained-only, so "no rows"
                        means nothing was pulled yet — send the operator to the
                        page where pulling happens instead of a dead end. */}
                    {models.length === 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 11, marginBottom: 8 }}>{t('models.emptyMaintainHint')}</div>
                        <button className="btn btn-sm" onClick={() => navigate('/providers')}>
                          {t('models.emptyMaintainAction')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>
                    {t('common.loading')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ---- Footer: pagination (summary left, controls right, one row) ---- */}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onChange={setPage}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />

        {editTarget && (
          <ModelEditDialog
            providerId={editTarget.providerId}
            modelId={editTarget.modelId}
            onClose={() => setEditTarget(null)}
            onSaved={load}
          />
        )}
      </div>
    </div>
  );
};
