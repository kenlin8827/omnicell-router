import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, RefreshCw, Database, ChevronDown, Check } from 'lucide-react';
import { Drawer } from './Drawer';
import { Dialog } from './Dialog';
import { Switch } from './Switch';
import { Combobox } from './Combobox';
import { Pagination } from './Pagination';
import { api, SourceOutcomeError, type HarnessCatalogSource, type HarnessMarketplaceEntry, type SourceReason } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from './ConfirmProvider';
import { RUNTIME_BADGE, type McpRuntimeVerdict } from '../lib/mcp-runtime';
import { needsHostDetection } from '../lib/harness-source-gate';

/**
 * Market source maintenance drawer (ADR-0015 §D9/§D10/§D11), ONE AXIS AT A TIME.
 *
 * The open tab decides everything: a PLUGIN source is per-harness (that harness's defaults, its
 * layer-scoped entries, host sync) and talks to `/plugins/:harness/sources*`; a SKILL source is
 * GLOBAL (ClawHub plus operator Git repositories that publish SKILL.md) and talks to
 * `/skills/sources*`, with no harness scope and no host plumbing. The axes never share a list.
 */
/**
 * Dual-mode catalog picker: allows typing any custom catalog or selecting
 * from existing catalogs via a dropdown menu.
 */
const CatalogPicker: React.FC<{
  value: string;
  onChange?: (v: string) => void;
  onCommit?: (v: string) => void;
  options: string[];
  placeholder?: string;
  onEnter?: () => void;
  compact?: boolean;
}> = ({ value, onChange, onCommit, options, placeholder, onEnter, compact }) => {
  const [internalVal, setInternalVal] = useState(value);
  const [open, setOpen] = useState(false);
  /** Idle display is localized (the catalog label); focus swaps in the raw wire value ("default")
   *  so the operator edits what actually gets persisted — the display label never round-trips. */
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  useEffect(() => {
    setInternalVal(value);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const formatOption = (opt: string) => {
    if (opt === 'default') return t('harness.srcMgmt.defaultCatalog');
    if (opt === 'pi.dev') return t('harness.sourceNames.piDev');
    if (opt === 'ClawHub') return t('harness.sourceNames.clawhub');
    return opt;
  };

  const commitValue = (val: string) => {
    const trimmed = val.trim() || 'default';
    setInternalVal(trimmed);
    onChange?.(trimmed);
    onCommit?.(trimmed);
  };

  const height = compact ? '26px' : '34px';
  const fontSize = compact ? '11px' : '12px';

  return (
    <div ref={containerRef} style={{ position: 'relative', width: compact ? '100%' : '160px', minWidth: 0, flexShrink: 0 }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          className="input"
          style={{ width: '100%', fontSize, height, paddingRight: '24px', boxSizing: 'border-box' }}
          placeholder={placeholder}
          title={formatOption(internalVal) === internalVal ? t('harness.srcMgmt.catalog') : `${t('harness.srcMgmt.catalog')}: ${internalVal}`}
          value={editing ? internalVal : formatOption(internalVal)}
          onChange={(e) => {
            setInternalVal(e.target.value);
            onChange?.(e.target.value);
          }}
          onFocus={() => {
            setEditing(true);
            setOpen(true);
          }}
          onBlur={() => {
            setEditing(false);
            if (internalVal !== value) {
              commitValue(internalVal);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOpen(false);
              setEditing(false);
              commitValue(internalVal);
              onEnter?.();
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          style={{
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
          }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={compact ? 12 : 14} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s ease' }} />
        </button>
      </div>

      {open && options.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: '180px',
            maxWidth: '260px',
            maxHeight: '180px',
            overflowY: 'auto',
            background: 'var(--card-bg, #1e1e24)',
            border: '1px solid var(--divider)',
            borderRadius: '6px',
            boxShadow: '0 6px 16px rgba(0, 0, 0, 0.4)',
            zIndex: 100,
            padding: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', padding: '2px 6px' }}>
            {t('harness.detailCatalog')}
          </div>
          {options.map((opt) => {
            const isSelected = internalVal.trim() === opt;
            return (
              <button
                key={opt}
                type="button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: compact ? '4px 6px' : '5px 8px',
                  fontSize: compact ? 'var(--text-xs)' : 'var(--text-sm)',
                  borderRadius: '4px',
                  border: 'none',
                  background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  color: isSelected ? 'var(--primary, #3b82f6)' : 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => {
                  commitValue(opt);
                  setEditing(false);
                  setOpen(false);
                }}
              >
                <span>{formatOption(opt)}</span>
                {isSelected && <Check size={12} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const HarnessSourcesDrawer: React.FC<{
  harness: string;
  kind: 'skill' | 'plugin' | 'mcp';
  open: boolean;
  onClose: () => void;
  /** Fired after every successful source mutation (add/remove/enable/rescan/sync) so the host
   *  page can mark the market behind the drawer stale and refresh it when the drawer closes. */
  onChanged?: () => void;
  /** Live verdict for a SOURCE row (MCP only): the page resolves the landed artifact behind the
   *  package and answers with the worst runtime state among the hosts carrying it. Absent = no
   *  live claim (not installed, or the host exposes no state surface), never "healthy". */
  runtimeForEntry?: (entry: HarnessMarketplaceEntry) => McpRuntimeVerdict | undefined;
}> = ({ harness, kind, open, onClose, onChanged, runtimeForEntry }) => {
  /** The skill axis is GLOBAL (ADR-0015 §D11): it has its own route, no harness scope and no
   *  host-sync/type pickers — a skill source is a Git repository of SKILL.md, shared by all agents. */
  const isSkill = kind === 'skill';
  /** The MCP axis: operator sources are packages (`npm` / `PyPI`) of MCP servers, one per source. */
  const isMcp = kind === 'mcp';
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const [sources, setSources] = useState<HarnessCatalogSource[]>([]);
  const [entries, setEntries] = useState<HarnessMarketplaceEntry[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageEntries = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return entries.slice(start, start + pageSize);
  }, [entries, safePage, pageSize]);
  /** Which source types this axis accepts. The skill axis is GitHub-only; the plugin axis offers a
   *  repository or an npm package; the MCP axis offers PACKAGES only (npm / PyPI), because an MCP
   *  server is a package the runtime launches — a repository is not an install handle there. */
  const supportedTypes: ('github' | 'npm' | 'pypi')[] = isSkill ? ['github'] : isMcp ? ['npm', 'pypi'] : ['github', 'npm'];
  const [url, setUrl] = useState('');
  const defaultType: 'github' | 'npm' | 'pypi' = isSkill ? 'github' : isMcp ? 'npm' : 'github';
  const [sourceType, setSourceType] = useState<'github' | 'npm' | 'pypi'>(defaultType);
  const [catalog, setCatalog] = useState('default');
  const [busy, setBusy] = useState<string | null>(null);

  const existingCatalogs = useMemo(() => {
    const set = new Set<string>(['default']);
    for (const s of sources) {
      if (s.catalog?.trim()) set.add(s.catalog.trim());
    }
    for (const e of entries) {
      if (e.catalog?.trim()) set.add(e.catalog.trim());
    }
    return Array.from(set);
  }, [entries, sources]);

  const [note, setNote] = useState('');
  /** Per-row rescan-interval drafts. Typing never persists: a PATCH fires only on blur/Enter, so
   *  half-typed minutes never become a stored schedule. */
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  /** Hosts the last check detected for the typed URL. The share choice exists ONLY when the
   *  repository serves several harnesses — a single-harness source pins here without asking. */
  const [checkedHosts, setCheckedHosts] = useState<string[]>([]);
  const [shareWithAll, setShareWithAll] = useState(false);
  /** The scope dialog: open only when the add-click probe found several supporting harnesses. */
  const [scopeAskOpen, setScopeAskOpen] = useState(false);

  /** The source table needs ~560px for its fixed control columns; below that the repo name would
   *  collapse to a couple of characters, so the rows fall back to a stacked layout and the column
   *  header (which would have nothing to label) is dropped. */
  const NARROW_TABLE_WIDTH = 560;
  const tableRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = tableRef.current;
    if (!open || !el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_TABLE_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
    // `entries.length` re-runs this the moment the table first mounts: the ref is null on open
    // whenever the list is still empty, and an observer cannot attach to a node that is not there.
  }, [open, entries.length]);

  const scope = harness || 'universal';

  const load = useCallback(async () => {
    if (!open) return;
    try {
      if (isSkill) {
        const res = await api.harnessSkillSources();
        setSources(res.sources ?? []);
        setEntries(res.operator ?? []);
        setSourceType('github');
        return;
      }
      const res = await api.harnessPluginSources(scope, kind);
      setSources(res.sources ?? []);
      setEntries(res.operator ?? []);
    } catch {
      setSources([]);
      setEntries([]);
    }
  }, [scope, kind, open, sourceType, isSkill]);

  useEffect(() => {
    if (!open) return;
    setNote('');
  }, [open, harness]);

  /** The type picker never points at a type the open axis cannot register (switching the tab
   *  resets it), so the next add cannot send `pypi` to the plugin axis or `github` to the MCP one. */
  useEffect(() => {
    setSourceType(defaultType);
  }, [defaultType]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const builtin = sources.filter((s) => !s.id.startsWith('mp-'));

  /** Built-in labels ship from the backend in English; the console's own names win when one exists. */
  const formatSourceLabel = (s: { id: string; label: string }) => {
    if (s.id === 'pi-dev') return t('harness.sourceNames.piDev');
    if (s.id === 'clawhub') return t('harness.sourceNames.clawhub');
    return s.label;
  };

  /**
   * Localized copy for a source outcome: the backend's `reason` + `params` pick the string, so the
   * console never echoes server English at the operator. The English `message` is only the fallback
   * for an outcome that has no template (and the detail appended to a failed probe).
   */
  const sourceNote = (reason?: SourceReason, params?: Record<string, string>, message?: string) => {
    const values: Record<string, string> = { ...(params ?? {}), ...(message ? { message } : {}) };
    const fill = (text: string) => Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), text);
    switch (reason) {
      case 'registered':
        return fill(t('harness.srcMgmt.srcRegistered'));
      case 'registered_scoped':
        return fill(t('harness.srcMgmt.srcRegisteredScoped'));
      case 'already_configured':
        if (values.harness && values.layer) return fill(t('harness.srcMgmt.srcAlreadyPinnedLayer'));
        if (values.harness) return fill(t('harness.srcMgmt.srcAlreadyPinned'));
        if (values.layer) return fill(t('harness.srcMgmt.srcAlreadyLayer'));
        return fill(t('harness.srcMgmt.srcAlreadyShared'));
      case 'slug_taken':
        return fill(t('harness.srcMgmt.srcSlugTaken'));
      case 'no_form':
        return fill(t('harness.srcMgmt.srcNoForm'));
      case 'not_a_repo':
        return fill(t('harness.srcMgmt.srcNotARepo'));
      case 'invalid_source':
        return fill(t('harness.srcMgmt.srcInvalidSource'));
      case 'invalid_layer':
        return fill(t('harness.srcMgmt.srcInvalidLayer'));
      case 'no_skill':
        return fill(t('harness.srcMgmt.srcNoSkill'));
      case 'probe_failed':
        return fill(t('harness.srcMgmt.srcProbeFailed'));
      case 'unsupported_here':
        return fill(t('harness.srcMgmt.srcUnsupportedHere'));
      default:
        return message ?? t('harness.srcMgmt.fail');
    }
  };

  const check = async () => {
    if (!url.trim() || busy !== null) return;
    setBusy('check');
    setNote('');
    try {
      if (isSkill) {
        setCheckedHosts([]);
        setShareWithAll(false);
        const res = await api.harnessSkillCheckSource(url.trim());
        setNote(
          res.ok
            ? t('harness.srcMgmt.checkSkillOk').replace('{skills}', String(res.skills))
            : sourceNote(res.reason, res.params, res.message),
        );
      } else {
        const res = await api.harnessPluginCheckSource(scope, url.trim(), { type: sourceType, kind });
        setCheckedHosts(res.ok ? (res.hosts ?? []) : []);
        setNote(
          res.ok
            ? isMcp
              ? t('harness.srcMgmt.checkMcpOk').replace('{count}', String(res.mcps))
              : `${t('harness.srcMgmt.checkOk')
                  .replace('{skills}', String(res.skills))
                  .replace('{mcps}', String(res.mcps))
                  .replace('{plugins}', String(res.plugins))} — ${t('harness.srcMgmt.hostsDetected')}: ${
                  res.hosts.length > 0 ? res.hosts.join(', ') : t('harness.srcMgmt.hostsNone')
                }`
            : sourceNote(res.reason, res.params, res.message),
        );
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  /** The actual registration, shared by the direct path (single-host) and the scope dialog's
   *  confirm button. Clears the form and refreshes the list on success. */
  const registerScoped = async () => {
    if (!url.trim() || busy !== null) return;
    setBusy('add');
    setNote('');
    try {
      if (isSkill) {
        const res = await api.harnessSkillRegisterSource(url.trim(), { catalog: catalog.trim() || 'default' });
        setNote(res.reason ? sourceNote(res.reason, res.params, res.message) : t('harness.srcMgmt.addOk'));
      } else {
        const res = await api.harnessPluginRegisterSource(scope, url.trim(), {
          type: sourceType,
          kind,
          catalog: catalog.trim() || 'default',
          ...(shareWithAll ? { shared: true } : {}),
        });
        setNote(res.reason ? sourceNote(res.reason, res.params, res.message) : t('harness.srcMgmt.addOk'));
      }
      setUrl('');
      setCatalog('default');
      setCheckedHosts([]);
      setShareWithAll(false);
      setScopeAskOpen(false);
      setPage(1); // a new entry lands on page 1 — never behind the operator's current page
      onChanged?.();
      await load();
    } catch (e) {
      setNote(e instanceof SourceOutcomeError ? sourceNote(e.reason, e.params, e.message) : e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!url.trim() || busy !== null) return;
    setBusy('add');
    setNote('');
    try {
      if (!isSkill) {
        // Phase 1 — probe before writing. The probe is skipped when Check already cached the
        // hosts this session; both the refusal (this harness unsupported) and the scope dialog
        // (several harnesses supported) are decided by the detected hosts either way, so a
        // Check-then-Add flow must reach the same gates. Package sources — an MCP npm/PyPI source
        // and an npm PLUGIN source alike — publish no form at all and take the direct path.
        let hosts = checkedHosts;
        if (hosts.length === 0) {
          const chk = await api.harnessPluginCheckSource(scope, url.trim(), { type: sourceType, kind });
          if (!chk.ok) {
            setNote(sourceNote(chk.reason, chk.params, chk.message));
            return;
          }
          hosts = chk.hosts ?? [];
        }
        // The gate and the scope dialog are FORM checks (ADR-0015 §D10), so only a repository
        // source runs them; `needsHostDetection` owns that rule for both axes.
        if (!isMcp && needsHostDetection(sourceType, url)) {
          setCheckedHosts(hosts);
          if (!hosts.includes(harness)) {
            setNote(sourceNote('unsupported_here', { hosts: hosts.join(', ') || 'none' }));
            return;
          }
          if (hosts.length > 1) {
            setScopeAskOpen(true);
            return;
          }
        }
      }
      await registerScoped();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (slug: string, enabled: boolean) => {
    setNote('');
    try {
      if (isSkill) await api.harnessSkillUpdateSource(slug, { enabled });
      else await api.harnessPluginUpdateSource(scope, slug, { enabled });
      setNote(t('harness.srcMgmt.updated').replace('{slug}', slug));
      onChanged?.();
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  const updateCatalog = async (slug: string, newCatalog: string) => {
    setNote('');
    try {
      if (isSkill) await api.harnessSkillUpdateSource(slug, { catalog: newCatalog.trim() || 'default' });
      else await api.harnessPluginUpdateSource(scope, slug, { catalog: newCatalog.trim() || 'default' });
      setNote(t('harness.srcMgmt.updated').replace('{slug}', slug));
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  const setRescan = async (slug: string, enabled: boolean, intervalMs: number) => {
    setNote('');
    try {
      if (isSkill) await api.harnessSkillUpdateSource(slug, { rescan: { enabled, intervalMs } });
      else await api.harnessPluginUpdateSource(scope, slug, { rescan: { enabled, intervalMs } });
      onChanged?.();
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  /** Persist one row's drafted interval (minutes → ms) and hand the field back to the stored value. */
  const commitInterval = (slug: string, enabled: boolean, intervalMs: number) => {
    const raw = intervalDrafts[slug];
    if (raw === undefined) return;
    const minutes = Math.max(Math.round(Number(raw)) || 0, 1);
    setIntervalDrafts((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    if (minutes * 60000 !== intervalMs) void setRescan(slug, enabled, minutes * 60000);
  };

  const rescan = async (slug: string) => {
    setBusy(`rescan:${slug}`);
    setNote('');
    try {
      const res = isSkill ? await api.harnessSkillRescanSource(slug) : await api.harnessPluginRescanSource(scope, slug);
      const diff = res.diff;
      setNote(
        diff
          ? t('harness.srcMgmt.rescanDiff')
              .replace('{added}', String(diff.added.length))
              .replace('{removed}', String(diff.removed.length))
              .replace('{rows}', String(res.rows))
          : t('harness.srcMgmt.rescanOk').replace('{rows}', String(res.rows)),
      );
      onChanged?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (slug: string) => {
    if (!(await confirmDialog({ title: t('harness.srcMgmt.removeConfirm').replace('{slug}', slug), danger: true }))) return;
    try {
      if (isSkill) await api.harnessSkillRemoveSource(slug);
      else await api.harnessPluginRemoveSource(scope, slug);
      await load();
      onChanged?.();
      setNote(t('harness.srcMgmt.removed').replace('{slug}', slug));
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  const syncHost = async () => {
    setBusy('syncHost');
    setNote('');
    try {
      const res = await api.harnessSyncHarnessMarketplaces(scope);
      setNote(
        `${t('harness.srcMgmt.syncOk')}: ${t('harness.srcMgmt.syncDiscovered')} ${res.summary.discoveredCount}, ${t('harness.srcMgmt.syncImported')} ${res.summary.importedCount}, ${t('harness.srcMgmt.syncSynced')} ${res.summary.syncedCount}${res.summary.failedCount > 0 ? `, ${t('harness.srcMgmt.syncFailed')} ${res.summary.failedCount}` : ''}`
      );
      onChanged?.();
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  const headerActionsNode = (
    <button
      type="button"
      className="btn btn-sm btn-secondary"
      onClick={() => void syncHost()}
      disabled={busy !== null}
      title={t('harness.srcMgmt.syncMarketplaces')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)' }}
    >
      {busy === 'syncHost' ? <Loader2 size={13} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <RefreshCw size={13} />}
      <span>{t('harness.srcMgmt.syncMarketplaces')}</span>
    </button>
  );

  /** ONE grid template for the column header and every row: source · catalog · auto-rescan ·
   *  enabled · actions. Fixed control widths keep the switches in aligned columns down the whole
   *  list — a per-row flex box let each row drift with its repository name. */
  const sourceRowGrid: React.CSSProperties = narrow
    ? // Narrow window: one column, the fixed control widths would squeeze the repo to nothing.
      { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', rowGap: '6px', alignItems: 'center' }
    : {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 92px 112px 44px 44px',
        columnGap: '8px',
        rowGap: '5px',
        alignItems: 'center',
      };

  return (
    <Drawer
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={17} style={{ color: 'var(--primary, #3b82f6)' }} />
          <span>{isSkill ? t('harness.srcMgmt.titleSkill') : isMcp ? t('harness.srcMgmt.titleMcp') : kind === 'plugin' ? t('harness.srcMgmt.titlePlugin') : t('harness.srcMgmt.title')}</span>
          <span
            className="chip"
            style={{
              fontSize: 'var(--text-xs)',
              padding: '2px 8px',
              background: 'var(--chip-bg)',
              color: 'var(--text-muted)',
              borderRadius: '12px',
              fontWeight: 'var(--font-medium)',
            }}
          >
            {isSkill ? t('harness.srcMgmt.globalScope') : harness}
          </span>
        </span>
      }
      subtitle={isSkill ? t('harness.srcMgmt.subtitleSkill') : isMcp ? t('harness.srcMgmt.subtitleMcp') : t('harness.srcMgmt.isolatedSubtitle')}
      headerActions={isSkill ? undefined : headerActionsNode}
      onClose={onClose}
      closeLabel={t('harness.srcMgmt.close')}
      width="min(660px, 94vw)"
    >
      {/* ── Builtin Sources ────────────────────────────────────────── */}
      {builtin.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
          <div
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--font-semibold)',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 'var(--tracking-wide)',
            }}
          >
            {t('harness.srcMgmt.builtin')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {builtin.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  background: 'var(--chip-bg, rgba(255, 255, 255, 0.04))',
                  border: '1px solid var(--divider)',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', color: 'var(--text)' }}>{formatSourceLabel(s)}</span>
                <span
                  style={{
                    fontSize: 'var(--text-2xs)',
                    color: 'var(--primary, #3b82f6)',
                    background: 'rgba(59, 130, 246, 0.12)',
                    padding: '1px 6px',
                    borderRadius: '4px',
                  }}
                >
                  system
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Add New Source Section (Placed at top for easy entry) ─ */}
      <div
        style={{
          flexShrink: 0,
          border: '1px solid var(--divider)',
          borderRadius: '8px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          background: 'var(--card-bg, #1e1e24)',
        }}
      >
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text)' }}>
          {isSkill ? t('harness.srcMgmt.addSkill') : isMcp ? t('harness.srcMgmt.addMcp') : kind === 'plugin' ? t('harness.srcMgmt.addPlugin') : t('harness.srcMgmt.add')}
        </div>

        {/* Scope dialog — opens when the add-click probe detected several supporting harnesses. */}
        {scopeAskOpen && (
          <Dialog
            title={t('harness.srcMgmt.scopeTitle')}
            subtitle={t('harness.srcMgmt.sharePrompt').replace('{hosts}', checkedHosts.join(', '))}
            onClose={() => {
              setScopeAskOpen(false);
              setCheckedHosts([]);
              setShareWithAll(false);
            }}
            closeLabel={t('common.cancel')}
            width={520}
            footerRight={
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setScopeAskOpen(false);
                    setCheckedHosts([]);
                    setShareWithAll(false);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void registerScoped()}
                >
                  {busy === 'add' ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : null}
                  <span>{t('common.confirm')}</span>
                </button>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="source-scope"
                  checked={!shareWithAll}
                  onChange={() => setShareWithAll(false)}
                  style={{ accentColor: 'var(--primary, #3b82f6)' }}
                />
                <span>{t('harness.srcMgmt.scopePinned').replace('{harness}', harness)}</span>
                <span
                  className="chip"
                  style={{
                    cursor: 'default',
                    fontSize: 'var(--text-3xs)',
                    padding: '0 6px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    fontWeight: 'var(--font-semibold)',
                    color: 'var(--primary, #3b82f6)',
                    background: 'rgba(59, 130, 246, 0.15)',
                    border: '1px solid rgba(59, 130, 246, 0.35)',
                  }}
                >
                  <Check size={10} />
                  <span>{harness}</span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="source-scope"
                  checked={shareWithAll}
                  onChange={() => setShareWithAll(true)}
                  style={{ accentColor: 'var(--primary, #3b82f6)' }}
                />
                <span>{t('harness.srcMgmt.scopeShared')}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  {checkedHosts.map((h) => {
                    const current = h === harness;
                    return (
                      <span
                        key={h}
                        className="chip"
                        style={{
                          cursor: 'default',
                          fontSize: 'var(--text-3xs)',
                          padding: '0 6px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          fontWeight: current ? 'var(--font-semibold)' : 'var(--font-medium)',
                          color: current ? 'var(--primary, #3b82f6)' : 'var(--accent-emerald, #10b981)',
                          background: current ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.10)',
                          border: current ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(16, 185, 129, 0.22)',
                        }}
                      >
                        {current && <Check size={10} />}
                        <span>{h}</span>
                      </span>
                    );
                  })}
                </span>
              </label>
            </div>
          </Dialog>
        )}

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {!isSkill && (
            <div style={{ width: '130px', flexShrink: 0 }}>
              <Combobox
                value={sourceType}
                onChange={(v) => setSourceType(v === 'npm' ? 'npm' : v === 'pypi' ? 'pypi' : 'github')}
                style={{ height: '34px', fontSize: 'var(--text-sm)' }}
                options={supportedTypes.map((type) => ({
                  value: type,
                  label:
                    type === 'npm'
                      ? t('harness.srcMgmt.typeNpm')
                      : type === 'pypi'
                        ? t('harness.srcMgmt.typePypi')
                        : t('harness.srcMgmt.typeGithub'),
                }))}
              />
            </div>
          )}

          <input
            className="input"
            style={{ flex: 1, minWidth: '200px', fontSize: 'var(--text-sm)', height: '34px', boxSizing: 'border-box' }}
            placeholder={
              sourceType === 'pypi'
                ? t('harness.srcMgmt.placeholderPypi')
                : sourceType === 'npm'
                  ? t(isMcp ? 'harness.srcMgmt.placeholderMcpPackage' : 'harness.srcMgmt.placeholderNpm')
                  : t('harness.srcMgmt.placeholder')
            }
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              // A new URL invalidates the previous check: no stale share offer.
              setCheckedHosts([]);
              setShareWithAll(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && busy === null) void add();
            }}
          />

          <CatalogPicker
            value={catalog}
            onChange={(v) => setCatalog(v)}
            options={existingCatalogs}
            placeholder={t('harness.srcMgmt.catalogPlaceholder')}
            onEnter={() => void add()}
          />

          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!url.trim() || busy !== null}
            onClick={() => void check()}
            style={{ height: '34px', padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {busy === 'check' ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : null}
            <span>{t('harness.srcMgmt.check')}</span>
          </button>

          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!url.trim() || busy !== null}
            onClick={() => void add()}
            style={{ height: '34px', padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {busy === 'add' ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Plus size={13} />}
            <span>{t('harness.srcMgmt.add')}</span>
          </button>
        </div>

        {note && (
          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--divider)',
              lineHeight: 'var(--leading-snug)',
            }}
          >
            {note}
          </div>
        )}
      </div>

      {/* ── Operator Configured Sources ────────────────────────────── */}
      {/* The marketplace table owns the drawer's remaining height (`flex: 1 0 auto`): the body is
          a fixed-height flex column, so the table box grows to the bottom edge instead of leaving
          dead space under a short page. `0` shrink keeps the natural row height (and body scroll)
          when the list is taller than the drawer. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: '1 0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--font-semibold)',
              color: 'var(--text-muted)',
                            letterSpacing: 'var(--tracking-wide)',
            }}
          >
            {t('harness.srcMgmt.operatorSources')}
          </span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {t('harness.srcMgmt.configuredCount').replace('{count}', String(entries.length))}
          </span>
        </div>

        {entries.length === 0 ? (
          isSkill || isMcp ? (
            <div
              style={{
                flex: '1 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 'var(--text-md)',
                color: 'var(--text-muted)',
                padding: '24px 16px',
                textAlign: 'center',
                border: '1px dashed var(--divider)',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.01)',
              }}
            >
              {isSkill ? t('harness.srcMgmt.emptySkill') : t('harness.srcMgmt.emptyMcp')}
            </div>
          ) : (
            // Plugin axis empty state: segmented steps, not one run-on sentence — each action
            // (sync, add) is its own numbered row the operator can follow top to bottom.
            <div
              style={{
                display: 'flex',
                flex: '1 0 auto',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '24px 20px',
                border: '1px dashed var(--divider)',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.01)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)', color: 'var(--text)' }}>
                  {builtin.length > 0 ? t('harness.srcMgmt.emptyPluginCustom') : t('harness.srcMgmt.emptyPlugin')}
                </div>
                {[
                  { n: 1, text: t('harness.srcMgmt.emptyStepSync') },
                  { n: 2, text: t('harness.srcMgmt.emptyStepAdd') },
                ].map(({ n, text }) => (
                  <div key={n} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        flexShrink: 0,
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 'var(--font-bold)',
                        color: 'var(--primary, #3b82f6)',
                        background: 'rgba(59, 130, 246, 0.12)',
                        border: '1px solid rgba(59, 130, 246, 0.3)',
                      }}
                    >
                      {n}
                    </span>
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>{text}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : (
          <div
            ref={tableRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: '1 0 auto',
              border: '1px solid var(--divider)',
              borderRadius: '8px',
            }}
          >
            {!narrow && (
              <div
                style={{
                  ...sourceRowGrid,
                  padding: '6px 10px',
                  borderBottom: '1px solid var(--divider)',
                  borderRadius: '8px 8px 0 0',
                  background: 'rgba(255, 255, 255, 0.02)',
                  fontSize: 'var(--text-2xs)',
                  color: 'var(--text-muted)',
                  letterSpacing: 'var(--tracking-wide)',
                }}
              >
                <span />
                <span>{t('harness.srcMgmt.catalog')}</span>
                <span>{t('harness.srcMgmt.rescanEnabled')}</span>
                <span style={{ textAlign: 'center' }}>{t('harness.srcMgmt.enabled')}</span>
                <span />
              </div>
            )}
            {pageEntries.map((e, i) => (
              <div
                key={e.slug}
                style={{
                  ...sourceRowGrid,
                  padding: '8px 10px',
                  borderTop: i === 0 ? undefined : '1px solid var(--divider)',
                  opacity: e.enabled ? undefined : 0.55,
                  transition: 'opacity 0.15s ease',
                }}
              >
                {/* Source identity: repo + source type. The repo takes the column and the type
                    badge pins its right edge, so badges line up down the list; the derived
                    `mp-<slug>` id rides the tooltip. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                  <span
                    title={`${e.repo} · mp-${e.slug}`}
                    style={{
                      flex: '1 1 auto',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-sm)',
                      fontWeight: 'var(--font-semibold)',
                      color: 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    {e.repo}
                  </span>
                  <span
                    className="chip"
                    style={{
                      cursor: 'default',
                      fontSize: 'var(--text-3xs)',
                      padding: '0 5px',
                      textTransform: 'uppercase',
                      fontWeight: 'var(--font-semibold)',
                      flexShrink: 0,
                    }}
                  >
                    {e.type === 'npm' ? 'npm' : e.type === 'pypi' ? 'PyPI' : 'GitHub'}
                  </span>
                </div>

                {/* Wide: `contents` so the four controls stay grid columns. Narrow: they become one
                    wrapping row under the identity instead of squeezing the repo name. */}
                <div
                  style={
                    narrow
                      ? { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }
                      : { display: 'contents' }
                  }
                >
                  <CatalogPicker
                    compact
                    value={e.catalog || 'default'}
                    onCommit={(newCat) => void updateCatalog(e.slug, newCat)}
                    options={existingCatalogs}
                    placeholder={t('harness.srcMgmt.catalogPlaceholder')}
                  />

                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                    <Switch
                      size="sm"
                      checked={e.rescan.enabled}
                      ariaLabel={t('harness.srcMgmt.rescanEnabled')}
                      onChange={(v) => void setRescan(e.slug, v, e.rescan.intervalMs)}
                    />
                    <input
                      className="input"
                      type="number"
                      min={1}
                      style={{ width: '46px', height: '22px', fontSize: 'var(--text-xs)', padding: '1px 4px', boxSizing: 'border-box' }}
                      aria-label={t('harness.srcMgmt.intervalMin')}
                      value={intervalDrafts[e.slug] ?? Math.round(e.rescan.intervalMs / 60000)}
                      onChange={(ev) => setIntervalDrafts((prev) => ({ ...prev, [e.slug]: ev.target.value }))}
                      onBlur={() => commitInterval(e.slug, e.rescan.enabled, e.rescan.intervalMs)}
                      onKeyDown={(ev) => {
                        if (ev.key !== 'Enter') return;
                        ev.preventDefault();
                        commitInterval(e.slug, e.rescan.enabled, e.rescan.intervalMs);
                      }}
                    />
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t('harness.srcMgmt.intervalMin')}</span>
                  </span>

                  <span style={{ display: 'flex', justifyContent: narrow ? 'flex-start' : 'center' }}>
                    <Switch
                      size="sm"
                      checked={e.enabled}
                      ariaLabel={t('harness.srcMgmt.enabled')}
                      onChange={(v) => void toggle(e.slug, v)}
                    />
                  </span>

                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '2px' }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      title={t('harness.srcMgmt.rescanNow')}
                      disabled={busy !== null}
                      onClick={() => void rescan(e.slug)}
                      style={{ padding: '2px 5px' }}
                    >
                      {busy === `rescan:${e.slug}` ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <RefreshCw size={12} />}
                    </button>
                    <button
                      type="button"
                      aria-label={t('harness.srcMgmt.remove')}
                      title={t('harness.srcMgmt.remove')}
                      onClick={() => void remove(e.slug)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '2px',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        borderRadius: '4px',
                      }}
                      onMouseEnter={(ev) => (ev.currentTarget.style.color = 'var(--danger, #ef4444)')}
                      onMouseLeave={(ev) => (ev.currentTarget.style.color = 'var(--text-muted)')}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>

                {!isSkill && (
                  // Hosts-detected metadata (per-harness axes only; skills are global). Tags, not
                  // prose: a scan down the column answers "will this land here?" without reading.
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: 'var(--text-2xs)',
                      color: 'var(--text-muted)',
                      flexWrap: 'wrap',
                    }}
                  >
                    {/* The source is a package on disk; whether its server actually CONNECTED is
                        the runtime's answer, not the landing's. Badge it here so a row that is
                        installed-but-failing cannot read as "normal" (ADR-0015 §D8.8). */}
                    {(() => {
                      const runtime = runtimeForEntry?.(e);
                      if (!runtime) return null;
                      const badge = RUNTIME_BADGE[runtime.status];
                      return (
                        <span
                          className={badge.className}
                          title={runtime.error ?? `${runtime.host} · ${t(badge.key)}`}
                          style={{ flexShrink: 0, fontSize: 'var(--text-3xs)', padding: '0 6px' }}
                        >
                          {t(badge.key)}
                        </span>
                      );
                    })()}
                    {/* A shared entry carries no harness pin: legacy pre-2026-11-01 entries and
                        every MCP package source (that axis is shared by definition) land here.
                        Badge it so scope is scannable, not inferred from absence. */}
                    {!e.harness && (
                      <span
                        className="chip"
                        title={t('harness.srcMgmt.sharedEntry')}
                        style={{
                          cursor: 'default',
                          fontSize: 'var(--text-3xs)',
                          padding: '0 6px',
                          fontWeight: 'var(--font-semibold)',
                          color: 'var(--warning, #f59e0b)',
                          background: 'rgba(245, 158, 11, 0.12)',
                          border: '1px solid rgba(245, 158, 11, 0.3)',
                          marginRight: '2px',
                        }}
                      >
                        {t('harness.srcMgmt.sharedEntry')}
                      </span>
                    )}
                    <span style={{ marginRight: '2px' }}>{t('harness.srcMgmt.hostsDetected')}:</span>
                    {(() => {
                      const hosts = e.hosts ?? [];
                      if (hosts.length === 0) return <span>{t('harness.srcMgmt.hostsNone')}</span>;
                      const current = hosts.includes(harness);
                      return (
                        <>
                          {current && (
                            <span
                              className="chip"
                              style={{
                                cursor: 'default',
                                fontSize: 'var(--text-3xs)',
                                padding: '0 6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                fontWeight: 'var(--font-semibold)',
                                color: 'var(--primary, #3b82f6)',
                                background: 'rgba(59, 130, 246, 0.15)',
                                border: '1px solid rgba(59, 130, 246, 0.35)',
                              }}
                            >
                              <Check size={10} />
                              <span>{harness}</span>
                              <span style={{ fontWeight: 'var(--font-regular)', opacity: 0.75 }}>
                                ({t('harness.srcMgmt.currentHost')})
                              </span>
                            </span>
                          )}
                          {hosts
                            .filter((h) => h !== harness)
                            .map((h) => (
                              <span
                                key={h}
                                className="chip"
                                style={{
                                  cursor: 'default',
                                  fontSize: 'var(--text-3xs)',
                                  padding: '0 6px',
                                  fontWeight: 'var(--font-medium)',
                                  color: 'var(--accent-emerald, #10b981)',
                                  background: 'rgba(16, 185, 129, 0.10)',
                                  border: '1px solid rgba(16, 185, 129, 0.22)',
                                }}
                              >
                                {h}
                              </span>
                            ))}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))}
            {entries.length > 0 && (
              <div style={{ marginTop: 'auto', padding: '6px 10px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end' }}>
                <Pagination
                  page={safePage}
                  pageSize={pageSize}
                  total={entries.length}
                  onChange={setPage}
                  showSummary
                  pageSizeOptions={[10, 20, 50]}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
};
