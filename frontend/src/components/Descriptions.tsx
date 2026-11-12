import React from 'react';

/**
 * Bordered description list (the Ant Design Descriptions shape): every item
 * renders as a dim label cell followed by a content cell, laid out on a fixed
 * `column`-item grid. Items are placed in DOM order; `span` lets one item own
 * a whole row (a long value — a series of stats, a model ref — never shares
 * its row). Borders collapse via the 1px-gap trick: the container paints the
 * border color, the cells sit on top with the elevated background.
 *
 * Consumed by the session-detail summary card (SessionsPage), where the old
 * label-over-value stat grid read as scattered tiles because each metric
 * owned a variable-width track.
 */
export interface DescriptionsItem {
  key: string;
  label: React.ReactNode;
  /** Tooltip on the label cell (explains the metric, not the value). */
  title?: string;
  /** Items per full row this one occupies (default 1; `column` = a whole row). */
  span?: number;
  children: React.ReactNode;
}

export const Descriptions: React.FC<{
  items: DescriptionsItem[];
  /** Items per row (label+content pairs). Default 2. */
  column?: number;
}> = ({ items, column = 2 }) => {
  // Track pattern per item: an auto-width label + one flexible content cell.
  const template = Array.from({ length: column }, () => 'auto minmax(0, 1fr)').join(' ');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: template,
        gap: 1,
        background: 'var(--divider)',
        border: '1px solid var(--divider)',
        borderRadius: 8,
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {items.map(item => (
        <React.Fragment key={item.key}>
          <div
            title={item.title}
            style={{
              background: 'var(--bg-elev)',
              padding: '7px 12px',
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-muted)',
              fontWeight: 'var(--font-semibold)',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              background: 'var(--bg-elev)',
              padding: '7px 12px',
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              ...(item.span && item.span > 1
                ? { gridColumn: `span ${(item.span - 1) * 2 + 1}` }
                : {}),
            }}
          >
            {item.children}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
