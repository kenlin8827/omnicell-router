/**
 * Shared clamp-and-expand text block — the "show a bounded preview, expand
 * for more" interaction used by every long body in the capture surfaces:
 * the replay transcript (thinking / tool args / answers) and the drawer's
 * parsed render view. One implementation on purpose: the `long` heuristic
 * and the line-clamp style must never drift between the two consumers.
 */
import React, { useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { Dialog } from './Dialog';
import { FONT_MONO } from '../lib/fonts';

const MONO = FONT_MONO;

export const MD_PLUGINS = [remarkGfm];
// Captured answers may link out — never hijack the console's own tab.
// Remote <img> is never fetched: a model's markdown must not make the
// operator's browser hit a third-party origin (IP/UA leak, tracking pixel).
// The console's own media route is a same-origin relative path, so it stays.
// Exported: the live chat page (/chat) renders model answers through the SAME
// sanitized map, so the no-remote-fetch rule cannot drift between surfaces.
export const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _node, src, ...props }) =>
    typeof src === 'string' && /^(?:https?:)?\/\//i.test(src) ? (
      <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>[image]</span>
    ) : (
      <img {...props} src={src} loading="lazy" />
    ),
};

/** Prose with line-clamp collapse; the toggle only appears for long bodies.
 *  markdown=true renders GFM (assistant answers) instead of the pre-wrap
 *  well — clamp/expand behavior is identical, only the medium.
 *  mono=false switches the plain (non-markdown) well from the terminal face
 *  to the body font — natural language (prompts, reasoning, injected context)
 *  is not code; JetBrains Mono has no CJK glyphs and the mixed-width fallback
 *  reads as broken typesetting. Tool output stays mono.
 *  open/hideToggle support a parent-owned toggle (ToolResultRow's header row)
 *  so the control can sit above the preview instead of under it.
 *  viewTitle shows a "view" button next to the toggle: it opens the shared
 *  dialog with the full text — scrollable, fullscreen-capable — while the
 *  toggle keeps expanding in place. Answer blocks use both; every other
 *  block keeps just the toggle. */
const Prose: React.FC<{
  text: string;
  clamp?: number;
  color?: string;
  bg?: string;
  border?: string;
  markdown?: boolean;
  mono?: boolean;
  open?: boolean;
  /** Notifies the parent-owned open state on toggle (bulk section control). */
  onOpenChange?: (v: boolean) => void;
  hideToggle?: boolean;
  /** Present → the "view" button appears; its value is the dialog title. */
  viewTitle?: string;
}> = ({
  text,
  clamp = 12,
  color,
  bg,
  border,
  markdown = false,
  mono = true,
  open: openProp,
  onOpenChange,
  hideToggle,
  viewTitle,
}) => {
  const { t } = useI18n();
  const [openState, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewFull, setViewFull] = useState(false);
  const open = openProp ?? openState;
  const long = useMemo(() => text.split('\n').length > clamp || text.length > clamp * 140, [text, clamp]);
  // Collapsed = line-clamp; expanded = full flow — the round's waterfall
  // panel owns vertical scrolling (two scroll layers, not three).
  const clampStyle: React.CSSProperties =
    long && !open
      ? {
          display: '-webkit-box',
          WebkitLineClamp: clamp,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      : {};
  const baseShell: React.CSSProperties = {
    margin: 0,
    padding: '6px 10px',
    background: bg ?? 'var(--well-bg)',
    // 1px frame kept: on the dark theme the fill alone (5% text) is too low a
    // contrast against the panel bg — borderless wells read as edgeless void.
    border: `1px solid ${border ?? 'var(--card-border)'}`,
    borderRadius: 6,
    fontSize: '12px',
    lineHeight: 1.6,
    color: color ?? 'var(--text)',
    wordBreak: 'break-word',
  };
  const shell: React.CSSProperties = { ...baseShell, ...clampStyle };
  return (
    <div>
      {markdown ? (
        <div className="md-well" style={shell}>
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <pre style={{ ...shell, fontFamily: mono ? MONO : 'inherit', whiteSpace: 'pre-wrap' }}>{text}</pre>
      )}
      {long && !hideToggle && (
        <>
          <button
            onClick={() => (onOpenChange ? onOpenChange(!open) : setOpen(o => !o))}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              fontSize: '11px',
              padding: '2px 4px',
              marginLeft: 2,
            }}
          >
            {open ? t('captures.collapse') : t('captures.expand')}
          </button>
          {viewTitle && (
            <button
              onClick={() => setViewOpen(true)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 4px',
                marginLeft: 6,
              }}
            >
              {t('captures.view')}
            </button>
          )}
        </>
      )}
      {/* view dialog: the shared dialog shell hosts the same well, unclamped,
          in its own scroll layer; the header action toggles fullscreen. */}
      {viewOpen && (
        <Dialog
          title={viewTitle ?? t('captures.expand')}
          closeLabel={t('common.close')}
          width={900}
          full={viewFull}
          onClose={() => setViewOpen(false)}
          headerActions={
            <button
              type="button"
              className="btn btn-sm"
              style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 6px' }}
              onClick={() => setViewFull(f => !f)}
              title={viewFull ? t('captures.chatExitFullscreen') : t('captures.chatFullscreen')}
              aria-label={viewFull ? t('captures.chatExitFullscreen') : t('captures.chatFullscreen')}
            >
              {viewFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          }
        >
          {markdown ? (
            <div className="md-well" style={baseShell}>
              <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
                {text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre style={{ ...baseShell, fontFamily: mono ? MONO : 'inherit', whiteSpace: 'pre-wrap' }}>{text}</pre>
          )}
        </Dialog>
      )}
    </div>
  );
};

export { Prose };
