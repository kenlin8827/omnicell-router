/**
 * Release update check — asynchronous, cached, never on the request path of a
 * model call.
 *
 * The console asks the gateway; the gateway asks GitHub's latest-release
 * endpoint. A call is made at most once per success TTL (or per failure TTL,
 * so an offline box retries sooner than six hours but never hammers the API).
 * The first console read triggers the check in the background and answers
 * `checking: true`; the console polls until the answer settles.
 *
 * The check is display-only: it never gates routing and its failure is a log
 * line, not a gateway error. `releaseUrl` is always validated to the project's
 * own release host before it reaches the browser.
 */
import { APP_VERSION } from '../version.js';
import { isNewerVersion } from '../utils/semver.js';
import { proxiedFetch } from '../utils/proxy.js';

export const UPDATE_REPO = 'kenlin8827/omnicell-router';
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Re-asking GitHub after a successful answer. */
export const UPDATE_CHECK_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
/** Shorter retry after a network/API failure: an offline start should recover
 *  without waiting the full success window, yet not probe on every console load. */
export const UPDATE_CHECK_FAILURE_TTL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 8000;

export interface UpdateCheckSnapshot {
  /** Version of THIS gateway process (backend/src/version.ts). */
  currentVersion: string;
  /** Newest published release, normalized (`v0.6.0` → `0.6.0`); null until the
   *  first successful check. */
  latestVersion: string | null;
  /** Strict semver comparison; false when either side is unparseable. */
  updateAvailable: boolean;
  /** GitHub release page to open — the project's own URL, never an arbitrary
   *  payload link. */
  releaseUrl: string;
  releaseName?: string;
  publishedAt?: string;
  /** ISO timestamp of the last successful check. */
  checkedAt?: string;
  /** A background check is currently in flight. */
  checking: boolean;
  /** Last failure (network / HTTP / malformed payload); cleared by success. */
  error?: string;
}

type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface ReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  name?: unknown;
  published_at?: unknown;
}

export interface UpdateChecker {
  /** Current snapshot; starts a background refresh when the cache is stale. */
  status(): UpdateCheckSnapshot;
  /** Await a check (bounded by the cache TTL unless `force`). */
  refresh(force?: boolean): Promise<UpdateCheckSnapshot>;
}

export interface UpdateCheckerOptions {
  currentVersion?: string;
  fetchImpl?: UpdateFetch;
  now?: () => number;
}

/** Accept only this repository's release pages; anything else falls back to the
 *  canonical /releases/latest URL. */
function trustedReleaseUrl(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(`/${UPDATE_REPO}/releases/`)) {
        return url.toString();
      }
    } catch {
      // fall through
    }
  }
  return RELEASES_URL;
}

export function createUpdateChecker(options: UpdateCheckerOptions = {}): UpdateChecker {
  const currentVersion = options.currentVersion ?? APP_VERSION;
  const fetchImpl = options.fetchImpl ?? proxiedFetch;
  const now = options.now ?? Date.now;

  let latestVersion: string | null = null;
  let updateAvailable = false;
  let releaseUrl = RELEASES_URL;
  let releaseName: string | undefined;
  let publishedAt: string | undefined;
  let checkedAt: string | undefined;
  let error: string | undefined;
  let lastAttemptAt = 0;
  let inFlight: Promise<void> | null = null;

  const snapshot = (): UpdateCheckSnapshot => ({
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    ...(releaseName ? { releaseName } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    checking: inFlight !== null,
    ...(error ? { error } : {}),
  });

  const ttl = (): number => (error ? UPDATE_CHECK_FAILURE_TTL_MS : UPDATE_CHECK_SUCCESS_TTL_MS);

  const run = async (): Promise<void> => {
    try {
      const response = await fetchImpl(LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `OmniCellRouter/${currentVersion}`,
        },
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      const payload = (await response.json()) as ReleasePayload;
      const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim().replace(/^[vV]/, '') : '';
      if (!tag) throw new Error('GitHub release payload has no tag_name');

      latestVersion = tag;
      updateAvailable = isNewerVersion(tag, currentVersion);
      releaseUrl = trustedReleaseUrl(payload.html_url);
      releaseName = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : undefined;
      publishedAt = typeof payload.published_at === 'string' && payload.published_at ? payload.published_at : undefined;
      checkedAt = new Date(now()).toISOString();
      error = undefined;
    } catch (cause) {
      // Keep the last successful answer visible; only the retry timing changes.
      error = cause instanceof Error && cause.message ? cause.message : String(cause);
    }
  };

  const refresh = (force = false): Promise<UpdateCheckSnapshot> => {
    if (inFlight) return inFlight.then(snapshot);
    if (!force && lastAttemptAt !== 0 && now() - lastAttemptAt < ttl()) {
      return Promise.resolve(snapshot());
    }
    lastAttemptAt = now();
    const pending = run().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending.then(snapshot);
  };

  return {
    status() {
      if (!inFlight && (lastAttemptAt === 0 || now() - lastAttemptAt >= ttl())) {
        void refresh();
      }
      return snapshot();
    },
    refresh,
  };
}

let singleton: UpdateChecker | null = null;

/** Process-wide checker (one cache, one in-flight request per gateway). */
export function getUpdateChecker(): UpdateChecker {
  if (!singleton) singleton = createUpdateChecker();
  return singleton;
}
