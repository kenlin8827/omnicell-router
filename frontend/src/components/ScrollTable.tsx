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
  // The head's tracks mirror the body's, so a longer label must clip rather than push
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
 * The head is a second table that mirrors the body table's own layout mode and used width, so
 * the tracks line up whatever the body's layout does (auto or fixed) and whether or not the body
 * currently overflows. Horizontal scrolling is mirrored onto the head, and the head's scrollable
 * width is taken from the body's own scroll range — a cell wider than its track (a long badge)
 * overflows into that range, and a head sized to the tracks alone would clamp the mirrored
 * `scrollLeft` short and sit shifted at the far right.
 *
 * Mirrored layout mode alone is NOT enough: with `auto` layout the head would size its columns
 * from its own content (labels) while the body sizes them from row content (badges, buttons,
 * monospace ids), so on a narrow window every column drifted left of its body track. The columns
 * are therefore MEASURED from the body — a table cell's used width is its column's track, so any
 * full-width row reports the same numbers — and the head is laid out fixed over those widths.
 *
 * Use this for every bounded, scrolling table. A page-level table keeps a plain header row too.
 *
 * The scrolling viewport carries `.scroll-table-viewport`, which styles/index.css uses to
 * draw its bar thinner than the global 6px decoration at rest and fatter on hover: on a wide
 * table this bar is the only way to reach the right-hand columns (and the pinned action
 * column), so it has to be grabbable rather than merely visible — a constant 10px hit area
 * with a small resting pill.
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
  // Measured column tracks, in column order. A cell's used width is its COLUMN's
  // track (not its content width), so one full-width row reports every track.
  const [widths, setWidths] = useState<number[] | null>(null);
  // Scrollable width the head must expose. The measured tracks alone are NOT enough:
  // content wider than its track (a long badge, an unbreakable token) overflows into
  // the body's scrollable area, so the body can scroll further right than a head sized
  // to the tracks. The mirrored `scrollLeft` would then clamp short and leave every
  // column shifted by the overflow at the far right of the table.
  const [headWidth, setHeadWidth] = useState<number | null>(null);
  // The width the body's vertical scrollbar takes from its client box. The head's
  // scrollport has no bar, so it is this much WIDER than the body's. A `sticky
  // right: 0` cell pins to its own scrollport's right edge, so without this inset
  // the pinned HEAD cell lands one bar to the right of the pinned BODY cell
  // (visible on narrow windows where the table overflows sideways: the opaque
  // pinned cell clips its neighbour column and a ghost gap opens up in the head).
  const [stickyInset, setStickyInset] = useState(0);

  const measure = () => {
    const body = bodyRef.current;
    const bodyTable = bodyTableRef.current;
    const bar = body ? body.offsetWidth - body.clientWidth : 0;
    // Sample the first row that actually spans EVERY column: band/tree header rows
    // and the empty-state row use colSpan, so their cell count does not match. If no
    // row qualifies the head falls back to its declared colgroup / auto layout.
    let next: number[] | null = null;
    const rows = bodyTable?.tBodies[0]?.rows;
    if (rows) {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.cells.length !== columns.length) continue;
        // Used layout width, NOT getBoundingClientRect: dialogs animate their card
        // with a scale (`ocr-pop-in`), and a rect read during that transform comes
        // back scaled (e.g. 0.97×). `getComputedStyle().width` resolves the used
        // value from layout, so ancestor transforms never leak into the measurement.
        const rowWidths = Array.from(row.cells).map((cell) => {
          const used = Number.parseFloat(getComputedStyle(cell).width);
          return Number.isFinite(used) ? used : cell.getBoundingClientRect().width;
        });
        if (rowWidths.every((w) => Number.isFinite(w) && w > 0)) {
          next = rowWidths;
          break;
        }
      }
    }
    setWidths((prev) => {
      if (!next) return prev === null ? prev : null;
      if (prev && prev.length === next.length && prev.every((w, i) => Math.abs(w - next[i]) < 0.5)) return prev;
      return next;
    });
    if (body) {
      // The body's own scroll range, plus the width a classic vertical scrollbar takes
      // from its client box (the head has no scrollbar, so without that term the head
      // would come up short by the bar's width even with no content overflow).
      const extent = body.scrollWidth + bar;
      setHeadWidth((prev) => (prev !== null && Math.abs(prev - extent) < 0.5 ? prev : extent));
      setStickyInset((prev) => (Math.abs(prev - bar) < 0.5 ? prev : bar));
    }
  };

  // After every render: rows, column count, the body's scrollbar and any content that
  // overflows its track can all change the tracks or the head's scrollable extent.
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
  // The head is laid out fixed over the measured tracks; without a measurable row it
  // keeps the declared colgroup / auto layout. The inner box carries the widest of the
  // measured tracks and the body's scroll extent, so the mirrored `scrollLeft` can reach
  // the far right of content that overflowed its track.
  const headTableWidth = widths ? widths.reduce((sum, w) => sum + w, 0) : null;
  const headBoxWidth =
    headWidth === null && headTableWidth === null ? null : Math.max(headWidth ?? 0, headTableWidth ?? 0);

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
          as wide as the body's tracks, so a cell border would stop short of the frame whenever the
          body shows a scrollbar. No fill here either — the header reads as a plain row over the
          surface, like every other table in the console. */}
      <div
        ref={headRef}
        style={{ flex: '0 0 auto', overflow: 'hidden', borderBottom: '1px solid var(--divider)' }}
      >
        {/* The inner box carries the scroll EXTENT, the table only the tracks. The head must
            mirror the body's own tracks, so the tail left by content that overflowed its track
            inside the body is added OUTSIDE the table — widening the table itself would spread
            the extra width over the tracks and drift every column out of line. */}
        <div style={headBoxWidth !== null ? { width: headBoxWidth } : undefined}>
          <table
            style={{
              ...baseTable(Boolean(widths) || hasDeclaredWidth),
              ...(headTableWidth !== null ? { width: headTableWidth } : {}),
            }}
          >
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
                      // Pin with the body's bar inset so the seam lands on the
                      // SAME x as the pinned body cell below it.
                      ...(column.sticky ? { ...stickyBodyCell, right: stickyInset } : {}),
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
