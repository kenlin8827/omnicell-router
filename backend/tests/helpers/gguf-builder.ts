/**
 * Synthetic GGUF writer for tests: builds just the header (magic, version,
 * tensor count, kv section) the reader parses — no tensor data follows, which
 * is fine because readGgufMeta never seeks past the metadata section.
 */

export type GgufKv =
  | { key: string; type: 'string'; value: string }
  | { key: string; type: 'uint32'; value: number }
  | { key: string; type: 'bool'; value: boolean }
  | { key: string; type: 'array-string'; value: string[] }
  | { key: string; type: 'array-uint32'; value: number[] };

const T_UINT32 = 4;
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function str(v: string): Buffer {
  const bytes = Buffer.from(v, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

/**
 * Serialize a GGUF v2/v3 header from kv pairs, in the order given (the early
 * stop tests rely on emission order, so the builder never sorts).
 */
export function buildGguf(kvs: GgufKv[], version = 3): Buffer {
  const parts: Buffer[] = [u32(0x46554747), u32(version), u64(0), u64(kvs.length)];
  for (const kv of kvs) {
    parts.push(str(kv.key));
    switch (kv.type) {
      case 'string':
        parts.push(u32(T_STRING), str(kv.value));
        break;
      case 'uint32':
        parts.push(u32(T_UINT32), u32(kv.value));
        break;
      case 'bool':
        parts.push(u32(T_BOOL), Buffer.from([kv.value ? 1 : 0]));
        break;
      case 'array-string':
        parts.push(u32(T_ARRAY), u32(T_STRING), u64(kv.value.length));
        for (const item of kv.value) parts.push(str(item));
        break;
      case 'array-uint32':
        parts.push(u32(T_ARRAY), u32(T_UINT32), u64(kv.value.length));
        for (const item of kv.value) parts.push(u32(item));
        break;
    }
  }
  return Buffer.concat(parts);
}
