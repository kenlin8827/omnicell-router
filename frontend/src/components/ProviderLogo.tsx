import React, { useState } from 'react';

/**
 * Provider logo rendered through the cached catalog proxy
 * (`/api/admin/catalog/logo?url=…`, offline/intranet safe), falling back to an
 * initial-letter chip. Both render on the fixed light `--logo-plate-bg`
 * plate, unfiltered — see index.css for why. Logos are decorative: a missing
 * entry or a failed load silently renders the fallback. `logoMap` is built
 * from
 * `opencodeApi.listProviders()` — its logo values are already local proxy
 * paths (the catalog repository rewrites them via `localLogoApiPath`), so an
 * absolute URL is wrapped only when it is not already a proxied path;
 * double-wrapping makes the proxy reject the inner relative URL (404).
 */
export const ProviderLogo: React.FC<{ providerId: string; logoMap: Record<string, string>; size?: number }> = ({
  providerId,
  logoMap,
  size = 16,
}) => {
  const [failed, setFailed] = useState(false);
  const url = logoMap[providerId];
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
  if (!url || failed) {
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
        src={url.startsWith('/') ? url : `/api/admin/catalog/logo?url=${encodeURIComponent(url)}`}
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        alt={providerId}
        loading="lazy"
        style={{ objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
    </div>
  );
};
