import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { browseAwesomeOpencode, resetBrowseCache } from '../src/harness/browse.js';

/**
 * awesome-opencode is the only browse source whose payload is a FOREIGN structured registry.
 * `dist/registry.json` is a flat array mixing five categories; only `plugins` are extensions, and the
 * row's key must stay install-honest (no package name is published upstream).
 */

/** Shaped exactly like `scripts/export-json.js` output. */
const REGISTRY = [
  {
    productId: 'agent-memory',
    type: 'plugins',
    displayName: 'Agent Memory',
    repoUrl: 'https://github.com/joshuadavidthomas/opencode-agent-memory',
    tagline: 'Letta-inspired memory',
    description: 'Persistent, self-editable memory blocks inspired by Letta agents.',
    scope: ['global'],
    tags: ['memory', 'persistence'],
    minVersion: '1.0.0',
  },
  {
    productId: 'notifier',
    type: 'plugins',
    displayName: 'Notifier',
    repoUrl: 'https://github.com/mohak34/opencode-notifier',
    tagline: 'Desktop notifications',
    description: 'Desktop notifications and sound alerts for permission and completion events.',
    tags: [],
  },
  {
    productId: 'dracula',
    type: 'themes',
    displayName: 'Dracula',
    repoUrl: 'https://github.com/example/dracula',
    tagline: 'A dark theme',
    description: 'A dark theme for the TUI.',
  },
];

const realFetch = globalThis.fetch;

function stub(status: number, body: string, contentType = 'application/json'): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

beforeEach(() => {
  resetBrowseCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('browseAwesomeOpencode', () => {
  it('answers unavailable when the GitHub API rate limit is hit', async () => {
    stub(403, '{"message":"API rate limit exceeded"}');
    const result = await browseAwesomeOpencode('', 24);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toContain('GITHUB_TOKEN');
  }, 30_000);

  it('refuses a payload that is not the declared flat array', async () => {
    stub(200, '{"total_count":3}');
    const result = await browseAwesomeOpencode('', 24);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('upstream');
    expect(result.message).toContain('flat array');
  });

  it('decodes a base64 contents envelope the API answered instead of raw bytes', async () => {
    const envelope = JSON.stringify({
      content: Buffer.from(JSON.stringify(REGISTRY), 'utf8').toString('base64'),
      encoding: 'base64',
    });
    stub(200, envelope);
    const result = await browseAwesomeOpencode('', 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.length).toBe(2);
  });

  it('keeps plugins only, maps the shared market shape, and caches the whole registry', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(REGISTRY), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await browseAwesomeOpencode('', 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A theme in an extension market would be a category error.
    expect(result.items.map((i) => i.name)).toEqual(['Agent Memory', 'Notifier']);
    const memory = result.items[0]!;
    expect(memory.sourceId).toBe('awesome-opencode');
    expect(memory.installKind).toBe('extension');
    expect(memory.key).toBe('awesome-opencode:agent-memory');
    expect(memory.repo).toBe('joshuadavidthomas/opencode-agent-memory');
    expect(memory.topics).toEqual(['memory', 'persistence']);
    expect(memory.stars).toBeNull();
    expect(memory.updatedAt).toBe('');
    expect(calls).toBe(1);

    // A second query answers from the cache: one upstream read serves every keystroke.
    const filtered = await browseAwesomeOpencode('notif', 50);
    if (!filtered.ok) throw new Error('expected ok');
    expect(filtered.items.map((i) => i.name)).toEqual(['Notifier']);
    expect(calls).toBe(1);
  });

  it('filters on name, description and tags', async () => {
    stub(200, JSON.stringify(REGISTRY));
    const byTag = await browseAwesomeOpencode('persistence', 50);
    if (!byTag.ok) throw new Error('expected ok');
    expect(byTag.items.map((i) => i.name)).toEqual(['Agent Memory']);

    const byDescription = await browseAwesomeOpencode('SOUND ALERTS', 50);
    if (!byDescription.ok) throw new Error('expected ok');
    expect(byDescription.items.map((i) => i.name)).toEqual(['Notifier']);

    const miss = await browseAwesomeOpencode('zzz-nope-zzz', 50);
    if (!miss.ok) throw new Error('expected ok');
    expect(miss.items).toEqual([]);
  });
});
