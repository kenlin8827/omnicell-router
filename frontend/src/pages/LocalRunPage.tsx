/**
 * Local Run console — the launch page for one local model.
 *
 * Left: a machine snapshot that collapses to one line and expands to the
 * free VRAM/RAM bars, then the auto-tiering plan. Free memory never rewrites
 * the plan.
 * The plan bars are the launch (`-ngl`, `-c`). Right: launch options (engine+target
 * pick among the installed builds, context ladder with the planner's auto
 * pick, thinking mode, acceleration toggles, LAN access) and the start/stop
 * button. Live runs sit in a strip above the picker: the name selects that
 * model, Stop ends the run. Once the selected run is ready, gateway usage
 * (model id, cURL, direct endpoint) opens from a one-line button into a
 * dialog so the launch card stays short.
 *
 * The page polls `/runs` while a launch is starting or serving and `/logs`
 * while the log drawer is open. A model preselected on the Installed page
 * arrives as `?model=<id>`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useOutletContext } from 'react-router-dom';
import {
  BrainCircuit, ChevronDown, ChevronRight, Copy, Cpu, FolderCog, Gauge, Hammer, HardDrive,
  MemoryStick, Microchip,
  Image as ImageIcon, Loader2, Play, ScrollText, Square, Zap,
} from 'lucide-react';
import {
  api,
  type GatewayStatusResponse,
  type LocalBuildJob,
  type LocalEngineCatalogRow,
  type LocalEnginesResponse,
  type LocalInstalledModel,
  type LocalPlanResponse,
  type LocalRun,
  type LocalRunLogLine,
  type LocalRunStats,
  type LocalRunsResponse,
} from '../lib/api';
import { gatewayBaseUrl } from '../lib/gateway-url';
import { fmtLatency, formatSpeed } from '../lib/format';
import { engineProfileOf, hasEngineProfile } from '../lib/local-profile';
import { localModelDisplayName, localModelGatewayId } from '../lib/local-model';
import { localBuildErrorMessage, localRunErrorMessage, localRunStatusLabel } from '../lib/local-run-error';
import { LOCAL_CTX_LADDER } from '../lib/defaults';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { SegGroup } from '../components/SegGroup';
import { EngineProfileFields } from '../components/EngineProfileFields';
import { ModelFamilyLogo } from '../components/ModelFamilyLogo';

const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

const fmtGB = (bytes: number): string => `${(bytes / 1_073_741_824).toFixed(1)} GB`;
const fmtCtxK = (ctx: number): string => (ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx));
/** Directory half of a model path, for the "model files" readout. */
const dirOf = (filePath: string): string => filePath.replace(/[\\/][^/\\]+$/, '');

/**
 * One selectable engine install: engine id + build target (llama.cpp · Vulkan).
 * `blocked` carries the ENGINE's own refusal (ADR-0039) — the console never
 * decides why an engine cannot serve a file, it renders the verdict.
 */
interface EngineChoice {
  engine: string;
  target: string;
  backend: string;
  label: string;
}

/** Section caption row (mirrors the engines page's sectionTitle). */
const sectionTitle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 'var(--text-sm)', fontWeight: 600,
};

/** One residency bar of the plan panel (GPU / RAM / disk). */
const PlanBar: React.FC<{
  label: string;
  used: string;
  detail?: string;
  ratio: number;
  tone: 'gpu' | 'ram' | 'disk';
  /** Inside the machine card the sub-card chrome would double up. */
  plain?: boolean;
}> = ({ label, used, detail, ratio, tone, plain }) => {
  const color = tone === 'gpu' ? 'var(--accent)' : tone === 'ram' ? 'var(--accent-emerald)' : 'var(--text-dim)';
  return (
    <div className={plain ? undefined : 'sub-card'} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: plain ? 0 : '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--text-xs)' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{label}</span>
        <span style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{used}</span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: 'var(--divider)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
      </div>
      {detail ? (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{detail}</div>
      ) : null}
    </div>
  );
};

/** A labelled switch row (thinking mode / LAN access / the acceleration toggles). */
const ToggleRow: React.FC<{
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}> = ({ label, hint, on, onChange, disabled }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-main)' }}>{label}</span>
      {hint && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{hint}</span>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        flexShrink: 0, width: 38, height: 22, borderRadius: 999, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'var(--accent)' : 'var(--divider)', position: 'relative', transition: 'background 0.15s ease',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%',
          background: 'var(--bg-card, #fff)', transition: 'left 0.15s ease',
        }}
      />
    </button>
  </div>
);

export const LocalRunPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  // The gateway's listen port, for the ready-state gateway snippet (the same
  // outlet context ApiKeysPage builds its quick-connect URLs from).
  const { status } = useOutletContext<{ status: GatewayStatusResponse | null }>();

  const [models, setModels] = useState<LocalInstalledModel[]>([]);
  const [engines, setEngines] = useState<LocalEnginesResponse | null>(null);
  const [runs, setRuns] = useState<LocalRun[]>([]);
  /** Per-run throughput keyed by run id (ADR-0040). Absent = no counters yet
   *  (a fresh run, or a gateway without the monitor route) — the card then
   *  renders without the strip rather than showing zeros as if it were idle. */
  const [runStats, setRunStats] = useState<Map<string, LocalRunStats>>(new Map());
  const [loading, setLoading] = useState(true);

  const [modelId, setModelId] = useState(params.get('model') ?? '');
  const [enginePick, setEnginePick] = useState(''); // `engine:target`
  const [ctxPick, setCtxPick] = useState<number>(0); // 0 = auto
  const [nglPick, setNglPick] = useState<number>(-1); // -1 = auto
  const [thinking, setThinking] = useState(false);
  const [flashAttn, setFlashAttn] = useState(true);
  const [kvQ8, setKvQ8] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  // The resource switch: true = leave room for the desktop (the planner's
  // default budget), false = full performance. Re-plans live like every knob.
  const [headroom, setHeadroom] = useState(true);
  /** Bumped after a capability switch (spec/vision) writes the profile, so
   *  the plan — and with it the engine's declaration chips — re-resolves. */
  const [planNonce, setPlanNonce] = useState(0);
  const [threads, setThreads] = useState(0);
  const [extraArgs, setExtraArgs] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** Machine card opens on the free bars; collapsing leaves icon chips. */
  const [showMachine, setShowMachine] = useState(true);
  const [showAccel, setShowAccel] = useState(false);
  /** Gateway usage (model id, cURL, direct endpoint) stays in a dialog. */
  const [showGateway, setShowGateway] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LocalRunLogLine[]>([]);
  const [builds, setBuilds] = useState<LocalBuildJob[]>([]);
  const [showBuildLogs, setShowBuildLogs] = useState(false);
  const [buildLogLines, setBuildLogLines] = useState<LocalRunLogLine[]>([]);
  const [plan, setPlan] = useState<LocalPlanResponse | null>(null);
  const [planError, setPlanError] = useState('');
  const [starting, setStarting] = useState(false);
  /** Engine id whose in-flight build should chain into a launch (the operator
   *  clicked "build & run" — ADR-0039 §9). */
  const buildThenRunRef = useRef<string | null>(null);
  /** Engine id waiting for its verdict to flip to runnable before starting. */
  const [pendingAutoStart, setPendingAutoStart] = useState<string | null>(null);

  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  /** Runnable engine installs for the selected model, one entry per build. */
  const engineChoices: EngineChoice[] = useMemo(() => {
    if (!engines || !selectedModel) return [];
    const out: EngineChoice[] = [];
    for (const engine of engines.engines) {
      // Install-only catalog entries are never run targets.
      if (!engine.runtime) continue;
      if (selectedModel.meta?.engines?.[engine.id]?.serves !== true) continue;
      for (const install of engine.installs) {
        const target = engine.targets.find((item) => item.id === install.target);
        out.push({
          engine: engine.id,
          target: install.target,
          backend: target?.backend ?? 'cpu',
          label: `${engine.name} · ${target?.label ?? install.target}`,
        });
      }
    }
    return out;
  }, [engines, selectedModel]);

  /**
   * Installed engines that CANNOT launch this model, one row per engine. They
   * stay visible because the refusal is information: "not this family" is why
   * an installed engine is missing from the picker, and "no profile yet" is the
   * one block the operator can clear from this page (ADR-0038 §4).
   */
  const blockedEngines = useMemo(() => {
    if (!engines || !selectedModel) return [];
    const out: Array<{ id: string; name: string; reason: string; needsSetup: boolean; buildable: boolean }> = [];
    for (const engine of engines.engines) {
      if (!engine.runtime || engine.installs.length === 0) continue;
      const verdict = selectedModel.meta?.engines?.[engine.id];
      if (!verdict || verdict.serves) continue;
      if (!verdict.family && !verdict.needsSetup && !verdict.buildable) continue;
      out.push({
        id: engine.id,
        name: engine.name,
        reason: verdict.reason ?? '',
        needsSetup: verdict.needsSetup === true,
        buildable: verdict.buildable === true,
      });
    }
    return out;
  }, [engines, selectedModel]);

  const launchableChoices = engineChoices;
  const choice = launchableChoices.find((c) => `${c.engine}:${c.target}` === enginePick) ?? launchableChoices[0] ?? null;

  const catalogOf = useCallback(
    (engineId: string | undefined): LocalEngineCatalogRow | null =>
      (engineId ? engines?.engines.find((e) => e.id === engineId) : null) ?? null,
    [engines]
  );

  /**
   * The engine whose launch profile the drawer renders (ADR-0039): the picked
   * engine when it takes one, otherwise the first installed engine whose gate
   * says "profile missing" — that is the one case the operator cannot select,
   * so hiding its form would leave them with no way to unblock it.
   */
  const profileEngine = useMemo<LocalEngineCatalogRow | null>(() => {
    if (!engines || !selectedModel) return null;
    const picked = catalogOf(choice?.engine);
    if (picked?.runtime?.profile) return picked;
    for (const engine of engines.engines) {
      if (!engine.runtime?.profile) continue;
      if (selectedModel.meta?.engines?.[engine.id]?.needsSetup) return engine;
    }
    return null;
  }, [engines, selectedModel, choice?.engine, catalogOf]);

  /** The picked engine's runtime info (control gating lives in this block). */
  const activeRuntime = catalogOf(choice?.engine)?.runtime ?? null;

  /** Active run of the selected model (latest first from the backend). */
  const activeRun: LocalRun | null = useMemo(
    () => runs.find((r) => r.modelId === modelId && (r.status === 'starting' || r.status === 'ready' || r.status === 'stopping')) ?? null,
    [runs, modelId],
  );

  /** The run the log drawer shows: the live one, else the model's latest run
   *  whatever its status — a FAILED launch keeps its engine log viewable
   *  (the in-memory ring survives the failure; only a gateway restart or an
   *  explicit prune drops it). */
  const drawerRun: LocalRun | null = useMemo(
    () => activeRun ?? runs.find((r) => r.modelId === modelId) ?? null,
    [runs, modelId, activeRun],
  );

  const refreshRuns = useCallback(async () => {
    try {
      const data: LocalRunsResponse = await api.listLocalRuns();
      setRuns(data.runs);
    } catch {
      // A transient poll failure keeps the previous view.
    }
  }, []);

  /** Live throughput for the run cards (ADR-0040). The counters live behind
   *  `/monitor`; fetching them here is what keeps the operator from having to
   *  go FIND the monitor page to see whether a model is actually serving. */
  const refreshStats = useCallback(async () => {
    try {
      const data = await api.getLocalMonitor();
      setRunStats(new Map(data.runs.map((row) => [row.run.id, row.stats])));
    } catch {
      // A gateway that predates the monitor route answers 404: the cards then
      // simply show no counters, never an error.
    }
  }, []);

  const refreshBuilds = useCallback(async () => {
    try {
      const data = await api.listLocalBuilds();
      setBuilds(data.jobs);
    } catch {
      // A transient poll failure keeps the previous view.
    }
  }, []);

  /** Build jobs of the selected model, newest first (the API's own order). */
  const modelBuilds = useMemo(() => builds.filter((b) => b.modelId === modelId), [builds, modelId]);
  const activeBuild = modelBuilds.find((b) => b.status === 'building') ?? null;
  const latestBuild = modelBuilds[0] ?? null;

  useEffect(() => {
    void (async () => {
      try {
        const [modelList, engineList] = await Promise.all([api.getLocalModels(), api.getLocalEngines()]);
        setModels(modelList.models);
        setEngines(engineList);
        if (!modelId && modelList.models.length > 0) setModelId(modelList.models[0].id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    void refreshRuns();
    void refreshBuilds();
    void refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll runs and builds while anything is live; poll logs while a drawer is open.
  useEffect(() => {
    const anyLive =
      runs.some((r) => r.status === 'starting' || r.status === 'ready') ||
      builds.some((b) => b.status === 'building');
    if (!anyLive && !showLogs && !showBuildLogs) return;
    const timer = setInterval(() => {
      void refreshRuns();
      void refreshBuilds();
      void refreshStats();
      if (showLogs && drawerRun) {
        void api.getLocalRunLogs(drawerRun.id).then((data) => setLogs(data.lines)).catch(() => undefined);
      }
      if (showBuildLogs && latestBuild) {
        void api.getLocalBuildLogs(latestBuild.id).then((data) => setBuildLogLines(data.lines)).catch(() => undefined);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [runs, builds, showLogs, showBuildLogs, drawerRun, latestBuild, refreshRuns, refreshBuilds, refreshStats]);

  // The drawer follows its target: opening it, or the target changing (model
  // switch, live → failed handoff), refetches the ring once. An ended run's
  // ring is static, so the poll above only matters while a run is live.
  useEffect(() => {
    if (!showLogs) return;
    if (!drawerRun) {
      setLogs([]);
      return;
    }
    void api.getLocalRunLogs(drawerRun.id).then((data) => setLogs(data.lines)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLogs, drawerRun?.id]);

  // Default the engine pick to the first LAUNCHABLE choice (GPU-backed sorts
  // first via the install order; the operator overrides explicitly).
  useEffect(() => {
    if (launchableChoices.length === 0) return;
    if (!launchableChoices.some((c) => `${c.engine}:${c.target}` === enginePick)) {
      setEnginePick(`${launchableChoices[0].engine}:${launchableChoices[0].target}`);
    }
  }, [launchableChoices, enginePick]);

  // Landing on an engine that takes a launch profile keeps the advanced
  // drawer CLOSED: since ADR-0039 §8 an empty profile is the normal case (the
  // engine derives its launch inputs), so there is no form to foreground — a
  // stored override raises the chip on the toggle, same as every engine.

  // The placement plan: re-asked whenever a plan input changes (debounced).
  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!modelId || !choice) {
      setPlan(null);
      return;
    }
    if (planTimer.current) clearTimeout(planTimer.current);
    planTimer.current = setTimeout(() => {
      void api.getLocalPlan({
        modelId,
        engine: choice.engine,
        target: choice.target,
        ...(ctxPick > 0 ? { ctx: ctxPick } : {}),
        ...(nglPick >= 0 && choice.backend !== 'cpu' ? { ngl: nglPick } : {}),
        kvq8: kvQ8,
        headroom,
      }).then((data) => {
        setPlan(data);
        setPlanError('');
      }).catch((err) => {
        setPlan(null);
        setPlanError(err instanceof Error ? err.message : String(err));
      });
    }, 250);
    return () => {
      if (planTimer.current) clearTimeout(planTimer.current);
    };
  }, [modelId, choice, ctxPick, nglPick, kvQ8, headroom, planNonce]);

  const pickModel = (id: string) => {
    setModelId(id);
    setParams(id ? { model: id } : {}, { replace: true });
  };

  const start = async (pick?: EngineChoice) => {
    // An explicit pick lets the build→run chain launch the engine it just
    // built without waiting for the picker state to settle.
    const chosen = pick ?? choice;
    if (!selectedModel || !chosen || starting) return;
    setStarting(true);
    try {
      const result = await api.startLocalRun({
        modelId: selectedModel.id,
        engine: chosen.engine,
        target: chosen.target,
        ctx: ctxPick,
        // A cpu build never layers; the manual pick only rides GPU backends.
        ngl: chosen.backend === 'cpu' ? -1 : nglPick,
        flashAttn,
        kvCacheQ8: kvQ8,
        reasoning: thinking,
        autoRestart,
        headroom,
        threads,
        extraArgs: extraArgs.trim() ? extraArgs.trim().split(/\s+/).slice(0, 32) : [],
      });
      if (result.status !== 'ok') {
        toast.error(result.message || t('localModels.runFailed'));
      } else {
        toast.success(t('localModels.runStarted'));
        setShowLogs(true);
      }
      await refreshRuns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (run: LocalRun) => {
    const result = await api.stopLocalRun(run.id);
    if (result.status !== 'ok') toast.error(result.message || t('localModels.runStopFailed'));
    await refreshRuns();
  };

  /**
   * Build & run (ADR-0039 §9): the engine builds the launch input it derives
   * (Strata: the pack, by the workspace's own packer); when the job finishes
   * the model's verdict flips to runnable and the launch fires with the
   * automatic parameter set. One click, no packer command line.
   */
  const buildAndRun = async (engineId: string) => {
    if (!selectedModel || activeBuild) return;
    const result = await api.startLocalBuild({ modelId: selectedModel.id, engine: engineId });
    if (result.status !== 'ok' || !result.job) {
      toast.error(result.message || t('localModels.runBuildFailed'));
      return;
    }
    buildThenRunRef.current = engineId;
    toast.success(t('localModels.runBuildStarted'));
    setShowBuildLogs(true);
    await refreshBuilds();
  };

  // The build→run chain: when the job this page started finishes, refresh the
  // model rows (the backend rescanned the verdict) and arm the auto-start.
  useEffect(() => {
    const engineId = buildThenRunRef.current;
    if (!engineId) return;
    const job = builds.find((b) => b.modelId === modelId && b.engine === engineId);
    if (!job || job.status === 'building') return;
    buildThenRunRef.current = null;
    if (job.status !== 'done') {
      toast.error(job.error || t('localModels.runBuildFailed'));
      return;
    }
    toast.success(t('localModels.runBuildDone'));
    setPendingAutoStart(engineId);
    void api.getLocalModels().then((list) => setModels(list.models)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builds, modelId]);

  // The armed launch: fires once the rebuilt verdict makes the engine a
  // launchable choice for this model.
  useEffect(() => {
    if (!pendingAutoStart || activeRun || starting) return;
    const target = launchableChoices.find((c) => c.engine === pendingAutoStart);
    if (!target) return;
    setPendingAutoStart(null);
    setEnginePick(`${target.engine}:${target.target}`);
    void start(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoStart, launchableChoices, activeRun, starting]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('localModels.runCopied'));
    } catch {
      toast.error(t('localModels.runCopyFailed'));
    }
  };

  // Label is the operator-chosen name when set, else the filename stem — never
  // the GGUF header name (meta.name): several quants/variants of one family
  // share the same internal name, which makes the picker rows
  // A NAMED model shows its operator name as the option label — the gateway id
  // is `local/<name>`, so the label IS what a client calls, and two files with
  // equal stems stay distinguishable (ADR-0038 §7). The meta column stays the
  // uniform `quant · size` for every row; the full filename moves to the hover
  // tooltip, where a named row keeps its underlying file identifiable. The
  // leading icon is the model FAMILY's mark (combobox renders `icon` in trigger
  // and rows), shared with the Installed page's rows.
  const modelOptions: ComboboxOption[] = models.map((m) => ({
    value: m.id,
    label: localModelDisplayName(m),
    meta: `${m.quant ? `${m.quant} · ` : ''}${fmtGB(m.size)}`,
    tip: m.filename,
    icon: <ModelFamilyLogo repo={m.repo} filename={m.filename} metaName={m.meta?.name} metaArch={m.meta?.arch} size={18} />,
  }));
  const engineOptions: ComboboxOption[] = launchableChoices.map((c) => ({
    value: `${c.engine}:${c.target}`,
    label: c.label,
    meta: c.backend === 'cpu' ? 'CPU' : 'GPU',
  }));

  // The placement half of the plan response (null until the planner answered,
  // and ALWAYS null for an engine-owned placement — ADR-0038 §5).
  const pp = plan?.plan ?? null;
  const declaration = plan?.mode === 'declared' ? plan.declaration ?? null : null;
  // Expanded: name, totals, then the free bars. Collapsed: an icon chip
  // per pool so the two numbers stay distinct. Totals are what the planner
  // budgets against.
  const vramFreeBytes = plan?.vramFreeMb != null ? plan.vramFreeMb * 1_048_576 : null;
  const machineName = !plan ? '' : (plan.gpus && plan.gpus.length > 0 ? plan.gpus.join(' · ') : t('localModels.runMachineNoGpu'));
  const machineIdentity = !plan ? '' : [
    machineName,
    plan.vramMb != null && plan.vramMb > 0 ? `${fmtGB(plan.vramMb * 1_048_576)} ${t('localModels.runGpuLabel')}` : '',
    plan.ramBytes > 0 ? `${fmtGB(plan.ramBytes)} ${t('localModels.runRamLabel')}` : '',
  ].filter(Boolean).join(' · ');
  const vramChip = plan != null && plan.vramMb != null && plan.vramMb > 0
    ? (vramFreeBytes != null ? `${fmtGB(vramFreeBytes)} / ${fmtGB(plan.vramMb * 1_048_576)}` : fmtGB(plan.vramMb * 1_048_576))
    : '';
  const ramChip = plan != null && plan.ramBytes > 0
    ? (plan.ramFreeBytes != null ? `${fmtGB(plan.ramFreeBytes)} / ${fmtGB(plan.ramBytes)}` : fmtGB(plan.ramBytes))
    : '';
  // Warning only. Recomputing -ngl from free memory would make the preview
  // disagree with the launch the moment another process touches the card.
  const memoryTight = pp != null && (
    (vramFreeBytes != null && pp.backend !== 'cpu' && pp.vramBytes > vramFreeBytes)
    || (plan?.ramFreeBytes != null && pp.ramBytes > plan.ramFreeBytes)
  );

  // ctx readout: the typed value, else the planner's auto pick, else what a
  // declared engine resolved (it answers `ctx`, never `autoCtx`).
  const effectiveCtx = ctxPick > 0 ? ctxPick : plan?.autoCtx ?? plan?.ctx ?? 0;

  // The ctx ladder is backend-owned (the plan response carries it); the mirror
  // in lib/defaults only covers the first paint before the plan lands.
  const ctxSteps: readonly number[] = plan?.ctxLadder ?? LOCAL_CTX_LADDER;
  // The ceiling a step is disabled against: the planner's for a gateway-owned
  // placement, else the model's own trained context.
  const ctxCeiling = pp?.maxCtx ?? selectedModel?.meta?.maxCtx ?? 0;

  /** The picked engine's stored profile — the capability switches read it. */
  const profileOfChoice = selectedModel && choice ? engineProfileOf(selectedModel, choice.engine) : null;
  const specOff = profileOfChoice?.mtp === 'off';
  const visionOff = profileOfChoice?.mmproj === 'off';

  /**
   * Persist one capability switch (speculative draft / vision leg) into the
   * picked engine's profile: the value merges over the stored record, `null`
   * deletes the key (back to auto-discovery). The engine's profile owns how
   * "off" is expressed — the console only writes the sentinel and never names
   * the mechanism. The plan re-asks afterwards so the declaration chips follow
   * the switch immediately.
   */
  const saveCapability = async (patch: Record<string, string | null>) => {
    if (!selectedModel || !choice) return;
    const merged: Record<string, unknown> = { ...(profileOfChoice ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const result = await api.setLocalEngineProfile(selectedModel.id, choice.engine, merged);
    if (result.status !== 'ok' || !result.model) {
      toast.error(result.message || t('localModels.runFailed'));
      return;
    }
    setModels((prev) => prev.map((m) => (result.model && m.id === result.model.id ? result.model : m)));
    setPlanNonce((n) => n + 1);
  };
  const endpoint = activeRun ? `http://${activeRun.host}:${activeRun.port}${activeRun.apiPath}` : '';
  // The gateway-facing identity of the selected model — what a client actually
  // calls (`local/<name ?? repo/file>`, ADR-0038 §7). Registration rides every
  // pool rebuild (ADR-0038 §1), so this id is callable through the gateway the
  // moment the run reports ready; the raw endpoint above is debug info only
  // (dialing it bypasses routing, capture and protocol conversion).
  const gwModelId = selectedModel ? localModelGatewayId(selectedModel) : '';
  const gwBase = gatewayBaseUrl(status?.port);
  // The copyable quick-call sample. Console copy-paste snippets are sanctioned
  // non-i18n copy (same convention as ApiKeysPage's connect tabs).
  const gwCurl = `curl ${gwBase}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <API_KEY>" \\
  -d '{
    "model": "${gwModelId}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

  // First-load readout: an engine that declares its eager bytes (Strata maps
  // the pack's dense half, not the whole GGUF) names the base; everything
  // else loads the whole file. ONE display rate for both (no drift twin).
  const firstLoadMin = selectedModel
    ? Math.max(1, Math.round((declaration?.firstLoadBytes ?? selectedModel.size) / 1_073_741_824 / 1.5))
    : 0;
  // Title readout for the layer pick: the typed value, else the planner's.
  const effectiveNgl = nglPick >= 0 ? nglPick : pp?.gpuLayers ?? null;
  const planHeadline = declaration
    ? t('localModels.runPlanDeclared')
    : !pp
      ? ''
      : pp.backend === 'cpu'
        ? t('localModels.runPlanCpu')
        : pp.fullGpu
          ? t('localModels.runPlanFullGpu', { layers: pp.layers })
          : t('localModels.runPlanSplit', { gpu: fmtGB(pp.vramBytes), ram: fmtGB(pp.ramBytes) });

  const liveRuns = runs.filter((r) => r.status === 'ready' || r.status === 'starting');

  if (loading) {
    return <div className="pane-section"><div className="pane-section-scroll"><div className="card">{t('common.loading')}</div></div></div>;
  }

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        {liveRuns.length > 0 && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ ...sectionTitle, color: 'var(--text-dim)' }}>
              <BrainCircuit size={13} />
              <span>{t('localModels.runLiveModels')}</span>
            </div>
            {liveRuns.map((run) => {
              const runModel = models.find((m) => m.id === run.modelId);
              const selected = run.modelId === modelId;
              return (
                <div key={run.id} className="sub-card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', fontSize: 'var(--text-xs)' }}>
                  {runModel ? (
                    <ModelFamilyLogo repo={runModel.repo} filename={runModel.filename} metaName={runModel.meta?.name} metaArch={runModel.meta?.arch} size={18} />
                  ) : (
                    <HardDrive size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                  )}
                  <button
                    type="button"
                    onClick={() => pickModel(run.modelId)}
                    title={t('localModels.runPickLive')}
                    style={{
                      flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textAlign: 'left', fontFamily: 'var(--font-mono)',
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: selected ? 'var(--accent)' : 'var(--text-main)',
                    }}
                  >
                    {runModel ? localModelDisplayName(runModel) : run.modelId} · :{run.port}
                  </button>
                  <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{localRunStatusLabel(run.status, t)}</span>
                  <button type="button" className="btn btn-sm btn-danger" style={{ flexShrink: 0 }} onClick={() => void stop(run)}>
                    <Square size={12} />
                    <span>{t('localModels.runStop')}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Head: model picker + manage link (the screenshot's top row). */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 260 }}>
              <Combobox
                options={modelOptions}
                value={modelId}
                onChange={pickModel}
                placeholder={t('localModels.runSelectModel')}
                /* One family usually has a dozen quant files; the picker is
                   a search surface, so the filter shows from the first
                   option (the >8 threshold default is for small selects). */
                forceFilter
                style={{ height: 40 }}
              />
            </div>
            <Link to="/installed-models" className="btn btn-sm" style={{ textDecoration: 'none', flexShrink: 0 }}>
              <FolderCog size={13} />
              <span>{t('localModels.runManage')}</span>
            </Link>
          </div>
          {selectedModel && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {selectedModel.quant && <span className="badge" style={{ fontSize: 'var(--text-2xs)' }}>{selectedModel.quant}</span>}
              {selectedModel.meta?.arch && <span className="badge" style={{ fontSize: 'var(--text-2xs)' }}>{selectedModel.meta.arch}</span>}
              {selectedModel.meta?.moe && (
                <span className="badge" style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-violet)', borderColor: 'var(--accent-violet)' }}>MoE</span>
              )}
              <span>{selectedModel.repo === 'local-import' ? t('localModels.importedRepo') : selectedModel.repo}</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* Left: this computer + the layered placement plan. */}
            <div style={{ flex: '1.35 1 420px', minWidth: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Opens on the free bars. Collapsed leaves a GPU chip and a RAM chip. */}
              <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: showMachine ? '10px 14px' : '8px 14px' }}>
                <button
                  type="button"
                  onClick={() => setShowMachine((v) => !v)}
                  style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={{ ...sectionTitle, flexShrink: 0 }}>
                    {showMachine ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <HardDrive size={13} />
                    <span>{t('localModels.runMachine')}</span>
                  </span>
                  {!showMachine && vramChip && (
                    <span title={t('localModels.runGpuLabel')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 400, fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                      <Microchip size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      {vramChip}
                    </span>
                  )}
                  {!showMachine && ramChip && (
                    <span title={t('localModels.runRamLabel')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 400, fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                      <MemoryStick size={13} style={{ color: 'var(--accent-emerald)', flexShrink: 0 }} />
                      {ramChip}
                    </span>
                  )}
                </button>
                {showMachine && (
                  <>
                    {machineIdentity && (
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{machineIdentity}</span>
                    )}
                    {plan && plan.vramFreeMb != null && plan.vramMb != null && plan.vramMb > 0 && (
                      <PlanBar
                        plain
                        label={t('localModels.runGpuLabel')}
                        used={t('localModels.runMachineFree', {
                          free: fmtGB(plan.vramFreeMb * 1_048_576),
                          total: fmtGB(plan.vramMb * 1_048_576),
                        })}
                        ratio={plan.vramFreeMb / plan.vramMb}
                        tone="gpu"
                      />
                    )}
                    {plan && plan.ramFreeBytes != null && plan.ramBytes > 0 && (
                      <PlanBar
                        plain
                        label={t('localModels.runRamLabel')}
                        used={t('localModels.runMachineFree', {
                          free: fmtGB(plan.ramFreeBytes),
                          total: fmtGB(plan.ramBytes),
                        })}
                        ratio={plan.ramFreeBytes / plan.ramBytes}
                        tone="ram"
                      />
                    )}
                  </>
                )}
                {/* What THIS launch would spend, in the planner's own numbers. */}
                {pp && (
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                    {pp.backend === 'cpu'
                      ? t('localModels.runMachineUseCpu', { ram: fmtGB(pp.ramBytes) })
                      : t('localModels.runMachineUse', { vram: fmtGB(pp.vramBytes), ram: fmtGB(pp.ramBytes) })}
                  </span>
                )}
                {selectedModel && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
                    <span style={{ flexShrink: 0 }}>{t('localModels.runModelFiles')}</span>
                    <code style={{ fontFamily: 'var(--font-mono)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {dirOf(selectedModel.filePath)}
                    </code>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>{t('localModels.runPlanTitle')}</span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                {planError || planHeadline || t('localModels.runPlanLoading')}
              </div>

              {pp && (
                <>
                  {pp.backend !== 'cpu' && pp.vramTotalBytes > 0 && (
                    <PlanBar
                      label={t('localModels.runGpuLabel')}
                      used={`${fmtGB(pp.vramBytes)} / ${fmtGB(pp.vramTotalBytes)}`}
                      detail={pp.fullGpu
                        ? t('localModels.runGpuDetailFull', { layers: pp.layers, ctx: fmtCtxK(pp.ctx) })
                        : t('localModels.runGpuDetailSplit', { gpuLayers: pp.gpuLayers, layers: pp.layers, ctx: fmtCtxK(pp.ctx) })}
                      ratio={pp.vramTotalBytes > 0 ? pp.vramBytes / pp.vramTotalBytes : 0}
                      tone="gpu"
                    />
                  )}
                  <PlanBar
                    label={t('localModels.runRamLabel')}
                    used={`${fmtGB(pp.ramBytes)} / ${fmtGB(pp.ramTotalBytes)}`}
                    detail={pp.backend === 'cpu'
                      ? t('localModels.runRamDetailCpu', { reserve: fmtGB(pp.ramReserveBytes) })
                      : pp.fullGpu
                        ? t('localModels.runRamDetailIdle')
                        : t('localModels.runRamDetailSplit', { layers: Math.max(0, pp.layers - pp.gpuLayers), reserve: fmtGB(pp.ramReserveBytes) })}
                    ratio={pp.ramTotalBytes > 0 ? pp.ramBytes / pp.ramTotalBytes : 0}
                    tone="ram"
                  />
                  <PlanBar
                    label={t('localModels.runDiskLabel')}
                    used={pp.diskStreamed ? fmtGB(Math.max(0, pp.ramBytes - pp.ramTotalBytes)) : '0.0 GB'
                    }
                    detail={pp.diskStreamed ? t('localModels.runDiskStream') : t('localModels.runDiskNone')}
                    ratio={pp.diskStreamed ? 0.35 : 0}
                    tone="disk"
                  />
                </>
              )}

              {/* An engine that owns placement DECLARES instead of being
                  estimated: what the launch will pass, in its own words
                  (ADR-0038 §5 / ADR-0039). */}
              {declaration && (
                <div
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 6,
                    padding: '10px 12px', borderRadius: 8,
                    border: '1px dashed var(--divider)', background: 'transparent',
                    fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 1.6,
                  }}
                >
                  {declaration.argv.map((line) => (
                    <div key={line} style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{line}</div>
                  ))}
                  {declaration.features.length > 0 && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {declaration.features.map((feature) => (
                        <span key={feature.label} style={{ color: feature.on ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                          {feature.on ? '✓' : '·'} {feature.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Advanced: launch arguments — ONE drawer for every engine. It shows
                  the rows that engine actually takes, from the engine's own
                  descriptor; ctx / KV / extra args / host stay the shared
                  controls above and are never duplicated here. */}
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--text-xs)', alignSelf: 'flex-start' }}
              >
                {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>{t('localModels.runAdvanced')}</span>
                {/* "Unset" is no longer a warning: the engine derives its own
                    launch inputs, so an empty profile is the normal case and
                    only a real override is worth a chip (ADR-0039 §8). */}
                {profileEngine && selectedModel && hasEngineProfile(selectedModel, profileEngine.id) && (
                  <span className="badge badge-success" style={{ fontSize: 'var(--text-2xs)' }}>
                    {t('localModels.engineProfileConfigured')}
                  </span>
                )}
              </button>
              {showAdvanced && (
                <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
                  {/* The thread knob belongs to the engine that has one. */}
                  {activeRuntime?.accepts.threads !== false && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{t('localModels.runThreads')}</span>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={512}
                        value={threads}
                        onChange={(e) => setThreads(Math.max(0, Math.min(512, Number(e.target.value) || 0)))}
                        style={{ width: 120, fontSize: 'var(--text-sm)' }}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{t('localModels.runExtraArgs')}</span>
                    <input
                      className="input"
                      value={extraArgs}
                      onChange={(e) => setExtraArgs(e.target.value)}
                      placeholder="--no-warmup --prio 2"
                      spellCheck={false}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                    />
                  </div>
                  {profileEngine?.runtime?.profile && selectedModel && (
                    <EngineProfileFields
                      model={selectedModel}
                      engine={profileEngine.id}
                      engineName={profileEngine.name}
                      intro={profileEngine.runtime.profile.intro}
                      groups={profileEngine.runtime.profile.groups}
                      onSaved={(updated) => {
                        // The saved record carries the re-derived meta (the
                        // engine lands in `runnable`), so picker and plan
                        // refresh from one row.
                        setModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
                        // Configured in order to RUN it: land the picker there
                        // instead of making them hunt for the now-unblocked row.
                        if (updated.meta?.runnable.includes(profileEngine.id)) {
                          const install = profileEngine.installs[0];
                          if (install) setEnginePick(`${profileEngine.id}:${install.target}`);
                        }
                      }}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Right: launch options. */}
            <div style={{ flex: '1 1 320px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Engine pick — one row per installed (engine, target) build. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={sectionTitle}>
                  <Cpu size={13} />
                  <span>{t('localModels.runEngine')}</span>
                </div>
                {launchableChoices.length > 0 ? (
                  /* A handful of installed builds is a choice you SEE, not one
                   * you open: the engine switch re-plans the left panel live, so
                   * a wrapping SegGroup keeps every option one click away, at
                   * toolbar size. Only a big install list (many builds) falls
                   * back to the searchable Combobox. */
                  launchableChoices.length <= 6 ? (
                    <SegGroup
                      size="md"
                      wrap
                      value={choice ? `${choice.engine}:${choice.target}` : ''}
                      onChange={setEnginePick}
                      options={launchableChoices.map((c) => ({
                        value: `${c.engine}:${c.target}`,
                        label: c.label,
                        title: c.backend === 'cpu' ? 'CPU' : 'GPU',
                      }))}
                    />
                  ) : (
                    <Combobox
                      options={engineOptions}
                      value={choice ? `${choice.engine}:${choice.target}` : ''}
                      onChange={setEnginePick}
                      style={{ height: 34 }}
                    />
                  )
                ) : (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
                    {t('localModels.runNoEngine')}{' '}
                    <Link to="/local-models" style={{ color: 'var(--accent)' }}>{t('localModels.runGoEngines')}</Link>
                  </div>
                )}
                {/* An installed engine that cannot serve this file says WHY,
                    in its own words, instead of disappearing from the picker. */}
                {blockedEngines.map((engine) => (
                  <div
                    key={engine.id}
                    style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <span className="badge" style={{ fontSize: 'var(--text-2xs)', opacity: 0.7 }}>{engine.name}</span>
                    <span style={{ flex: '1 1 220px', minWidth: 0 }}>{engine.reason}</span>
                    {engine.needsSetup && (
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(true)}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: 'var(--accent)', fontSize: 'inherit', fontFamily: 'inherit', flexShrink: 0,
                        }}
                      >
                        {t('localModels.runAddProfile')}
                      </button>
                    )}
                    {/* The missing piece is one the engine builds itself (the
                        pack): offer the build, never a form (ADR-0039 §9). */}
                    {engine.buildable && (
                      activeBuild && activeBuild.engine === engine.id ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--accent)', flexShrink: 0 }}>
                          <Loader2 size={11} style={SPIN} />
                          {t('localModels.runBuilding')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void buildAndRun(engine.id)}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            color: 'var(--accent)', fontSize: 'inherit', fontFamily: 'inherit', flexShrink: 0,
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          <Hammer size={11} />
                          {t('localModels.runBuild')}
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>

              {/* Context ladder. An engine that declares its own placement
                  writes the picked ctx into the run config it generates, so the
                  picker is a real control here — not a number the launch
                  ignores. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={sectionTitle}>
                  <span>{t('localModels.runCtxTitle', { n: effectiveCtx > 0 ? fmtCtxK(effectiveCtx) : '—' })}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {/* Same metrics as the engine SegGroup (md): 5px/12px padding,
                   *  text-sm — one shared control height across both rows. The
                   *  .btn-sm min-height (30px) made these read taller than the
                   *  engine pills they sit under. */}
                  <button
                    type="button"
                    className={ctxPick === 0 ? 'btn btn-primary' : 'btn'}
                    style={{ minHeight: 0, padding: '5px 12px', fontSize: 'var(--text-sm)' }}
                    onClick={() => setCtxPick(0)}
                  >
                    {t('localModels.runCtxAuto')}
                  </button>
                  {ctxSteps.map((step) => (
                    <button
                      key={step}
                      type="button"
                      disabled={ctxCeiling > 0 && step > ctxCeiling}
                      className={ctxPick === step ? 'btn btn-primary' : 'btn'}
                      style={{ minHeight: 0, padding: '5px 12px', fontSize: 'var(--text-sm)' }}
                      onClick={() => setCtxPick(step)}
                    >
                      {fmtCtxK(step)}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runCtxHint')}</span>
              </div>

              {/* Speculative draft (the engine capability, never the engine's
                  name): auto follows discovery, off writes the profile
                  sentinel. Only an engine that TAKES the switch shows it. */}
              {activeRuntime?.accepts.spec && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={sectionTitle}>
                    <BrainCircuit size={13} />
                    <span>{t('localModels.runSpec')}</span>
                  </div>
                  <SegGroup
                    size="md"
                    wrap
                    value={specOff ? 'off' : 'auto'}
                    onChange={(v) => void saveCapability({ mtp: v === 'off' ? 'off' : null })}
                    options={[
                      { value: 'auto', label: t('localModels.runSpecAuto') },
                      { value: 'off', label: t('localModels.runSpecOff') },
                    ]}
                  />
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runSpecHint')}</span>
                </div>
              )}

              {/* Vision leg — same capability-driven rule as the draft. */}
              {activeRuntime?.accepts.vision && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={sectionTitle}>
                    <ImageIcon size={13} />
                    <span>{t('localModels.runVision')}</span>
                  </div>
                  <ToggleRow
                    label={t('localModels.runVisionLabel')}
                    hint={t('localModels.runVisionHint')}
                    on={!visionOff}
                    onChange={(on) => void saveCapability({ mmproj: on ? null : 'off' })}
                  />
                </div>
              )}

              {/* Resource mode — the planner's budget switch. An engine-owned
                  placement budgets itself, so there is nothing to offer here
                  (ADR-0038 §5). */}
              {activeRuntime?.placement === 'gateway' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={sectionTitle}>
                    <Gauge size={13} />
                    <span>{t('localModels.runResources')}</span>
                  </div>
                  <SegGroup
                    size="md"
                    wrap
                    value={headroom ? 'room' : 'perf'}
                    onChange={(v) => setHeadroom(v === 'room')}
                    options={[
                      { value: 'room', label: t('localModels.runResourcesBalanced') },
                      { value: 'perf', label: t('localModels.runResourcesPerf') },
                    ]}
                  />
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runResourcesHint')}</span>
                </div>
              )}

              {/* GPU layer count — only an engine that takes `-ngl` has one: a
                  cpu build never layers, and an engine-owned placement
                  (Strata's `--expert-cache`) has no layer knob at all
                  (ADR-0038 §5 / ADR-0039). */}
              {activeRuntime?.accepts.ngl !== false && activeRuntime?.placement !== 'engine' && choice?.backend !== 'cpu' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={sectionTitle}>
                    <span>{t('localModels.runNglTitle', { n: effectiveNgl != null ? String(effectiveNgl) : '—' })}</span>
                  </div>
                  {/* ONE frame for the pair: Auto is the field's "empty" state and the
                      number is its value, so they share a control rather than sitting
                      side by side as a badge and a box of two different heights. Both
                      halves use ONE type size: the field's — a smaller label next to the
                      value reads as misaligned even when both are box-centered. */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="input-group" style={{ height: 32, alignItems: 'stretch' }}>
                      <button
                        type="button"
                        aria-pressed={nglPick < 0}
                        style={{
                          display: 'inline-flex', alignItems: 'center', padding: '0 12px', minHeight: 0,
                          borderRadius: 0, border: 'none', fontSize: 'var(--text-sm)',
                          fontFamily: 'inherit', fontWeight: 'var(--font-semibold)',
                          background: nglPick < 0 ? 'var(--btn-primary-bg)' : 'transparent',
                          color: nglPick < 0 ? 'var(--btn-primary-text)' : 'var(--text-dim)',
                          cursor: 'pointer',
                        }}
                        onClick={() => setNglPick(-1)}
                      >
                        {t('localModels.runCtxAuto')}
                      </button>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        aria-label={t('localModels.runNglTitle', { n: effectiveNgl != null ? String(effectiveNgl) : '—' })}
                        {...(pp?.layers ? { max: pp.layers, placeholder: `0-${pp.layers}` } : { placeholder: '0' })}
                        value={nglPick >= 0 ? nglPick : ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === '') {
                            setNglPick(-1);
                            return;
                          }
                          const n = Math.floor(Number(raw));
                          if (!Number.isFinite(n) || n < 0) return;
                          setNglPick(pp?.layers ? Math.min(pp.layers, n) : n);
                        }}
                        /* Keep `.input`'s own vertical symmetry (7px top/bottom): a
                           fixed-height frame plus `align-self: stretch` gives the value a
                           real content box, so the glyphs center the same way they do in
                           every other `.input` on the page. */
                        style={{ width: 96, boxSizing: 'border-box', padding: '7px 10px', fontSize: 'var(--text-sm)', border: 'none', borderRadius: 0, background: 'transparent', alignSelf: 'stretch' }}
                      />
                    </div>
                    {pp?.layers != null && pp.layers > 0 && (
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
                        {t('localModels.runNglTotal', { n: pp.layers })}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runNglHint')}</span>
                </div>
              )}

              <ToggleRow
                label={t('localModels.runThinking')}
                hint={t('localModels.runThinkingHint')}
                on={thinking}
                onChange={setThinking}
              />

              {/* Inference speed & stability — collapsible summary. An engine
                  that takes neither switch (Strata: its run config owns the KV
                  type) hides the whole block rather than offering a control
                  that changes nothing (ADR-0037 preview ≠ launch). */}
              {(activeRuntime?.accepts.flashAttn !== false || activeRuntime?.accepts.kv !== false) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setShowAccel((v) => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                  >
                    <Zap size={13} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-main)' }}>{t('localModels.runAccel')}</span>
                    {showAccel ? <ChevronDown size={13} style={{ color: 'var(--text-dim)' }} /> : <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />}
                  </button>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
                    {t('localModels.runAccelSummary', {
                      fa: flashAttn ? t('localModels.runToggleOn') : t('localModels.runToggleOff'),
                      kv: kvQ8 ? 'Q8' : 'F16',
                      rs: autoRestart ? t('localModels.runToggleOn') : t('localModels.runToggleOff'),
                    })}
                  </span>
                  {showAccel && (
                    <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
                      <ToggleRow label="Flash Attention" on={flashAttn} onChange={setFlashAttn} />
                      <ToggleRow label={t('localModels.runKvQ8')} hint={t('localModels.runKvQ8Hint')} on={kvQ8} onChange={setKvQ8} />
                      <ToggleRow label={t('localModels.runAutoRestart')} on={autoRestart} onChange={setAutoRestart} />
                    </div>
                  )}
                </div>
              )}
              {(activeRuntime?.accepts.flashAttn === false && activeRuntime?.accepts.kv === false) && (
                <ToggleRow label={t('localModels.runAutoRestart')} on={autoRestart} onChange={setAutoRestart} />
              )}

              {/* Estimates + the start button. */}
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="sub-card" style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runEstSpeed')}</span>
                  <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {pp
                      ? t('localModels.estSpeed', { n: pp.estTokPerSec })
                      : declaration?.estTokPerSec != null
                        ? t('localModels.estSpeed', { n: declaration.estTokPerSec })
                        : '—'}
                  </span>
                </div>
                <div className="sub-card" style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runFirstLoad')}</span>
                  <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {t('localModels.runFirstLoadValue', { n: firstLoadMin })}
                  </span>
                </div>
              </div>

              {activeRun ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)' }}>
                    {activeRun.status === 'ready' ? (
                      <span className="badge badge-success">
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-emerald)' }} />
                        {t('localModels.runReady')}
                      </span>
                    ) : activeRun.status === 'starting' ? (
                      <span className="badge badge-warning">
                        <Loader2 size={11} style={SPIN} />
                        {t('localModels.runStarting')}
                      </span>
                    ) : (
                      <span className="badge">{localRunStatusLabel(activeRun.status, t)}</span>
                    )}
                    <span style={{ color: 'var(--text-dim)' }}>
                      {activeRun.engine} · {activeRun.target} · ctx {activeRun.ctx} · ngl {activeRun.ngl}
                    </span>
                  </div>
                  {activeRun.status === 'ready' && (
                    <button
                      type="button"
                      onClick={() => setShowGateway(true)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--text-xs)', alignSelf: 'flex-start' }}
                    >
                      <ChevronRight size={13} />
                      <span>{t('localModels.runGatewayTitle')}</span>
                    </button>
                  )}
                  {localRunErrorMessage(activeRun, t) && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{localRunErrorMessage(activeRun, t)}</div>
                  )}
                  {/* Throughput right where the run was started: the counters
                      answer "is it actually serving?", which is the question
                      the run card raises. The full board stays at
                      /local-monitor (per-run history, rolling averages). */}
                  {activeRun.status === 'ready' && (() => {
                    const stats = runStats.get(activeRun.id);
                    if (!stats || stats.requests === 0) return null;
                    const tps = stats.decodeTps ? formatSpeed(stats.decodeTps.last) : null;
                    return (
                      <div
                        className="sub-card"
                        style={{
                          display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center',
                          padding: '8px 14px', fontSize: 'var(--text-2xs)', lineHeight: 'var(--leading-tight, 1.25)',
                        }}
                        title={t('localMonitor.windowHint')}
                      >
                        <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                          <span style={{ color: 'var(--text-dim)' }}>{t('localMonitor.inFlight')}</span>
                          <strong style={{ fontVariantNumeric: 'tabular-nums', color: stats.inFlight > 0 ? 'var(--accent-teal, var(--accent))' : 'var(--text)' }}>
                            {stats.inFlight}
                          </strong>
                        </span>
                        <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                          <span style={{ color: 'var(--text-dim)' }}>{t('localMonitor.requests')}</span>
                          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{stats.requests}</strong>
                        </span>
                        {stats.errors > 0 && (
                          <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-dim)' }}>{t('localMonitor.errors')}</span>
                            <strong style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent-rose, var(--danger))' }}>{stats.errors}</strong>
                          </span>
                        )}
                        {tps !== null && (
                          <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-dim)' }}>{t('localMonitor.decode')}</span>
                            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{tps}</strong>
                          </span>
                        )}
                        {stats.ttftMs && (
                          <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-dim)' }}>{t('localMonitor.ttft')}</span>
                            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtLatency(stats.ttftMs.last)}</strong>
                          </span>
                        )}
                        <Link to="/local-monitor" style={{ marginLeft: 'auto', color: 'var(--accent)', textDecoration: 'none' }}>
                          {t('localMonitor.title')} →
                        </Link>
                      </div>
                    );
                  })()}
                  <button className="btn btn-danger" style={{ justifyContent: 'center' }} onClick={() => void stop(activeRun)}>
                    <Square size={13} />
                    <span>{t('localModels.runStop')}</span>
                  </button>
                </div>
              ) : (
                <>
                {memoryTight && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)', lineHeight: 'var(--leading-normal)' }}>
                    {t('localModels.runMachineTight')}
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  style={{ justifyContent: 'center', height: 42, fontSize: 'var(--text-sm)' }}
                  disabled={!selectedModel || !choice || starting}
                  onClick={() => void start()}
                >
                  {starting ? <Loader2 size={15} style={SPIN} /> : <Play size={15} />}
                  <span>{starting ? t('localModels.runStarting') : t('localModels.runStart')}</span>
                </button>
                </>
              )}
            </div>
          </div>

          {/* Build-log drawer (`localModels.runBuildLogs`): the packer's own
              output, shown while a build runs and kept for the latest one. */}
          {latestBuild && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  setShowBuildLogs((v) => !v);
                  if (!showBuildLogs) {
                    void api.getLocalBuildLogs(latestBuild.id).then((data) => setBuildLogLines(data.lines)).catch(() => undefined);
                  }
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--text-xs)', alignSelf: 'flex-start' }}
              >
                {showBuildLogs ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Hammer size={13} />
                <span>{t('localModels.runBuildLogs')}</span>
                {latestBuild.status === 'building' ? (
                  <span className="badge badge-warning" style={{ fontSize: 'var(--text-2xs)' }}>
                    <Loader2 size={10} style={SPIN} />
                    {t('localModels.runBuilding')}
                  </span>
                ) : latestBuild.status === 'done' ? (
                  <span className="badge badge-success" style={{ fontSize: 'var(--text-2xs)' }}>{t('localModels.runBuildDoneShort')}</span>
                ) : (
                  <span className="badge badge-warning" style={{ fontSize: 'var(--text-2xs)' }}>{t('localModels.runBuildFailed')}</span>
                )}
              </button>
              {localBuildErrorMessage(latestBuild, t) && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{localBuildErrorMessage(latestBuild, t)}</div>
              )}
              {showBuildLogs && (
                <div
                  className="sub-card"
                  style={{ padding: '8px 12px', maxHeight: 260, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  {buildLogLines.length === 0 ? (
                    <span style={{ color: 'var(--text-dim)' }}>{t('localModels.runLogsEmpty')}</span>
                  ) : (
                    buildLogLines.map((line) => (
                      <div key={line.id} style={{ color: line.stream === 'stderr' ? 'var(--accent-amber)' : line.stream === 'gateway' ? 'var(--text-dim)' : 'var(--text-main)' }}>
                        {line.text}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* `localModels.runLogs` — the run-log drawer. Its target is
              `drawerRun`: the live run, else the model's latest ended run, so
              a failed launch keeps its engine log one click away. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              type="button"
              onClick={() => setShowLogs((v) => !v)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--text-xs)', alignSelf: 'flex-start' }}
            >
              {showLogs ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <ScrollText size={13} />
              <span>{t('localModels.runLogs')}</span>
              {drawerRun && drawerRun !== activeRun && (
                <span className={drawerRun.status === 'failed' ? 'badge badge-danger' : 'badge'} style={{ fontSize: 'var(--text-2xs)' }}>
                  {localRunStatusLabel(drawerRun.status, t)}
                </span>
              )}
            </button>
            {drawerRun && localRunErrorMessage(drawerRun, t) && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{localRunErrorMessage(drawerRun, t)}</div>
            )}
            {showLogs && (
              <div
                className="sub-card"
                style={{ padding: '8px 12px', maxHeight: 260, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {!drawerRun || logs.length === 0 ? (
                  <span style={{ color: 'var(--text-dim)' }}>{t('localModels.runLogsEmpty')}</span>
                ) : (
                  logs.map((line) => (
                    <div key={line.id} style={{ color: line.stream === 'stderr' ? 'var(--accent-amber)' : line.stream === 'gateway' ? 'var(--text-dim)' : 'var(--text-main)' }}>
                      {line.text}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {activeRun?.status === 'ready' && showGateway && (
        <Dialog
          title={t('localModels.runGatewayTitle')}
          subtitle={t('localModels.runGatewayHint', { base: `${gwBase}/v1` })}
          onClose={() => setShowGateway(false)}
          closeLabel={t('common.close')}
          width={720}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', background: 'var(--chip-bg)', borderRadius: 6, padding: '6px 10px' }}>
              {gwModelId}
            </code>
            <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => void copy(gwModelId)}>
              <Copy size={12} />
              <span>{t('localModels.runCopy')}</span>
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('localModels.runGatewayCurl')}</span>
              <button className="btn btn-sm" style={{ flexShrink: 0, minHeight: 0, padding: '2px 8px' }} onClick={() => void copy(gwCurl)}>
                <Copy size={11} />
                <span>{t('localModels.runCopy')}</span>
              </button>
            </div>
            <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 6, background: 'var(--chip-bg)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre' }}>{gwCurl}</pre>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('localModels.runGatewayDirect')}</span>
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
              {endpoint}
            </code>
            <button className="btn btn-sm" style={{ flexShrink: 0, minHeight: 0, padding: '2px 8px' }} onClick={() => void copy(endpoint)}>
              <Copy size={11} />
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
};
