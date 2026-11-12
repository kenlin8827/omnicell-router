import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ScrollTableColumn {
  key: string;
  label: React.ReactNode;
  /** Column width: a px number or any CSS length (`'32%'`). Omitted columns size to their content. */
  width?: number | string;
  align?: 'left' | 'center' | 'right';
  /** Extra style for this column's header cell (padding, alignment fine-tuning). */
  headStyle?: React.CSSProperties;
  /** Pin the column to the right edge of the scroll viewport: it stays visible
   * while the body scrolls sideways (used for row action columns that would
   * otherwise be the first thing a horizontal scroll hides). */
  sticky?: 'right';
}

const HEAD_CELL: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  whiteSpace: 'nowrap',
  // The head's widths are measured from the body, so a longer label must clip rather than push
  // its column out of line with the tracks below.
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const baseTable = (fixed: boolean): React.CSSProperties => ({
  width: '100%',
  tableLayout: fixed ? 'fixed' : 'auto',
  borderCollapse: 'collapse',
  textAlign: 'left',
  fontSize: 'var(--text-sm)',
});

// Pinned-column cells: opaque background (scrolled rows slide UNDER them, so a
// translucent surface would show the content bleeding through) plus a divider
// edge marking the pin seam. The HEAD cell style is applied by this component;
// body cells are rendered by the caller, so export the body style for the
// caller's <td>.
export const stickyBodyCell: React.CSSProperties = {
  position: 'sticky',
  right: 0,
  zIndex: 2,
  background: 'var(--card-bg)',
  borderLeft: '1px solid var(--divider)',
};

/**
 * A table whose header is a NORMAL ROW outside the scrolling body — never `position: sticky`.
 * Only the body scrolls, so its scrollbar belongs to the body and scrolled rows never slide
 * under a floating head.
 *
 * The head is a second table; its column widths are MEASURED from the body's first row, so it
 * stays aligned whatever the body's own layout does (auto or fixed) and whether or not the body
 * currently overflows. Horizontal scrolling is mirrored onto the head.
 *
 * Use this for every bounded, scrolling table. A page-level table keeps a plain header row too.
 *
 * The scrolling viewport carries `.scroll-table-viewport`, which styles/index.css uses to
 * size its scrollbars above the global 6px decoration: on a wide table this bar is the only
 * way to reach the right-hand columns (and the pinned action column), so it has to be
 * grabbable rather than merely visible.
 */
export const ScrollTable: React.FC<{
  columns: ScrollTableColumn[];
  children: React.ReactNode;
  /** Body height cap in px. Omit for a body that grows with its rows. */
  maxHeight?: number;
  /** Take the remaining height of a flex parent; the body scrolls inside. */
  fill?: boolean;
  /** Horizontal floor; the body scrolls sideways below it. */
  minWidth?: number;
  /** Shown inside the body when there are no rows. */
  empty?: React.ReactNode;
  /** Style shared by every header cell (padding, weight, height). */
  headCellStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}> = ({ columns, children, maxHeight, fill, minWidth, empty, headCellStyle, style }) => {
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyTableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState<number[] | null>(null);

  const measure = () => {
    const row = bodyTableRef.current?.tBodies[0]?.rows[0];
    if (!row || row.cells.length !== columns.length) {
      setWidths((prev) => (prev === null ? prev : null));
      return;
    }
    const next = Array.from(row.cells).map((cell) => cell.getBoundingClientRect().width);
    setWidths((prev) =>
      prev && prev.length === next.length && prev.every((w, i) => Math.abs(w - next[i]!) < 0.5) ? prev : next
    );
  };

  // After every render: rows, column count and scrollbar presence can all change the tracks.
  useLayoutEffect(measure);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // `measure` reads refs and the current props through them; re-arm only when the column count
    // (the one value it closes over) changes.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [columns.length]);

  const hasDeclaredWidth = columns.some((column) => column.width !== undefined);
  // `position: sticky` cells live inside a `border-collapse: collapse` table —
  // collapsed borders make sticky offsets unreliable (the seam border lands on
  // the row edge instead of the cell). Only a pinned column forces `separate`
  // on the BODY table; callers that use one draw no per-row borders in JS, so
  // the CSS class below re-adds the row rule the collapse used to provide.
  const hasSticky = columns.some((column) => column.sticky);
  const bodyBorderCollapse: React.CSSProperties['borderCollapse'] = hasSticky ? 'separate' : 'collapse';
  const declaredColgroup = (
    <colgroup>
      {columns.map((column) => (
        <col key={column.key} style={column.width !== undefined ? { width: column.width } : undefined} />
      ))}
    </colgroup>
  );
  const measuredColgroup =
    widths && (
      <colgroup>
        {columns.map((column, i) => (
          <col key={column.key} style={{ width: widths[i] }} />
        ))}
      </colgroup>
    );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        border: '1px solid var(--divider)',
        borderRadius: 6,
        overflow: 'hidden',
        ...(fill ? { flex: '1 1 auto' } : {}),
        ...style,
      }}
    >
      {/* The rule under the head belongs to this wrapper, not to the cells: the head table is only
          as wide as the measured body tracks, so a cell border would stop short of the frame
          whenever the body shows a scrollbar. No fill here either — the header reads as a plain
          row over the surface, like every other table in the console. */}
      <div
        ref={headRef}
        style={{ flex: '0 0 auto', overflow: 'hidden', borderBottom: '1px solid var(--divider)' }}
      >
        <table style={{ ...baseTable(Boolean(widths)), ...(widths ? { width: widths.reduce((sum, w) => sum + w, 0) } : {}) }}>
          {measuredColgroup ?? declaredColgroup}
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  style={{
                    ...HEAD_CELL,
                    ...headCellStyle,
                    ...(column.align ? { textAlign: column.align } : {}),
                    ...(column.sticky ? stickyBodyCell : {}),
                    ...column.headStyle,
                  }}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <div
        ref={bodyRef}
        className="scroll-table-viewport"
        onScroll={(event) => {
          if (headRef.current) headRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        style={{
          minHeight: 0,
          overflow: 'auto',
          ...(maxHeight !== undefined ? { maxHeight } : {}),
          ...(fill ? { flex: '1 1 auto' } : {}),
        }}
      >
        <table
          ref={bodyTableRef}
          className={hasSticky ? 'scroll-table-sticky' : undefined}
          style={{
            ...baseTable(hasDeclaredWidth),
            borderCollapse: bodyBorderCollapse,
            // `separate` defaults to 2px cellspacing; zero it so tracks match
            // the collapse layout used by every other ScrollTable.
            borderSpacing: 0,
            ...(minWidth !== undefined ? { minWidth } : {}),
          }}
        >
          {declaredColgroup}
          <tbody className="scroll-table-body">
            {React.Children.toArray(children).filter(React.isValidElement).length === 0 ? (
              empty !== undefined ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    style={{ padding: '18px 10px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}
                  >
                    {empty}
                  </td>
                </tr>
              ) : null
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
