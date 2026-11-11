import { describe, expect, it } from 'vitest';
import { applicableDecoders, bytesToHexDump, hexDumpToBytes, sniffImage, type DecoderContext } from './sideDecoders';

/**
 * Side decoder registry — the ONE path from captured bytes to a readable view.
 *
 * The invariant worth guarding: `hex` ALWAYS applies (it is the floor decoder,
 * Wireshark's `data`), and the DEFAULT view is the most specific decoder that
 * claims the bytes. A regression here silently hides protocol knowledge behind
 * a hex dump, which is exactly the failure this registry exists to prevent.
 */

const ctx = (bytes: Uint8Array | null, extra: Partial<DecoderContext> = {}): DecoderContext => ({
  bytes,
  bodyBytes: bytes?.length,
  windowed: false,
  ...extra,
});

const ids = (c: DecoderContext): string[] => applicableDecoders(c).map((d) => d.id);

describe('side decoders', () => {
  it('offers hex as the floor for any non-empty body', () => {
    expect(ids(ctx(new Uint8Array([0x00, 0xff, 0x10])))).toEqual(['hex']);
    expect(ids(ctx(new Uint8Array(0)))).toEqual([]);
  });

  it('ranks the most specific decoder first: text < json < image < dissector', () => {
    expect(ids(ctx(new TextEncoder().encode('plain words')))[0]).toBe('text');
    expect(ids(ctx(new TextEncoder().encode('{"a":1}')))[0]).toBe('json');
    // 1x1 PNG header + trailing bytes — the magic bytes are what matters.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(ids(ctx(png))[0]).toBe('image');
    expect(ids(ctx(png, { layers: [{ name: 'connect-frames', frames: [] }] }))[0]).toBe('dissector');
  });

  it('recognizes a PDF header without pretending to render it', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%...');
    const decoders = applicableDecoders(ctx(pdf));
    expect(decoders[0]?.id).toBe('pdf');
    const out = decoders[0]!.render(ctx(pdf));
    expect(out.kind).toBe('text');
    expect(out.kind === 'text' && out.text).toContain('PDF 1.7');
  });

  it('pretty-prints JSON, and falls back to verbatim text on a truncated window', () => {
    const full = new TextEncoder().encode('{"a":1,"b":[2]}');
    const out = applicableDecoders(ctx(full))[0]!.render(ctx(full));
    expect(out.kind === 'text' && out.text).toContain('\n  "a": 1');
    const cut = new TextEncoder().encode('{"a":1,"b":');
    const partial = applicableDecoders(ctx(cut))[0]!.render(ctx(cut));
    expect(partial.kind === 'text' && partial.text).toBe('{"a":1,"b":');
  });

  it('reports the dissector layers as the decoded view', () => {
    const body = new Uint8Array([1, 2, 3]);
    const c = ctx(body, { layers: [{ name: 'connect-frames', frames: [{ bytes: 3 }] }] });
    const out = applicableDecoders(c)[0]!.render(c);
    expect(out.kind === 'text' && out.text).toContain('connect-frames');
    expect(out.kind === 'text' && out.text).toContain('"bytes": 3');
  });

  it('round-trips a hex dump', () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x00, 0xff, 0x7f]);
    expect([...hexDumpToBytes(bytesToHexDump(bytes))]).toEqual([...bytes]);
  });

  it('sniffs only displayable image containers', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('not an image'))).toBeNull();
  });
});
