import React from 'react';
import { Globe, MoveRight } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * Outbound egress of one request/turn (ADR-0018) as a single glyph.
 *
 * The old row spelling printed the redacted endpoint inline — `经
 * http://127.0.0.1:7890` — which spends ~24 characters of a dense row on a
 * yes/no question. So the row carries ONE icon and the endpoint moves to the
 * hover tip: still on screen (an operator scanning a list must see which way a
 * model-scoped split actually sent the bytes), just not verbose.
 *
 *   PROXY   → Globe, the glyph the sidebar already uses for the proxy group.
 *   DIRECT  → MoveRight, a straight line out of the machine. Kept quiet on
 *             purpose: it is the default path, and a loud glyph would make
 *             every ordinary row shout.
 *   unknown → em dash. A legacy row, or a transport that never reports its
 *             dial base (plugin executors). NEVER rendered as direct — absence
 *             of a report is not evidence of a path (see api.ts `egress`).
 *
 * Tips ride `[data-tip]` (singleton TooltipProvider), so they are themed,
 * open fast, and survive card overflow like every other hover hint here.
 */
export const EgressIcon: React.FC<{
  /** Backend vocabulary (api.ts): 'direct' | 'proxy'; absent = UNKNOWN. */
  egress?: 'direct' | 'proxy';
  /** Redacted `scheme://host:port`; only meaningful with `egress: 'proxy'`. */
  proxy?: string;
  /** Micro-chip scale — rows sit beside 10–12px glyphs. */
  size?: number;
  /**
   * How an unobserved egress renders. `dash` (default) states the gap;
   * `none` renders nothing at all, for surfaces whose whole line disappears
   * when there is no verdict (probe results), where a lone dash would read as
   * an answer.
   */
  unknown?: 'dash' | 'none';
  /** Call-site spacing (rows differ: a probe line needs a gap, a table cell
   *  does not). */
  style?: React.CSSProperties;
}> = ({ egress, proxy, size = 12, unknown = 'dash', style }) => {
  const { t } = useI18n();
  const box: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: '-2px',
    flexShrink: 0,
    cursor: 'help',
    ...style,
  };
  if (egress === 'proxy') {
    const tip = proxy ? `${t('egress.proxy')}\n${proxy}` : t('egress.proxy');
    return (
      <span style={{ ...box, color: 'var(--hue-blue)' }} data-tip={tip} aria-label={tip}>
        <Globe size={size} />
      </span>
    );
  }
  if (egress === 'direct') {
    const tip = t('egress.direct');
    return (
      <span style={{ ...box, color: 'var(--text-muted)' }} data-tip={tip} aria-label={tip}>
        <MoveRight size={size} />
      </span>
    );
  }
  if (unknown === 'none') return null;
  const tip = t('egress.unknown');
  return (
    <span style={{ ...box, color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }} data-tip={tip} aria-label={tip}>
      —
    </span>
  );
};
