import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { Combobox } from './Combobox';

import { FONT_MONO } from '../lib/fonts';
interface PaginationProps {
  /** 1-based current page */
  page: number;
  pageSize: number;
  /** Total number of items across all pages */
  total: number;
  onChange: (page: number) => void;
  /** Disable every control (e.g. while loading) */
  disabled?: boolean;
  /** Show "from–to of total" summary on the left */
  showSummary?: boolean;
  /**
   * The caller's `total` is a LOWER BOUND, not an exact count (the source publishes no total — the MCP
   * registry answers only a cursor). The summary then reads "of at least N", so the pager shows a
   * number the list can prove instead of hiding the figure or inventing one.
   */
  totalAtLeast?: boolean;
  /** When provided (with onPageSizeChange), shows a per-page size selector */
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
}

/** Page number list with ellipsis gaps: 1 2 … 6 7 8 … 19 20 */
function pageItems(current: number, totalPages: number): (number | '…')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = new Set(
    [1, 2, current - 1, current, current + 1, totalPages - 1, totalPages].filter(
      (p) => p >= 1 && p <= totalPages
    )
  );
  const sorted = [...wanted].sort((a, b) => a - b);
  const items: (number | '…')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) items.push('…');
    items.push(p);
    prev = p;
  }
  return items;
}

/**
 * Shared presentational pager. Knows nothing about where data comes from:
 * server-side callers pass the API's `total` and re-fetch in `onChange`,
 * client-side callers pass `list.length` and re-slice. Data fetching,
 * slicing and refresh semantics stay in the page — never add them here.
 *
 * Layout rule: the bar renders whenever the list is non-empty — summary and
 * size selector on the left, page buttons on the right (a single page shows
 * a disabled "1"). Returns null only for an empty list.
 */
export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize,
  total,
  onChange,
  disabled,
  showSummary,
  totalAtLeast,
  pageSizeOptions,
  onPageSizeChange,
}) => {
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Self-heal when the data set shrinks below the current page (deletions, filters)
  React.useEffect(() => {
    if (page > totalPages) onChange(totalPages);
  }, [page, totalPages, onChange]);

  const showButtons = total > 0;
  const showSelector = Boolean(pageSizeOptions && onPageSizeChange) && total > 0;
  const showLeft = (showSummary || showSelector) && total > 0;

  // Nothing to render at all (e.g. small config list without summary/selector)
  if (!showLeft && !showButtons) return null;

  const btnStyle: React.CSSProperties = {
    minWidth: 32,
    height: 32,
    padding: '0 10px',
    fontSize: 12,
    justifyContent: 'center',
    fontFamily: FONT_MONO,
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 12,
        flexWrap: 'wrap',
      }}
    >
      {showSummary && (
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {t(totalAtLeast ? 'pagination.summaryAtLeast' : 'pagination.summary', {
            from: Math.min((page - 1) * pageSize + 1, total),
            to: Math.min(page * pageSize, total),
            total,
          })}
        </span>
      )}
      {showButtons && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {pageSizeOptions && onPageSizeChange && (
            <Combobox
              style={{ fontSize: 12, width: 118, height: 32, padding: '0 10px', cursor: 'pointer', marginRight: 6 }}
              value={String(pageSize)}
              onChange={(v) => onPageSizeChange(Number(v))}
              options={pageSizeOptions.map((n) => ({
                value: String(n),
                label: t('pagination.perPage', { n }),
              }))}
            />
          )}
          <button
            className="btn btn-sm"
            style={btnStyle}
            disabled={disabled || page <= 1}
            onClick={() => onChange(page - 1)}
            aria-label={t('pagination.prev')}
          >
            <ChevronLeft size={13} />
          </button>
          {pageItems(page, totalPages).map((item, idx) =>
            item === '…' ? (
              <span key={`gap-${idx}`} style={{ fontSize: 12, color: 'var(--text-dim)', padding: '0 2px' }}>
                …
              </span>
            ) : (
              <button
                key={item}
                className={`btn btn-sm ${item === page ? 'btn-primary' : ''}`}
                style={btnStyle}
                disabled={disabled}
                onClick={() => onChange(item)}
                aria-label={t('pagination.page', { n: item })}
                aria-current={item === page ? 'page' : undefined}
              >
                {item}
              </button>
            )
          )}
          <button
            className="btn btn-sm"
            style={btnStyle}
            disabled={disabled || page >= totalPages}
            onClick={() => onChange(page + 1)}
            aria-label={t('pagination.next')}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
};
