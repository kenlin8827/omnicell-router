import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, RefreshCw, Database, ChevronDown, Check } from 'lucide-react';
import { Drawer } from './Drawer';
import { Switch } from './Switch';
import { Combobox } from './Combobox';
import { Pagination } from './Pagination';
import { api, type HarnessCatalogSource, type HarnessMarketplaceEntry } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

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
  /** Idle display is localized ("默认"); focus swaps in the raw wire value ("default") so the
   *  operator edits what actually gets persisted — the display label never round-trips. */
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
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '2px 6px' }}>
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
                  fontSize: compact ? '11px' : '12px',
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
  kind: 'skill' | 'plugin';
  open: boolean;
  onClose: () => void;
}> = ({ harness, kind, open, onClose }) => {
  /** The skill axis is GLOBAL (ADR-0015 §D11): it has its own route, no harness scope and no
   *  host-sync/type pickers — a skill source is a Git repository of SKILL.md, shared by all agents. */
  const isSkill = kind === 'skill';
  const { t } = useI18n();
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
  /** Which source types this axis accepts. The skill axis is GitHub-only; the plugin axis offers
   *  both registrations and lets the install gate refuse a host that cannot take one. */
  const supportedTypes: ('github' | 'npm')[] = isSkill ? ['github'] : ['github', 'npm'];
  const [url, setUrl] = useState('');
  const [sourceType, setSourceType] = useState<'github' | 'npm'>('github');
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

  const check = async () => {
    if (!url.trim() || busy !== null) return;
    setBusy('check');
    setNote('');
    try {
      if (isSkill) {
        const res = await api.harnessSkillCheckSource(url.trim());
        setNote(
          res.ok
            ? t('harness.srcMgmt.checkSkillOk').replace('{skills}', String(res.skills))
            : res.message ?? t('harness.srcMgmt.fail'),
        );
      } else {
        const res = await api.harnessPluginCheckSource(scope, url.trim(), { type: sourceType });
        setNote(
          res.ok
            ? `${t('harness.srcMgmt.checkOk')
                .replace('{skills}', String(res.skills))
                .replace('{mcps}', String(res.mcps))
                .replace('{plugins}', String(res.plugins))} — ${t('harness.srcMgmt.hostsDetected')}: ${
                res.hosts.length > 0 ? res.hosts.join(', ') : t('harness.srcMgmt.hostsNone')
              }`
            : res.message ?? t('harness.srcMgmt.fail'),
        );
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!url.trim() || busy !== null) return;
    setBusy('add');
    setNote('');
    try {
      const res = isSkill
        ? await api.harnessSkillRegisterSource(url.trim(), { catalog: catalog.trim() || 'default' })
        : await api.harnessPluginRegisterSource(scope, url.trim(), { type: sourceType, catalog: catalog.trim() || 'default' });
      setNote(res.message ?? t('harness.srcMgmt.addOk'));
      setUrl('');
      setCatalog('default');
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
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
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (slug: string) => {
    try {
      if (isSkill) await api.harnessSkillRemoveSource(slug);
      else await api.harnessPluginRemoveSource(scope, slug);
      await load();
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
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
    >
      {busy === 'syncHost' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
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
          <span>{isSkill ? t('harness.srcMgmt.titleSkill') : kind === 'plugin' ? t('harness.srcMgmt.titlePlugin') : t('harness.srcMgmt.title')}</span>
          <span
            className="chip"
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              background: 'var(--chip-bg)',
              color: 'var(--text-muted)',
              borderRadius: '12px',
              fontWeight: 500,
            }}
          >
            {isSkill ? t('harness.srcMgmt.globalScope') : harness}
          </span>
        </span>
      }
      subtitle={isSkill ? t('harness.srcMgmt.subtitleSkill') : t('harness.srcMgmt.isolatedSubtitle')}
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
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
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
                <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)' }}>{formatSourceLabel(s)}</span>
                <span
                  style={{
                    fontSize: '10px',
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
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
          {isSkill ? t('harness.srcMgmt.addSkill') : kind === 'plugin' ? t('harness.srcMgmt.addPlugin') : t('harness.srcMgmt.add')}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {!isSkill && (
            <div style={{ width: '130px', flexShrink: 0 }}>
              <Combobox
                value={sourceType}
                onChange={(v) => setSourceType(v === 'npm' ? 'npm' : 'github')}
                style={{ height: '34px', fontSize: '12px' }}
                options={
                  supportedTypes.length === 1 && supportedTypes[0] === 'npm'
                    ? [{ value: 'npm', label: t('harness.srcMgmt.typeNpm') }]
                    : [
                        { value: 'github', label: t('harness.srcMgmt.typeGithub') },
                        { value: 'npm', label: t('harness.srcMgmt.typeNpm') },
                      ]
                }
              />
            </div>
          )}

          <input
            className="input"
            style={{ flex: 1, minWidth: '200px', fontSize: '12px', height: '34px', boxSizing: 'border-box' }}
            placeholder={sourceType === 'npm' ? t('harness.srcMgmt.placeholderNpm') : t('harness.srcMgmt.placeholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
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
            {busy === 'check' ? <Loader2 size={12} className="spin" /> : null}
            <span>{t('harness.srcMgmt.check')}</span>
          </button>

          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!url.trim() || busy !== null}
            onClick={() => void add()}
            style={{ height: '34px', padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {busy === 'add' ? <Loader2 size={12} className="spin" /> : <Plus size={13} />}
            <span>{t('harness.srcMgmt.add')}</span>
          </button>
        </div>

        {note && (
          <div
            style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--divider)',
              lineHeight: 1.5,
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
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-muted)',
                            letterSpacing: '0.04em',
            }}
          >
            {t('harness.srcMgmt.operatorSources') || 'Custom Sources'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {t('harness.srcMgmt.configuredCount').replace('{count}', String(entries.length))}
          </span>
        </div>

        {entries.length === 0 ? (
          <div
            style={{
              flex: '1 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '13px',
              color: 'var(--text-muted)',
              padding: '24px 16px',
              textAlign: 'center',
              border: '1px dashed var(--divider)',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.01)',
            }}
          >
            {isSkill ? t('harness.srcMgmt.emptySkill') : kind === 'plugin' ? t('harness.srcMgmt.emptyPlugin') : t('harness.srcMgmt.empty')}
          </div>
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
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.04em',
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
                      fontFamily: 'var(--mono, monospace)',
                      fontSize: '12px',
                      fontWeight: 600,
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
                      fontSize: '9px',
                      padding: '0 5px',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {e.type === 'npm' ? 'npm' : 'GitHub'}
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
                      style={{ width: '46px', height: '22px', fontSize: '11px', padding: '1px 4px', boxSizing: 'border-box' }}
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
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t('harness.srcMgmt.intervalMin')}</span>
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
                      {busy === `rescan:${e.slug}` ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
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
                      fontSize: '10px',
                      color: 'var(--text-muted)',
                      flexWrap: 'wrap',
                    }}
                  >
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
                                fontSize: '9px',
                                padding: '0 6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                fontWeight: 600,
                                color: 'var(--primary, #3b82f6)',
                                background: 'rgba(59, 130, 246, 0.15)',
                                border: '1px solid rgba(59, 130, 246, 0.35)',
                              }}
                            >
                              <Check size={10} />
                              <span>{harness}</span>
                              <span style={{ fontWeight: 400, opacity: 0.75 }}>
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
                                  fontSize: '9px',
                                  padding: '0 6px',
                                  fontWeight: 500,
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
