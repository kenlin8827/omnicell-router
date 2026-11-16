import type { CSSProperties } from 'react';
import { FONT_MONO } from './fonts';

/**
 * Style atoms shared by the proxy-capability pages (inbound access settings and
 * the traffic log that explains their rules). They live here rather than in one
 * page because the detail drawer in the log page and the section headers in the
 * settings page must look like the same console — two local copies of the same
 * literal would drift on the next restyle.
 */

/** Monospace, non-wrapping cell text (hosts, paths, ids). */
export const FONT_MONO_COLOR: CSSProperties = { fontFamily: FONT_MONO, whiteSpace: 'nowrap' };

/** Section header inside a .sub-card group — 11px bold dim, one tier under card titles. */
export const SEC_TITLE: CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-bold)',
  color: 'var(--text-dim)',
  marginBottom: '12px',
  letterSpacing: 'var(--tracking-wide)',
};
