import React from 'react';

/**
 * Client brand logos, auto-discovered from SVG files on disk.
 *
 * TWO asset shapes, both keyed by file basename (which maps 1:1 to backend
 * client adapter names):
 *
 * - `<clientName>.svg` — monochrome mark, 24x24 viewBox, no fills. Rendered
 *   inline, `fill="currentColor"` (theme-safe: colors come from CSS variables).
 * - `<clientName>.color.svg` — the vendor's own app icon/tile, colors and its
 *   own viewBox intact. Rendered as an `<img>` of the built asset URL, so the
 *   brand colors survive and the SVG is never mutated.
 *
 * Loaded at BUILD time (eager globs): Vite inlines the monochrome content and
 * emits the color assets — zero runtime HTTP requests beyond the cached asset,
 * offline/intranet safe.
 *
 * Sources: simple-icons (https://simpleicons.org, CC0-1.0). Note: the OpenAI
 * mark was removed from upstream simple-icons (v15+) at OpenAI's request, so
 * codex.svg is vendored from simple-icons@13 and maintained locally.
 * pi.svg is derived from the official Pi press-kit mark (pi.dev/press-kit,
 * three tile paths on an 800x800 grid), rescaled to 24x24 and flattened to
 * monochrome — the colored tiles become untagged subpaths so the wrapper's
 * fill="currentColor" themes it with the rest of the row.
 * qoder.color.svg is the Qoder app icon shipped in `plugins/qoder/logo.svg`.
 * idea.color.svg / goland.color.svg are JetBrains' official product icons
 *   (resources.jetbrains.com/storage/products/company/brand/logos/IntelliJ_IDEA_icon.svg
 *   and GoLand_icon.svg), vendored because simple-icons carries no JetBrains
 *   product marks — and the Go language mark would label a product instead of
 *   the language it is for. The earlier `idea.svg` was byte-identical to the
 *   FAMILY mark, so it is gone: the console drew "IntelliJ IDEA" beside the
 *   JetBrains logo and no reader could tell the two apart.
 * jetbrains.svg is JetBrains' own family mark (24x24, single path, no fill) from
 *   resources.jetbrains.com/storage/products/company/brand/logos/jetbrains.svg —
 *   the family card uses it, its product rows use the product icons above.
 * google.color.svg is Google's official multicolor "G" mark (Wikimedia Commons,
 *   file `Google_"G"_logo.svg`), vendored because the provider glyph for Google
 *   AI is the Gemini sparkle, not the Google brand mark.
 */
const BRAND_SVGS: Record<string, string> = {};
for (const [file, raw] of Object.entries(
  import.meta.glob('../assets/brands/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
)) {
  if (file.endsWith('.color.svg')) continue;
  const name = file.split('/').pop()!.replace(/\.svg$/, '');
  BRAND_SVGS[name] = raw;
}

const COLOR_SVGS: Record<string, string> = {};
for (const [file, url] of Object.entries(
  import.meta.glob('../assets/brands/*.color.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)) {
  const name = file.split('/').pop()!.replace(/\.color\.svg$/, '');
  COLOR_SVGS[name] = url;
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
  const key = name.toLowerCase().trim();
  const colored = COLOR_SVGS[key];
  if (colored) {
    return (
      <img
        src={colored}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      />
    );
  }
  const raw = BRAND_SVGS[key];
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
