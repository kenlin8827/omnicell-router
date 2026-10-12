import React from 'react';

/**
 * Client brand logos, auto-discovered from SVG files on disk.
 *
 * Drop a `frontend/src/assets/brands/<clientName>.svg` file (24x24 viewBox,
 * Simple-Icons style) and it is picked up automatically — no TSX change.
 * File basenames map 1:1 to backend client adapter names (opencode/claude/codex,
 * see backend/src/cli/clients/index.ts).
 *
 * Loaded at BUILD time via import.meta.glob('?raw', eager): Vite reads the
 * files from disk and inlines them into the bundle — zero runtime HTTP
 * requests, offline/intranet safe. Rendered monochrome via currentColor
 * (theme-safe: colors come from CSS variables, never hardcoded brand hexes).
 *
 * Sources: simple-icons (https://simpleicons.org, CC0-1.0). Note: the OpenAI
 * mark was removed from upstream simple-icons (v15+) at OpenAI's request, so
 * codex.svg is vendored from simple-icons@13 and maintained locally.
 * pi.svg is derived from the official Pi press-kit mark (pi.dev/press-kit,
 * three tile paths on an 800x800 grid), rescaled to 24x24 and flattened to
 * monochrome — the colored tiles become untagged subpaths so the wrapper's
 * fill="currentColor" themes it with the rest of the row.
 */
const BRAND_SVGS: Record<string, string> = {};
for (const [file, raw] of Object.entries(
  import.meta.glob('../assets/brands/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
)) {
  const name = file.split('/').pop()!.replace(/\.svg$/, '');
  BRAND_SVGS[name] = raw;
}

/** Strip the file's own <svg> wrapper; we re-host the inner content in a sized, currentColor svg. */
const toInner = (raw: string): string =>
  raw.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

interface BrandIconProps {
  /** Client name from ClientStatus (opencode / claude / codex …) */
  name: string;
  size?: number;
  /** Rendered instead when the client has no brand SVG on disk */
  fallback?: React.ReactNode;
}

export const BrandIcon: React.FC<BrandIconProps> = ({ name, size = 18, fallback = null }) => {
  const raw = BRAND_SVGS[name.toLowerCase().trim()];
  if (!raw) return <>{fallback}</>;
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: toInner(raw) }}
    />
  );
};
