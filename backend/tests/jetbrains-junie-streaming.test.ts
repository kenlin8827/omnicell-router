import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { zipSync } from 'fflate';

// Same guard as jetbrains-junie.test.ts: a backend-only checkout has no
// `plugins/jetbrains-gateway`, so the suite must not fail at import time.
const pluginDir = path.resolve(import.meta.dirname, '../../plugins/jetbrains-gateway');
const mod = fs.existsSync(path.join(pluginDir, 'junie-streaming.ts'))
  ? await import('../../plugins/jetbrains-gateway/junie-streaming.js')
  : null;

/**
 * A hand-built class file holding ONE method, `isStreamingEnabled()Z`, whose
 * Code attribute is the verbatim 41-byte body from Junie 4020.10. Keeps the
 * fixture tiny and avoids checking vendor bytecode into the repo.
 */
const REAL_CODE = Buffer.from(
  '2ab2025bb6025e2ab400302ab601d09a00112ab602549a000a2ab6013b99000704a7000403b60262ac',
  'hex',
);

function u2(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u4(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function utf8(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([1]), u2(bytes.length), bytes]);
}

function buildModelParametersClass(code: Buffer = REAL_CODE): Buffer {
  // cp: 1 Utf8 "X", 2 Class#1, 3 Utf8 "java/lang/Object", 4 Class#3,
  //     5 Utf8 "isStreamingEnabled", 6 Utf8 "()Z", 7 Utf8 "Code"
  const cp = Buffer.concat([
    u2(8),
    utf8('X'), Buffer.from([7]), u2(1),
    utf8('java/lang/Object'), Buffer.from([7]), u2(3),
    utf8('isStreamingEnabled'), utf8('()Z'), utf8('Code'),
  ]);
  const codeAttr = Buffer.concat([
    u2(7),                    // attribute_name_index -> "Code"
    u4(12 + code.length + 4),// attribute_length
    u2(2),                    // max_stack
    u2(1),                    // max_locals
    u4(code.length),
    code,
    u2(0),                    // exception_table_length
    u2(0),                    // attributes_count
  ]);
  const method = Buffer.concat([
    u2(0x0001), u2(5), u2(6), u2(1), codeAttr,
  ]);
  return Buffer.concat([
    Buffer.from('cafebabe', 'hex'), u2(0), u2(52), cp,
    u2(0x0021), u2(2), u2(4),
    u2(0),                    // interfaces
    u2(0),                    // fields
    u2(1), method,
    u2(0),                    // class attributes
  ]);
}

/** Small zip builder exercising both stored and deflated entries. */
function buildZip(name: string, data: Buffer, method: 0 | 8): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const payload = method === 0 ? data : Buffer.from(deflateRawSync(data));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localPart = Buffer.concat([local, nameBuf, payload]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralPart = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

describe('junie client-side streaming patch', () => {
  it('recognises the unpatched gate', () => {
    if (!mod) return;
    assert.equal(mod.inspectModelParameters(buildModelParametersClass()), 'streaming-off');
  });

  it('flips exactly one byte and leaves the class length intact', () => {
    if (!mod) return;
    const before = buildModelParametersClass();
    const beforeHex = before.toString('hex');
    const { bytes, state } = mod.patchModelParameters(before);
    assert.equal(state, 'patched');
    assert.equal(before.toString('hex'), beforeHex, 'input buffer is not mutated');
    assert.equal(bytes.length, before.length);
    const diffs = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== bytes[i]) diffs.push(i);
    assert.equal(diffs.length, 1, 'only the iconst_0 byte changes');
    assert.equal(before[diffs[0]!], 0x03);
    assert.equal(bytes[diffs[0]!], 0x04);
    assert.equal(before.toString('hex'), REAL_CODE.subarray(0, 0).toString('hex') + before.toString('hex'), 'input not mutated');
  });

  it('is idempotent and reports an already-patched class', () => {
    if (!mod) return;
    const first = mod.patchModelParameters(buildModelParametersClass());
    assert.equal(first.state, 'patched');
    assert.equal(mod.inspectModelParameters(first.bytes), 'streaming-on');
    const second = mod.patchModelParameters(first.bytes);
    assert.equal(second.state, 'already');
    assert.equal(second.bytes.toString('hex'), first.bytes.toString('hex'));
  });

  it('refuses to patch a changed method shape', () => {
    if (!mod) return;
    const altered = Buffer.from(REAL_CODE);
    altered[32] = 0x00; // break the verified iconst_1 / goto guard
    assert.equal(mod.inspectModelParameters(buildModelParametersClass(altered)), 'unknown');
    assert.equal(mod.patchModelParameters(buildModelParametersClass(altered)).state, 'unsupported');
  });

  it('reads a deflated class out of a zip without any archiver binary', () => {
    if (!mod) return;
    const cls = buildModelParametersClass();
    const zip = buildZip(mod.MODEL_PARAMETERS_CLASS, cls, 8);
    assert.deepEqual(mod.readZipEntry(zip, mod.MODEL_PARAMETERS_CLASS), cls);
  });

  it('reads a stored (uncompressed) class too', () => {
    if (!mod) return;
    const cls = buildModelParametersClass();
    const zip = buildZip(mod.MODEL_PARAMETERS_CLASS, cls, 0);
    assert.deepEqual(mod.readZipEntry(zip, mod.MODEL_PARAMETERS_CLASS), cls);
    assert.equal(mod.readZipEntry(zip, 'missing.class'), null);
  });

  it('reads an fflate-produced zip (general-purpose flags set by a real writer)', () => {
    if (!mod) return;
    const cls = buildModelParametersClass();
    const zip = Buffer.from(zipSync({ [mod.MODEL_PARAMETERS_CLASS]: cls }, { level: 6 }));
    assert.deepEqual(mod.readZipEntry(zip, mod.MODEL_PARAMETERS_CLASS), cls);
  });

  it('reads the real 70k-entry ZIP64 Junie jar when one is installed', { timeout: 30000 }, () => {
    if (!mod) return;
    const jars = mod.findJunieJars();
    if (!jars.length) return; // no Junie on a CI box
    const status = mod.junieStreamingStatus(jars);
    assert.ok(status.length > 0);
    for (const s of status) {
      assert.ok(['streaming-off', 'streaming-on', 'unknown'].includes(s.state));
      assert.ok(fs.existsSync(s.jar));
    }
  });
});
