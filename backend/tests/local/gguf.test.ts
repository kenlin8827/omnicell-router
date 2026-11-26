/**
 * readGgufMeta + engineSupportFor: the GGUF header IS the model's identity —
 * arch, layers, context, MoE geometry and the KV widths all come from it, and
 * the engine badges derive from the arch (ADR-0037 §3).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineSupportFor } from '../../src/local/engines.js';
import { readGgufMeta, type GgufMeta } from '../../src/local/gguf.js';
import { buildGguf, type GgufKv } from '../helpers/gguf-builder.js';
import { makeStrataWorkspace } from './strata-fixture.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gguf-test-'));
const strataRoots: string[] = [];

afterEach(() => {
  for (const root of strataRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeGguf(name: string, kvs: GgufKv[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, buildGguf(kvs));
  return file;
}

const QWEN3MOE_KVS: GgufKv[] = [
  { key: 'general.architecture', type: 'string', value: 'qwen3moe' },
  { key: 'general.name', type: 'string', value: 'Qwen3 30B A3B' },
  { key: 'general.file_type', type: 'uint32', value: 15 },
  { key: 'qwen3moe.block_count', type: 'uint32', value: 48 },
  { key: 'qwen3moe.context_length', type: 'uint32', value: 32768 },
  { key: 'qwen3moe.embedding_length', type: 'uint32', value: 2048 },
  { key: 'qwen3moe.attention.head_count', type: 'uint32', value: 32 },
  { key: 'qwen3moe.attention.head_count_kv', type: 'uint32', value: 4 },
  { key: 'qwen3moe.expert_count', type: 'uint32', value: 128 },
  { key: 'qwen3moe.expert_used_count', type: 'uint32', value: 8 },
];

describe('readGgufMeta', () => {
  test('parses a full MoE header incl. derived headDim', () => {
    const meta = readGgufMeta(writeGguf('moe.gguf', QWEN3MOE_KVS));
    expect(meta.ok).toBe(true);
    expect(meta.arch).toBe('qwen3moe');
    expect(meta.name).toBe('Qwen3 30B A3B');
    expect(meta.fileType).toBe(15);
    expect(meta.layers).toBe(48);
    expect(meta.maxCtx).toBe(32768);
    expect(meta.embedding).toBe(2048);
    expect(meta.heads).toBe(32);
    expect(meta.kvHeads).toBe(4);
    expect(meta.experts).toBe(128);
    expect(meta.expertsUsed).toBe(8);
    // No explicit key_length: embedding / heads.
    expect(meta.headDim).toBe(64);
  });

  test('an explicit attention.key_length wins over the derivation', () => {
    const meta = readGgufMeta(writeGguf('keylen.gguf', [
      ...QWEN3MOE_KVS,
      { key: 'qwen3moe.attention.key_length', type: 'uint32', value: 128 },
    ]));
    expect(meta.ok).toBe(true);
    expect(meta.headDim).toBe(128);
  });

  test('arrays are skipped and the tokenizer section stops the scan early', () => {
    const meta = readGgufMeta(writeGguf('tok.gguf', [
      ...QWEN3MOE_KVS,
      // The vocab array dominates real files; it must be walked, never kept.
      { key: 'tokenizer.ggml.tokens', type: 'array-string', value: ['<s>', 'hello', 'world'] },
      // Emitted after the tokenizer section: never collected (early stop).
      { key: 'general.alignment', type: 'uint32', value: 32 },
    ]));
    expect(meta.ok).toBe(true);
    expect(meta.arch).toBe('qwen3moe');
    expect(meta.layers).toBe(48);
  });

  test('a non-GGUF file is rejected with not-gguf', () => {
    const file = path.join(tmp, 'weights.safetensors');
    fs.writeFileSync(file, Buffer.from('not a gguf at all'));
    const meta = readGgufMeta(file);
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe('not-gguf');
  });

  test('a truncated header is rejected, never throws', () => {
    const file = path.join(tmp, 'truncated.gguf');
    fs.writeFileSync(file, buildGguf(QWEN3MOE_KVS).subarray(0, 40));
    const meta = readGgufMeta(file);
    expect(meta.ok).toBe(false);
  });

  test('a v2 header parses the same way', () => {
    const file = path.join(tmp, 'v2.gguf');
    fs.writeFileSync(file, buildGguf(QWEN3MOE_KVS, 2));
    const meta = readGgufMeta(file);
    expect(meta.ok).toBe(true);
    expect(meta.layers).toBe(48);
  });
});

describe('engineSupportFor', () => {
  const moeMeta: GgufMeta = { ok: true, arch: 'qwen3moe', layers: 48, experts: 128, expertsUsed: 8 };
  const denseMeta: GgufMeta = { ok: true, arch: 'llama', layers: 32 };

  test('a GGUF file is runnable by llamacpp', () => {
    const support = engineSupportFor('model.gguf', denseMeta);
    expect(support.runnable).toEqual(['llamacpp']);
    expect(support.moe).toBe(false);
    expect(support.engines.strata?.family).toBe(false);
  });

  test('a Strata-family MoE without a profile carries the badge only', () => {
    const support = engineSupportFor('moe.gguf', moeMeta);
    expect(support.runnable).toEqual(['llamacpp']);
    expect(support.moe).toBe(true);
    expect(support.engines.strata?.family).toBe(true);
    // A badge is never a launch path: family alone buys nothing (ADR-0038 §4).
    expect(support.runnable).not.toContain('strata');
  });

  test('a Qwen3.8-Flash-Next MoE (arch qwen4exp) is offered, not hidden', () => {
    // The field case: `Swift-Qwen3.8-Flash-Next-...-00001-of-00002.gguf` reports
    // arch `qwen4exp` with 512 experts and Strata runs it. An arch list that
    // misses it must not make the engine disappear from the console.
    const next: GgufMeta = { ok: true, arch: 'qwen4exp', layers: 48, experts: 512, expertsUsed: 8 };
    const support = engineSupportFor('qwen38.gguf', next);
    expect(support.engines.strata?.family).toBe(true);
    expect(support.runnable).not.toContain('strata');
    // No profile is asked for any more: the verdict names the artefact the disk
    // is missing, because the gateway derives the rest (ADR-0039 §8).
    expect(support.engines.strata?.needsSetup).toBeUndefined();
    expect(support.engines.strata?.reason).toContain('serve/server.py');

    // The same model INSIDE its workspace is a launch target with nothing typed.
    const ws = makeStrataWorkspace({ slug: 'abl-iq2_xs', modelDir: 'abl-IQ2_XS' });
    strataRoots.push(ws.root);
    const ready = engineSupportFor(ws.modelPath, next);
    expect(ready.engines.strata?.serves).toBe(true);
    expect(ready.runnable).toContain('strata');
  });

  test('an undocumented MoE stays OFFERED (never vanishes) and says why it cannot launch yet', () => {
    const exotic: GgufMeta = { ok: true, arch: 'some-new-moe', layers: 40, experts: 64 };
    const support = engineSupportFor('exotic.gguf', exotic);
    // Not in the curated list, so the badge is plain — but the engine is still
    // reported, and the reason is about the missing workspace, not the arch.
    expect(support.engines.strata?.family).toBe(false);
    expect(support.engines.strata?.reason).toContain('serve/server.py');
    expect(support.engines.strata?.reason).not.toContain('some-new-moe');
  });

  test('a dense checkpoint is refused by name, not left unexplained', () => {
    const support = engineSupportFor('dense.gguf', denseMeta);
    expect(support.engines.strata?.family).toBe(false);
    expect(support.engines.strata?.needsSetup).toBeUndefined();
    expect(support.engines.strata?.reason).toContain('dense');
  });

  test('workspace and MoE together make strata runnable; a workspace alone does not', () => {
    const ws = makeStrataWorkspace({ slug: 'abl-iq2_xs', modelDir: 'abl-IQ2_XS' });
    strataRoots.push(ws.root);
    const moe = engineSupportFor(ws.modelPath, moeMeta);
    expect(moe.runnable).toEqual(['llamacpp', 'strata']);
    const dense = engineSupportFor(ws.modelPath, denseMeta);
    expect(dense.runnable).toEqual(['llamacpp']);
    expect(dense.engines.strata?.family).toBe(false);
  });

  test('a non-GGUF file has no runnable engine', () => {
    const support = engineSupportFor('model.safetensors', null);
    expect(support.runnable).toEqual([]);
    expect(support.moe).toBe(false);
  });
});
