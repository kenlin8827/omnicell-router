/**
 * Model Marketplace — LocModel-shaped: tabbed front page (curated picks /
 * HuggingFace search), one card per model with a quant dropdown, a
 * hardware-fit speed estimate and a one-click download. The downloaded-file
 * registry is the separate Installed Models page.
 *
 * Row anatomy — recommended tab (4 columns, mirroring the reference product):
 *   [ name + tags + one-liner ] [ quant Combobox + size ] [ speed badge + bar ] [ download ]
 * Search tab rows stay lean like the reference: [ repo ] [ downloads/likes ] [ versions ];
 * expanding a row lazy-loads its GGUF tree and lists versions with speed +
 * download (no eager per-repo probing for search results).
 *
 * The speed column is an estimate, not a benchmark: bytes-touched-per-token
 * (full file, or the MoE active fraction when the repo name carries `NxB-AyB`)
 * over an assumed memory bandwidth (VRAM 250 GB/s, split 110, RAM 50) — enough
 * to rank "smooth / runnable / struggling", labelled as an estimate.
 *
 * Downloads stream with live NDJSON progress (leg `model:<repo>/<filename>`);
 * a cancelled transfer keeps its staged bytes and the next click resumes.
 * The market reads the Hub through the gateway (`HF_ENDPOINT` picks a mirror —
 * hf-mirror.com where the hub is not directly reachable).
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Download, ExternalLink, HardDriveDownload, Loader2, Search, Sparkles } from 'lucide-react';
import {
  api,
  type LocalDetectResponse,
  type LocalHfFileEntry,
  type LocalHfModelSummary,
  type LocalHfSearchResponse,
  type LocalModelDownloadResult,
} from '../lib/api';
import {
  cancelTransfer,
  getTransferSnapshot,
  startTransfer,
  subscribeTransfers,
} from '../lib/transferStore';
import { InfoTip } from '../components/InfoTip';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { SearchInput } from '../components/SearchInput';
import { Chip } from '../components/Chip';
import { Combobox, type ComboboxOption } from '../components/Combobox';

const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

const fmtSize = (bytes: number): string => {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
};

type CatKey = 'chat' | 'code' | 'vision' | 'reasoning';

/**
 * Curated front-page picks — every repo is probed live for its GGUF tree, so
 * the list stays honest when upstream reuploads. One line of zh/en copy each;
 * other locales fall back to en (same policy as the yaml comment panel).
 */
interface CuratedRepo {
  repo: string;
  name: string;
  vendor: string;
  cats: CatKey[];
  desc: { zh: string; en: string };
}

const CAT_KEY: Record<CatKey, string> = { chat: 'catChat', code: 'catCode', vision: 'catVision', reasoning: 'catReasoning' };

/** Category tag color — theme-adaptive accents so both color schemes work. */
const CAT_TAG: Record<CatKey, string> = {
  chat: 'var(--accent-emerald)',
  code: 'var(--accent)',
  vision: 'var(--accent-amber)',
  reasoning: 'var(--accent-violet)',
};

/** Tinted pill tag (bg/border derive from the text color via color-mix). */
const CatTag: React.FC<{ fg: string; label: string }> = ({ fg, label }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 8px',
      borderRadius: 999,
      fontSize: 'var(--text-2xs)',
      fontWeight: 600,
      lineHeight: '1.6',
      color: fg,
      background: `color-mix(in srgb, ${fg} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${fg} 30%, transparent)`,
    }}
  >
    {label}
  </span>
);

const CURATED: CuratedRepo[] = [
  { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', name: 'Qwen3 4B', vendor: 'Qwen', cats: ['chat'], desc: { zh: '中等大小，8G 显存即可流畅对话的甜点款', en: 'Mid-size sweet spot; smooth chat on 8 GB VRAM' } },
  { repo: 'unsloth/Qwen3-8B-GGUF', name: 'Qwen3 8B', vendor: 'Qwen', cats: ['chat'], desc: { zh: '8B 全能款，12G 显存的甜点', en: 'Capable 8B all-rounder; sweet spot at 12 GB' } },
  { repo: 'unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF', name: 'Qwen3.5 30B-A3B', vendor: 'Qwen', cats: ['chat', 'reasoning'], desc: { zh: 'MoE 模型，每次只激活 3B，速度非常快', en: 'MoE with only 3B active per token — very fast' } },
  { repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', name: 'Qwen3 Coder 30B', vendor: 'Qwen', cats: ['code'], desc: { zh: '编程特化 MoE，聚合 30B 激活 3B，编码利器', en: 'Code-tuned MoE: 30B total, 3B active per token' } },
  { repo: 'unsloth/GLM-4.6-GGUF', name: 'GLM-4.6', vendor: '智谱', cats: ['chat', 'code'], desc: { zh: '智谱旗舰，编程和智能体任务强', en: 'Zhipu flagship; strong at coding and agent tasks' } },
  { repo: 'unsloth/gpt-oss-20b-GGUF', name: 'gpt-oss 20B', vendor: 'OpenAI', cats: ['reasoning'], desc: { zh: 'OpenAI 开源 MoE，16G 显存就能流畅跑', en: 'OpenAI open MoE; runs smoothly on 16 GB VRAM' } },
  { repo: 'unsloth/gemma-3-4b-it-GGUF', name: 'Gemma 3 4B', vendor: 'Google', cats: ['chat', 'vision'], desc: { zh: '为笔记本和小显存设计，纯 CPU 也能跑，能看图', en: 'Laptop-friendly; runs on pure CPU and reads images' } },
  { repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF', name: 'Llama 3.2 3B', vendor: 'Meta', cats: ['chat'], desc: { zh: '入门首选，低配电脑也能流畅对话', en: 'Easy entry point; smooth even on modest hardware' } },
  { repo: 'unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF', name: 'DeepSeek-R1 7B', vendor: 'DeepSeek', cats: ['reasoning'], desc: { zh: '推理蒸馏模型，数学与逻辑链强', en: 'Reasoning distill; strong math and chain-of-thought' } },
  { repo: 'unsloth/Qwen2.5-VL-7B-Instruct-GGUF', name: 'Qwen2.5 VL 7B', vendor: 'Qwen', cats: ['vision'], desc: { zh: '视觉理解，看图识文档', en: 'Vision-language; reads images and documents' } },
  { repo: 'unsloth/SmolLM3-3B-GGUF', name: 'SmolLM3 3B', vendor: 'HuggingFace', cats: ['chat'], desc: { zh: '小巧全能，低配电脑友好', en: 'Tiny all-rounder; friendly to low-end machines' } },
];

/** Default-quant preference — Q4_K_M first (the community default), then
 *  4-bit variants, then the fidelity ladder; shards only as last resort. */
const QUANT_PREF = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_XL', 'IQ4_XS', 'Q4_0', 'Q5_K_M', 'Q6_K', 'Q8_0'];

const pickDefaultFile = (files: LocalHfFileEntry[]): string => {
  const whole = files.filter((f) => !/-\d+-of-\d+/.test(f.path));
  const pool = whole.length > 0 ? whole : files;
  for (const quant of QUANT_PREF) {
    const hit = pool.find((f) => (f.quant ?? '').toUpperCase() === quant);
    if (hit) return hit.path;
  }
  const sorted = [...pool].sort((a, b) => a.size - b.size);
  return sorted[Math.floor(sorted.length / 2)]?.path ?? pool[0]?.path ?? '';
};

/** Version-list order: preferred quants first (community defaults on top),
 *  then smallest first within the same tier. */
const versionOrder = (a: LocalHfFileEntry, b: LocalHfFileEntry): number => {
  const rank = (f: LocalHfFileEntry) => {
    const idx = QUANT_PREF.indexOf((f.quant ?? '').toUpperCase());
    return idx === -1 ? QUANT_PREF.length : idx;
  };
  return rank(a) - rank(b) || a.size - b.size;
};

/** MoE active fraction from a repo name (`Qwen3-30B-A3B` → 0.1). */
const activeFraction = (repo: string): number | undefined => {
  const match = /(\d+(?:\.\d+)?)B-A(\d+(?:\.\d+)?)B/i.exec(repo);
  if (!match) return undefined;
  const total = Number(match[1]);
  const active = Number(match[2]);
  return total > 0 && active > 0 && active < total ? active / total : undefined;
};

type TabId = 'recommended' | 'search';

/** "Fits my machine" pill — Chip with a disabled posture (`.chip` has no disabled
 *  state; without a VRAM reading the filter cannot be evaluated, so it renders
 *  inert and the tooltip explains why). */
const FitChip: React.FC<{ pressed: boolean; disabled: boolean; onToggle: () => void; label: string; title?: string }> = ({ pressed, disabled, onToggle, label, title }) =>
  disabled ? (
    <span className="chip" style={{ opacity: 0.5, cursor: 'not-allowed' }} title={title}>
      {label}
    </span>
  ) : (
    <Chip label={label} pressed={pressed} onToggle={onToggle} title={title} />
  );

/**
 * Marketplace browsing place (active tab, open repo detail), kept OUTSIDE the
 * component: live downloads survive navigation at module scope already, and
 * resetting the browsing context under a still-running download made the
 * transfer look orphaned.
 */
let place: { tab: TabId; detailRepo: string | null } = { tab: 'recommended', detailRepo: null };

export const ModelMarketPage: React.FC = () => {
  const { t, lang } = useI18n();
  const toast = useToast();

  // Place state at module scope: downloads already survive navigation
  // (`lib/transferStore`), and coming back to the list while the detail view
  // you were downloading from is gone read as "my download vanished" — the
  // strip showed it, but the context around it was reset.
  const [tab, setTabState] = useState<TabId>(place.tab);
  const setTab = (next: TabId) => { place.tab = next; setTabState(next); };
  const [market, setMarket] = useState<LocalHfSearchResponse | null>(null);
  const [marketQuery, setMarketQuery] = useState('');
  const [marketLoading, setMarketLoading] = useState(false);
  /** Fit + category filter pills (recommended tab; fit-only on search). */
  const [fitOnly, setFitOnly] = useState(false);
  const [cat, setCat] = useState<'all' | CatKey>('all');
  const [tabLoading, setTabLoading] = useState(true);
  /** Repo → GGUF tree cache, shared by both tabs. */
  const [repoFiles, setRepoFiles] = useState<Record<string, { loading: boolean; error?: string; files?: LocalHfFileEntry[] }>>({});
  const inFlight = useRef<Set<string>>(new Set());
  /** Selected quant (file path) per repo. */
  const [selectedFile, setSelectedFile] = useState<Record<string, string>>({});
  /** Repo currently open in the detail view (null = the results list).
   *  Module-backed so a route switch preserves the browsing place. */
  const [detailRepo, setDetailRepoState] = useState<string | null>(place.detailRepo);
  const setDetailRepo = (next: string | null) => { place.detailRepo = next; setDetailRepoState(next); };
  /** Version-filter text inside the detail view. */
  const [fileFilter, setFileFilter] = useState('');
  /** Detection runs once on mount, silently: it feeds fit hints + speed estimates. */
  const [detect, setDetect] = useState<LocalDetectResponse | null>(null);

  // Live transfer view state lives at module scope (`lib/transferStore`), so a
  // route switch neither cancels a download nor loses its progress bar.
  const transfers = useSyncExternalStore(subscribeTransfers, getTransferSnapshot);
  /** The downloads-in-flight strip starts expanded; the operator can fold
   *  it away, and a NEWLY started download re-opens it so a fresh task is
   *  never hidden. */
  const [stripOpen, setStripOpen] = useState(true);
  const prevStripLegs = useRef(0);
  const stripLegCount = Object.keys(transfers).filter((leg) => leg.startsWith('model:')).length;
  useEffect(() => {
    if (stripLegCount > prevStripLegs.current) setStripOpen(true);
    prevStripLegs.current = stripLegCount;
  }, [stripLegCount]);

  /** Fetch one repo's GGUF tree once; concurrent callers share the flight. */
  const loadRepoFiles = useCallback(async (repo: string) => {
    if (inFlight.current.has(repo)) return;
    inFlight.current.add(repo);
    setRepoFiles((prev) => ({ ...prev, [repo]: { loading: true } }));
    try {
      const data = await api.getHfModelFiles(repo);
      setRepoFiles((prev) => ({
        ...prev,
        [repo]: { loading: false, files: data.files.filter((f) => f.path.toLowerCase().endsWith('.gguf')) },
      }));
    } catch (err) {
      setRepoFiles((prev) => ({ ...prev, [repo]: { loading: false, error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      inFlight.current.delete(repo);
    }
  }, []);

  /** Open the repo detail view (`localModels.viewVersions`); entering lazy-loads the tree once. */
  const openRepo = useCallback((repo: string) => {
    setDetailRepo(repo);
    setFileFilter('');
    void loadRepoFiles(repo);
  }, [loadRepoFiles]);

  const runSearch = useCallback(async (query: string) => {
    setMarketLoading(true);
    setMarket(null); // drop the previous result list while the new one loads
    try {
      setMarket(await api.searchHfModels(query));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setMarketLoading(false);
    }
  }, [toast]);

  const runDetect = useCallback(async () => {
    try {
      setDetect(await api.detectLocalDependencies());
    } catch {
      // Fit hints are optional; a failed probe just hides the badges.
    }
  }, []);

  useEffect(() => {
    void runDetect();
    void runSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recommended tab: probe every curated repo up-front so each card shows its
  // quant dropdown immediately.
  useEffect(() => {
    setTabLoading(true);
    void Promise.all(CURATED.map((c) => loadRepoFiles(c.repo))).finally(() => setTabLoading(false));
  }, [loadRepoFiles]);

  const vramBudget = detect?.report.vramMb != null ? detect.report.vramMb * 1_048_576 * 0.92 : null;

  /** Hardware-fit bucket for one file; null when the probe is missing. */
  const fitLevel = (bytes: number): 'gpu' | 'split' | 'ram' | null => {
    if (vramBudget == null) return null;
    if (bytes <= vramBudget) return 'gpu';
    if (bytes <= vramBudget * 2.4) return 'split';
    return 'ram';
  };

  /** Rough tokens/s for one file on this machine (see header comment). */
  const speedFor = (repo: string, file: LocalHfFileEntry): { tps: number; badge: 'smooth' | 'run' | 'slow' } | null => {
    const fit = fitLevel(file.size);
    if (!fit) return null;
    let bandwidth = 50; // GB/s — dual-channel system RAM ballpark
    if (fit === 'gpu') bandwidth = 250; // VRAM ballpark
    else if (fit === 'split') bandwidth = 110;
    const frac = activeFraction(repo);
    const touchedGB = Math.max(0.3, (file.size * (frac ?? 1)) / 1e9);
    const tps = Math.max(1, Math.round(bandwidth / touchedGB));
    return { tps, badge: tps >= 12 ? 'smooth' : tps >= 4 ? 'run' : 'slow' };
  };

  /** Files visible under the current `localModels.fitOnly` filter. */
  const visibleFiles = useCallback(
    (files: LocalHfFileEntry[]): LocalHfFileEntry[] =>
      fitOnly && vramBudget != null ? files.filter((f) => (fitLevel(f.size) ?? 'ram') !== 'ram') : files,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fitOnly, vramBudget],
  );

  /** Stream one GGUF file down (leg `model:<repo>/<filename>`). The loop runs
   *  at module scope — route switches never touch it; only the Cancel button
   *  or closing the app stops it (staged bytes persist either way). */
  const downloadModel = (repo: string, file: LocalHfFileEntry) => {
    const leg: `model:${string}` = `model:${repo}/${file.path}`;
    const parts = file.parts && file.parts.length > 1 ? file.parts : null;
    void startTransfer(leg, {
      initial: { stage: 'download', asset: file.path, downloaded: 0, total: file.size, assetIndex: 1, assetTotal: parts?.length ?? 1 },
      request: (signal, onEvent) => parts
        ? api.downloadHfModelGroup(repo, parts, { signal, onEvent })
        : api.downloadHfModel(repo, file.path, {
          signal,
          // The tree API's LFS digest: the gateway verifies the finished file
          // before it becomes a registry row.
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
          ...(file.size > 0 ? { size: file.size } : {}),
          onEvent,
        }),
      onOk: (result: LocalModelDownloadResult) => {
        if (result.status === 'ok') toast.success(t('localModels.modelDownloadDone'));
        else if (result.code === 'download-aborted') toast.info(t('localModels.installCancelled'));
        else toast.error(result.error || t('localModels.modelDownloadFailed'));
      },
      onCancelled: () => toast.info(t('localModels.installCancelled')),
      onError: (message) => toast.error(message),
    });
  };

  /** Download / progress column — shared by every row shape. */
  const renderDownloadCell = (repo: string, file: LocalHfFileEntry) => {
    const leg: `model:${string}` = `model:${repo}/${file.path}`;
    const entry = transfers[leg];
    const run = entry?.phase === 'active' ? entry.run : undefined;
    if (!run) {
      return (
        <button className="btn btn-sm btn-primary" style={{ minWidth: 92, justifyContent: 'center' }} onClick={() => downloadModel(repo, file)}>
          <Download size={13} />
          <span>{t('localModels.modelDownload')}</span>
        </button>
      );
    }
    const pct = run.total > 0 ? Math.min(100, Math.floor((run.downloaded / run.total) * 100)) : 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>{pct}%</span>
          <button className="btn btn-sm" onClick={() => cancelTransfer(leg)}>
            {t('common.cancel')}
          </button>
        </div>
        <div style={{ height: 3, borderRadius: 999, background: 'var(--divider)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' }} />
        </div>
      </div>
    );
  };

  /** Speed column: fit/speed badge + estimate bar + `~N tok/s` readout. */
  const renderSpeedCell = (repo: string, file: LocalHfFileEntry) => {
    const speed = speedFor(repo, file);
    if (!speed) return <div style={{ width: 150, flexShrink: 0 }} />;
    const badge =
      speed.badge === 'smooth' ? { cls: 'badge badge-success', key: 'localModels.speedSmooth' }
      : speed.badge === 'run' ? { cls: 'badge badge-warning', key: 'localModels.speedRunnable' }
      : { cls: 'badge', key: 'localModels.speedStruggling' };
    const pct = Math.min(100, Math.round((speed.tps / 50) * 100));
    return (
      <div style={{ width: 150, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={badge.cls}>{t(badge.key)}</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
            {t('localModels.estSpeed', { n: speed.tps })}
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 999, background: 'var(--divider)', overflow: 'hidden' }}>
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 999,
              background: speed.badge === 'smooth' ? 'var(--badge-success-text, var(--accent))' : speed.badge === 'run' ? 'var(--accent-amber)' : 'var(--text-dim)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>
    );
  };

  /** Quant dropdown (selection carries its own size label), the row's second column. */
  const renderQuantCell = (repo: string, files: LocalHfFileEntry[]) => {
    const options: ComboboxOption[] = files.map((f) => ({
      value: f.path,
      label: f.quant ?? f.path,
      meta: `${fmtSize(f.size)}${f.shardCount != null && f.shardCount > 1 ? ` · ${t('localModels.shardBadge', { n: f.shardCount })}` : ''}`,
    }));
    const chosen = selectedFile[repo] && files.some((f) => f.path === selectedFile[repo])
      ? selectedFile[repo]
      : pickDefaultFile(files);
    return (
      <div style={{ width: 200, flexShrink: 0 }}>
        <Combobox
          options={options}
          value={chosen}
          onChange={(value) => setSelectedFile((prev) => ({ ...prev, [repo]: value }))}
          style={{ fontSize: 'var(--text-sm)', height: 30 }}
        />
      </div>
    );
  };

  /** The one card layout both tabs render: info | quant | speed | download. */
  const renderModelRow = (repo: string, name: string, metaLine: React.ReactNode, badges: React.ReactNode, files: LocalHfFileEntry[] | undefined, filesError: string | undefined) => {
    const shown = files ? visibleFiles(files) : undefined;
    if (files && shown && shown.length === 0) return null; // filtered out entirely
    const chosenPath = selectedFile[repo] && shown?.some((f) => f.path === selectedFile[repo])
      ? selectedFile[repo]
      : shown && shown.length > 0 ? pickDefaultFile(shown) : undefined;
    const chosenFile = shown?.find((f) => f.path === chosenPath);
    return (
      <div className="sub-card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{name}</span>
            {badges}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {metaLine}
          </div>
        </div>
        {files && shown && shown.length > 0 && (
          <>
            {renderQuantCell(repo, shown)}
            {chosenFile && renderSpeedCell(repo, chosenFile)}
            {chosenFile && renderDownloadCell(repo, chosenFile)}
          </>
        )}
        {!files && (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            {filesError ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent-amber)' }}>
                <span>{t('localModels.loadFailed')}</span>
                <InfoTip text={filesError} variant="warning" />
              </span>
            ) : (
              <><Loader2 size={12} style={SPIN} /><span>{t('localModels.filesLoading')}</span></>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderRecommended = () => {
    const descLang: 'zh' | 'en' = lang === 'zh' ? 'zh' : 'en';
    const rows = CURATED.filter((c) => cat === 'all' || c.cats.includes(cat));
    const anyVisible = rows.some((c) => {
      const state = repoFiles[c.repo];
      if (!state?.files) return true; // still loading — keep the slot
      return visibleFiles(state.files).length > 0;
    });
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FitChip label={t('localModels.fitOnly')} pressed={fitOnly} disabled={vramBudget == null} onToggle={() => setFitOnly((v) => !v)} title={vramBudget == null ? t('localModels.noGpu') : undefined} />
          <span style={{ width: 1, height: 16, background: 'var(--divider)' }} />
          {(['all', 'chat', 'code', 'vision', 'reasoning'] as const).map((key) => (
            <Chip
              key={key}
              label={key === 'all' ? t('localModels.catAll') : t(`localModels.${CAT_KEY[key]}`)}
              pressed={cat === key}
              onToggle={() => setCat(key)}
            />
          ))}
        </div>
        {tabLoading && rows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            <Loader2 size={12} style={SPIN} />
            <span>{t('localModels.filesLoading')}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((c) => {
            const state = repoFiles[c.repo];
            const metaLine = (
              <>
                {c.vendor} · {c.desc[descLang]}
                <span style={{ opacity: 0.7 }}> · {c.repo}</span>
              </>
            );
            const badges = (
              <>
                {c.cats.map((k) => (
                  <CatTag key={k} fg={CAT_TAG[k]} label={t(`localModels.${CAT_KEY[k]}`)} />
                ))}
              </>
            );
            return renderModelRow(c.repo, c.name, metaLine, badges, state?.files, state?.error);
          })}
        </div>
        {!anyVisible && !tabLoading && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.marketEmpty')}</div>
        )}
      </>
    );
  };

  /** One lean search-result row: repo name | downloads/likes | `localModels.viewVersions`. */
  const renderSearchRow = (model: LocalHfModelSummary) => (
    <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 4px', borderBottom: '1px solid var(--divider)' }}>
      <span
        title={model.id}
        style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--text-sm)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {model.id}
        {model.gated && (
          <span className="badge badge-warning" style={{ fontSize: 'var(--text-2xs)', marginLeft: 8 }}>gated</span>
        )}
      </span>
      <span style={{ flexShrink: 0, width: 240, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
        {t('localModels.downloadsLabel')} {model.downloads.toLocaleString('en-US')} · {t('localModels.likesLabel')} {model.likes.toLocaleString('en-US')}
      </span>
      <button className="btn btn-sm" style={{ flexShrink: 0, minWidth: 92, justifyContent: 'center' }} onClick={() => openRepo(model.id)}>
        {t('localModels.viewVersions')}
      </button>
    </div>
  );

  /** One version row in the detail view: quant title over filename | size |
   *  speed estimate | download — the reference product's detail anatomy. */
  const renderVersionRow = (repo: string, file: LocalHfFileEntry, last: boolean) => (
    <div key={file.path} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 0', borderBottom: last ? 'none' : '1px solid var(--divider)' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {file.quant ?? t('localModels.quantOther')}
          {file.shardCount != null && file.shardCount > 1 && (
            <span className="badge" style={{ fontSize: 'var(--text-2xs)', marginLeft: 8 }}>
              {t('localModels.shardBadge', { n: file.shardCount })}
            </span>
          )}
        </span>
        <span title={file.path} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {file.path.slice(file.path.lastIndexOf('/') + 1)}
        </span>
      </div>
      <span style={{ flexShrink: 0, width: 90, fontSize: 'var(--text-sm)', color: 'var(--text-main)', fontVariantNumeric: 'tabular-nums' }}>
        {fmtSize(file.size)}
      </span>
      {renderSpeedCell(repo, file)}
      {renderDownloadCell(repo, file)}
    </div>
  );

  /** The view `localModels.viewVersions` opens (like the reference product): back bar + repo
   *  header with stats, then one card listing every GGUF version. */
  const renderRepoDetail = (repo: string) => {
    const state = repoFiles[repo];
    const files = state?.files;
    const summary = market?.models.find((m) => m.id === repo);
    const sorted = files ? [...files].sort(versionOrder) : [];
    // Version filter: match against the whole path (covers quant tags and,
    // in multi-model collections, the per-model folder names).
    const needle = fileFilter.trim().toLowerCase();
    const matched = needle ? sorted.filter((f) => f.path.toLowerCase().includes(needle)) : sorted;
    // Multi-model collections (files spread across top-level folders, e.g.
    // audio.cpp-gguf's per-model dirs) group by folder so the repeated quant
    // labels stop reading as noise; single-model repos stay one flat list.
    const grouped = matched.some((f) => f.path.includes('/'));
    const groups = new Map<string, LocalHfFileEntry[]>();
    for (const file of matched) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      const bucket = groups.get(dir);
      if (bucket) bucket.push(file);
      else groups.set(dir, [file]);
    }
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => { setDetailRepo(null); setFileFilter(''); }}>
            <ArrowLeft size={13} />
            <span>{t('localModels.detailBack')}</span>
          </button>
          <span
            title={repo}
            style={{ fontSize: 'var(--text-base)', fontWeight: 700, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {repo}
          </span>
          <a
            href={`${market?.endpoint ?? 'https://huggingface.co'}/${repo}`}
            target="_blank"
            rel="noreferrer"
            title={repo}
            style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-dim)', flexShrink: 0 }}
          >
            <ExternalLink size={14} />
          </a>
          {summary?.gated && <span className="badge badge-warning" style={{ fontSize: 'var(--text-2xs)' }}>gated</span>}
        </div>
        {summary && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
            {t('localModels.downloadsLabel')} {summary.downloads.toLocaleString('en-US')} · {t('localModels.likesLabel')} {summary.likes.toLocaleString('en-US')}
          </div>
        )}
        {sorted.length > 0 && (
          <SearchInput
            value={fileFilter}
            onChange={setFileFilter}
            placeholder={t('localModels.filterVersions')}
            style={{ flex: '0 0 auto' }}
          />
        )}
        {sorted.length > 0 && matched.length === 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.filesNoMatch')}</div>
        )}
        {state?.error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
            <span>{t('localModels.loadFailed')}</span>
            <InfoTip text={state.error} variant="warning" />
          </div>
        )}
        {!files && !state?.error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            <Loader2 size={12} style={SPIN} />
            <span>{t('localModels.filesLoading')}</span>
          </div>
        )}
        {files && files.length === 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.filesNone')}</div>
        )}
        {matched.length > 0 && !grouped && (
          <div className="sub-card" style={{ padding: '4px 16px' }}>
            {matched.map((file, i) => renderVersionRow(repo, file, i === matched.length - 1))}
          </div>
        )}
        {matched.length > 0 && grouped && (
          <>
            {[...groups.entries()].map(([dir, entries]) => (
              <div key={dir || '_root'} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dir && (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700 }}>{dir}</span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{entries.length}</span>
                  </div>
                )}
                <div className="sub-card" style={{ padding: '4px 16px' }}>
                  {entries.map((file, i) => renderVersionRow(repo, file, i === entries.length - 1))}
                </div>
              </div>
            ))}
          </>
        )}
      </>
    );
  };

  const renderSearch = () =>
    detailRepo ? (
      renderRepoDetail(detailRepo)
    ) : (
      <>
        <div
          style={{ display: 'flex', gap: 10, alignItems: 'center' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !marketLoading) void runSearch(marketQuery);
          }}
        >
          <SearchInput value={marketQuery} onChange={setMarketQuery} placeholder={t('localModels.marketSearchPlaceholder')} />
          <button
            className="btn btn-primary"
            style={{ height: 36, minWidth: 84, justifyContent: 'center', flexShrink: 0 }}
            onClick={() => void runSearch(marketQuery)}
            disabled={marketLoading}
          >
            {marketLoading ? <Loader2 size={14} style={SPIN} /> : <Search size={14} />}
            <span>{t('localModels.searchAction')}</span>
          </button>
        </div>
        {marketLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '18px 4px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
            <Loader2 size={14} style={SPIN} />
            <span>{t('localModels.searching')}</span>
          </div>
        )}
        {market?.message && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{market.message}</div>
        )}
        {!marketLoading && (market?.models ?? []).length > 0 && (
          <div style={{ borderTop: '1px solid var(--divider)' }}>
            {(market?.models ?? []).map(renderSearchRow)}
          </div>
        )}
        {market && market.models.length === 0 && !market.message && !marketLoading && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.marketEmpty')}</div>
        )}
      </>
    );

  const tabs: { id: TabId; label: string }[] = [
    { id: 'recommended', label: t('localModels.tabRecommended') },
    { id: 'search', label: t('localModels.tabSearch') },
  ];

  /** Aggregated downloads-in-flight strip: every in-flight marketplace download pinned in
   *  one place, visible from both tabs AND the repo detail view — a download
   *  started in one repo's rows should not vanish when the operator drills
   *  into another. Entries self-clear shortly after they settle. */
  const renderTransferStrip = () => {
    const rows = Object.entries(transfers).filter(([leg]) => leg.startsWith('model:'));
    if (rows.length === 0) return null;
    return (
      <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
        <button
          type="button"
          onClick={() => setStripOpen((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)', alignSelf: 'flex-start' }}
          aria-expanded={stripOpen}
        >
          {stripOpen ? <ChevronDown size={13} style={{ color: 'var(--text-dim)' }} /> : <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />}
          <HardDriveDownload size={13} style={{ color: 'var(--text-dim)' }} />
          <span>{t('downloads.title')}</span>
          <span className="badge" style={{ fontSize: 'var(--text-2xs)', background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
            {rows.filter(([, entry]) => entry.phase === 'active').length}
          </span>
        </button>
        {stripOpen && rows.map(([leg, entry]) => {
          const run = entry.phase === 'active' ? entry.run : undefined;
          const pct = run && run.total > 0 ? Math.min(100, Math.floor((run.downloaded / run.total) * 100)) : 0;
          const name = leg.slice('model:'.length).split('/').pop() || leg;
          const stateText = entry.phase === 'ok' ? t('localModels.modelDownloadDone')
            : entry.phase === 'cancelled' ? t('localModels.installCancelled')
              : entry.phase === 'error' ? entry.error || t('localModels.modelDownloadFailed')
                : run && run.total > 0 ? t('localModels.installingPct', { pct }) : t('localModels.installing');
          return (
            <div key={leg} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-xs)', fontWeight: 500 }} title={leg}>
                  {name}
                </span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  {run && run.downloaded > 0 ? `${fmtSize(run.downloaded)}${run.total > 0 ? ` / ${fmtSize(run.total)}` : ''}` : stateText}
                </span>
                {entry.phase === 'active' ? (
                  <button className="btn btn-sm" onClick={() => cancelTransfer(leg)}>{t('common.cancel')}</button>
                ) : (
                  <span style={{ fontSize: 'var(--text-xs)', color: entry.phase === 'ok' ? 'var(--accent-emerald)' : entry.phase === 'error' ? 'var(--accent-rose)' : 'var(--text-dim)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stateText}
                  </span>
                )}
              </div>
              {entry.phase === 'active' && (
                <div style={{ height: 3, borderRadius: 999, background: 'var(--divider)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' }} />
                </div>
              )}
              {entry.phase === 'error' && entry.error && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)', overflowWrap: 'anywhere' }}>{entry.error}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{t('localModels.marketTitle')}</span>
            {market?.endpoint && (
              <span className="badge" style={{ fontSize: 'var(--text-2xs)', background: 'var(--chip-bg)', color: 'var(--text-dim)' }} title={t('localModels.marketSource')}>
                {market.endpoint.replace(/^https?:\/\//, '')}
              </span>
            )}
          </div>
          {detect && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              <Sparkles size={12} style={{ color: 'var(--accent-amber)' }} />
              {detect.report.gpus.length > 0 ? detect.report.gpus[0] : t('localModels.noGpu')}
              {detect.report.vramMb ? ` · VRAM ${detect.report.vramMb >= 1024 ? `${(detect.report.vramMb / 1024).toFixed(1)} GB` : `${detect.report.vramMb} MB`}` : ''}
            </span>
          )}
        </div>

        {renderTransferStrip()}

        <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--divider)' }}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: `2px solid ${tab === item.id ? 'var(--accent)' : 'transparent'}`,
                padding: '6px 2px',
                marginBottom: -1,
                fontSize: 'var(--text-sm)',
                fontWeight: tab === item.id ? 600 : 400,
                color: tab === item.id ? 'var(--text-main)' : 'var(--text-dim)',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'recommended' && renderRecommended()}
        {tab === 'search' && renderSearch()}
        </div>
      </div>
    </div>
  );
};
