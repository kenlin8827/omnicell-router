import { describe, expect, it } from 'bun:test';
import { compareVersions, isNewerVersion, parseVersion } from '../src/utils/semver.js';
import {
  createUpdateChecker,
  RELEASES_URL,
  UPDATE_CHECK_FAILURE_TTL_MS,
  UPDATE_CHECK_SUCCESS_TTL_MS,
} from '../src/update/check.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const releasePayload = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/kenlin8827/omnicell-router/releases/tag/${tag}`,
  name: `Release ${tag}`,
  published_at: '2026-11-01T00:00:00Z',
  ...extra,
});

describe('semver comparison', () => {
  it('orders numeric segments, not strings', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.99.99', '2.0.0')).toBe(false);
  });

  it('ranks a release above its prereleases and prereleases by semver precedence', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-beta')).toBe(true);
    expect(isNewerVersion('1.0.0-beta', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.10')).toBe(false);
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.11', '1.0.0-beta.2')).toBe(true);
  });

  it('accepts short and unparseable forms without inventing an update', () => {
    expect(parseVersion('1.2')).toMatchObject({ major: 1, minor: 2, patch: 0 });
    expect(parseVersion('garbage')).toBeNull();
    expect(compareVersions('garbage', '1.0.0')).toBe(0);
    expect(isNewerVersion('1.0.0', 'garbage')).toBe(false);
  });
});

describe('release update checker', () => {
  it('answers checking immediately, then settles with the release facts', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let calls = 0;
    const checker = createUpdateChecker({
      currentVersion: '0.6.0',
      now: () => 1_000_000,
      fetchImpl: () => {
        calls += 1;
        // ES2022 lib (backend tsconfig): Promise.withResolvers is unavailable — executor form.
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    const first = checker.status();
    expect(first.checking).toBe(true);
    expect(first.latestVersion).toBeNull();
    expect(calls).toBe(1);

    resolveFetch!(jsonResponse(releasePayload('v0.7.0')));
    const settled = await checker.refresh();

    expect(settled.checking).toBe(false);
    expect(settled.currentVersion).toBe('0.6.0');
    expect(settled.latestVersion).toBe('0.7.0');
    expect(settled.updateAvailable).toBe(true);
    expect(settled.releaseUrl).toBe('https://github.com/kenlin8827/omnicell-router/releases/tag/v0.7.0');
    expect(settled.releaseName).toBe('Release v0.7.0');
    expect(settled.checkedAt).toBe(new Date(1_000_000).toISOString());
    expect(settled.error).toBeUndefined();
  });

  it('does not announce an update when the running version is current or newer', async () => {
    const checker = createUpdateChecker({
      currentVersion: '0.7.0',
      fetchImpl: async () => jsonResponse(releasePayload('v0.7.0')),
    });
    const snapshot = await checker.refresh();
    expect(snapshot.updateAvailable).toBe(false);
    expect(snapshot.latestVersion).toBe('0.7.0');
  });

  it('falls back to the canonical releases URL for a foreign payload link', async () => {
    const checker = createUpdateChecker({
      currentVersion: '0.6.0',
      fetchImpl: async () =>
        jsonResponse(releasePayload('v0.7.0', { html_url: 'https://evil.example/omnicell-router/releases/tag/v0.7.0' })),
    });
    const snapshot = await checker.refresh();
    expect(snapshot.releaseUrl).toBe(RELEASES_URL);
  });

  it('caches a successful answer for the success TTL and refetches when forced', async () => {
    let now = 1_000_000;
    let calls = 0;
    const checker = createUpdateChecker({
      currentVersion: '0.6.0',
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(releasePayload('v0.7.0'));
      },
    });

    await checker.refresh();
    now += UPDATE_CHECK_SUCCESS_TTL_MS - 1;
    await checker.refresh();
    expect(calls).toBe(1);

    now += 1;
    await checker.refresh();
    expect(calls).toBe(2);

    await checker.refresh(true);
    expect(calls).toBe(3);
  });

  it('keeps the last good answer on failure and retries after the shorter failure TTL', async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = false;
    const checker = createUpdateChecker({
      currentVersion: '0.6.0',
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        if (fail) throw new Error('offline');
        return jsonResponse(releasePayload('v0.7.0'));
      },
    });

    await checker.refresh();
    fail = true;
    now += UPDATE_CHECK_SUCCESS_TTL_MS + 1;
    const failed = await checker.refresh();
    expect(calls).toBe(2);
    expect(failed.error).toBe('offline');
    expect(failed.latestVersion).toBe('0.7.0');
    expect(failed.updateAvailable).toBe(true);

    now += UPDATE_CHECK_FAILURE_TTL_MS - 1;
    await checker.refresh();
    expect(calls).toBe(2);

    now += 1;
    fail = false;
    const recovered = await checker.refresh();
    expect(calls).toBe(3);
    expect(recovered.error).toBeUndefined();
  });

  it('surfaces an HTTP failure or a payload without a tag as an error, never a version', async () => {
    const httpError = createUpdateChecker({
      currentVersion: '0.6.0',
      fetchImpl: async () => jsonResponse({ message: 'rate limited' }, 403),
    });
    expect((await httpError.refresh()).error).toBe('GitHub API HTTP 403');

    const noTag = createUpdateChecker({
      currentVersion: '0.6.0',
      fetchImpl: async () => jsonResponse({ html_url: 'https://github.com/kenlin8827/omnicell-router/releases/tag/x' }),
    });
    const snapshot = await noTag.refresh();
    expect(snapshot.error).toBe('GitHub release payload has no tag_name');
    expect(snapshot.latestVersion).toBeNull();
    expect(snapshot.updateAvailable).toBe(false);
  });
});
