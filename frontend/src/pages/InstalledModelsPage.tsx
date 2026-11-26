/**
 * Local Models — the local GGUF registry as its own page.
 *
 * Rows come from two sources: files downloaded through the marketplace
 * (repo = the HF id, lives under `<ocrHome>/models`) and files imported from
 * anywhere on this machine (repo `local-import`, registered in place — the
 * file is never copied, and removing the row keeps the file on disk). The
 * page lists both, totals the models-dir disk usage, and offers per-row
 * removal with a confirm dialog.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, FolderPlus, Hammer, HardDrive, Loader2, PackageOpen, Pencil, Play, Trash2 } from 'lucide-react';
import {
  api,
  type LocalBuildJob,
  type LocalInstalledModel,
  type LocalEngineCatalogRow,
  type LocalModelsListResponse,
} from '../lib/api';
import { localModelGatewayId } from '../lib/local-model';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { SearchInput } from '../components/SearchInput';
import { FilePickerModal } from '../components/FilePickerModal';
import { ModelFamilyLogo } from '../components/ModelFamilyLogo';
import { formatTimestamp } from '../lib/format';

const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

/** Repo marker the backend stamps on imported rows (keep in sync with model-store). */
const IMPORT_REPO = 'local-import';

const fmtSize = (bytes: number): string => {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
};

export const InstalledModelsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [installed, setInstalled] = useState<LocalModelsListResponse | null>(null);
  /** Engine catalog, for display names + which engines take a launch profile
   *  (ADR-0039: this page names no engine). */
  const [engines, setEngines] = useState<LocalEngineCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Import-from-disk row (paste an absolute .gguf file or folder path). */
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Engine build jobs (ADR-0039 §9) — a building one spins the row's Pack button. */
  const [builds, setBuilds] = useState<LocalBuildJob[]>([]);
  /** Client-side filter for the model list (filename / repo / quant). */
  const [query, setQuery] = useState('');
  /** Inline rename state (ADR-0038 §7): the row being named + the draft. An
   *  empty draft on save CLEARS the name (the file stem becomes the display
   *  identity again). */
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  /** Ids of jobs SEEN mid-build; their exit is what triggers the verdict refresh. */
  const buildingRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setInstalled(await api.getLocalModels());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refreshBuilds = useCallback(async () => {
    try {
      const data = await api.listLocalBuilds();
      setBuilds(data.jobs);
    } catch {
      // A transient poll failure keeps the previous view.
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.getLocalEngines().then((res) => setEngines(res.engines)).catch(() => undefined);
    void refreshBuilds();
  }, [refresh, refreshBuilds]);

  // Poll while any build is live.
  useEffect(() => {
    if (!builds.some((b) => b.status === 'building')) return;
    const timer = setInterval(() => void refreshBuilds(), 2000);
    return () => clearInterval(timer);
  }, [builds, refreshBuilds]);

  // A finished build flipped the model's verdict server-side (rescanModelMeta):
  // refresh the rows so the Pack button becomes the Run button.
  useEffect(() => {
    const seen = buildingRef.current;
    for (const job of builds) {
      if (job.status === 'building') {
        seen.add(job.id);
        continue;
      }
      if (!seen.has(job.id)) continue;
      seen.delete(job.id);
      if (job.status === 'done') toast.success(t('localModels.packDone'));
      else toast.error(job.error || t('localModels.runBuildFailed'));
      void refresh();
    }
  }, [builds, refresh, toast, t]);

  /** Pack from the models page (ADR-0039 §9): the engine builds the launch
   *  input it derived as missing (Strata: the pack); Run stays a separate
   *  click that appears once the rescan flips the verdict. */
  const startPack = async (model: LocalInstalledModel, engineId: string) => {
    const result = await api.startLocalBuild({ modelId: model.id, engine: engineId });
    if (result.status !== 'ok' || !result.job) {
      toast.error(result.message || t('localModels.runBuildFailed'));
      return;
    }
    toast.success(t('localModels.packStarted'));
    await refreshBuilds();
  };

  const engineName = useCallback(
    (id: string): string => engines.find((engine) => engine.id === id)?.name ?? id,
    [engines]
  );


  const removeModel = async (model: LocalInstalledModel) => {
    const ok = await confirmDialog({
      title: t('localModels.modelRemoveConfirmTitle'),
      description: `${model.filename} · ${fmtSize(model.size)}`,
      confirmLabel: t('localModels.modelRemove'),
    });
    if (!ok) return;
    const result = await api.removeLocalModel(model.id);
    if (result.status === 'ok') {
      toast.success(t('localModels.modelRemoved'));
      void refresh();
    } else {
      toast.error(result.message || t('localModels.modelDownloadFailed'));
    }
  };

  const models = installed?.models ?? [];
  // Filter over every field a row shows — filename, operator name, repo,
  // quant and the header name — so a pasted model name lands on its whole
  // quant family.
  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      `${m.filename} ${m.name ?? ''} ${m.repo} ${m.quant ?? ''} ${m.meta?.name ?? ''}`.toLowerCase().includes(q)
    );
  }, [models, query]);

  /** Save (or clear, on an empty draft) the operator name of one row. The
   *  backend answer carries the re-registered gateway id and the config spots
   *  that still reference the OLD id (tier rules / combos / key access /
   *  settings) — the rename is applied, the references are a loud warning,
   *  never a silent rewrite (ADR-0038 §7). */
  const saveRename = async (model: LocalInstalledModel) => {
    if (renaming) return;
    setRenaming(true);
    try {
      const result = await api.setLocalModelName(model.id, renameDraft.trim());
      if (result.status !== 'ok' || !result.model) {
        toast.error(result.message || t('localModels.modelNameFailed'));
        return;
      }
      const updated = result.model;
      setInstalled((prev) =>
        prev ? { ...prev, models: prev.models.map((m) => (m.id === updated.id ? updated : m)) } : prev
      );
      setRenameId(null);
      const refs = result.references ?? [];
      if (refs.length > 0 && result.previousGatewayId && result.previousGatewayId !== result.gatewayId) {
        toast.info(
          t('localModels.modelNameRefsWarning', {
            n: refs.length,
            from: result.previousGatewayId,
            to: result.gatewayId ?? '',
          })
        );
      } else {
        toast.success(t('localModels.modelNameSaved'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(false);
    }
  };

  /** Import one .gguf file or a folder of them from this machine. */
  const runImport = async () => {
    const target = importPath.trim();
    if (!target || importing) return;
    setImporting(true);
    try {
      const result = await api.importLocalModels(target);
      if (result.imported.length > 0) {
        toast.success(t('localModels.importDone', { n: result.imported.length }));
        setShowImport(false);
        setImportPath('');
        void refresh();
      } else if (result.skipped > 0) {
        toast.info(t('localModels.importDuplicate'));
      } else {
        toast.error(result.errors[0] || t('localModels.importNoneFound'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{t('localModels.installedTitle')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {installed && installed.diskUsageBytes > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                <HardDrive size={12} />
                {t('localModels.diskUsage')}: {fmtSize(installed.diskUsageBytes)}
              </span>
            )}
            <button className="btn btn-sm btn-primary" style={{ flexShrink: 0 }} onClick={() => setShowImport((v) => !v)}>
              <FolderPlus size={13} />
              <span>{t('localModels.importAction')}</span>
            </button>
          </div>
        </div>

        {showImport && (
          <div
            style={{ display: 'flex', gap: 10, alignItems: 'center' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !importing) void runImport();
            }}
          >
            <SearchInput value={importPath} onChange={setImportPath} placeholder={t('localModels.importPlaceholder')} />
            <button className="btn" style={{ height: 36, flexShrink: 0 }} onClick={() => setPickerOpen(true)}>
              <FolderOpen size={14} />
              <span>{t('localModels.browse')}</span>
            </button>
            <button className="btn btn-primary" style={{ height: 36, flexShrink: 0, minWidth: 76, justifyContent: 'center' }} onClick={() => void runImport()} disabled={importing}>
              {importing ? <Loader2 size={14} style={SPIN} /> : <FolderPlus size={14} />}
              <span>{t('localModels.importAction')}</span>
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            <PackageOpen size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
            …
          </div>
        ) : models.length === 0 ? (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.installedNone')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Search box on any non-empty list: even a handful of models
                benefits from paste-to-filter (drop a filename, land on its
                quant family). */}
            <SearchInput value={query} onChange={setQuery} placeholder={t('localModels.installedSearchPlaceholder')} style={{ maxWidth: 360 }} />
            {visibleModels.length === 0 ? (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.installedSearchEmpty')}</div>
            ) : null}
            {visibleModels.map((model) => {
              /* Family-locked engines that CANNOT serve yet: the family match
                 is what makes them worth offering, the `?` names the gap
                 (ADR-0039 §8). A serving engine is already named by the
                 runnable badges — rendering it here too would duplicate it. */
              const gapEngines = engines.filter((engine) => {
                const verdict = model.meta?.engines?.[engine.id];
                return verdict?.family === true && verdict.serves !== true;
              });
              const hasBadges =
                !!model.quant || (model.meta?.runnable.length ?? 0) > 0 || !!model.meta?.moe || gapEngines.length > 0;
              return (
              <div key={model.id} className="sub-card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }}>
                {/* Family mark from the repo/filename (Qwen, DeepSeek, Llama …)
                    so a long quant list scans by shape; unmapped names fall
                    back to the initial-letter chip. Sized to span BOTH text
                    lines (title + tertiary meta). */}
                <ModelFamilyLogo
                  repo={model.repo}
                  filename={model.filename}
                  metaName={model.meta?.name}
                  metaArch={model.meta?.arch}
                  size={40}
                />
                <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {renameId === model.id ? (
                    /* Inline rename (ADR-0038 §7): Enter saves, Escape cancels,
                       an empty value clears the name. */
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(model);
                        if (e.key === 'Escape') setRenameId(null);
                      }}
                    >
                      <input
                        className="input"
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        placeholder={t('localModels.modelNamePlaceholder')}
                        spellCheck={false}
                        style={{ flex: '1 1 180px', minWidth: 0, height: 28, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                      />
                      <button className="btn btn-sm btn-primary" style={{ flexShrink: 0 }} disabled={renaming} onClick={() => void saveRename(model)}>
                        {renaming ? <Loader2 size={12} style={SPIN} /> : <span>{t('localModels.modelNameSave')}</span>}
                      </button>
                      <button className="btn btn-sm" style={{ flexShrink: 0 }} disabled={renaming} onClick={() => setRenameId(null)}>
                        <span>{t('common.cancel')}</span>
                      </button>
                    </div>
                  ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {/* The primary id (ADR-0038 §7): a NAMED model leads with
                        its operator name — the name IS the gateway id
                        (`local/<name>`, hover shows it), so it owns the title
                        spot and the file drops to the tertiary line below. An
                        unnamed model keeps the filename as its title. */}
                    <span
                      style={{ fontSize: 'var(--text-sm)', fontWeight: 600, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0, maxWidth: '44ch' }}
                      title={model.name ? localModelGatewayId(model) : model.filePath}
                    >
                      {model.name ?? model.filename}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flexShrink: 0, minHeight: 0, padding: '1px 6px' }}
                      title={t('localModels.modelNameAction')}
                      onClick={() => {
                        setRenameId(model.id);
                        setRenameDraft(model.name ?? '');
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                  )}
                  {/* A NAMED model's file is its own tertiary line (ADR-0038
                      §7): the name took the title spot, and folding the file
                      into the source/size/date line would make it run long.
                      Hover shows the full path. */}
                  {model.name && (
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={model.filePath}>
                      {model.filename}
                    </div>
                  )}
                  {/* Tertiary meta line — deliberately smaller and dimmer than
                      a subtitle. The source slot says HOW the model got here
                      (downloaded via the registry vs imported from disk); a
                      downloaded row keeps its repo id on hover. */}
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }} title={model.repo === IMPORT_REPO ? undefined : model.repo}>
                    {model.repo === IMPORT_REPO ? t('localModels.importedRepo') : t('localModels.downloadedRepo')} · {fmtSize(model.size)} · {formatTimestamp(model.downloadedAt)}
                  </div>
                  {gapEngines.map((engine) => {
                    const verdict = model.meta?.engines?.[engine.id];
                    if (!verdict?.reason || verdict.buildable) return null;
                    return (
                      <div key={engine.id} style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={verdict.reason}>
                        {engine.name}: {verdict.reason}
                      </div>
                    );
                  })}
                </div>
                {/* Badge cluster: a ROW-level flex item, so the row's own
                    center alignment centers it across BOTH text lines, and it
                    sits right-aligned beside the action buttons as one
                    straight column for every row. */}
                {hasBadges && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0, maxWidth: '38%' }}>
                    {model.quant && <span className="badge" style={{ fontSize: 'var(--text-2xs)' }}>{model.quant}</span>}
                    {/* Runnable-engine badges: which engines can serve this
                        file, straight from the verdict block of the header scan. */}
                    {model.meta?.runnable.map((engine) => (
                      <span key={engine} className="badge badge-success" style={{ fontSize: 'var(--text-2xs)' }}>
                        {engineName(engine)}
                      </span>
                    ))}
                    {model.meta?.moe && (
                      <span
                        className="badge"
                        style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-violet)', borderColor: 'var(--accent-violet)' }}
                        title={t('localModels.moeHint')}
                      >
                        MoE{model.meta.experts ? ` · ${model.meta.expertsUsed ?? '?'}⁄${model.meta.experts}` : ''}
                      </span>
                    )}
                    {gapEngines.map((engine) => {
                      const verdict = model.meta?.engines?.[engine.id];
                      return (
                      <span
                        key={engine.id}
                        className="badge"
                        style={{ fontSize: 'var(--text-2xs)' }}
                        title={verdict?.reason || t('localModels.strataProfileMissing')}
                      >
                        {engine.name}{verdict?.buildable ? '' : ' ?'}
                      </span>
                      );
                    })}
                  </div>
                )}
                {/* Missing-pack engines (ADR-0039 §9): the verdict says the
                    only gap is an artefact the engine builds itself, so the
                    row offers the build right here — import → Pack → Run. */}
                {engines
                  .filter((engine) => model.meta?.engines?.[engine.id]?.buildable === true)
                  .map((engine) => {
                    const building = builds.some(
                      (b) => b.modelId === model.id && b.engine === engine.id && b.status === 'building'
                    );
                    return (
                      <button
                        key={engine.id}
                        className="btn btn-sm"
                        style={{ flexShrink: 0 }}
                        disabled={building}
                        onClick={() => void startPack(model, engine.id)}
                      >
                        {building ? <Loader2 size={12} style={SPIN} /> : <Hammer size={12} />}
                        <span>{building ? t('localModels.runBuilding') : t('localModels.packAction')}</span>
                      </button>
                    );
                  })}
                {(model.meta?.runnable.length ?? 0) > 0 && (
                  /* Navigation only: the row lands on the run page with the
                     model preselected, and the LAUNCH stays an explicit click
                     there (the planner's automatic parameter set is already
                     the default, so nothing is lost by the extra step). */
                  <Link
                    to={`/local-run?model=${encodeURIComponent(model.id)}`}
                    className="btn btn-sm btn-primary"
                    style={{ flexShrink: 0, textDecoration: 'none' }}
                  >
                    <Play size={12} />
                    <span>{t('localModels.runAction')}</span>
                  </Link>
                )}
                <button className="btn btn-sm" onClick={() => void removeModel(model)} style={{ flexShrink: 0 }}>
                  <Trash2 size={12} />
                  <span>{t('localModels.modelRemove')}</span>
                </button>
              </div>
              );
            })}
          </div>
        )}
        </div>
      </div>
      <FilePickerModal
        open={pickerOpen}
        mode="gguf"
        initialPath={importPath}
        onPick={(p) => {
          setImportPath(p);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
};
