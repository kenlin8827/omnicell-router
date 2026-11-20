import { describe, expect, test, afterAll } from 'bun:test';
import { protocolForWire, protocolVocabulary } from '../../src/providers/vocabulary.js';
import { claimPluginWires } from '../../src/providers/plugin-wires.js';
import { wireFor } from '../../src/providers/wire.js';

const VOCABULARY = protocolVocabulary();

// The plugin half of the table is registry-driven; a case that claims a wire is
// a case where a model-service plugin is installed. Nothing here may leave a
// claim behind for the next file in this process.
afterAll(() => claimPluginWires([]));

/**
 * The OCR protocol vocabulary is served to the console over
 * /api/admin/opencode/protocol-vocabulary and DRIVES every UI protocol surface.
 * These pins keep the table honest against the actual wire resolver:
 *   - `package` and `alias` are the same protocol id — no second vocabulary;
 *   - every offered entry resolves through wireFor (no invented wire kinds);
 *   - orders are unique and ascending (stable dropdown order).
 */
describe('protocol vocabulary consistency', () => {
  test('every offered protocol resolves through the same wire', () => {
    for (const e of VOCABULARY) {
      expect(wireFor(e.alias)).toBe(e.wire);
      expect(wireFor(e.package)).toBe(e.wire);
    }
  });

  test('alias and package are the same protocol id', () => {
    for (const e of VOCABULARY) {
      expect(e.package).toBe(e.alias);
    }
  });

  test('orders are unique and ascending — the dropdown order is stable', () => {
    const orders = VOCABULARY.map((e) => e.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
  });

  // The decision protocol IS offered: it resolves to the `systemone` wire, and
  // client loadability is handled by the materializer's CLIENT_PACKAGE_FALLBACK
  // rather than by hiding the option.
  test('the decision protocol is offered and resolves to the decision wire', () => {
    const entry = VOCABULARY.find((e) => e.alias === 'systemone');
    expect(entry?.package).toBe('systemone');
    expect(entry?.wire).toBe('systemone');
    expect(wireFor('systemone')).toBe('systemone');
    // Legacy SDK spellings keep routing.
    expect(wireFor('@ai-sdk/typesafe-ai')).toBe('systemone');
    expect(wireFor('@opencode/ai/providers/typesafe')).toBe('unroutable');
  });

  // Unroutable wires (SDK-side URL construction / SigV4 signing) must never be
  // OFFERED: the dropdown would invite authoring a def the router can't serve.
  test('unroutable aliases are not offered', () => {
    for (const e of VOCABULARY) {
      expect(wireFor(e.alias)).not.toBe('unroutable');
    }
    expect(VOCABULARY.find((e) => e.alias === 'azure')).toBeUndefined();
    expect(VOCABULARY.find((e) => e.alias === 'bedrock')).toBeUndefined();
  });

  // The playground/session chips print protocol ids, but execution only knows
  // the wire — the inverse must land back on an OFFERED id, and an unknown wire
  // must keep its own name instead of inventing one.
  test('protocolForWire inverts wireFor for every offered row', () => {
    for (const e of VOCABULARY) {
      expect(protocolForWire(e.wire)).toBe(e.alias);
    }
    expect(protocolForWire('openai')).toBe('openai-chat');
    expect(protocolForWire('openai-compatible')).toBe('openai-chat');
    expect(wireFor('openai-compatible')).toBe('openai-chat');
    expect(protocolForWire('responses')).toBe('openai-responses');
    // Fail-open: no offered protocol carries this wire (unroutable, or a plugin
    // wire whose plugin is absent) — the raw id stays readable.
    expect(protocolForWire('acme-vendor')).toBe('acme-vendor');
  });
});

// ── The plugin half is DERIVED, never enumerated ───────────────────────────
// A core table naming vendor protocols is the drift this pins against: the
// plugin host is the authority on which wires exist, and a new plugin protocol
// must become selectable with no core edit.
describe('plugin-owned protocols are registry-driven', () => {
  test('an installed plugin wire is offered and resolves to itself', () => {
    claimPluginWires(['acme-vendor']);
    try {
      const entry = protocolVocabulary().find((e) => e.alias === 'acme-vendor');
      expect(entry?.wire).toBe('acme-vendor');
      expect(entry?.package).toBe('acme-vendor');
      expect(wireFor('acme-vendor')).toBe('acme-vendor');
      // Plugin rows sort AFTER every core row (the kind split stays visible).
      expect(entry!.order).toBeGreaterThan(50);
    } finally {
      claimPluginWires([]);
    }
  });

  test('an uninstalled plugin wire is NOT offered — no executor, no suggestion', () => {
    claimPluginWires([]);
    expect(protocolVocabulary().find((e) => e.alias === 'acme-vendor')).toBeUndefined();
  });

  test('an unclaimed bare protocol id still falls back to the chat wire', () => {
    // Lenient by contract: unknown npm/protocol tokens are chat-compatible
    // until a plugin claims them as its own wire.
    claimPluginWires([]);
    expect(wireFor('acme-vendor')).toBe('openai-chat');
  });

  test('a plugin cannot annex a core protocol', () => {
    claimPluginWires(['anthropic-messages']);
    try {
      const rows = protocolVocabulary().filter((e) => e.alias === 'anthropic-messages');
      expect(rows).toHaveLength(1);
      expect(rows[0].order).toBe(20);
      expect(wireFor('anthropic-messages')).toBe('anthropic-messages');
    } finally {
      claimPluginWires([]);
    }
  });

  test('OCR-native ids resolve to their own wire even with no plugin installed', () => {
    claimPluginWires([]);
    // The def may predate the install; the wire must not fall through to chat.
    expect(wireFor('qoder')).toBe('qoder');
    expect(wireFor('workbuddy')).toBe('workbuddy');
    expect(wireFor(undefined, 'https://openapi.qoder.sh')).toBe('qoder');
  });
});

// ── The console's offline fallback is a MIRROR, guarded as one ─────────────
// `frontend/src/lib/protocol-vocabulary.ts` cannot import backend code, so its
// rows are hand-copied. It lists only the CORE protocols: the plugin half is
// registry-derived at runtime and cannot be mirrored offline. Compared by
// source text — the frontend has no importable type for this.
describe('frontend protocol fallback mirrors the core rows', () => {
  test('same core aliases in the same order', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'frontend',
      'src',
      'lib',
      'protocol-vocabulary.ts'
    );
    const src = readFileSync(file, 'utf8');
    const aliases = [...src.matchAll(/^\s*\{ alias: '([^']+)', wire:/gm)].map((m) => m[1]);
    // Plugin rows are never mirrored (they are registry-derived at runtime), so
    // the mirror equals the table with NO plugin installed.
    claimPluginWires([]);
    const core = protocolVocabulary().map((e) => e.alias);
    expect(aliases).toEqual(core);
  });
});
