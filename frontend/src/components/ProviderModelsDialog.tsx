import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Download, Eye, EyeOff, Pencil, Check, X, Eraser, Loader2, AudioLines, Video, Thermometer, Wand2, Zap, Search } from 'lucide-react';
import { opencodeApi, type OpenCodeModelView } from '../lib/api';
import { matchCatalogModel, catalogAutofillPatch, detectEffortLevel } from '../lib/catalogAutofill';
import { effortOptionList } from '../lib/effort';
import { modalityLabel } from '../lib/modality';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { useModelTest } from '../lib/useModelTest';
import { Combobox } from '../components/Combobox';
import { Switch } from './Switch';

/** Backdrop blur is opt-in per dialog (default: dim only, no blur). */
const overlayStyle = (blur: boolean): React.CSSProperties => ({
  position: 'fixed',
  inset: 0,
  zIndex: 200,
  background: 'var(--scrim)',
  backdropFilter: blur ? 'blur(8px)' : undefined,
  display: 'flex',
  overflowY: 'auto',
  padding: '16px',
  animation: 'ocr-fade-in 0.15s ease',
});

const dialogStyle: React.CSSProperties = {
  margin: 'auto',
  width: '100%',
  maxWidth: 680,
  maxHeight: '85vh',
  overflow: 'hidden', // inner regions scroll; header/actions stay pinned
  padding: '20px',
  boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  animation: 'ocr-pop-in 0.18s ease',
};

const formOverlayStyle = (blur: boolean): React.CSSProperties => ({ ...overlayStyle(blur), zIndex: 210 });

const formDialogStyle: React.CSSProperties = {
  ...dialogStyle,
  maxWidth: 520,
};

/** Scrollable body region between a pinned header and pinned footer. */
const formBodyStyle: React.CSSProperties = {
  overflowY: 'auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  paddingRight: 2,
};

const formFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  paddingTop: 10,
  borderTop: '1px solid var(--divider)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  // Transparent rows + hairline separators (list-group): gray pill-per-row
  // stacked on the white dialog read as heavy blocks ("abrupt").
  fontSize: 11.5,
  cursor: 'default',
};

// Outline badges: transparent fill, border derived from the text hue (the
// bg param is legacy at call sites — kept for signature stability).
const badge = (color: string, _bg: string): React.CSSProperties => ({
  color,
  background: 'transparent',
  border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
  fontSize: 9.5,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 99,
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
});

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-dim)',
  display: 'block',
  marginBottom: 4,
};

const SOURCE_BADGE: Record<string, { color: string; bg: string; labelKey: string }> = {
  opencode: { color: 'var(--accent)', bg: 'var(--accent-bg)', labelKey: 'models.srcOpencode' },
  'models-dev': { color: 'var(--hue-blue)', bg: 'var(--hue-blue-soft)', labelKey: 'models.srcModelsDev' },
  openrouter: { color: 'var(--hue-violet)', bg: 'var(--hue-violet-soft)', labelKey: 'models.srcOpenrouter' },
  config: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', labelKey: 'models.srcConfig' },
  custom: { color: 'var(--hue-emerald)', bg: 'var(--hue-emerald-soft)', labelKey: 'models.srcCustom' },
  mapped: { color: '#c084fc', bg: 'rgba(192,132,252,0.12)', labelKey: 'models.srcMapped' },
  'openai-compatible': { color: 'var(--text-dim)', bg: 'var(--chip-bg)', labelKey: 'models.srcOpenaiCompatible' },
  service: { color: 'var(--text-dim)', bg: 'var(--chip-bg)', labelKey: 'models.srcService' },
};

const MODALITY_OPTIONS = ['text', 'image', 'audio', 'video', 'pdf'] as const;
// Effort dropdown options come from lib/effort.ts (single source of truth):
// 6-level ladder + a UI "unset" sentinel, labels rendered as
// `<wire> (<localized>)` so users see the protocol token they will send
// on the wire, with a short hint in their language.

const fmtContext = (n?: number): string => {
  if (!n || n <= 0) return '';
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000)}K`;
};

const fmtPrice = (v?: number): string => (typeof v === 'number' && v >= 0 ? `$${v.toFixed(2)}` : '—');

// -- v1/v2 definition readers -------------------------------------------------

const defTools = (d: any): boolean => d?.capabilities?.tools ?? d?.tool_call === true;
const defInput = (d: any): string[] => d?.capabilities?.input ?? d?.modalities?.input ?? [];
const defOutput = (d: any): string[] => d?.capabilities?.output ?? d?.modalities?.output ?? [];
const defThinking = (d: any): boolean =>
  d?.reasoning === true || Boolean(d?.settings?.reasoningEffort) || (Array.isArray(d?.variants) && d.variants.length > 0);
const defVision = (d: any): boolean => d?.attachment === true || defInput(d).includes('image');
const defAudio = (d: any): boolean => defInput(d).includes('audio');
const defVideo = (d: any): boolean => defInput(d).includes('video');

// -- form state ----------------------------------------------------------------

interface VariantRow {
  id: string;
  effort: string;
}

interface ModelFormState {
  id: string;
  name: string;
  modelID: string;
  disabled: boolean;
  tools: boolean;
  inputMod: string[];
  outputMod: string[];
  contextLimit: string;
  outputLimit: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  reasoningEffort: string;
  headersText: string;
  bodyText: string;
  reasoningField: string;
  variants: VariantRow[];
}

const emptyForm: ModelFormState = {
  id: '',
  name: '',
  modelID: '',
  disabled: false,
  tools: false,
  inputMod: ['text'],
  outputMod: ['text'],
  contextLimit: '',
  outputLimit: '',
  reasoningEffort: '',
  headersText: '',
  bodyText: '',
  reasoningField: '',
  costInput: '',
  costOutput: '',
  costCacheRead: '',
  costCacheWrite: '',
  variants: [],
};

interface PullPreview {
  matched: number;
  pullable: number;
  models: OpenCodeModelView[];
}

/** Normalized list row — raw definition (v1 or v2 shape) + provenance. */
interface ModelRow {
  id: string;
  def: any;
  source?: string;
}

export const ProviderModelsDialog: React.FC<{
  providerId: string;
  providerName?: string;
  readOnly?: boolean;
  blur?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}> = ({ providerId, providerName, readOnly = false, blur = false, onClose, onChanged }) => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  useBodyScrollLock(true);

  const [rows, setRows] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;

  const [pattern, setPattern] = useState('');
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [form, setForm] = useState<{ mode: 'add' | 'edit'; data: ModelFormState } | null>(null);
  const [hover, setHover] = useState<{ row: ModelRow; top: number; left: number } | null>(null);
  const { testingIds, testResults, testAll, testOne, testAllTargets } = useModelTest();

  const load = async () => {
    setLoading(true);
    try {
      if (readOnly) {
        const res = await opencodeApi.listModels({ provider: providerId });
        setRows(
          res.models
            .map((m) => ({
              id: m.id,
              def: m as any, // full catalog view (OpenCode schema)
              source: m.source,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
        );
      } else {
        // raw opencode.jsonc definitions — v1 or v2 shape, kept verbatim
        const res = await opencodeApi.listProviderModels(providerId);
        setRows(
          Object.entries(res.models || {})
            .map(([id, d]: [string, any]) => ({ id, def: d || {}, source: 'config' }))
            .sort((a, b) => a.id.localeCompare(b.id))
        );
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Local view-only filter — never mutates `rows`; the upstream "Test All"
  // button keeps targeting the full set so its semantics stay "all models of
  // this provider", independent of what the user has typed in the filter.
  const filterText = filter.trim().toLowerCase();
  const filteredRows = filterText
    ? rows.filter((row) => {
        const d = row.def || {};
        const name = (d.name || row.id.split('/').pop() || '').toLowerCase();
        return row.id.toLowerCase().includes(filterText) || name.includes(filterText);
      })
    : rows;

  const run = (action: string, fn: () => Promise<void>) => {
    setPending(action);
    (async () => {
      try {
        await fn();
      } catch (err: any) {
        toast.error(`Failed: ${err.message}`);
      } finally {
        setPending(null);
      }
    })();
  };

  /** Batch probe every listed model — confirmation above 20 real requests lives in useModelTest. */
  const handleTestAll = () =>
    testAllTargets(rows.map((row) => ({ key: row.id, providerId, modelId: row.id })));

  const refreshAll = async () => {
    await load();
    onChanged?.();
  };

  const openAdd = () => setForm({ mode: 'add', data: { ...emptyForm, tools: true } });

  const [filling, setFilling] = useState(false);

  /** Auto-fill blank form fields from the best catalog match (never overwrites entered values). */
  const handleAutofill = async () => {
    if (!form) return;
    const f = form.data;
    const want = f.modelID.trim() || f.id.trim();
    if (!want) {
      toast.info(t('op.pmAutofillNoId'));
      return;
    }
    setFilling(true);
    try {
      const hit = await matchCatalogModel(providerId, f.modelID, f.id);
      if (!hit) {
        toast.info(t('op.pmAutofillNone', { id: want }));
        return;
      }
      const m = hit.model;
      const p = catalogAutofillPatch(m);
      const effort = detectEffortLevel([f.modelID, f.id]);
      setForm((prev) => {
        if (!prev) return prev;
        const d = { ...prev.data };
        const isDefaultMod = (a: string[]) => a.length === 1 && a[0] === 'text';
        if (!d.name && p.name) d.name = p.name;
        if (!d.contextLimit && p.contextLimit) d.contextLimit = p.contextLimit;
        if (!d.outputLimit && p.outputLimit) d.outputLimit = p.outputLimit;
        if (!d.costInput && p.costInput) d.costInput = p.costInput;
        if (!d.costOutput && p.costOutput) d.costOutput = p.costOutput;
        if (!d.costCacheRead && p.costCacheRead) d.costCacheRead = p.costCacheRead;
        if (!d.costCacheWrite && p.costCacheWrite) d.costCacheWrite = p.costCacheWrite;
        // add-mode tools=true is just a preset — catalog capability is authoritative;
        // in edit mode the user's toggle is intentional and stays untouched
        if (prev.mode === 'add' && p.tools != null) d.tools = p.tools;
        if (isDefaultMod(d.inputMod) && p.inputMod) d.inputMod = [...p.inputMod];
        if (isDefaultMod(d.outputMod) && p.outputMod) d.outputMod = [...p.outputMod];
        // reasoning effort encoded in the id itself ('...-high') — fill when unset
        if (!d.reasoningEffort && effort) d.reasoningEffort = effort;
        return { ...prev, data: d };
      });
      const matchedId = `${m.providerId}/${m.id}`;
      toast.success(
        hit.alternatives > 1
          ? t('op.pmAutofillAmbiguous', { n: hit.alternatives, id: matchedId })
          : t('op.pmAutofillMatched', { id: matchedId })
      );
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setFilling(false);
    }
  };

  const openEdit = (row: ModelRow) => {
    const d = row.def || {};
    setForm({
      mode: 'edit',
      data: {
        id: row.id,
        name: d.name || '',
        modelID: d.modelID || '',
        disabled: d.disabled === true,
        tools: defTools(d),
        inputMod: defInput(d).length ? [...defInput(d)] : ['text'],
        outputMod: defOutput(d).length ? [...defOutput(d)] : ['text'],
        contextLimit: d.limit?.context ? String(d.limit.context) : '',
        outputLimit: d.limit?.output ? String(d.limit.output) : '',
        costInput: typeof d.cost?.input === 'number' ? String(d.cost.input) : '',
        costOutput: typeof d.cost?.output === 'number' ? String(d.cost.output) : '',
        costCacheRead: typeof d.cost?.cache_read === 'number' ? String(d.cost.cache_read) : '',
        costCacheWrite: typeof d.cost?.cache_write === 'number' ? String(d.cost.cache_write) : '',
        reasoningEffort: d.settings?.reasoningEffort || '',
        headersText: Object.entries(d.headers || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
        bodyText: d.body && Object.keys(d.body).length > 0 ? JSON.stringify(d.body, null, 2) : '',
        reasoningField: d.compatibility?.reasoningField || '',
        variants: Array.isArray(d.variants)
          ? d.variants.map((v: any) => ({ id: v.id || '', effort: v.settings?.reasoningEffort || '' }))
          : [],
      },
    });
  };

  const handleFormSave = () =>
    run('save', async () => {
      if (!form) return;
      const f = form.data;
      // full-definition editor: composite fields are always sent so emptying
      // one clears it; absent keys keep their old values on PATCH
      const payload: any = {
        name: f.name.trim() || undefined,
        modelID: f.modelID.trim() || undefined,
        disabled: f.disabled,
        capabilities: { tools: f.tools, input: f.inputMod, output: f.outputMod },
        settings: f.reasoningEffort ? { reasoningEffort: f.reasoningEffort } : {},
        headersText: f.headersText,
        bodyText: f.bodyText,
        compatibility: f.reasoningField.trim() ? { reasoningField: f.reasoningField.trim() } : {},
        variants: f.variants.filter((v) => v.id.trim()).map((v) => ({ id: v.id.trim(), settings: v.effort ? { reasoningEffort: v.effort } : undefined })),
        contextLimit: f.contextLimit ? Number(f.contextLimit) : undefined,
        outputLimit: f.outputLimit ? Number(f.outputLimit) : undefined,
      };
      // cost ($/1M): always sent — the backend treats a present `cost` key as
      // full replace, so blanking a field clears the stored value. Invalid
      // input (non-numeric / negative) is dropped, i.e. treated as blank.
      const cost: Record<string, number> = {};
      const costNum = (s: string): number | undefined => {
        const t = s.trim();
        if (!t) return undefined;
        const n = Number(t);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const cIn = costNum(f.costInput);
      const cOut = costNum(f.costOutput);
      const cRead = costNum(f.costCacheRead);
      const cWrite = costNum(f.costCacheWrite);
      if (cIn !== undefined) cost.input = cIn;
      if (cOut !== undefined) cost.output = cOut;
      if (cRead !== undefined) cost.cache_read = cRead;
      if (cWrite !== undefined) cost.cache_write = cWrite;
      payload.cost = cost;
      if (!payload.capabilities.tools && payload.capabilities.input.length === 0 && payload.capabilities.output.length === 0) {
        payload.capabilities = {};
      }
      try {
        if (f.bodyText.trim()) JSON.parse(f.bodyText);
      } catch {
        toast.error(t('op.pmBodyInvalid'));
        return;
      }
      if (form.mode === 'add') {
        if (!f.id.trim()) return;
        await opencodeApi.addProviderModel(providerId, { id: f.id.trim(), ...payload });
      } else {
        await opencodeApi.updateProviderModel(providerId, f.id, payload);
      }
      setForm(null);
      setHover(null);
      await refreshAll();
    });

  /** Hide / show a model in the catalog. Writes the OVERRIDE layer
   *  (overrides.json) — the single writer of the flag, shared with the model
   *  list rows, so what either surface shows is what the routing pool does. */
  const handleToggleHidden = (mid: string, hidden: boolean) =>
    run('toggle-hidden', async () => {
      await opencodeApi.putCatalogOverride(providerId, mid, { disabled: hidden });
      await refreshAll();
      // The catalog store rebuilds immediately, but the ROUTING pool is built
      // at boot — without this note the row looks hidden while the model keeps
      // serving until a restart.
      toast.info(t(hidden ? 'models.hiddenToast' : 'models.shownToast', { id: `${providerId}/${mid}` }));
    });

  const handleDelete = async (mid: string) => {
    const ok = await confirmDialog({
      title: t('op.pmDeleteConfirm', { id: mid }),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    run('delete', async () => {
      await opencodeApi.deleteProviderModel(providerId, mid);
      await refreshAll();
    });
  };

  const handlePreview = () =>
    run('preview', async () => {
      const res = await opencodeApi.pullProviderModels(providerId, { pattern: pattern.trim() || undefined, dryRun: true });
      setPreview({
        matched: res.matched || 0,
        pullable: res.pullable || 0,
        models: (res.models as OpenCodeModelView[]) || [],
      });
    });

  const handlePull = () =>
    run('pull', async () => {
      const res = await opencodeApi.pullProviderModels(providerId, { pattern: pattern.trim() || undefined });
      const pulled = (res.models as string[])?.length || 0;
      if (res.hint === 'not-in-catalog' && pulled === 0) {
        toast.error(t('op.pmNotInCatalog'));
        return;
      }
      toast.success(t('op.pmPulled', { n: pulled, s: res.skipped || 0 }));
      setPreview(null);
      await refreshAll();
    });

  const handleClear = async () => {
    const p = pattern.trim();
    const message = p
      ? t('op.pmClearPatternConfirm', { id: providerId, pattern: p })
      : t('op.pmClearAllConfirm', { id: providerId });
    const ok = await confirmDialog({
      title: message,
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    run('clear', async () => {
      const res = await opencodeApi.clearProviderModels(providerId, p || undefined);
      toast.success(t('op.pmCleared', { n: res.removed || 0 }));
      setPreview(null);
      await refreshAll();
    });
  };

  const showHoverCard = (row: ModelRow, e: React.MouseEvent) => {
    if (form) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cardWidth = 320;
    const left = rect.right + 10 + cardWidth > window.innerWidth ? rect.left - cardWidth - 10 : rect.right + 10;
    setHover({ row, top: Math.max(8, Math.min(rect.top, window.innerHeight - 300)), left });
  };

  const sourceLabel = (id?: string): string => (id ? (SOURCE_BADGE[id] ? t(SOURCE_BADGE[id].labelKey) : id) : '');
  const spin: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

  const modalityChecks = (
    key: 'inputMod' | 'outputMod'
  ) => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {MODALITY_OPTIONS.map((m) => (
        <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
          <input
            type="checkbox"
            checked={form!.data[key].includes(m)}
            onChange={(e) =>
              setForm({
                ...form!,
                data: {
                  ...form!.data,
                  [key]: e.target.checked ? [...form!.data[key], m] : form!.data[key].filter((x) => x !== m),
                },
              })
            }
          />
          {modalityLabel(t, m)}
        </label>
      ))}
    </div>
  );

  // Close on backdrop click only when BOTH press and release happen on the
  // overlay itself — a click that starts inside the dialog and ends on the
  // overlay (text-selection drag) must not dismiss it.
  const mouseDownOnOverlay = React.useRef(false);

  return createPortal(
    <div
      style={overlayStyle(blur)}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" onClick={(e) => e.stopPropagation()} style={dialogStyle}>
        {/* ---- Header ---- */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t(readOnly ? 'op.pmView' : 'op.pmTitle')}</span>
          <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--accent)' }}>{providerName || providerId}</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {filterText
              ? `${filteredRows.length} / ${rows.length}`
              : t('op.modelsCount', { n: rows.length })}
          </span>
          {loading && rows.length > 0 && <Loader2 size={12} style={{ ...spin, color: 'var(--text-dim)' }} />}
          <button
            className="btn btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px', marginLeft: 'auto' }}
            disabled={testAll.running || testingIds.size > 0 || rows.length === 0}
            title={t('op.testAllBtn')}
            onClick={handleTestAll}
          >
            {testAll.running ? <Loader2 size={11} style={spin} /> : <Zap size={11} />}
            <span>{testAll.running ? t('op.testAllRunning', { done: testAll.done, n: testAll.total }) : t('op.testAllBtn')}</span>
          </button>
          <button className="btn btn-sm" style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 6px' }} onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        {/* ---- Filter ---- */}
        {rows.length > 0 && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search
              size={11}
              style={{ position: 'absolute', left: 8, color: 'var(--text-dim)', pointerEvents: 'none' }}
            />
            <input
              className="input"
              style={{ fontSize: 11.5, padding: '4px 24px 4px 24px', width: '100%' }}
              placeholder={t('op.pmFilterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                title={t('common.clear')}
                style={{
                  position: 'absolute',
                  right: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        )}

        {/* ---- Model list ---- */}
        {rows.length === 0 ? (
          <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            {loading ? t('common.loading') : t('op.pmEmpty')}
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            {t('op.pmNoMatch')}
          </div>
        ) : (
          <div
            className="list-group"
            style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', overflowY: 'auto', opacity: loading ? 0.55 : 1, transition: 'opacity 0.15s ease' }}
            onScroll={() => setHover(null)}
          >
            {filteredRows.map((row) => {
              const d = row.def || {};
              const effort = d.settings?.reasoningEffort;
              return (
                <div
                  key={row.id}
                  className="list-row"
                  style={{ ...rowStyle, opacity: d.disabled === true ? 0.45 : 1 }}
                  onMouseEnter={(e) => showHoverCard(row, e)}
                  onMouseLeave={() => setHover(null)}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontWeight: 600, wordBreak: 'break-all' }}>{row.id}</span>
                  {d.modelID && d.modelID !== row.id && <span style={{ color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: 10 }}>→ {d.modelID}</span>}
                  {(d.name || row.id.split('/').pop()) && <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name || row.id.split('/').pop()}</span>}
                  {defThinking(d) && <span style={badge('var(--hue-violet)', 'var(--hue-violet-soft)')} title={t('models.badgeReasoning')}>{effort ? `R·${effort}` : 'R'}</span>}
                  {defTools(d) && <span style={badge('var(--accent)', 'var(--accent-bg)')} title={t('models.badgeToolCall')}>T</span>}
                  {defVision(d) && <span style={badge('var(--hue-emerald)', 'var(--hue-emerald-soft)')} title={t('models.badgeVision')}><Eye size={9} /></span>}
                  {defAudio(d) && <span style={badge('var(--hue-pink)', 'var(--hue-pink-soft)')} title={t('models.badgeAudio')}><AudioLines size={9} /></span>}
                  {defVideo(d) && <span style={badge('var(--hue-blue)', 'var(--hue-blue-soft)')} title={t('models.badgeVideo')}><Video size={9} /></span>}
                  {d.temperature === true && <span style={badge('var(--hue-orange)', 'var(--hue-orange-soft)')} title={t('models.badgeTemperature')}><Thermometer size={9} /></span>}
                  {Array.isArray(d.variants) && d.variants.length > 0 && (
                    <span style={badge('#e879f9', 'rgba(232,121,249,0.12)')} title={t('op.pmVariants')}>#{d.variants.length}</span>
                  )}
                  {d.disabled === true && <span style={badge('var(--text-dim)', 'var(--chip-bg)')}>{t('models.hiddenBadge')}</span>}
                  {row.source && <span style={badge(SOURCE_BADGE[row.source]?.color ?? 'var(--text-dim)', SOURCE_BADGE[row.source]?.bg ?? 'var(--chip-bg)')}>{sourceLabel(row.source)}</span>}
                  {d.limit?.context ? <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-dim)', marginLeft: 'auto' }}>{fmtContext(d.limit.context)}</span> : null}
                  {testResults[row.id] && (
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                        fontSize: 10,
                        whiteSpace: 'nowrap',
                        color: testResults[row.id].ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                        marginLeft: d.limit?.context ? 0 : 'auto',
                      }}
                      title={testResults[row.id].ok ? `${testResults[row.id].latencyMs} ms` : testResults[row.id].error}
                    >
                      {testResults[row.id].ok ? `✓${testResults[row.id].latencyMs}ms` : '✗'}
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 4, marginLeft: d.limit?.context || testResults[row.id] ? 0 : 'auto' }}>
                    <button
                      className="btn btn-sm btn-icon"
                      title={t('op.testBtn')}
                      disabled={testingIds.size > 0 || testAll.running}
                      onClick={() => testOne({ key: row.id, providerId, modelId: row.id })}
                    >
                      {testingIds.has(row.id) ? <Loader2 size={11} style={spin} /> : <Zap size={11} />}
                    </button>
                    {!readOnly && (
                      <>
                        <button
                          className="btn btn-sm btn-icon"
                          style={d.disabled === true ? { color: 'var(--text-dim)' } : undefined}
                          title={d.disabled === true ? t('models.showInCatalog') : t('models.hideFromCatalog')}
                          onClick={() => handleToggleHidden(row.id, d.disabled !== true)}
                          disabled={busy || testingIds.size > 0 || testAll.running}
                        >
                          {d.disabled === true ? <EyeOff size={11} /> : <Eye size={11} />}
                        </button>
                        <button className="btn btn-sm btn-icon" title={t('op.pmEdit')} onClick={() => openEdit(row)} disabled={busy}>
                          <Pencil size={11} />
                        </button>
                        <button className="btn btn-sm btn-icon" style={{ color: 'var(--accent-rose)' }} onClick={() => handleDelete(row.id)} disabled={busy || testingIds.size > 0 || testAll.running}>
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ---- Actions ---- */}
        {!readOnly && (
          <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={openAdd}>
              <Plus size={11} />
              <span>{t('op.pmAdd')}</span>
            </button>
            <input className="input" style={{ fontSize: 11.5, flex: 1, minWidth: 180 }} placeholder={t('op.pmPattern')} value={pattern} onChange={(e) => { setPattern(e.target.value); setPreview(null); }} />
            <button className="btn btn-sm" disabled={busy} onClick={handlePreview} title={t('op.pmPreview')}>
              {pending === 'preview' ? <Loader2 size={11} style={spin} /> : <Eye size={11} />}
              <span>{t('op.pmPreview')}</span>
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handlePull} title={t('op.pmPull')}>
              {pending === 'pull' ? <Loader2 size={11} style={spin} /> : <Download size={11} />}
              <span>{pending === 'pull' ? t('common.loading') : t('op.pmPull')}</span>
            </button>
            <button className="btn btn-sm" style={{ color: 'var(--accent-rose)' }} disabled={busy || rows.length === 0} onClick={handleClear} title={t('op.pmClear')}>
              {pending === 'clear' ? <Loader2 size={11} style={spin} /> : <Eraser size={11} />}
              <span>{t('op.pmClear')}</span>
            </button>
          </div>

          {preview && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 8px', borderRadius: 6, background: 'var(--well-bg)' }}>
              <div style={{ marginBottom: 4 }}>
                {t('op.pmMatched', { matched: preview.matched, pullable: preview.pullable })}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 90, overflowY: 'auto' }}>
                {preview.models.slice(0, 40).map((m) => (
                  <span key={m.id} style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--chip-bg)' }}>
                    {m.id}
                  </span>
                ))}
                {preview.models.length > 40 && <span>+{preview.models.length - 40}…</span>}
              </div>
            </div>
          )}
          </>
        )}
      </div>

      {/* ---- Hover card ---- */}
      {hover && !form && createPortal(
        <div
          style={{
            position: 'fixed',
            top: hover.top,
            left: hover.left,
            zIndex: 220,
            width: 320,
            maxHeight: 300,
            overflowY: 'auto',
            padding: '12px 14px',
            borderRadius: 10,
            background: 'var(--card-bg, #111113)',
            border: '1px solid var(--card-border)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
            fontSize: 11,
            pointerEvents: 'none',
            animation: 'ocr-fade-in 0.12s ease',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const d = hover.row.def || {};
            return (
              <>
                <div style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontWeight: 700, fontSize: 11.5, wordBreak: 'break-all', marginBottom: 2 }}>
                  {hover.row.id}
                  {d.disabled === true && <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> (disabled)</span>}
                </div>
                {(d.name || hover.row.id.split('/').pop()) && <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{d.name || hover.row.id.split('/').pop()}</div>}
                {d.modelID && (
                  <div style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-dim)', fontSize: 10.5, marginBottom: 6 }}>
                    modelID → {d.modelID}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                  {defThinking(d) && <span style={badge('var(--hue-violet)', 'var(--hue-violet-soft)')}>{t('models.badgeReasoning')}{d.settings?.reasoningEffort ? `·${d.settings.reasoningEffort}` : ''}</span>}
                  {defTools(d) && <span style={badge('var(--accent)', 'var(--accent-bg)')}>{t('models.badgeToolCall')}</span>}
                  {defVision(d) && <span style={badge('var(--hue-emerald)', 'var(--hue-emerald-soft)')}>{t('models.badgeVision')}</span>}
                  {defAudio(d) && <span style={badge('var(--hue-pink)', 'var(--hue-pink-soft)')}>{t('models.badgeAudio')}</span>}
                  {defVideo(d) && <span style={badge('var(--hue-blue)', 'var(--hue-blue-soft)')}>{t('models.badgeVideo')}</span>}
                  {d.temperature === true && <span style={badge('var(--hue-orange)', 'var(--hue-orange-soft)')}>{t('models.badgeTemperature')}</span>}
                  {hover.row.source && <span style={badge(SOURCE_BADGE[hover.row.source]?.color ?? 'var(--text-dim)', SOURCE_BADGE[hover.row.source]?.bg ?? 'var(--chip-bg)')}>{sourceLabel(hover.row.source)}</span>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', color: 'var(--text-dim)' }}>
                  <span>{t('models.thContext')}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{d.limit?.context ? fmtContext(d.limit.context) : '—'}</span>
                  <span>{t('op.pmEditOutput')}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{d.limit?.output ? fmtContext(d.limit.output) : '—'}</span>
                  <span>{t('models.thInput')}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{fmtPrice(d.cost?.input)}</span>
                  <span>{t('models.thOutput')}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{fmtPrice(d.cost?.output)}</span>
                  {typeof d.cost?.cache_read === 'number' && (<><span>{t('models.costCacheRead')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{fmtPrice(d.cost.cache_read)}</span></>)}
                  {typeof d.cost?.cache_write === 'number' && (<><span>{t('models.costCacheWrite')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{fmtPrice(d.cost.cache_write)}</span></>)}
                  {defInput(d).length > 0 && (<><span>{t('models.modalitiesInput')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{defInput(d).map((m) => modalityLabel(t, m)).join(', ')}</span></>)}
                  {defOutput(d).length > 0 && (<><span>{t('models.modalitiesOutput')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{defOutput(d).map((m) => modalityLabel(t, m)).join(', ')}</span></>)}
                  {d.settings?.reasoningEffort && (<><span>{t('op.pmSettingsReasoning')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{d.settings.reasoningEffort}</span></>)}
                  {d.compatibility?.reasoningField && (<><span>{t('op.pmReasoningField')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>{d.compatibility.reasoningField}</span></>)}
                  {Object.keys(d.headers || {}).length > 0 && (<><span>{t('op.pmHeaders')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)', wordBreak: 'break-all' }}>{Object.entries(d.headers).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span></>)}
                  {d.body && Object.keys(d.body).length > 0 && (<><span>{t('op.pmBody')}</span><span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)', wordBreak: 'break-all' }}>{JSON.stringify(d.body)}</span></>)}
                  {Array.isArray(d.variants) && d.variants.length > 0 && (
                    <>
                      <span>{t('op.pmVariants')}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-main)' }}>
                        {d.variants.map((v: any) => `${v.id}${v.settings?.reasoningEffort ? `(${v.settings.reasoningEffort})` : ''}`).join(', ')}
                      </span>
                    </>
                  )}
                </div>
              </>
            );
          })()}
        </div>,
        document.body
      )}

      {/* ---- Nested add/edit form dialog (opencode v2 model editor) ---- */}
      {form && (
        <div onClick={() => setForm(null)} style={formOverlayStyle(blur)}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={formDialogStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>
                {form.mode === 'add' ? t('op.pmAddTitle') : t('op.pmEditTitle')}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  title={t('op.pmAutofillTip')}
                  disabled={filling}
                  onClick={handleAutofill}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px' }}
                >
                  {filling ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Wand2 size={12} />}
                  <span style={{ fontSize: 11 }}>{t('op.pmAutofill')}</span>
                </button>
                <button className="btn btn-sm" style={{ padding: '3px 6px' }} onClick={() => setForm(null)}>
                  <X size={12} />
                </button>
              </div>
            </div>

            <div style={formBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmAddId')}</label>
                <input
                  className="input"
                  style={{ fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", width: '100%', opacity: form.mode === 'edit' ? 0.6 : 1 }}
                  value={form.data.id}
                  disabled={form.mode === 'edit'}
                  onChange={(e) => setForm({ ...form, data: { ...form.data, id: e.target.value } })}
                  autoFocus={form.mode === 'add'}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmModelID')}</label>
                <input
                  className="input"
                  style={{ fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", width: '100%' }}
                  placeholder="gpt-5.2"
                  value={form.data.modelID}
                  onChange={(e) => setForm({ ...form, data: { ...form.data, modelID: e.target.value } })}
                />
              </div>
            </div>

            <div>
              <label style={fieldLabelStyle}>{t('op.pmEditName')}</label>
              <input
                className="input"
                style={{ fontSize: 12, width: '100%' }}
                value={form.data.name}
                onChange={(e) => setForm({ ...form, data: { ...form.data, name: e.target.value } })}
                onKeyDown={(e) => e.key === 'Enter' && handleFormSave()}
              />
            </div>

            {/* capabilities */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <Switch size="sm" checked={form.data.tools} onChange={(v) => setForm({ ...form, data: { ...form.data, tools: v } })} />
                {t('models.badgeToolCall')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <Switch size="sm" checked={form.data.disabled} onChange={(v) => setForm({ ...form, data: { ...form.data, disabled: v } })} />
                {t('op.pmDisabled')}
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center' }}>
          <span style={fieldLabelStyle}>{t('models.modalitiesInput')}</span>
          {modalityChecks('inputMod')}
          <span style={fieldLabelStyle}>{t('models.modalitiesOutput')}</span>
          {modalityChecks('outputMod')}
            </div>

            {/* limit */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmEditContext')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="200000" value={form.data.contextLimit} onChange={(e) => setForm({ ...form, data: { ...form.data, contextLimit: e.target.value } })} />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmEditOutput')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="64000" value={form.data.outputLimit} onChange={(e) => setForm({ ...form, data: { ...form.data, outputLimit: e.target.value } })} />
              </div>
            </div>

            {/* pricing ($/1M) — feeds tiering & FinOps cost calc via the daemon sync */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmCostInput')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.00" value={form.data.costInput} onChange={(e) => setForm({ ...form, data: { ...form.data, costInput: e.target.value } })} />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmCostOutput')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="15.00" value={form.data.costOutput} onChange={(e) => setForm({ ...form, data: { ...form.data, costOutput: e.target.value } })} />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmCostCacheRead')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="0.30" value={form.data.costCacheRead} onChange={(e) => setForm({ ...form, data: { ...form.data, costCacheRead: e.target.value } })} />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmCostCacheWrite')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.75" value={form.data.costCacheWrite} onChange={(e) => setForm({ ...form, data: { ...form.data, costCacheWrite: e.target.value } })} />
              </div>
            </div>

            {/* thinking level */}
            <div>
              <label style={fieldLabelStyle}>{t('op.pmSettingsReasoning')}</label>
              <Combobox
                style={{ fontSize: 12, width: '100%', cursor: 'pointer' }}
                value={form.data.reasoningEffort}
                onChange={(v) => setForm({ ...form, data: { ...form.data, reasoningEffort: v } })}
                options={effortOptionList(t)}
              />
            </div>

            {/* variants */}
            <div>
              <label style={fieldLabelStyle}>{t('op.pmVariants')}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {form.data.variants.map((v, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      style={{ fontSize: 11.5, flex: 1, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}
                      placeholder="variant-id"
                      value={v.id}
                      onChange={(e) => {
                        const variants = [...form.data.variants];
                        variants[i] = { ...v, id: e.target.value };
                        setForm({ ...form, data: { ...form.data, variants } });
                      }}
                    />
                    <Combobox
                      style={{ fontSize: 11.5, width: 110, cursor: 'pointer' }}
                      value={v.effort}
                      options={effortOptionList(t)}
                      onChange={(effort) => {
                        const variants = [...form.data.variants];
                        variants[i] = { ...v, effort };
                        setForm({ ...form, data: { ...form.data, variants } });
                      }}
                    />
                    <button className="btn btn-sm" style={{ padding: '3px 6px' }} onClick={() => setForm({ ...form, data: { ...form.data, variants: form.data.variants.filter((_, j) => j !== i) } })}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setForm({ ...form, data: { ...form.data, variants: [...form.data.variants, { id: '', effort: '' }] } })}
                >
                  <Plus size={11} />
                  <span>{t('op.pmAdd')}</span>
                </button>
              </div>
            </div>

            {/* compatibility / headers / body */}
            <div>
              <label style={fieldLabelStyle}>{t('op.pmReasoningField')}</label>
              <input
                className="input"
                style={{ fontSize: 12, width: '100%', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}
                placeholder="reasoning_content"
                list="ocr-thinking-fields"
                value={form.data.reasoningField}
                onChange={(e) => setForm({ ...form, data: { ...form.data, reasoningField: e.target.value } })}
              />
              <datalist id="ocr-thinking-fields">
                <option value="reasoning" />
                <option value="reasoning_content" />
                <option value="reasoning_text" />
              </datalist>
            </div>
            <div>
              <label style={fieldLabelStyle}>{t('op.pmHeaders')}</label>
              <textarea
                className="input"
                style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", resize: 'vertical' }}
                placeholder={'X-Team: platform'}
                value={form.data.headersText}
                onChange={(e) => setForm({ ...form, data: { ...form.data, headersText: e.target.value } })}
              />
            </div>
            <div>
              <label style={fieldLabelStyle}>{t('op.pmBody')}</label>
              <textarea
                className="input"
                style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", resize: 'vertical' }}
                placeholder={'{ "store": false }'}
                value={form.data.bodyText}
                onChange={(e) => setForm({ ...form, data: { ...form.data, bodyText: e.target.value } })}
              />
            </div>
            </div>

            <div style={formFooterStyle}>
              <button className="btn" onClick={() => setForm(null)}>
                {t('op.pmCancel')}
              </button>
              <button className="btn btn-primary" disabled={busy || (form.mode === 'add' && !form.data.id.trim())} onClick={handleFormSave}>
                {pending === 'save' ? <Loader2 size={12} style={spin} /> : <Check size={12} />}
                <span>{t('op.pmSave')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
