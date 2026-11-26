/**
 * GGUF header metadata reader (Local Models).
 *
 * A .gguf file opens with a self-describing header — magic, tensor count and
 * a key/value metadata section — long before the first weight byte. Reading
 * it answers the two questions the console asks about a local file without
 * loading anything: WHICH architectures/engines can serve it
 * (`general.architecture`, MoE expert counts) and HOW it should be placed
 * (`<arch>.block_count` layers, context length, attention widths for the KV
 * cache estimate).
 *
 * The parse is sequential and bounded: scalars are collected, arrays are
 * walked element by element (the tokenizer's vocab/merges arrays dominate the
 * section and are skipped without being kept), and the whole read stops at
 * the earlier of the last kv pair, the tokenizer section, or a byte cap — a
 * corrupt or hostile file can never make this read the whole multi-GB file.
 */
import fs from 'node:fs';

/** The header scan never reads past this many bytes (metadata sections of
 *  real models sit well under it; the cap exists for corrupt files). */
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
/** Read chunk while growing the header buffer. */
const READ_CHUNK = 1024 * 1024;

const GGUF_MAGIC = 0x46554747; // 'GGUF' little-endian

/** GGUF metadata value types (spec order). */
const T_UINT8 = 0;
const T_INT8 = 1;
const T_UINT16 = 2;
const T_INT16 = 3;
const T_UINT32 = 4;
const T_INT32 = 5;
const T_FLOAT32 = 6;
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;
const T_UINT64 = 10;
const T_INT64 = 11;
const T_FLOAT64 = 12;

export interface GgufMeta {
  ok: boolean;
  /** Why the read failed (`not-gguf`, `truncated`, …); absent when ok. */
  reason?: string;
  /** `general.architecture` (`llama`, `qwen3moe`, …). */
  arch?: string;
  /** `general.name` when the author set one. */
  name?: string;
  /** `general.file_type` (GGML quant enum), informational. */
  fileType?: number;
  /** `<arch>.block_count` — transformer layer count. */
  layers?: number;
  /** `<arch>.context_length` — the model's trained context ceiling. */
  maxCtx?: number;
  /** `<arch>.embedding_length`. */
  embedding?: number;
  /** `<arch>.expert_count` — present only on MoE checkpoints. */
  experts?: number;
  /** `<arch>.expert_used_count` — experts active per token. */
  expertsUsed?: number;
  /** Attention head count (`<arch>.attention.head_count`). */
  heads?: number;
  /** KV head count (`<arch>.attention.head_count_kv`; GQA narrows the cache). */
  kvHeads?: number;
  /** Per-head width (`key_length`, falling back to embedding/heads). */
  headDim?: number;
}

/** Scalar kv pairs collected during the scan (arrays are skipped). */
type ScalarMap = Map<string, number | string | boolean>;

/** Cursor over the growing header buffer; `ensure` pulls more file bytes. */
class HeaderReader {
  private buf = Buffer.alloc(0);
  private pos = 0;
  private eof = false;

  constructor(private fd: number) {}

  /** Bytes consumed so far (the parse position). */
  get offset(): number {
    return this.pos;
  }

  private ensure(need: number): boolean {
    while (this.buf.length - this.pos < need) {
      if (this.eof || this.buf.length >= MAX_HEADER_BYTES) return false;
      const want = Math.min(READ_CHUNK, MAX_HEADER_BYTES - this.buf.length);
      const chunk = Buffer.alloc(want);
      const read = fs.readSync(this.fd, chunk, 0, want, this.buf.length);
      if (read <= 0) {
        this.eof = true;
        return this.buf.length - this.pos >= need;
      }
      this.buf = Buffer.concat([this.buf, chunk.subarray(0, read)]);
    }
    return true;
  }

  u8(): number | null {
    if (!this.ensure(1)) return null;
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number | null {
    if (!this.ensure(2)) return null;
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number | null {
    if (!this.ensure(4)) return null;
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): number | null {
    if (!this.ensure(8)) return null;
    const v = Number(this.buf.readBigUInt64LE(this.pos));
    this.pos += 8;
    return Number.isSafeInteger(v) ? v : null;
  }

  f64(): number | null {
    if (!this.ensure(8)) return null;
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  str(): string | null {
    const len = this.u64();
    if (len == null || len > MAX_HEADER_BYTES) return null;
    if (!this.ensure(len)) return null;
    const v = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return v;
  }

  /** Skip `count` raw bytes (array payloads of fixed-width scalars). */
  skip(count: number): boolean {
    if (!this.ensure(count)) return false;
    this.pos += count;
    return true;
  }
}

/** Fixed byte width of a scalar element type; null for strings (walked). */
function scalarWidth(type: number): number | null {
  switch (type) {
    case T_UINT8:
    case T_INT8:
    case T_BOOL:
      return 1;
    case T_UINT16:
    case T_INT16:
      return 2;
    case T_UINT32:
    case T_INT32:
    case T_FLOAT32:
      return 4;
    case T_UINT64:
    case T_INT64:
    case T_FLOAT64:
      return 8;
    default:
      return null;
  }
}

/** Read one scalar value; strings recurse. null = malformed/truncated. */
function readScalar(reader: HeaderReader, type: number): number | string | boolean | null {
  switch (type) {
    case T_UINT8:
    case T_BOOL:
      { const v = reader.u8(); return v == null ? null : type === T_BOOL ? v !== 0 : v; }
    case T_INT8:
      { const v = reader.u8(); return v == null ? null : v > 127 ? v - 256 : v; }
    case T_UINT16:
    case T_INT16:
      { const raw = reader.u16(); if (raw == null) return null;
        return type === T_INT16 ? (raw > 32767 ? raw - 65536 : raw) : raw; }
    case T_UINT32:
    case T_INT32:
      { const raw = reader.u32(); if (raw == null) return null;
        return type === T_INT32 ? raw | 0 : raw; }
    case T_UINT64:
    case T_INT64:
      return reader.u64();
    case T_FLOAT32:
      { const v = reader.u32(); if (v == null) return null;
        const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b.readFloatLE(0); }
    case T_FLOAT64:
      return reader.f64();
    case T_STRING:
      return reader.str();
    default:
      return null;
  }
}

/** Walk an array payload without keeping it (vocab/merges can be MBs). */
function skipArray(reader: HeaderReader): boolean {
  const elemType = reader.u32();
  const count = reader.u64();
  if (elemType == null || count == null) return false;
  if (elemType === T_STRING) {
    for (let i = 0; i < count; i++) {
      if (reader.str() == null) return false;
    }
    return true;
  }
  const width = scalarWidth(elemType);
  if (width == null) return false;
  return reader.skip(width * count);
}

/**
 * Parse the metadata section of one GGUF file. Never throws: a truncated or
 * foreign file returns `{ ok: false, reason }`. The returned meta is the
 * parsed prefix view — absent fields mean the header did not declare them.
 */
export function readGgufMeta(filePath: string): GgufMeta {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'open failed' };
  }
  try {
    const reader = new HeaderReader(fd);
    const magic = reader.u32();
    if (magic == null) return { ok: false, reason: 'unreadable' };
    if (magic !== GGUF_MAGIC) return { ok: false, reason: 'not-gguf' };
    const version = reader.u32();
    if (version == null || version < 2 || version > 3) return { ok: false, reason: `unsupported-gguf-version` };
    reader.u64(); // tensor count — not needed for placement
    const kvCount = reader.u64();
    if (kvCount == null || kvCount > 1_000_000) return { ok: false, reason: 'truncated' };

    const scalars: ScalarMap = new Map();
    for (let i = 0; i < kvCount; i++) {
      const key = reader.str();
      if (key == null) return { ok: false, reason: 'truncated' };
      const type = reader.u32();
      if (type == null) return { ok: false, reason: 'truncated' };
      if (type === T_ARRAY) {
        if (!skipArray(reader)) return { ok: false, reason: 'truncated' };
      } else {
        const value = readScalar(reader, type);
        if (value == null) return { ok: false, reason: 'truncated' };
        scalars.set(key, value);
      }
      // The tokenizer section is emitted last by every writer in the wild and
      // is the bulk of the section; nothing the console needs lives past it.
      if (key.startsWith('tokenizer.') && scalars.has('general.architecture')) break;
    }

    const arch = typeof scalars.get('general.architecture') === 'string'
      ? (scalars.get('general.architecture') as string)
      : undefined;
    const num = (key: string): number | undefined => {
      const v = scalars.get(key);
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const first = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const v = num(key);
        if (v != null) return v;
      }
      return undefined;
    };
    const prefix = arch ? `${arch}.` : '';
    const heads = arch ? first(`${prefix}attention.head_count`) : undefined;
    const embedding = arch ? first(`${prefix}embedding_length`) : undefined;
    const meta: GgufMeta = {
      ok: true,
      ...(arch ? { arch } : {}),
      ...(typeof scalars.get('general.name') === 'string' ? { name: scalars.get('general.name') as string } : {}),
      ...(num('general.file_type') != null ? { fileType: num('general.file_type') } : {}),
      ...(arch && first(`${prefix}block_count`) != null ? { layers: first(`${prefix}block_count`) } : {}),
      ...(arch && first(`${prefix}context_length`) != null ? { maxCtx: first(`${prefix}context_length`) } : {}),
      ...(embedding != null ? { embedding } : {}),
      ...(arch && first(`${prefix}expert_count`) != null ? { experts: first(`${prefix}expert_count`) } : {}),
      ...(arch && first(`${prefix}expert_used_count`) != null ? { expertsUsed: first(`${prefix}expert_used_count`) } : {}),
      ...(heads != null ? { heads } : {}),
      ...(arch && first(`${prefix}attention.head_count_kv`) != null ? { kvHeads: first(`${prefix}attention.head_count_kv`) } : {}),
    };
    const keyLen = arch ? first(`${prefix}attention.key_length`) : undefined;
    if (keyLen != null) meta.headDim = keyLen;
    else if (heads != null && embedding != null && heads > 0) meta.headDim = Math.round(embedding / heads);
    return meta;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'parse failed' };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A close failure after a successful read changes nothing.
    }
  }
}
