import React, { useEffect, useState } from 'react';
import { BUNDLED_PROVIDER_LOGOS, WORDMARK_PROVIDER_LOGOS } from '../lib/provider-logos';

/**
 * Provider logo, resolved in strict precedence order:
 *
 * 1. the BUNDLED official glyph (`frontend/public/provider-logos/<id>.svg`,
 *    downloaded from models.dev / the OpenRouter brand page — see
 *    `scripts/fetch-provider-logos.ts`). Offline-first: no dependence on the
 *    catalog disk cache being warm, and the console never shows a letter chip
 *    for a provider whose official mark we already ship;
 * 2. the catalog/plugin logo from `logoMap` (`/api/admin/catalog/logo?url=…`,
 *    or a plugin's `/api/admin/plugins/<id>/logo` path);
 * 3. an initial-letter chip.
 *
 * A failed load steps down the chain instead of retrying the same URL.
 * `logoMap` is built from `opencodeApi.listProviders()` — its logo values are
 * already local proxy paths (the catalog repository rewrites them via
 * `localLogoApiPath`), so an absolute URL is wrapped only when it is not
 * already a proxied path; double-wrapping makes the proxy reject the inner
 * relative URL (404).
 */

/**
 * The bundled-first source chain, also used by the page-local logo renderers.
 * Wordmark lockups are skipped entirely: every card keeps one square plate, and
 * a wide lockup squeezed into it degenerates into illegible smeared text — a
 * monogram reads better and keeps the grid uniform.
 */
export function providerLogoSources(providerId: string, remote?: string): string[] {
  if (WORDMARK_PROVIDER_LOGOS[providerId]) return [];
  const sources: string[] = [];
  if (BUNDLED_PROVIDER_LOGOS.has(providerId)) {
    sources.push(`${import.meta.env.BASE_URL}provider-logos/${encodeURIComponent(providerId)}.svg`);
  }
  if (remote) {
    sources.push(remote.startsWith('/') ? remote : `/api/admin/catalog/logo?url=${encodeURIComponent(remote)}`);
  }
  return sources;
}

export const ProviderLogo: React.FC<{ providerId: string; logoMap: Record<string, string>; size?: number }> = ({
  providerId,
  logoMap,
  size = 16,
}) => {
  const remote = logoMap[providerId];
  const sources = providerLogoSources(providerId, remote);
  const [step, setStep] = useState(0);
  // New provider / refreshed map → restart from the bundled glyph.
  useEffect(() => setStep(0), [providerId, remote]);
  const url = sources[step];
  // Fixed light plate, unfiltered artwork (mirrors KeysPage).
  const chip: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, Math.round(size * 0.28)),
    background: 'var(--logo-plate-bg)',
    border: '1px solid var(--card-border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  };
  if (!url) {
    return (
      <div style={chip}>
        <span
          style={{
            fontSize: Math.round(size * 0.55),
            fontWeight: 'var(--font-bold)',
            color: 'var(--logo-plate-ink)',
            textTransform: 'uppercase',
            lineHeight: 'var(--leading-none)',
          }}
        >
          {providerId.charAt(0)}
        </span>
      </div>
    );
  }
  return (
    <div style={chip}>
      <img
        src={url}
        width={Math.round(size * 0.78)}
        height={Math.round(size * 0.78)}
        alt={providerId}
        loading="lazy"
        style={{ objectFit: 'contain' }}
        onError={() => setStep((s) => s + 1)}
      />
    </div>
  );
};
