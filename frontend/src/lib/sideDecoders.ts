/**
 * Side decoders — the ONE way a captured body is turned into something a human
 * can read.
 *
 * The model is Wireshark's: a body is just bytes, and any number of decoders
 * may claim those bytes. `hex` is the floor decoder (Wireshark's `data`
 * dissector): it always matches, it is never absent, and it is what you get
 * when nothing more specific applies. Everything else — UTF-8 text, JSON,
 * images, PDF, and each plugin dissector layer — is a peer in the same list.
 *
 * Consequences that make this worth the indirection:
 *   - The drawer has NO special cases. It asks the registry what applies and
 *     renders the winner; a new format is a new entry here (or a plugin layer
 *     on the server), never a new branch in the UI.
 *   - Higher `rank` = more specific. The default view is simply the highest
 *     ranked applicable decoder, so a Connect-RPC frame tree wins over hex and
 *     an image wins over text — with no ordering logic outside the registry.
 */

/** What a decoder produced, in a form the drawer can render directly. */
export type DecoderOutput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; bytes: Uint8Array }
  | { kind: 'none'; reason: string };

/** Input every decoder sees: the captured bytes plus what the wire said. */
export interface DecoderContext {
  /** Captured window bytes (may be shorter than the full body). */
  bytes: Uint8Array | null;
  /** Full captured byte count, when the gateway knows it (sidecar bodies). */
  bodyBytes?: number;
  /** True when the window is shorter than the body — decoders must say so. */
  windowed: boolean;
  contentType?: string;
  /** Plugin dissector layers for this side (server-side protocol knowledge). */
  layers?: { name: string; frames?: unknown[] }[];
  /** Id of the plugin whose dissector produced `layers` (its display name). */
  decoderName?: string;
}

export interface SideDecoder {
  id: string;
  /** i18n key for the picker label — UI text never lives in this module. */
  labelKey: string;
  /** Provider-supplied name that supersedes the generic label (a plugin
   *  dissector is named after the plugin that owns the protocol knowledge:
   *  `cursor-gateway`, `qoder`, … — never a faceless "Decoded"). */
  labelOverride?: string;
  /** Specificity: the highest-ranked applicable decoder is the default view. */
  rank: number;
  match: (ctx: DecoderContext) => boolean;
  render: (ctx: DecoderContext) => DecoderOutput;
}

/** Printable-UTF-8 heuristic: >90% of code points are not control chars. */
const looksTextual = (bytes: Uint8Array): boolean => {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.length === 0) return false;
  let printable = 0;
  for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t') printable++;
  return printable / text.length > 0.9;
};

/** 16-bytes-per-row hex dump (offset / hex / ASCII gutter). */
export const bytesToHexDump = (buf: Uint8Array): string => {
  const rows: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const slice = buf.subarray(off, off + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0'));
    const cells: string[] = [];
    for (let i = 0; i < 16; i += 8) cells.push(hex.slice(i, i + 8).join(' ').padEnd(23, ' '));
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${off.toString(16).padStart(8, '0')}  ${cells.join('  ')}  |${ascii}|`);
  }
  return rows.join('\n');
};

/** Parse a hex dump back into raw bytes (offset + ASCII gutter are prose). */
export const hexDumpToBytes = (dump: string): Uint8Array => {
  const out: number[] = [];
  for (const line of dump.split('\n')) {
    const bar = line.indexOf('|');
    const hexPart = (bar >= 0 ? line.slice(0, bar) : line).replace(/^[0-9a-f]+\s*/, '').replace(/[^0-9a-f]/g, '');
    for (let i = 0; i + 1 < hexPart.length; i += 2) out.push(parseInt(hexPart.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
};

/** Image container sniffing from magic bytes; null when not displayable. */
export const sniffImage = (
  b: Uint8Array
): 'image/png' | 'image/gif' | 'image/jpeg' | 'image/webp' | 'image/bmp' | 'image/x-icon' | null => {
  const head = b.subarray(0, 12);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return 'image/x-icon';
  if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  return null;
};

/** `%PDF-` header → its version (`%PDF-1.7` → `1.7`), null when not a PDF. */
const pdfVersion = (b: Uint8Array): string | null => {
  if (b[0] !== 0x25 || b[1] !== 0x50 || b[2] !== 0x44 || b[3] !== 0x46 || b[4] !== 0x2d) return null;
  return new TextDecoder('latin1').decode(b.subarray(5, 8)).trim() || null;
};

/**
 * Built-in decoders. Order here is documentation only — the picker sorts by
 * `rank`, so the list stays readable while the default view stays correct.
 */
export const BUILTIN_DECODERS: SideDecoder[] = [
  {
    id: 'hex',
    labelKey: 'protoLog.dec.hex',
    rank: 0,
    match: (ctx) => ctx.bytes !== null && ctx.bytes.length > 0,
    render: (ctx) => ({ kind: 'text', text: bytesToHexDump(ctx.bytes!) }),
  },
  {
    id: 'text',
    labelKey: 'protoLog.dec.text',
    rank: 10,
    match: (ctx) => ctx.bytes !== null && ctx.bytes.length > 0 && looksTextual(ctx.bytes),
    render: (ctx) => ({ kind: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(ctx.bytes!) }),
  },
  {
    id: 'json',
    labelKey: 'protoLog.dec.json',
    rank: 20,
    match: (ctx) => {
      if (ctx.bytes === null || ctx.bytes.length === 0) return false;
      const head = new TextDecoder('utf-8', { fatal: false }).decode(ctx.bytes.subarray(0, 64)).trimStart();
      return head.startsWith('{') || head.startsWith('[');
    },
    render: (ctx) => {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(ctx.bytes!);
      try {
        return { kind: 'text', text: JSON.stringify(JSON.parse(raw), null, 2) };
      } catch {
        // A truncated window is not parseable JSON — show it verbatim rather
        // than pretending the body is unreadable.
        return { kind: 'text', text: raw };
      }
    },
  },
  {
    id: 'image',
    labelKey: 'protoLog.dec.image',
    rank: 30,
    match: (ctx) => ctx.bytes !== null && sniffImage(ctx.bytes) !== null,
    render: (ctx) => ({ kind: 'image', mime: sniffImage(ctx.bytes!)!, bytes: ctx.bytes! }),
  },
  {
    id: 'pdf',
    labelKey: 'protoLog.dec.pdf',
    rank: 25,
    match: (ctx) => ctx.bytes !== null && pdfVersion(ctx.bytes) !== null,
    render: (ctx) => ({
      // No PDF engine in the bundle: report what the header says and point at
      // the download. Rendering a truncated PDF would just be a blank box.
      kind: 'text',
      text: [
        `PDF ${pdfVersion(ctx.bytes!) ?? ''}`.trim(),
        `captured: ${ctx.bodyBytes ?? ctx.bytes!.length} bytes${ctx.windowed ? ' (window truncated)' : ''}`,
      ].join('\n'),
    }),
  },
  {
    id: 'dissector',
    labelKey: 'protoLog.dec.dissector',
    rank: 100,
    match: (ctx) => (ctx.layers?.length ?? 0) > 0,
    render: (ctx) => ({
      kind: 'text',
      text: JSON.stringify((ctx.layers ?? []).map((l) => ({ layer: l.name, frames: l.frames ?? [] })), null, 2),
    }),
  },
];

/** Every decoder that applies to this side, most specific first. */
export const applicableDecoders = (ctx: DecoderContext): SideDecoder[] =>
  BUILTIN_DECODERS.filter((d) => {
    try {
      return d.match(ctx);
    } catch {
      return false; // a broken matcher must not blank the pane
    }
  })
    .map((d) => (d.id === 'dissector' && ctx.decoderName ? { ...d, labelOverride: ctx.decoderName } : d))
    .sort((a, b) => b.rank - a.rank);

/** Display label of one decoder. A provider's dissector keeps its generic
 *  i18n label and carries the provider name as a qualifier — `Decode (cursor)`,
 *  not a bare `cursor` (a bare vendor id reads as an unknown noun; the label
 *  must say WHAT the segment is and which decoder owns it). */
export const decoderLabel = (d: SideDecoder, t: (key: string) => string): string =>
  d.labelOverride ? `${t(d.labelKey)} (${d.labelOverride})` : t(d.labelKey);
