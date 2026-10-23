import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Eraser } from 'lucide-react';
import { Combobox, type ComboboxOption } from './Combobox';
import { InfoTip } from './InfoTip';
import { Switch } from './Switch';
import type { ModelProfileView } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

import { FONT_MONO } from '../lib/fonts';
/** One linkable row: opencode passes agents (with an optional mode group),
 *  pi passes discovered subagent roles (mode omitted — single flat group). */
export interface ProfileLinkRow {
  name: string;
  mode?: 'primary' | 'subagent' | 'all';
  /** Current model in the client config (bare ref or native pin), echoed verbatim. */
  current?: string;
}

interface Props {
  rows: ProfileLinkRow[];
  /** Rows not loaded yet (opencode inventory fetch in flight). */
  loading?: boolean;
  /** Rows failed to load — retry affordance; drafts stay omitted from setup. */
  error?: boolean;
  onRetry?: () => void;
  emptyText: string;
  /** Selected profile id ('' = none) + the profile inventory — the header
   *  hosts the selector, the rows derive their Slot: shortcuts from it. */
  profileId: string;
  profiles: ModelProfileView[];
  onProfileChange: (v: string) => void;
  /** Optional control rendered right after the profile selector (e.g. the
   *  smart-assign button — its candidate semantics follow that selector). */
  headerAction?: React.ReactNode;
  /** Gateway-addressable options (auto aliases + registered ids + combos). */
  gatewayOptions: ComboboxOption[];
  /** name → draft value: '' | gateway ref | `slot:<key>`. */
  drafts: Record<string, string>;
  /** Applied link tags from the server echo — row ordering only. */
  appliedTags: Record<string, string>;
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
  /** Linked-row count while OFF — keeps existing links visible at a glance. */
  linkedCount?: number;
  showSort?: boolean;
}

/**
 * The agent/role link table shared by opencode and pi on the clients page.
 * Self-contained: the header row hosts the profile selector (slots drive the
 * row shortcuts), the filter box, sort and clear controls; each row links
 * either a profile slot (`slot:<key>` draft → follows the profile), a
 * concrete gateway model (manual), or nothing (inherit). Row options:
 * operations first (inherit / Slot: shortcuts with the emerald profile chip),
 * then gateway models, then an echoed native pin kept visible.
 */
export const ProfileLinkTable: React.FC<Props> = ({
  rows,
  loading,
  error,
  onRetry,
  emptyText,
  profileId,
  profiles,
  onProfileChange,
  headerAction,
  gatewayOptions,
  drafts,
  appliedTags,
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
  const profile = profiles.find(p => p.id === profileId);

  const rowOptions = (current: string): ComboboxOption[] => {
    const opts: ComboboxOption[] = [{ value: '', label: t('clients.profileBindNone') }];
    if (profile) {
      for (const [k, ref] of Object.entries(profile.slots || {})) {
        opts.push({
          value: `slot:${k}`,
          label: k,
          badge: t('clients.profileSlotBadge'),
          badgeColor: 'var(--accent-emerald)',
          meta: ref,
        });
      }
    }
    opts.push(...gatewayOptions);
    if (current && !opts.some(o => o.value === current)) opts.splice(1, 0, { value: current, label: current });
    return opts;
  };

  const linkedEntries = Object.entries(drafts).filter(
    ([, v]) => typeof v === 'string' && v.startsWith('slot:')
  );
  const keptCount = profile ? linkedEntries.filter(([, v]) => !!(profile.slots || {})[v.slice(5)]).length : 0;
  const missingCount = linkedEntries.length - keptCount;

  // Name clustering key: 'suffix' = segment after the last '-', 'prefix' =
  // segment before the first '-'. Names without a hyphen use the full name.
  const nameKey = (a: ProfileLinkRow): string => {
    const n = a.name;
    if (sort === 'prefix') {
      const i = n.indexOf('-');
      return i === -1 ? n : n.slice(0, i);
    }
    const i = n.lastIndexOf('-');
    return i === -1 ? n : n.slice(i + 1);
  };

  const hasModeGroups = rows.some(r => !!r.mode);
  const groups: [ProfileLinkRow['mode'] | undefined, string | null][] = hasModeGroups
    ? [
        ['primary', t('clients.profileGroupPrimary')],
        ['subagent', t('clients.profileGroupSubagent')],
        ['all', t('clients.profileGroupAll')],
      ]
    : [[undefined, null]];

  const q = filter.trim().toLowerCase();
  const visible = rows.filter(r => !q || r.name.toLowerCase().includes(q));

  // Switch OFF: the whole table collapses to one switch row — the form
  // declares "not configuring subagents" (setup omits the agent payload).
  // The linked count stays visible so existing links never go dark; the
  // semantics ride an InfoTip instead of a text line.
  if (on === false) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Switch size="sm" checked={false} onChange={v => onToggle?.(v)} />
            <span>
              {label}
              {(linkedCount || 0) > 0 ? ` · ${linkedCount}` : ''}
            </span>
          </label>
          <InfoTip text={t('clients.profileRowsOffHint')} />
          <span style={{ flex: 1 }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '10px' }}>
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
            placeholder={t('clients.profileFilter')}
            style={{ flex: 1, maxWidth: '260px', fontSize: '12px', padding: '5px 10px' }}
          />
        )}
        <div style={{ width: '280px', flexShrink: 0 }}>
          <Combobox
            value={profileId}
            onChange={onProfileChange}
            style={{ fontSize: '12px', padding: '5px 10px' }}
            options={[
              { value: '', label: t('clients.profileNone') },
              ...profiles.map(p => ({ value: p.id, label: p.name || p.id, meta: p.name ? p.id : undefined })),
            ]}
          />
        </div>
        {headerAction}
        {Object.values(drafts).some(Boolean) && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ flexShrink: 0, fontSize: '11px', marginRight: 4 }}
            title={t('clients.profileClearBindingsHint')}
            onClick={onClear}
          >
            <Eraser size={11} />
            <span>{t('clients.profileClearBindings')}</span>
          </button>
        )}
        <span style={{ flex: 1 }} />
        {showSort && rows.length > 8 && (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '4px', flexShrink: 0 }} title={t('clients.profileSortHint')}>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: '2px', alignSelf: 'center' }}>{t('clients.profileSortLabel')}</span>
            {([
              ['name', t('clients.profileSortName')],
              ['suffix', t('clients.profileSortSuffix')],
              ['prefix', t('clients.profileSortPrefix')],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="btn btn-sm"
                style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', ...(sort === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                onClick={() => setSort(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <Link to="/model-profiles" style={{ color: 'var(--accent)', textDecoration: 'none', flexShrink: 0 }}>{t('clients.profileManage')}</Link>
      </div>
      {profiles.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          {t('clients.profileEmpty')}{' '}
          <Link to="/model-profiles" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{t('clients.profileManage')}</Link>
        </div>
      )}
      {profileId && profile && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {t('clients.profileLinkedHint', { name: profile.name || profileId })}
        </div>
      )}
      {loading ? (
        error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--accent-amber)' }}>
            <span>{t('clients.profileAgentsError')}</span>
            <button type="button" className="btn btn-sm" style={{ fontSize: '11px' }} onClick={onRetry}>
              {t('clients.profileAgentsRetry')}
            </button>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsLoading')}</div>
        )
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{emptyText}</div>
      ) : visible.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsNoMatch')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groups.map(([mode, label]) => {
            const groupRows = rows.filter(r => !mode || r.mode === mode);
            // Applied-first: echo-tagged rows lead under the default 'name'
            // sort so the eye lands on decisions already made; cluster sorts
            // take over as the primary key instead.
            const sorted = groupRows
              .filter(r => !q || r.name.toLowerCase().includes(q))
              .sort((x, y) => (sort !== 'name' && showSort ? nameKey(x).localeCompare(nameKey(y)) : 0)
                || (appliedTags[y.name] ? 1 : 0) - (appliedTags[x.name] ? 1 : 0)
                || x.name.localeCompare(y.name));
            if (sorted.length === 0) return null;
            const boundN = sorted.filter(r => !!drafts[r.name]).length;
            return (
              <div key={mode || 'all'}>
                {label && (
                  <div style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: '4px' }}>
                    {label} · {boundN}/{sorted.length}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))', gap: '6px 18px' }}>
                  {sorted.map(r => {
                    const bound = drafts[r.name] || '';
                    const linked = bound.startsWith('slot:');
                    const missing = linked && !(profile?.slots || {})[bound.slice(5)];
                    return (
                      <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ width: '140px', flexShrink: 0, fontFamily: FONT_MONO, fontSize: '12px' }}>{r.name}</span>
                        {r.current && (
                          <InfoTip text={`${t('clients.profileCurrentModel')}: ${r.current}`} />
                        )}
                        <div style={{ width: '230px', flexShrink: 0 }}>
                          <Combobox
                            value={bound}
                            onChange={v => onDraft(r.name, v)}
                            options={rowOptions(bound)}
                            panelMinWidth={300}
                          />
                        </div>
                        {missing && (
                          <span style={{ flexShrink: 0, fontSize: '10px', color: 'var(--accent-amber)' }}>
                            {t('clients.profileSlotMissing', { slot: bound.slice(5) })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {(keptCount > 0 || missingCount > 0) && (
            <div style={{ fontSize: '11px', color: missingCount > 0 ? 'var(--accent-amber)' : 'var(--text-dim)' }}>
              {t('clients.profileSlotCarry', { kept: keptCount, missing: missingCount })}
            </div>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>{hint}</div>
        </div>
      )}
    </div>
  );
};
