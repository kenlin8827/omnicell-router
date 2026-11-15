import React, { useState } from 'react';
import { Eraser } from 'lucide-react';
import { Combobox, type ComboboxOption } from './Combobox';
import { InfoTip } from './InfoTip';
import { Switch } from './Switch';
import { useI18n } from '../i18n/I18nContext';

import { FONT_MONO } from '../lib/fonts';
/** One linkable row: opencode passes agents (with an optional mode group),
 *  pi passes discovered subagent roles (mode omitted — single flat group). */
interface AgentRow {
  name: string;
  mode?: 'primary' | 'subagent' | 'all';
  /** Current model in the client config (bare ref or native pin), echoed verbatim. */
  current?: string;
}

interface Props {
  rows: AgentRow[];
  /** Rows not loaded yet (opencode inventory fetch in flight). */
  loading?: boolean;
  /** Rows failed to load — retry affordance; drafts stay omitted from setup. */
  error?: boolean;
  onRetry?: () => void;
  emptyText: string;
  /** Optional control rendered at the header row start (e.g. the
   *  smart-assign button). */
  headerAction?: React.ReactNode;
  /** Gateway-addressable options (auto aliases + registered ids + combos). */
  gatewayOptions: ComboboxOption[];
  /** name → draft value: '' | gateway ref. */
  drafts: Record<string, string>;
  onDraft: (name: string, value: string) => void;
  onClear: () => void;
  /** Per-client apply hint line. */
  hint: string;
  /** Short label at the header-row start (e.g. Subagent). */
  label?: string;
  /** Link-table switch (opencode, pi): OFF hides the whole table — the form
   *  declares "not configuring subagents" and setup omits the payload. When
   *  undefined the table always shows (no switch). */
  on?: boolean;
  onToggle?: (v: boolean) => void;
  /** Bound-row count while OFF — keeps existing picks visible at a glance. */
  linkedCount?: number;
  showSort?: boolean;
}

/**
 * The agent/role link table shared by opencode and pi on the clients page.
 * Self-contained: the header row hosts the filter box, sort and clear
 * controls; each row picks either a concrete gateway model or nothing
 * (inherit the client's default model).
 */
export const AgentRowsTable: React.FC<Props> = ({
  rows,
  loading,
  error,
  onRetry,
  emptyText,
  headerAction,
  gatewayOptions,
  drafts,
  onDraft,
  onClear,
  hint,
  label,
  on,
  onToggle,
  linkedCount,
  showSort,
}) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'suffix' | 'prefix'>('name');

  const rowOptions = (current: string): ComboboxOption[] => {
    const opts: ComboboxOption[] = [{ value: '', label: t('clients.rowsNone') }];
    opts.push(...gatewayOptions);
    if (current && !opts.some(o => o.value === current)) opts.splice(1, 0, { value: current, label: current });
    return opts;
  };

  // Name clustering key: 'suffix' = segment after the last '-', 'prefix' =
  // segment before the first '-'. Names without a hyphen use the full name.
  const nameKey = (a: AgentRow): string => {
    const n = a.name;
    if (sort === 'prefix') {
      const i = n.indexOf('-');
      return i === -1 ? n : n.slice(0, i);
    }
    const i = n.lastIndexOf('-');
    return i === -1 ? n : n.slice(i + 1);
  };

  const hasModeGroups = rows.some(r => !!r.mode);
  const groups: [AgentRow['mode'] | undefined, string | null][] = hasModeGroups
    ? [
        ['primary', t('clients.rowsGroupPrimary')],
        ['subagent', t('clients.rowsGroupSubagent')],
        ['all', t('clients.rowsGroupAll')],
      ]
    : [[undefined, null]];

  const q = filter.trim().toLowerCase();
  const visible = rows.filter(r => !q || r.name.toLowerCase().includes(q));

  // Switch OFF: the whole table collapses to one switch row — the form
  // declares "not configuring subagents" (setup omits the agent payload).
  // The bound count stays visible so existing picks never go dark; the
  // semantics ride an InfoTip instead of a text line.
  if (on === false) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Switch size="sm" checked={false} onChange={v => onToggle?.(v)} />
            <span>
              {label}
              {(linkedCount || 0) > 0 ? ` · ${linkedCount}` : ''}
            </span>
          </label>
          <InfoTip text={t('clients.rowsOffHint')} />
          <span style={{ flex: 1 }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '10px' }}>
        {on !== undefined ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <Switch size="sm" checked onChange={v => onToggle?.(v)} />
            <span>{label}</span>
          </label>
        ) : (
          label && <span style={{ flexShrink: 0 }}>{label}</span>
        )}
        <InfoTip text={hint} />
        {rows.length > 8 && (
          <input
            className="input"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('clients.rowsFilter')}
            style={{ flex: 1, maxWidth: '260px', fontSize: 'var(--text-sm)', padding: '5px 10px' }}
          />
        )}
        {headerAction}
        {Object.values(drafts).some(Boolean) && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ flexShrink: 0, fontSize: 'var(--text-xs)', marginRight: 4 }}
            title={t('clients.rowsClearHint')}
            onClick={onClear}
          >
            <Eraser size={11} />
            <span>{t('clients.rowsClear')}</span>
          </button>
        )}
        <span style={{ flex: 1 }} />
        {showSort && rows.length > 8 && (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '4px', flexShrink: 0 }} title={t('clients.rowsSortHint')}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginRight: '2px', alignSelf: 'center' }}>{t('clients.rowsSortLabel')}</span>
            {([
              ['name', t('clients.rowsSortName')],
              ['suffix', t('clients.rowsSortSuffix')],
              ['prefix', t('clients.rowsSortPrefix')],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="btn btn-sm"
                style={{ fontSize: 'var(--text-xs)', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', ...(sort === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                onClick={() => setSort(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {loading ? (
        error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: 'var(--text-sm)', color: 'var(--accent-amber)' }}>
            <span>{t('clients.rowsError')}</span>
            <button type="button" className="btn btn-sm" style={{ fontSize: 'var(--text-xs)' }} onClick={onRetry}>
              {t('clients.rowsRetry')}
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('clients.rowsLoading')}</div>
        )
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{emptyText}</div>
      ) : visible.length === 0 ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('clients.rowsNoMatch')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groups.map(([mode, label]) => {
            const groupRows = rows.filter(r => !mode || r.mode === mode);
            const sorted = groupRows
              .filter(r => !q || r.name.toLowerCase().includes(q))
              .sort((x, y) => (sort !== 'name' && showSort ? nameKey(x).localeCompare(nameKey(y)) : 0)
                || x.name.localeCompare(y.name));
            if (sorted.length === 0) return null;
            const boundN = sorted.filter(r => !!drafts[r.name]).length;
            return (
              <div key={mode || 'all'}>
                {label && (
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', marginBottom: '4px' }}>
                    {label} · {boundN}/{sorted.length}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(480px, 1fr))', gap: '6px 18px' }}>
                  {sorted.map(r => {
                    const bound = drafts[r.name] || '';
                    return (
                      <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ width: '140px', flexShrink: 0, fontFamily: FONT_MONO, fontSize: 'var(--text-sm)' }}>{r.name}</span>
                        {r.current && (
                          <InfoTip text={`${t('clients.rowsCurrentModel')}: ${r.current}`} />
                        )}
                        {/* The picker takes the row's remaining width instead of a
                            fixed 230px: model ids are long (vendor/model-suffix),
                            and a fixed box clipped them to an unusable prefix. */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Combobox
                            value={bound}
                            onChange={v => onDraft(r.name, v)}
                            options={rowOptions(bound)}
                            panelMinWidth={360}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{hint}</div>
        </div>
      )}
    </div>
  );
};
