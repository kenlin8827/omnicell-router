/**
 * Run Monitor — the concurrency board for live local runs (ADR-0040).
 *
 * `/local-run` answers "start this model"; this page answers "what is happening
 * right now" and sits LAST in the Local group for that reason: it observes what
 * the rows above it configured and launched. The nav label says "run", not
 * "machine" — this board monitors runs and their request counters, and no GPU
 * or VRAM sampler is involved (ADR-0040 §5). every run the gateway knows, with the counters counted ON the
 * request path by the `local` provider decorator. Nothing here is scraped from
 * an engine's own `/metrics` (ADR-0040 §1) — the gateway is the only party that
 * sees a local call, so its numbers are the traffic, not an approximation.
 *
 * The page polls one endpoint while anything is live and stops polling when
 * nothing is, so an idle console does not tick forever for an empty board.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ChevronDown, ChevronRight, ChevronUp, Cpu, Gauge, Loader2, Play, ScrollText, Server, Trash2 } from 'lucide-react';
import {
  api,
  type LocalEngineCatalogRow,
  type LocalInstalledModel,
  type LocalMonitorResponse,
  type LocalMonitorRow,
  type LocalRateSample,
  type LocalRun,
  type LocalRunLogLine,
} from '../lib/api';
import { localModelDisplayName } from '../lib/local-model';
import { localRunErrorMessage, localRunStatusLabel } from '../lib/local-run-error';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { fmtLatency, formatRate } from '../lib/format';

/** Spinner keyframes (the launcher's own constant; a delete in flight uses it). */
const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

/** Poll cadence while any run is live (the launcher's own 2s cadence, settled
 *  by the same reasoning: fast enough to watch a request land). */
const LIVE_POLL_MS = 2000;
/** Idle cadence: a board with nothing running still notices the first launch. */
const IDLE_POLL_MS = 10_000;

/** Status → the badge class that carries its colour. */
function statusClass(status: LocalRun['status']): string {
  if (status === 'ready') return 'badge badge-success';
  if (status === 'starting' || status === 'stopping') return 'badge badge-warning';
  if (status === 'failed') return 'badge badge-danger';
  return 'badge';
}

/** Count label: exact below 10k, compact above (a long-run board must not
 *  widen its columns). */
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const compactCount = (n: number): string => (n >= 10_000 ? COMPACT.format(n) : n.toLocaleString('en-US'));

const Figure: React.FC<{ label: string; value: string; hint?: string; accent?: boolean }> = ({ label, value, hint, accent }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-label)' }}>
      {label}
    </span>
    <span
      style={{
        fontVariantNumeric: 'tabular-nums',
        fontSize: 'var(--text-md)',
        fontWeight: 'var(--font-semibold)',
        color: accent ? 'var(--accent-teal, var(--accent))' : 'var(--text)',
        whiteSpace: 'nowrap',
      }}
      title={hint}
    >
      {value}
    </span>
  </div>
);

/** A rolling rate: the latest sample is the headline, the average rides the
 *  tooltip with its sample count (ADR-0040 §3 — one number cannot answer both
 *  "right now" and "in general"). */
function rateValue(sample: LocalRateSample | null, unit: 'rate' | 'latency'): string {
  if (!sample) return '—';
  if (unit === 'rate') return formatRate(sample.last);
  return fmtLatency(sample.last);
}

function rateHint(t: (k: string, vars?: Record<string, string | number>) => string, sample: LocalRateSample | null, unit: 'rate' | 'latency'): string | undefined {
  if (!sample || sample.samples < 2) return undefined;
  const avg = unit === 'rate' ? formatRate(sample.avg) : fmtLatency(sample.avg);
  return t('localMonitor.rateHint', { avg, n: sample.samples });
}

const RunCard: React.FC<{
  row: LocalMonitorRow;
  modelName: string | null;
  engineName: string;
  onStop: (run: LocalRun) => void;
  stopping: boolean;
  /** Only history rows offer it: a live run's record owns its process, so the
   *  backend refuses the delete (409 `run-live`) until it is stopped. */
  onDelete?: (run: LocalRun) => void;
  deleting?: boolean;
}> = ({ row, modelName, engineName, onStop, stopping, onDelete, deleting }) => {
  const { t } = useI18n();
  const { run, stats } = row;
  const live = run.status === 'ready' || run.status === 'starting';
  // An ended run keeps its in-memory log ring until a prune, so the board can
  // still show WHY it ended. Fetched on expand, never polled — the ring of an
  // ended run is final.
  const [showLogs, setShowLogs] = useState(false);
  const [logLines, setLogLines] = useState<LocalRunLogLine[]>([]);
  // uptime is a LIVE figure: a stopped/failed run reports the span it actually
  // ran (`stoppedAt`), never `now - startedAt` — the latter kept ticking on the
  // board for a run that had been down for hours (ADR-0040: an observation must
  // not describe a process that is gone as if it were still serving).
  const endAt = live ? Date.now() : (run.stoppedAt ?? run.startedAt);
  const uptime = Math.max(0, endAt - (run.readyAt ?? run.startedAt));
  const errorCount = stats.errors;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Identity row: model, engine·target, endpoint, status. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-md)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {modelName ?? run.modelId}
        </span>
        <span className="badge" style={{ fontSize: 'var(--text-2xs)' }}>
          {engineName} · {run.target}
        </span>
        <span className={statusClass(run.status)} style={{ fontSize: 'var(--text-2xs)' }} title={run.status}>
          {localRunStatusLabel(run.status, t)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          :{run.port}
        </span>
        {(run.status === 'ready' || run.status === 'starting') && (
          <button className="btn btn-sm" onClick={() => onStop(run)} disabled={stopping}>
            {stopping ? t('localMonitor.stopping') : t('localModels.runStop')}
          </button>
        )}
        {onDelete && !live && (
          <button
            className="btn btn-sm"
            style={{
              color: 'var(--accent-rose, var(--danger))',
              // Icon and label are centred as one unit inside a fixed-height
              // row: the button's own box is stretched by the tabular-nums
              // `:{port}` sibling, so centring must happen HERE, not on the
              // button's line box (which is where the glyph was riding high).
              display: 'inline-flex', alignItems: 'center', gap: 5, lineHeight: 1,
            }}
            onClick={() => onDelete(run)}
            disabled={deleting}
            title={t('localMonitor.deleteHint')}
          >
            {deleting ? <Loader2 size={12} style={SPIN} /> : <Trash2 size={12} />}
            <span>{t('localMonitor.delete')}</span>
          </button>
        )}
      </div>

      {/* Lifecycle line: uptime, restarts, aux legs, last error. */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
        <span>
          {live ? t('localMonitor.uptime') : t('localMonitor.ranFor')} {fmtLatency(uptime)}
        </span>
        <span aria-hidden>·</span>
        <span>{t('localMonitor.restarts')} {run.restarts}</span>
        {run.ctx > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>ctx {run.ctx >= 1024 ? `${Math.round(run.ctx / 1024)}K` : run.ctx}</span>
          </>
        )}
        {run.ngl >= 0 && (
          <>
            <span aria-hidden>·</span>
            <span>ngl {run.ngl}</span>
          </>
        )}
        {(run.aux ?? []).length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>
              {run.aux!.map((aux) => `${aux.name} ${aux.pid != null ? '✓' : '✗'}`).join(' · ')}
            </span>
          </>
        )}
      </div>

      {localRunErrorMessage(run, t) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 'var(--text-xs)', color: 'var(--accent-rose, var(--danger))' }}>
          <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ wordBreak: 'break-word' }}>{localRunErrorMessage(run, t)}</span>
        </div>
      )}

      {/* The counters: what the board exists for. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
          gap: 12,
          padding: '10px 0 0',
          borderTop: '1px solid var(--divider)',
        }}
      >
        <Figure
          label={t('localMonitor.inFlight')}
          value={String(stats.inFlight)}
          accent={stats.inFlight > 0}
          hint={t('localMonitor.inFlightHint')}
        />
        <Figure label={t('localMonitor.requests')} value={compactCount(stats.requests)} />
        <Figure
          label={t('localMonitor.errors')}
          value={compactCount(errorCount)}
          accent={errorCount === 0 && stats.requests > 0}
        />
        <Figure label={t('localMonitor.outputTokens')} value={compactCount(stats.outputTokens)} />
        <Figure label={t('localMonitor.inputTokens')} value={compactCount(stats.inputTokens)} />
        <Figure
          label={t('localMonitor.decode')}
          value={rateValue(stats.decodeTps, 'rate')}
          hint={rateHint(t, stats.decodeTps, 'rate')}
        />
        <Figure
          label={t('localMonitor.ttft')}
          value={rateValue(stats.ttftMs, 'latency')}
          hint={stats.ttftMs ? (stats.bufferedOnly ? t('localMonitor.ttftBuffered') : rateHint(t, stats.ttftMs, 'latency')) : undefined}
        />
      </div>

      {stats.requests === 0 && live && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localMonitor.noTraffic')}</div>
      )}

      {/* Ended-run log drawer: the engine's own words survive the failure in
          memory, so a failed launch is debuggable from the history card too. */}
      {!live && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              setShowLogs((v) => !v);
              if (!showLogs) {
                void api.getLocalRunLogs(run.id).then((res) => setLogLines(res.lines)).catch(() => undefined);
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--text-xs)', alignSelf: 'flex-start' }}
          >
            {showLogs ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <ScrollText size={13} />
            <span>{t('localModels.runLogs')}</span>
          </button>
          {showLogs && (
            <div
              className="sub-card"
              style={{ padding: '8px 12px', maxHeight: 260, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
            >
              {logLines.length === 0 ? (
                <span style={{ color: 'var(--text-dim)' }}>{t('localModels.runLogsEmpty')}</span>
              ) : (
                logLines.map((line) => (
                  <div key={line.id} style={{ color: line.stream === 'stderr' ? 'var(--accent-amber)' : line.stream === 'gateway' ? 'var(--text-dim)' : 'var(--text-main)' }}>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const LocalMonitorPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [data, setData] = useState<LocalMonitorResponse | null>(null);
  const [models, setModels] = useState<LocalInstalledModel[]>([]);
  const [engines, setEngines] = useState<LocalEngineCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Set when the gateway predates the monitor route (404) — the page says so
   *  instead of rendering an empty board that looks like "nothing runs". */
  const [unsupported, setUnsupported] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  /** Per-row delete in flight, and the bulk "clear history" flag. */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  /** History is OFF by default: this page answers "what is happening NOW", and
   *  the registry keeps every ended run until it is pruned, so showing them all
   *  buried the one live run under a growing pile of stopped cards. */
  const [showHistory, setShowHistory] = useState(false);
  /** Tick so the uptime line advances between polls. It only runs while
   *  something is live — an idle board has nothing that changes with time. */
  const [, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      setData(await api.getLocalMonitor());
      setUnsupported(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\b404\b/.test(message)) setUnsupported(true);
      // A transient poll failure keeps the previous board (same rule as the
      // launcher's run poll).
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, e] = await Promise.all([api.getLocalModels(), api.getLocalEngines()]);
        if (cancelled) return;
        setModels(m.models);
        setEngines(e.engines);
      } catch {
        // Names are cosmetic: the board still renders run ids.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasLive = useMemo(
    () => (data?.runs ?? []).some((row) => row.run.status === 'starting' || row.run.status === 'ready' || row.run.status === 'stopping'),
    [data]
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), hasLive ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, hasLive]);

  // The uptime tick exists only for LIVE rows; with nothing running there is
  // nothing to advance, and a permanent 1s re-render was just churn.
  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasLive]);

  const modelNameOf = useCallback(
    (modelId: string): string | null => {
      const model = models.find((m) => m.id === modelId);
      return model ? localModelDisplayName(model) : null;
    },
    [models]
  );

  const engineNameOf = useCallback(
    (engineId: string): string => engines.find((e) => e.id === engineId)?.name ?? engineId,
    [engines]
  );

  const stopRun = useCallback(
    async (run: LocalRun) => {
      const name = modelNameOf(run.modelId) ?? run.modelId;
      const ok = await confirmDialog({
        title: t('localMonitor.stopTitle'),
        description: t('localMonitor.stopDesc', { name }),
        confirmLabel: t('localModels.runStop'),
        danger: true,
      });
      if (!ok) return;
      setStoppingId(run.id);
      try {
        const result = await api.stopLocalRun(run.id);
        if (result.status !== 'ok') toast.error(result.message || t('localModels.runStopFailed'));
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('localModels.runStopFailed'));
      } finally {
        setStoppingId(null);
      }
    },
    [confirmDialog, modelNameOf, refresh, t, toast]
  );

  /** Delete ONE history record. `not-found` is success in effect: the row is
   *  already gone, so the board just re-reads instead of showing an error. */
  const deleteRun = useCallback(
    async (run: LocalRun) => {
      const name = modelNameOf(run.modelId) ?? run.modelId;
      const ok = await confirmDialog({
        title: t('localMonitor.deleteTitle'),
        description: t('localMonitor.deleteDesc', { name }),
        confirmLabel: t('localMonitor.delete'),
        danger: true,
      });
      if (!ok) return;
      setDeletingId(run.id);
      try {
        const result = await api.deleteLocalRun(run.id);
        if (result.status !== 'ok' && result.code !== 'not-found') {
          // Refusals are CLASSES too: a live run's record cannot be deleted, and
          // that must not surface as an English backend sentence.
          const key = result.code === 'run-live' ? 'localMonitor.deleteErrRunLive'
            : result.code === 'not-found' ? 'localMonitor.deleteErrNotFound'
            : null;
          toast.error(key ? t(key) : result.error || t('localMonitor.deleteFailed'));
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('localMonitor.deleteFailed'));
      } finally {
        setDeletingId(null);
      }
    },
    [confirmDialog, modelNameOf, refresh, t, toast]
  );

  /** Clear the whole history in one go. */
  const clearHistory = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('localMonitor.historyClearAll'),
      description: t('localMonitor.clearAllDesc'),
      confirmLabel: t('localMonitor.delete'),
      danger: true,
    });
    if (!ok) return;
    setClearingHistory(true);
    try {
      const result = await api.pruneLocalRuns();
      if (result.status !== 'ok') toast.error(t('localMonitor.deleteFailed'));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('localMonitor.deleteFailed'));
    } finally {
      setClearingHistory(false);
    }
  }, [confirmDialog, refresh, t, toast]);

  if (loading) {
    return <div className="pane-section"><div className="pane-section-scroll"><div className="card">{t('common.loading')}</div></div></div>;
  }

  if (unsupported) {
    return (
      <div className="pane-section">
        <div className="pane-section-scroll">
          <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-dim)' }}>
            <AlertTriangle size={14} />
            <span>{t('localMonitor.unsupported')}</span>
          </div>
        </div>
      </div>
    );
  }

  const rows = data?.runs ?? [];
  // Active = the run can still answer (or is on its way). Everything else is
  // history: it keeps its record until pruned, but it is NOT "what is
  // happening now" — that was the bug that left stopped runs on the board.
  const activeRows = rows.filter((row) => row.run.status === 'starting' || row.run.status === 'ready' || row.run.status === 'stopping');
  const historyRows = rows.filter((row) => !activeRows.includes(row));
  const summary = data?.summary ?? null;

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        {/* Summary strip: the whole-machine answer at a glance. */}
        <div className="card" style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Activity size={15} style={{ color: 'var(--accent)' }} />
            <span style={{ fontWeight: 'var(--font-semibold)' }}>{t('localMonitor.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', flex: 1 }}>
            <Figure label={t('localMonitor.liveRuns')} value={String(summary?.liveRuns ?? 0)} accent={(summary?.liveRuns ?? 0) > 0} />
            <Figure label={t('localMonitor.inFlight')} value={String(summary?.inFlight ?? 0)} accent={(summary?.inFlight ?? 0) > 0} />
            <Figure label={t('localMonitor.totalRuns')} value={String(summary?.totalRuns ?? 0)} />
            {summary && (
              <Figure
                label={t('localMonitor.gatewayPort')}
                value={String(summary.gatewayPort)}
                hint={t('localMonitor.gatewayPortHint')}
              />
            )}
          </div>
          <Link to="/local-run" className="btn btn-sm" style={{ textDecoration: 'none' }}>
            <Play size={13} />
            <span>{t('localModels.runAction')}</span>
          </Link>
        </div>

        {activeRows.length === 0 ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', padding: '28px 16px', color: 'var(--text-dim)' }}>
            <Gauge size={22} />
            <span>{t('localMonitor.empty')}</span>
            <Link to="/local-run" className="btn btn-sm" style={{ textDecoration: 'none' }}>
              <Play size={13} />
              <span>{t('localModels.runAction')}</span>
            </Link>
          </div>
        ) : (
          activeRows.map((row) => (
            <RunCard
              key={row.run.id}
              row={row}
              modelName={modelNameOf(row.run.modelId)}
              engineName={engineNameOf(row.run.engine)}
              onStop={(run) => void stopRun(run)}
              stopping={stoppingId === row.run.id}
            />
          ))
        )}

        {/* History: ended runs stay in the registry until pruned, but they are
            not "what is happening now" — collapsed behind a toggle. */}
        {historyRows.length > 0 && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start', lineHeight: 1 }}
              onClick={() => setShowHistory((v) => !v)}
              aria-expanded={showHistory}
            >
              <span>{t('localMonitor.history', { n: historyRows.length })}</span>
              {/* A real chevron, not the `⌃` / `⌄` glyphs: those are ordinary
                  TEXT in whatever font resolves them, so their baseline and
                  cap height disagreed with the CJK label beside them and the
                  arrow sat visibly off-centre. An svg has a definite box, and
                  with `lineHeight: 1` on the button the flex row centres the
                  two together. */}
              {showHistory ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {showHistory &&
              historyRows.map((row) => (
                <RunCard
                  key={row.run.id}
                  row={row}
                  modelName={modelNameOf(row.run.modelId)}
                  engineName={engineNameOf(row.run.engine)}
                  onStop={(run) => void stopRun(run)}
                  stopping={stoppingId === row.run.id}
                  onDelete={(run) => void deleteRun(run)}
                  deleting={deletingId === row.run.id}
                />
              ))}
            {showHistory && historyRows.length > 1 && (
              <button
                className="btn btn-sm btn-danger"
                style={{ alignSelf: 'flex-start' }}
                disabled={clearingHistory}
                onClick={() => void clearHistory()}
              >
                {clearingHistory ? <Loader2 size={12} style={SPIN} /> : <Trash2 size={12} />}
                <span>{t('localMonitor.historyClearAll')}</span>
              </button>
            )}
          </div>
        )}

        {/* Where clients should point: the gateway, never the engine's port. */}
        {summary && activeRows.some((row) => row.run.status === 'ready') && (
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            <Server size={13} />
            <span>{t('localMonitor.clientHint', { port: summary.gatewayPort })}</span>
          </div>
        )}

        {/* The counters are process-local; say so rather than implying lifetimes. */}
        {activeRows.some((row) => row.stats.requests > 0) && (
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
            <Cpu size={12} />
            <span>{t('localMonitor.windowHint')}</span>
          </div>
        )}
      </div>
    </div>
  );
};