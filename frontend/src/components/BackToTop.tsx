/**
 * Floating back-to-top pill for the fullscreen reading surfaces (session
 * fullscreen read + single-round focus overlay). Long agent rounds scroll
 * deep; the wheel-less trip back deserves a one-click shortcut.
 *
 * Renders absolutely against the nearest positioned ancestor — the overlay
 * roots are `position: fixed`, so mount it as a sibling of the scroll
 * container (never inside it, or it would scroll away with the content).
 */
import React, { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

export const BackToTop: React.FC<{ scrollRef: React.RefObject<HTMLDivElement> }> = ({ scrollRef }) => {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setShow(el.scrollTop > 300);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);
  if (!show) return null;
  return (
    <button
      onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      title={t('captures.backToTop')}
      style={{
        position: 'absolute',
        right: 20,
        bottom: 20,
        width: 34,
        height: 34,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        border: '1px solid var(--card-border)',
        // Opaque composite (tint over the solid base): a plain --bg-elev fill
        // is translucent and content would show through the pill.
        background: 'linear-gradient(var(--bg-elev), var(--bg-elev)), var(--bg)',
        color: 'var(--text-muted)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
      }}
    >
      <ArrowUp size={16} />
    </button>
  );
};
