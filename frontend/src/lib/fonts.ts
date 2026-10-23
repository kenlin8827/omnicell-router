/**
 * Shared font tokens for inline styles. The actual stacks are declared ONCE as
 * CSS custom properties in styles/index.css (`:root` — --font-sans/--font-mono);
 * these constants just reference them so inline `fontFamily` stays in sync.
 * Never re-declare a font chain inline.
 */
export const FONT_MONO = 'var(--font-mono)';
export const FONT_SANS = 'var(--font-sans)';
