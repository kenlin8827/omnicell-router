/**
 * Local Models — engine management for locally-hosted inference.
 *
 * One card per engine (llama.cpp, Strata): the catalog row lists every build
 * target this platform can run, the dependency probe says which runtimes this
 * machine actually has, and the install button streams the release download
 * with live progress (NDJSON, same contract as the mihomo core install — a
 * cancelled transfer keeps its staged bytes and the next click resumes).
 *
 * The HuggingFace marketplace and the installed model files live on their own
 * page (`/model-market`, ModelMarketPage) — engines are infrastructure, models
 * are payload. Neither page writes gateway config: pointing the GATEWAY at a
 * running engine (its OpenAI-compatible port) is a provider row on the Keys
 * page.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowUpCircle, ChevronDown, CircleCheck, CircleX, Cpu, Download, ExternalLink, FolderOpen, HardDrive, Loader2, RefreshCw, Settings2, Sparkles, Trash2 } from 'lucide-react';
import {
  api,
  type LocalDepCheck,
  type LocalDetectResponse,
  type LocalEngineAvailabilityRow,
  type LocalEngineCatalogRow,
  type LocalEnginesResponse,
  type LocalInstallResult,
} from '../lib/api';
import {
  cancelTransfer,
  getTransferSnapshot,
  startTransfer,
  subscribeTransfers,
  type TransferEntry,
  type TransferView,
} from '../lib/transferStore';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { FilePickerModal } from '../components/FilePickerModal';
import { formatTimestamp } from '../lib/format';

const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

/** `#engine-setup-<id>` is the local-settings jump target for one installed engine. */
function engineSetupHash(hash: string): string | null {
  const match = /^#engine-setup-(.+)$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

/** scrollIntoView leaves a nested pane alone when the target is already
 *  inside the window. Drive the pane directly. */
function scrollPaneTo(el: HTMLElement) {
  const scroller = el.closest('.pane-section-scroll');
  if (!(scroller instanceof HTMLElement)) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

const sectionTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
};

const fmtMB = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Installer error codes with operator-facing copy; unknown codes stay raw. */
const INSTALL_ERROR_KEYS: Record<string, string> = {
  'asset-missing': 'localModels.errAssetMissing',
  'version-missing': 'localModels.errVersionMissing',
  'release-lookup-failed': 'localModels.errReleaseLookup',
  'unpack-failed': 'localModels.errUnpackFailed',
  'unsupported-platform': 'localModels.errUnsupportedPlatform',
};

/** Full transfer-store leg for one engine:target install. */
const engineLeg = (engineId: string, target: string): string => `engine:${engineId}:${target}`;

/**
 * Picked build target per engine, kept OUTSIDE the component: live install
 * state already survives route switches (`lib/transferStore`), and leaving the
 * picker in component state meant a return visit showed the default target
 * while the install it belongs to was still running on another one — progress
 * present, selection reset. Module scope keeps the two in lockstep.
 */
let selectedTargets: Record<string, string> = {};

export const LocalModelsPage: React.FC = () => {
  const { t } = useI18n();
  const location = useLocation();
  const toast = useToast();
  const confirmDialog = useConfirm();

  const [catalog, setCatalog] = useState<LocalEnginesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detect, setDetect] = useState<LocalDetectResponse | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** Release availability per engine id; absent = not probed yet / probe failed. */
  const [avail, setAvail] = useState<Record<string, LocalEngineAvailabilityRow>>({});
  /** Selected build target per engine; absent = the recommended (or first) one.
   *  Backed by module-level `selectedTargets` so the pick survives navigation. */
  const [selected, setSelectedState] = useState<Record<string, string>>(selectedTargets);
  const setSelected = (update: (prev: Record<string, string>) => Record<string, string>) => {
    setSelectedState((prev) => {
      const next = update(prev);
      selectedTargets = next;
      return next;
    });
  };
  /** Installer error message per leg; cleared when that install restarts. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Per-engine fold override; absent = the derived default (an engine with
   *  nothing on disk opens, because that card IS the install form; one already
   *  installed folds to its one-line status). A live install outranks this map
   *  and holds the card open — see `open` in renderEngine. */
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});
  /** Engine-level setup (ADR-0039 §10): stored values per engine id, the
   *  edited drafts beside them, and a saving flag per engine. `setupResolved`
   *  is what auto-discovery would use with no stored override — the form
   *  pre-fills it so the operator pins a real path instead of guessing one. */
  const [setupStored, setSetupStored] = useState<Record<string, Record<string, string>>>({});
  const [setupResolved, setSetupResolved] = useState<Record<string, Record<string, string>>>({});
  const [setupDrafts, setSetupDrafts] = useState<Record<string, Record<string, string>>>({});
  const [setupSaving, setSetupSaving] = useState<Record<string, boolean>>({});
  /** The setup field the directory picker is open for, if any. */
  const [setupPicker, setSetupPicker] = useState<{ engineId: string; fieldKey: string } | null>(null);

  // Live install view state lives at module scope (`lib/transferStore`), so a
  // route switch neither cancels an install nor loses its progress readout.
  // Only `engine:` legs gate this page: a marketplace GGUF download has its
  // own asset lock and must not grey every install button here.
  const transfers = useSyncExternalStore(subscribeTransfers, getTransferSnapshot);
  const busyLeg = Object.entries(transfers).find(([key, entry]) => entry.phase === 'active' && key.startsWith('engine:'))?.[0] ?? null;

  const refresh = useCallback(async () => {
    try {
      const data = await api.getLocalEngines();
      setCatalog(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A link from /local-settings lands on one installed engine's setup. The
  // card is folded once the engine is installed, so open it, then scroll the
  // pane — once per arrival, so a later collapse stays collapsed.
  const setupTarget = engineSetupHash(location.hash);
  const setupJumped = useRef<string | null>(null);
  useEffect(() => {
    if (!setupTarget || !catalog) return;
    const engine = catalog.engines.find((row) => row.id === setupTarget);
    if (!engine?.runtime?.setup) return;
    const opened = openOverrides[setupTarget] ?? engine.installs.length === 0;
    if (!opened) {
      setOpenOverrides((prev) => (prev[setupTarget] ? prev : { ...prev, [setupTarget]: true }));
      return;
    }
    if (setupJumped.current === setupTarget) return;
    // The fold opens on the next commit; measuring before that lands the
    // scroll on the summary. Wait until the setup block has a box.
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const card = document.getElementById(`engine-${setupTarget}`) as HTMLDetailsElement | null;
      const el = document.getElementById(`engine-setup-${setupTarget}`);
      if (!card?.open || !el || el.getBoundingClientRect().height === 0) {
        if (frames < 10) {
          frames += 1;
          raf = requestAnimationFrame(tick);
        }
        return;
      }
      setupJumped.current = setupTarget;
      scrollPaneTo(el);
      el.classList.remove('settings-jump-flash');
      void el.offsetWidth;
      el.classList.add('settings-jump-flash');
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setupTarget, catalog, openOverrides]);

  // Release availability probe on mount: drives chip state, fails silently —
  // an offline machine keeps every chip enabled and discovers at install time.
  useEffect(() => {
    void api.getLocalEngineAvailability()
      .then((res) => setAvail(Object.fromEntries(res.engines.map((row) => [row.id, row]))))
      .catch(() => undefined);
    void api.getLocalModelSettings()
      .then((res) => {
        setSetupStored(res.engineSetup ?? {});
        setSetupResolved(res.engineSetupResolved ?? {});
      })
      .catch(() => undefined);
  }, []);

  /** The edited setup values of one engine (draft over stored). */
  const setupDraft = (engineId: string): Record<string, string> => setupDrafts[engineId] ?? setupStored[engineId] ?? {};

  const setupFieldSpec = (engineId: string, fieldKey: string) =>
    catalog?.engines.find((row) => row.id === engineId)?.runtime?.setup?.fields.find((f) => f.key === fieldKey);

  /** What one field SHOWS: the edit, else the stored pin, else the discovered
   *  value — the field reads as the effective path, never an empty guess. A
   *  DERIVED field (python ← workspace) stays empty instead: its resolved
   *  value rides the placeholder, so it keeps following the field it derives
   *  from instead of going stale as a pin. */
  const setupValue = (engineId: string, fieldKey: string): string => {
    const edited = setupDraft(engineId)[fieldKey];
    if (edited !== undefined) return edited;
    if (setupFieldSpec(engineId, fieldKey)?.derived) return '';
    return setupResolved[engineId]?.[fieldKey] ?? '';
  };

  /** Save one engine's setup: the DISPLAYED values are persisted (a shown
   *  discovered path becomes the pin — what you see is what runs), and an
   *  emptied field drops the key (discovery owns it again). Derived fields
   *  are excluded from the pin-the-discovered merge: only an explicit edit
   *  or an existing stored value lands there. */
  const saveEngineSetup = async (engineId: string) => {
    if (setupSaving[engineId]) return;
    setSetupSaving((prev) => ({ ...prev, [engineId]: true }));
    try {
      const derivedKeys = new Set(
        (catalog?.engines.find((row) => row.id === engineId)?.runtime?.setup?.fields ?? [])
          .filter((f) => f.derived)
          .map((f) => f.key)
      );
      const shown: Record<string, string> = {
        ...Object.fromEntries(Object.entries(setupResolved[engineId] ?? {}).filter(([key]) => !derivedKeys.has(key))),
        ...setupDraft(engineId),
      };
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(shown)) {
        const trimmed = value.trim();
        if (trimmed) clean[key] = trimmed;
      }
      await api.updateLocalModelSettings({ engineSetup: { [engineId]: clean } });
      setSetupStored((prev) => {
        const next = { ...prev };
        if (Object.keys(clean).length > 0) next[engineId] = clean;
        else delete next[engineId];
        return next;
      });
      setSetupDrafts((prev) => {
        const next = { ...prev };
        delete next[engineId];
        return next;
      });
      toast.success(t('localModels.engineSetupSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupSaving((prev) => ({ ...prev, [engineId]: false }));
    }
  };

  const runDetect = useCallback(async () => {
    setDetecting(true);
    try {
      setDetect(await api.detectLocalDependencies());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, [toast]);

  /** The target an install will use: the operator's pick, else a build that is
   *  ALREADY on disk (a GPU build before a cpu one — the same preference the
   *  plan route states), else the detected recommendation, else the catalog's
   *  first target (a CPU build exists for every llama.cpp platform). Without
   *  the installed step a fresh page load — detect not run yet — would point
   *  the card at a build nobody has while the real one sits further along the
   *  chip row, offering an install button for something already installed. */
  const targetFor = (engine: LocalEngineCatalogRow): string => {
    const picked = selected[engine.id];
    if (picked) return picked;
    const backendOf = (id: string) => engine.targets.find((target) => target.id === id)?.backend ?? 'cpu';
    const onDisk = engine.installs.find((item) => backendOf(item.target) !== 'cpu') ?? engine.installs[0];
    if (onDisk && engine.targets.some((target) => target.id === onDisk.target)) return onDisk.target;
    const recommended = detect?.recommended[engine.id] ?? null;
    if (recommended && engine.targets.some((target) => target.id === recommended)) return recommended;
    return engine.targets[0]?.id ?? '';
  };

  /** Install one engine:target — the target the install button points at, or an
   *  explicit one when the update affordance acts on a build the picker is not
   *  showing. `upgrade` only affects the success copy: an update replaces a
   *  record, and calling that "installed" reads like a second copy landed.
   *  The streaming loop runs at module scope, so it survives route navigation;
   *  the store entry carries the progress back into view when the operator
   *  returns. */
  const install = (engine: LocalEngineCatalogRow, explicitTarget?: string, upgrade = false) => {
    const target = explicitTarget ?? targetFor(engine);
    if (!target) return;
    const leg = engineLeg(engine.id, target);
    setSelected((prev) => ({ ...prev, [engine.id]: target }));
    // Pin the card open across the install: `installs` growing 0→1 flips the
    // fold DEFAULT to collapsed, which would close the card at the exact
    // moment the operator wants to read where the build landed.
    setOpenOverrides((prev) => ({ ...prev, [engine.id]: true }));
    setErrors((prev) => ({ ...prev, [leg]: '' }));
    void startTransfer<LocalInstallResult>(leg, {
      initial: { stage: 'resolve', asset: '', downloaded: 0, total: 0, assetIndex: 1, assetTotal: 1 },
      request: (signal, onEvent) => api.installLocalEngine(engine.id, { target, onEvent, signal }),
      onOk: (result) => {
        if (result.ok) {
          toast.success(t(upgrade ? 'localModels.updateDone' : 'localModels.installDone'));
        } else if (result.code === 'download-aborted') {
          toast.info(t('localModels.installCancelled'));
          setErrors((prev) => ({ ...prev, [leg]: t('localModels.installCancelled') }));
        } else {
          const key = result.code ? INSTALL_ERROR_KEYS[result.code] : undefined;
          const message = (key ? t(key) : '') || result.error || t('localModels.installFailed');
          toast.error(message);
          setErrors((prev) => ({ ...prev, [leg]: message }));
        }
        void refresh();
      },
      onCancelled: () => {
        toast.info(t('localModels.installCancelled'));
        setErrors((prev) => ({ ...prev, [leg]: t('localModels.installCancelled') }));
        void refresh();
      },
      onError: (message) => {
        toast.error(message);
        setErrors((prev) => ({ ...prev, [leg]: message }));
        void refresh();
      },
    });
  };

  const uninstall = async (engine: LocalEngineCatalogRow, target: string) => {
    const ok = await confirmDialog({
      title: t('localModels.uninstallConfirmTitle'),
      description: t('localModels.uninstallConfirmDesc'),
      confirmLabel: t('localModels.uninstall'),
    });
    if (!ok) return;
    const result = await api.uninstallLocalEngine(engine.id, target);
    if (result.status === 'ok') {
      toast.success(t('localModels.uninstalled'));
      void refresh();
    } else {
      toast.error(result.message || t('localModels.installFailed'));
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }
  if (!catalog) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('localModels.installFailed')}</div>;
  }

  const renderCheck = (check: LocalDepCheck) => (
    <div key={check.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
      {check.ok
        ? <CircleCheck size={13} style={{ color: 'var(--accent-emerald)', flexShrink: 0 }} />
        : <CircleX size={13} style={{ color: 'var(--accent-rose)', flexShrink: 0 }} />}
      <span style={{ color: 'var(--text)' }}>{check.label}</span>
      <span>{check.ok ? check.detail : t('localModels.checkMissing')}</span>
    </div>
  );

  const renderEngine = (engine: LocalEngineCatalogRow) => {
    const picked = targetFor(engine);
    // The live install may be on a target the fresh mount cannot derive yet
    // (the detect probe that feeds targetFor is still in flight), so locate
    // the active leg by engine prefix first — the card must keep showing its
    // progress across a remount, never just a row of grey buttons.
    const leg = Object.entries(transfers).find(
      ([key, entry]) => entry.phase === 'active' && key.startsWith(`engine:${engine.id}:`),
    )?.[0] ?? engineLeg(engine.id, picked);
    const entry: TransferEntry | undefined = transfers[leg];
    const run: TransferView | undefined = entry?.phase === 'active' ? entry.run : undefined;
    const busyHere = entry?.phase === 'active';
    const error = errors[leg] || '';
    const recommended = detect?.recommended[engine.id] ?? null;
    const availability = avail[engine.id] ?? null;
    const availabilityOf = (targetId: string) => availability?.targets?.[targetId] ?? null;
    /** The version the CURRENT release would install for one target. The
     *  probe's `version` is authoritative and the tag only a fallback: the
     *  backend omits `version` when it equals the tag, so llama.cpp (tag IS the
     *  version) arrives as `tag`, while Strata answers with the engine version
     *  parsed out of the asset name (`0.1.69` under release tag `v0.2.22`).
     *  Comparing a Strata record against the tag alone would report every
     *  install of it as outdated forever. */
    const offeredVersionFor = (targetId: string): string | null => {
      const row = availabilityOf(targetId);
      if (!row?.available) return null;
      return row.version ?? availability?.tag ?? null;
    };
    const pickedUnavailable = (() => {
      const row = availabilityOf(picked);
      return row !== null && !row.available;
    })();
    const installs = engine.installs;
    const pickedInstall = installs.find((item) => item.target === picked) ?? null;
    // Installed targets lead: once a build is on disk this card is about
    // maintaining it, and the catalog order (CPU, Vulkan, then every
    // accelerator) would otherwise park the operator's one real build behind
    // rows they never use. Partition, never a re-sort — each group keeps the
    // catalog's own order, and pick/install semantics are untouched (a picked
    // chip stays picked wherever it lands).
    const installedTargetIds = new Set(installs.map((item) => item.target));
    const orderedTargets = [
      ...engine.targets.filter((target) => installedTargetIds.has(target.id)),
      ...engine.targets.filter((target) => !installedTargetIds.has(target.id)),
    ];
    const pct = run && run.total > 0 ? Math.min(100, Math.floor((run.downloaded / run.total) * 100)) : 0;
    const stageLabel = run
      ? run.stage === 'resolve' ? t('localModels.stageResolve')
        : run.stage === 'extract' ? (run.total > 0 ? t('localModels.stageExtractPct', { asset: run.asset, pct }) : t('localModels.stageExtract', { asset: run.asset }))
          : run.stage === 'finalize' ? t('localModels.stageFinalize')
            : t('localModels.stageDownload', { asset: run.asset })
      : '';
    // Multi-asset install (llama.cpp CUDA = main + cudart): without the
    // position marker the second asset's 0→100% looks like a restart.
    const assetPosition = run && run.assetTotal > 1 ? ` · ${run.assetIndex}/${run.assetTotal}` : '';
    // Fold default: an engine with nothing on disk IS the install form, so it
    // stays open; one that is already installed folds to a one-line status and
    // the operator opens it only to add/replace a build. The summary carries
    // the live percentage, so folding mid-download costs the bar, not the fact.
    // An override is only kept while a transfer runs: the operator's own
    // expand/collapse wins everywhere else.
    const engineOpen = openOverrides[engine.id] ?? installs.length === 0;
    // The picked target and the version the current release would install for
    // it: the install button reads "Update" only when the newer build is
    // actually reachable — an offline probe must not promise an update.
    const pickedOffered = pickedInstall ? offeredVersionFor(picked) : null;
    const pickedOutdated = pickedInstall !== null && pickedOffered !== null && pickedOffered !== pickedInstall.version;
    return (
      <details
        key={engine.id}
        id={`engine-${engine.id}`}
        className="sub-card"
        open={engineOpen}
        onToggle={(e) => {
          // React nulls SyntheticEvent.currentTarget after dispatch and the
          // state updater runs later (batched render) — read `open` NOW.
          const open = e.currentTarget.open;
          setOpenOverrides((prev) => ({ ...prev, [engine.id]: open }));
        }}
      >
        {/* The summary IS the card: engine name, repo link, install state and —
            while a transfer runs — its live percentage, so a folded card still
            answers "what is here and is it moving" without expanding. */}
        <summary style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <ChevronDown
              size={14}
              style={{ flexShrink: 0, color: 'var(--text-dim)', transition: 'transform 0.15s ease', transform: engineOpen ? undefined : 'rotate(-90deg)' }}
            />
            <HardDrive size={16} style={{ flexShrink: 0, color: 'var(--text-dim)' }} />
            <strong style={{ fontSize: 'var(--text-sm)' }}>{engine.name}</strong>
            {/* The repo link lives in the body, not here: a click inside a
                <summary> would toggle the card as well as open the browser. */}
            {availability?.tag && (
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
                {t('localModels.latestRelease', { tag: availability.tag })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            {installs.length > 0 ? (
              <>
                <span className="badge badge-success">
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-emerald)', flexShrink: 0 }} />
                  {t('localModels.installed')}
                </span>
                {/* One neutral chip per install: the badge's own uppercase
                    convention suits the target (`cuda-12.4` → CUDA-12.4, a
                    brand spelling), but NOT the release tag — `b8933` and
                    `B8933` are different strings, so the version segment
                    opts out of the transform and goes mono. */}
                {installs.map((item) => {
                  const offered = offeredVersionFor(item.target);
                  const isOutdated = offered !== null && offered !== item.version;
                  return (
                    <span
                      key={item.target}
                      className={isOutdated ? 'badge badge-info' : 'badge'}
                      style={isOutdated ? undefined : { background: 'var(--chip-bg)', color: 'var(--text-dim)' }}
                      title={isOutdated ? t('localModels.updateAvailableHint', { from: item.version, to: offered }) : undefined}
                    >
                      {item.target}
                      <span aria-hidden style={{ opacity: 0.45 }}>·</span>
                      <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'none' }}>{item.version}</span>
                      {isOutdated && (
                        <>
                          <span aria-hidden style={{ opacity: 0.45 }}>→</span>
                          <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'none' }}>{offered}</span>
                        </>
                      )}
                    </span>
                  );
                })}
              </>
            ) : (
              <span className="badge badge-warning">
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-amber)', flexShrink: 0 }} />
                {t('localModels.notInstalled')}
              </span>
            )}
            {busyHere && run && run.total > 0 && (
              <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                {pct}%
              </span>
            )}
            {!busyHere && error && (
              <span className="badge badge-warning">{t('localModels.installFailed')}</span>
            )}
          </div>
        </summary>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <a href={`https://github.com/${engine.repo}`} target="_blank" rel="noreferrer"
              className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
              {engine.repo}<ExternalLink size={10} />
            </a>
          </div>

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
            {engine.descriptionKey ? t(engine.descriptionKey) : engine.description}
          </div>

          {/* Installed facts: where each target lives and which binary serves it. */}
          {installs.map((item) => {
            const offered = offeredVersionFor(item.target);
            const isOutdated = offered !== null && offered !== item.version;
            return (
              <div key={item.target} style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span className="badge" style={{ fontSize: 'var(--text-2xs)' }}>{item.target}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{item.installDir}</span>
                  {/* Update is a PER-TARGET action, offered right where the
                      version lives: the picked chip may be a different build,
                      and the install button below only ever acts on that one.
                      The picked target is skipped here — its update is the
                      primary action below, and two buttons doing the same
                      thing in one card read as two different operations. */}
                  {isOutdated && item.target !== picked && (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyLeg !== null}
                      title={t('localModels.updateHint')}
                      onClick={() => install(engine, item.target, true)}
                    >
                      <ArrowUpCircle size={12} />
                      <span>{t('localModels.update')} {item.version} → {offered}</span>
                    </button>
                  )}
                </div>
                {item.binaries.length > 0 && (
                  <div>{t('localModels.binariesLabel')}: {item.binaries.map((bin) => bin.split(/[\\/]/).pop()).join(', ')}</div>
                )}
                <div>{t('localModels.installedAt')}: {formatTimestamp(item.installedAt)}</div>
              </div>
            );
          })}

          {/* Target picker: pills for every target this platform can run, with a
              spark on the detected recommendation and a dot on installed ones. */}
          <div>
            <div style={{ ...sectionTitle, marginBottom: '6px' }}>
              <Cpu size={13} />
              <span>{t('localModels.targetLabel')}</span>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {orderedTargets.map((target) => {
                const isPicked = target.id === picked;
                const isRecommended = target.id === recommended;
                const isInstalled = installs.some((item) => item.target === target.id);
                const targetAvail = availabilityOf(target.id);
                const isUnavailable = targetAvail !== null && !targetAvail.available;
                const chipDisabled = busyLeg !== null || isUnavailable;
                return (
                  <button
                    key={target.id}
                    type="button"
                    disabled={chipDisabled}
                    onClick={() => setSelected((prev) => ({ ...prev, [engine.id]: target.id }))}
                    className={isPicked ? 'badge badge-success' : 'badge'}
                    style={{
                      cursor: chipDisabled ? 'not-allowed' : 'pointer',
                      background: isPicked ? undefined : 'var(--chip-bg)',
                      color: isPicked ? undefined : 'var(--text-dim)',
                      opacity: isUnavailable ? 0.45 : 1,
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      /* One step above the badge tag but below the run page's
                       * md controls: this picker lives inside a dense card, and
                       * md here towers over the card's 11-12px text. */
                      padding: '3px 10px', fontSize: 'var(--text-xs)', textTransform: 'none', letterSpacing: 'normal',
                    }}
                    title={isUnavailable
                      ? t('localModels.targetUnavailable', { tag: availability?.tag ?? '' })
                      : target.requires.join(', ')}
                  >
                    {isRecommended && <Sparkles size={11} style={{ color: 'var(--accent-amber)' }} />}
                    {isInstalled && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-emerald)', flexShrink: 0 }} />}
                    {target.label}
                    {target.approxBytes > 0 && <span style={{ opacity: 0.7 }}>~{fmtMB(target.approxBytes)}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{error}</div>
          )}

          {/* Install / cancel / uninstall — per picked target. The install
              button doubles as the progress readout while a transfer is live;
              the label is stage-aware: a percentage only makes sense while
              bytes are moving — the extract leg reports archive-read progress
              (downloaded/total become archive bytes), while finalize stays
              pinned at 100% and must say so instead of reading as a stuck
              "downloading 100%". */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {busyHere ? (
              <>
                <button className="btn btn-sm" disabled>
                  <Loader2 size={13} style={SPIN} />
                  <span>{!run || run.stage === 'resolve'
                    ? t('localModels.installing')
                    : run.stage === 'extract'
                      ? run.total > 0 ? t('localModels.stageExtractPct', { asset: run.asset, pct }) : t('localModels.stageExtract', { asset: run.asset })
                      : run.stage === 'finalize'
                        ? t('localModels.stageFinalize')
                        : run.total > 0 ? t('localModels.installingPct', { pct }) : t('localModels.installing')}</span>
                </button>
                {/* The point of no return: extraction cannot be interrupted
                    (extractTarGz takes no signal) and the gateway finishes what
                    it started — single-asset installs complete and register.
                    Offering a Cancel here only produced "cancelled" followed by a
                    surprising "installed" on refresh, or a pointless full re-download
                    that queued behind the very extract it tried to stop. */}
                <button
                  className="btn btn-sm"
                  disabled={!run || run.stage === 'extract' || run.stage === 'finalize'}
                  title={!run || run.stage === 'extract' || run.stage === 'finalize' ? t('localModels.installCancelLocked') : undefined}
                  onClick={() => cancelTransfer(leg)}
                >
                  {t('common.cancel')}
                </button>
                {run && run.total === 0 && run.downloaded > 0 && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {t('localModels.installingSize', { mb: fmtMB(run.downloaded) })}
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busyLeg !== null || engine.targets.length === 0 || pickedUnavailable}
                  onClick={() => install(engine, undefined, pickedOutdated)}
                  title={pickedOutdated ? t('localModels.updateHint') : undefined}
                >
                  {pickedOutdated ? <ArrowUpCircle size={13} /> : <Download size={13} />}
                  <span>
                    {pickedOutdated
                      ? `${t('localModels.update')} ${pickedInstall?.version} → ${pickedOffered}`
                      : pickedInstall ? t('localModels.reinstall') : t('localModels.install')}
                  </span>
                </button>
                {pickedUnavailable && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
                    {t('localModels.targetUnavailable', { tag: availability?.tag ?? '' })}
                  </span>
                )}
                {pickedInstall && (
                  <button className="btn btn-sm" disabled={busyLeg !== null} onClick={() => void uninstall(engine, picked)}>
                    <Trash2 size={13} />
                    <span>{t('localModels.uninstall')} · {picked}</span>
                  </button>
                )}
                {picked && detect && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {t('localModels.recommended')}: {recommended ?? t('localModels.recommendNone')}
                  </span>
                )}
              </>
            )}
          </div>

          {busyHere && run && run.total > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ height: 4, borderRadius: 999, background: 'var(--divider)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s ease' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                <span>{stageLabel}{assetPosition}</span>
                <span>{fmtMB(run.downloaded)} / {fmtMB(run.total)}</span>
              </div>
            </div>
          )}

          {/* Engine setup (ADR-0039 §10): installation-level facts, one set per
              engine — declared by the engine, rendered generically. An empty
              field means auto-discovery owns the value. It sits AFTER the
              install action: setup overrides feed discovery, but installing is
              the card's primary job and must not wait behind a config form.
              Bordered as one fieldset so the form reads as a group distinct
              from the target picker and install row above it. */}
          {engine.runtime?.setup && (
            <fieldset id={`engine-setup-${engine.id}`} style={{ border: '1px solid var(--divider)', borderRadius: 10, padding: '12px 14px', margin: 0, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <legend style={{ ...sectionTitle, fontSize: 'var(--text-xs)', padding: '0 6px' }}>
                <Settings2 size={13} />
                <span>{t('localModels.engineSetupTitle')}</span>
              </legend>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                {t(engine.runtime.setup.intro)}
              </div>
              {engine.runtime.setup.fields.map((field) => (
                <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{t(field.label)}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="input"
                      type="text"
                      value={setupValue(engine.id, field.key)}
                      placeholder={(field.derived && setupResolved[engine.id]?.[field.key]) || t('localModels.engineSetupAuto')}
                      style={{ flex: 1, minWidth: 0, ...(field.mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' } : {}) }}
                      onChange={(e) =>
                        setSetupDrafts((prev) => ({
                          ...prev,
                          [engine.id]: { ...(prev[engine.id] ?? setupStored[engine.id] ?? {}), [field.key]: e.target.value },
                        }))
                      }
                    />
                    {field.picker === 'directory' && (
                      <button
                        className="btn btn-sm"
                        style={{ flexShrink: 0, justifyContent: 'center' }}
                        title={t('localModels.engineSetupBrowse')}
                        onClick={() => setSetupPicker({ engineId: engine.id, fieldKey: field.key })}
                      >
                        <FolderOpen size={13} />
                      </button>
                    )}
                  </div>
                  {field.hint && (
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t(field.hint)}</span>
                  )}
                </div>
              ))}
              <div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!!setupSaving[engine.id]}
                  onClick={() => void saveEngineSetup(engine.id)}
                >
                  {setupSaving[engine.id] && <Loader2 size={12} style={SPIN} />}
                  <span>{t('localModels.engineSetupSave')}</span>
                </button>
              </div>
            </fieldset>
          )}
          {!busyHere && installs.length === 0 && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.resumableHint')}</div>
          )}
        </div>
      </details>
    );
  };

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', maxWidth: 560, lineHeight: 'var(--leading-normal)' }}>
            {t('localModels.description')}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-sm" onClick={() => void refresh()} disabled={busyLeg !== null}>
              <RefreshCw size={13} />
              <span>{t('localModels.refresh')}</span>
            </button>
          </div>
        </div>

        {/* Dependency probe: one card, one button, results stay until the next
            probe — the answer ages with the machine, not with the page. */}
        <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={sectionTitle}>
              <Cpu size={14} />
              <span>{t('localModels.detectTitle')}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontWeight: 400 }}>
                {catalog.platform}/{catalog.arch}
              </span>
            </div>
            <button className="btn btn-sm" onClick={() => void runDetect()} disabled={detecting}>
              {detecting ? <Loader2 size={13} style={SPIN} /> : <Sparkles size={13} />}
              <span>{detecting ? t('localModels.detecting') : t('localModels.detectAction')}</span>
            </button>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
            {t('localModels.detectHint')}
          </div>
          {detect && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {detect.report.checks.map(renderCheck)}
              </div>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                <span>
                  {t('localModels.gpusLabel')}: {detect.report.gpus.length > 0 ? detect.report.gpus.join(', ') : t('localModels.noGpu')}
                </span>
                {detect.report.cudaVersion && <span>CUDA {detect.report.cudaVersion}</span>}
                <span>
                  {t('localModels.recommended')}:
                  {' '}
                  {catalog.engines.map((engine, index) => (
                    <React.Fragment key={engine.id}>
                      {index > 0 ? ' · ' : ''}
                      {engine.name} = {detect.recommended[engine.id] ?? t('localModels.recommendNone')}
                    </React.Fragment>
                  ))}
                </span>
              </div>
            </>
          )}
        </div>

        {catalog.engines.map(renderEngine)}
        </div>
      </div>

      {/* Engine setup directory picker: the same server-side browser the
          storage-dir setting uses — it walks the GATEWAY machine's filesystem,
          which is the machine the path must exist on. */}
      <FilePickerModal
        open={setupPicker !== null}
        mode="dir"
        initialPath={setupPicker ? setupValue(setupPicker.engineId, setupPicker.fieldKey) : ''}
        onPick={(picked) => {
          if (setupPicker) {
            const { engineId, fieldKey } = setupPicker;
            setSetupDrafts((prev) => ({
              ...prev,
              [engineId]: { ...(prev[engineId] ?? setupStored[engineId] ?? {}), [fieldKey]: picked },
            }));
          }
          setSetupPicker(null);
        }}
        onClose={() => setSetupPicker(null)}
      />
    </div>
  );
};
