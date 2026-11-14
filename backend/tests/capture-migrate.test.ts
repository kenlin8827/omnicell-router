import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'bun:test';
import {
  CAPTURE_MIGRATORS,
  CaptureArchiveMigrator,
  type CaptureMigratorVerdict,
  migrateArchiveFile,
  migrateArchiveRoot,
  migrateCaptureLine,
} from '../src/capture/migrate/index.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

/**
 * Synthetic chain steps named the way real ones are (ADR-0008 section 5):
 * one class per contiguous schema hop, payload fields only — the engine
 * stamps the new `schema` and the `migratedFrom` provenance itself.
 */
class V2ToV3Migrate extends CaptureArchiveMigrator {
  readonly from = 2;
  readonly to = 3;
  migrate(line: Record<string, unknown>): CaptureMigratorVerdict {
    return { ok: true, line: { ...line, v3: true } };
  }
}

class V3ToV4Migrate extends CaptureArchiveMigrator {
  readonly from = 3;
  readonly to = 4;
  migrate(line: Record<string, unknown>): CaptureMigratorVerdict {
    return { ok: true, line: { ...line, v4: true } };
  }
}

class SkippingMigrator extends CaptureArchiveMigrator {
  readonly from = 2;
  readonly to = 4; // non-contiguous hop — must never be selected
  migrate(line: Record<string, unknown>): CaptureMigratorVerdict {
    return { ok: true, line: { ...line, skipped: true } };
  }
}

const CHAIN34 = [() => new V2ToV3Migrate(), () => new V3ToV4Migrate()];

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-migrate-'));
}

function jsonl(lines: unknown[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

/* ------------------------------------------------------- chain mechanics */

test('migrateCaptureLine walks every contiguous hop and stamps the target schema', () => {
  const res = migrateCaptureLine({ schema: 2, a: 1 }, 4, CHAIN34);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.line.schema, 4);
  assert.equal(res.line.a, 1);
  assert.equal(res.line.v3, true);
  assert.equal(res.line.v4, true);
  // Provenance records where the line was BEFORE the chain, not the last hop.
  assert.equal(res.line.migratedFrom, 2);
});

test('migrateCaptureLine is a no-op at the target schema', () => {
  const raw = { schema: 2, a: 1 };
  const res = migrateCaptureLine(raw, 2, CHAIN34);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.line, raw); // untouched, same object
});

test('migrateCaptureLine refuses a gap in the chain', () => {
  const res = migrateCaptureLine({ schema: 2 }, 4, [() => new V2ToV3Migrate()]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /no migrator registered for schema 3 -> 4/);
});

test('migrateCaptureLine never selects a skipping migrator', () => {
  const res = migrateCaptureLine({ schema: 2 }, 4, [() => new SkippingMigrator()]);
  assert.equal(res.ok, false); // there is no 2 -> 3 step, so the chain is a gap
  if (res.ok) return;
  assert.match(res.reason, /no migrator registered for schema 2 -> 3/);
});

test('migrateCaptureLine enters the chain at the unmarked baseline and refuses newer schemas', () => {
  // Schema 1 is the unmarked baseline: no `schema` field at all. With only
  // 2 -> 3 -> 4 registered, 1 -> 2 is the gap.
  const unmarked = migrateCaptureLine({ a: 1 }, 4, CHAIN34);
  assert.equal(unmarked.ok, false);
  if (!unmarked.ok) assert.match(unmarked.reason, /no migrator registered for schema 1 -> 2/);

  const newer = migrateCaptureLine({ schema: 5 }, 4, CHAIN34);
  assert.equal(newer.ok, false);
  if (newer.ok) return;
  assert.match(newer.reason, /newer than target 4/);
});

/* ------------------------------------------------- whole-file discipline */

test('migrateArchiveFile rewrites mixed files atomically and keeps markers verbatim', async () => {
  const root = tmpRoot();
  const file = path.join(root, 's1.jsonl');
  const marker = JSON.stringify({ eventType: 'archive-overflow', sessionId: 's1', bytes: 999 });
  fs.writeFileSync(
    file,
    [JSON.stringify({ schema: 2, id: 'a' }), marker, JSON.stringify({ schema: 3, id: 'b' })].join('\n') + '\n',
  );
  const res = await migrateArchiveFile(file, 4, { chain: CHAIN34, hotMs: 0 });
  assert.deepEqual(res, { status: 'migrated', lines: 2, unreadable: 0 });
  const out = readLines(file);
  assert.equal(out.length, 3);
  assert.equal(out[0].schema, 4);
  assert.equal(out[0].v4, true);
  assert.deepEqual(out[1], JSON.parse(marker)); // marker copied verbatim
  assert.equal(out[2].schema, 4);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n')); // trailing newline preserved
  assert.ok(!fs.existsSync(file + '.migrating')); // no temp left behind
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateArchiveFile is idempotent and untouched files are not rewritten', async () => {
  const root = tmpRoot();
  const file = path.join(root, 's1.jsonl');
  fs.writeFileSync(file, jsonl([{ schema: 4, id: 'a' }]));
  const before = fs.statSync(file).mtimeMs;
  const res = await migrateArchiveFile(file, 4, { chain: CHAIN34, hotMs: 0 });
  assert.deepEqual(res, { status: 'untouched', unreadable: 0 });
  assert.equal(fs.statSync(file).mtimeMs, before); // zero writes
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateArchiveFile carries unparseable bytes verbatim instead of failing the file', async () => {
  const root = tmpRoot();
  const file = path.join(root, 's1.jsonl');
  fs.writeFileSync(
    file,
    [JSON.stringify({ schema: 2, id: 'a' }), 'not json at all', JSON.stringify({ schema: 3, id: 'b' })].join('\n') + '\n',
  );
  const res = await migrateArchiveFile(file, 4, { chain: CHAIN34, hotMs: 0 });
  // One rotten line must not cost the reader the good ones: the bad bytes stay
  // exactly as they were and the rest moves up the chain.
  assert.deepEqual(res, { status: 'migrated', lines: 2, unreadable: 1 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines[1], 'not json at all');
  assert.equal(JSON.parse(lines[0]).schema, 4);
  assert.equal(JSON.parse(lines[2]).schema, 4);
  assert.ok(!fs.existsSync(file + '.migrating'));

  // A gap in the chain still rejects — never a best-effort partial migration.
  fs.writeFileSync(file, jsonl([{ schema: 2, id: 'a' }]));
  const gap = await migrateArchiveFile(file, 4, { chain: [() => new V2ToV3Migrate()], hotMs: 0 });
  assert.equal(gap.status, 'rejected');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 2, id: 'a' });

  // A schema-less non-capture shape is metadata, not an archive event: kept
  // verbatim, and nothing else in the file is held hostage by it.
  fs.writeFileSync(file, jsonl([{ eventType: 'mystery' }, { schema: 2, id: 'a' }]));
  const unknown = await migrateArchiveFile(file, 4, { chain: CHAIN34, hotMs: 0 });
  assert.deepEqual(unknown, { status: 'migrated', lines: 1, unreadable: 0 });
  assert.deepEqual(readLines(file)[0], { eventType: 'mystery' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateArchiveFile skips hot files (active append targets)', async () => {
  const root = tmpRoot();
  const file = path.join(root, 's1.jsonl');
  fs.writeFileSync(file, jsonl([{ schema: 2, id: 'a' }]));
  const res = await migrateArchiveFile(file, 4, { chain: CHAIN34 }); // default 10 min window
  assert.deepEqual(res, { status: 'hot' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 2, id: 'a' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateArchiveRoot walks date shards, ignores non-JSONL side files and is zero-I/O on an empty chain', async () => {
  const root = tmpRoot();
  const dateDir = path.join(root, '2026-11-14');
  fs.mkdirSync(path.join(dateDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dateDir, 'media', 'abc.png'), 'media bytes');
  fs.writeFileSync(path.join(dateDir, 'old.jsonl'), jsonl([{ schema: 2, id: 'a' }, { schema: 3, id: 'b' }]));
  fs.writeFileSync(path.join(dateDir, 'cur.jsonl'), jsonl([{ schema: 4, id: 'c' }]));
  fs.mkdirSync(path.join(root, 'not-a-date'));
  fs.writeFileSync(path.join(root, 'not-a-date', 'x.jsonl'), 'garbage that must never be touched');

  const res = await migrateArchiveRoot(root, 4, { chain: CHAIN34, hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 2, hot: 0, rejected: 0, unreadable: 0 });
  assert.deepEqual(readLines(path.join(dateDir, 'old.jsonl')), [
    { schema: 4, id: 'a', v3: true, v4: true, migratedFrom: 2 },
    { schema: 4, id: 'b', v4: true, migratedFrom: 3 },
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'not-a-date', 'x.jsonl'), 'utf8'), 'garbage that must never be touched');

  // Idempotent: a second pass finds nothing to do.
  const again = await migrateArchiveRoot(root, 4, { chain: CHAIN34, hotMs: 0 });
  assert.deepEqual(again, { files: 0, lines: 0, hot: 0, rejected: 0, unreadable: 0 });

  // An empty chain is a zero-I/O no-op.
  const noopRoot = tmpRoot();
  fs.mkdirSync(path.join(noopRoot, '2026-11-14'), { recursive: true });
  fs.writeFileSync(path.join(noopRoot, '2026-11-14', 's.jsonl'), jsonl([{ schema: 2, id: 'a' }]));
  const noop = await migrateArchiveRoot(noopRoot, 2, { chain: [] });
  assert.deepEqual(noop, { files: 0, lines: 0, hot: 0, rejected: 0, unreadable: 0 });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(noopRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------- V1 -> V2 */

/** The wire dump a schema-1 line carries — the full inbound body included. */
function wire(requestBody: string): Record<string, unknown> {
  return {
    requestLine: 'POST /v1/chat/completions HTTP/1.1',
    requestHeaders: { 'content-type': 'application/json' },
    requestBody,
    responseLine: '',
    status: 0,
    responseHeaders: {},
    responseBody: '',
  };
}

function chatBody(messages: unknown[]): string {
  return JSON.stringify({ model: 'm', messages });
}

/** One schema-1 line: unmarked, gateway ids present (post-ADR-0021 shape). */
function s1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    id: 'evt_1',
    ts: 1,
    requestId: 'req_1',
    exchangeId: 'exc_1',
    sessionId: 'sess_1',
    model: 'm',
    status: 'ok',
    wire: wire('{}'),
    ...over,
  };
}

function copyInto(root: string, date: string, name: string, lines: unknown[]): string {
  const dir = path.join(root, date);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, jsonl(lines));
  return file;
}

test('V1ToV2Migrate replays the structural turn rule and numbers turns per session', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const assistant = { role: 'assistant', content: null };
  const tool = { role: 'tool', content: 'result' };
  const file = copyInto(root, '2026-11-13', 's1.jsonl', [
    // turn 1: the prompt
    s1({ requestId: 'req_1', exchangeId: 'exc_1', wire: wire(chatBody([user])) }),
    // turn 1: tool-loop continuation (trailing `role: tool`)
    s1({ requestId: 'req_2', exchangeId: 'exc_2', wire: wire(chatBody([user, assistant, tool])) }),
    // turn 2: a genuinely new user message appended past the previous floor
    s1({ requestId: 'req_3', exchangeId: 'exc_3', wire: wire(chatBody([user, assistant, tool, user])) }),
  ]);

  const res = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 3, hot: 0, rejected: 0, unreadable: 0 });

  const out = readLines(file);
  assert.deepEqual(
    out.map(l => [l.requestId, l.schema, l.turnIndex, l.isPromptStart, l.turnDecision, l.migratedFrom]),
    [
      ['req_1', 2, 1, true, 'new_prompt', 1],
      ['req_2', 2, 1, false, 'continuation', 1],
      ['req_3', 2, 2, true, 'new_prompt', 1],
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate gives a prompt-less request NO_TURN and flags compaction', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'a very long opening question' };
  const file = copyInto(root, '2026-11-13', 's1.jsonl', [
    // system-only request: no user message at all
    s1({ requestId: 'req_0', exchangeId: 'exc_0', wire: wire(chatBody([{ role: 'system', content: 's' }])) }),
    s1({ requestId: 'req_1', exchangeId: 'exc_1', wire: wire(chatBody([user, user, user])) }),
    // history shrank (client compacted) — allocate anyway, label the doubt
    s1({ requestId: 'req_2', exchangeId: 'exc_2', wire: wire(chatBody([user])) }),
  ]);
  await migrateArchiveRoot(root, 2, { hotMs: 0 });

  const out = readLines(file);
  assert.deepEqual(
    out.map(l => [l.requestId, l.turnIndex, l.isPromptStart, l.turnDecision]),
    [
      ['req_0', null, false, 'no_prompt'],
      ['req_1', 1, true, 'new_prompt'],
      ['req_2', 2, true, 'ambiguous_compaction'],
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate reconstructs attempt ordinals per (request, leg)', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const file = copyInto(root, '2026-11-13', 's1.jsonl', [
    s1({ exchangeId: 'exc_client', wire: wire(chatBody([user])) }),
    // Two upstream hops for the same request = a failover chain.
    s1({ direction: 'upstream', exchangeId: 'exc_up_1' }),
    s1({ direction: 'upstream', phase: 'response', exchangeId: 'exc_up_1' }),
    s1({ direction: 'upstream', exchangeId: 'exc_up_2' }),
  ]);
  await migrateArchiveRoot(root, 2, { hotMs: 0 });

  const out = readLines(file);
  assert.deepEqual(
    out.map(l => [l.direction, l.exchangeId, l.attempt, l.turnIndex]),
    [
      ['client', 'exc_client', 1, 1],
      ['upstream', 'exc_up_1', 1, 1],
      ['upstream', 'exc_up_1', 1, 1],
      ['upstream', 'exc_up_2', 2, 1],
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate drops the retired vocabulary and keeps the display stamp', async () => {
  const root = tmpRoot();
  const file = copyInto(root, '2026-11-13', 's1.jsonl', [
    s1({
      spanId: 'b4f0a20d7bb07b0a',
      traceId: '6bea573e5b38480c',
      promptMessageCount: 1,
      promptLastUserIdx: 0,
      promptSummary: 'hi',
      wire: wire(chatBody([{ role: 'user', content: 'hi' }])),
    }),
  ]);
  await migrateArchiveRoot(root, 2, { hotMs: 0 });

  const [line] = readLines(file);
  for (const gone of ['spanId', 'traceId', 'promptMessageCount', 'promptLastUserIdx']) {
    assert.equal(gone in line, false, `${gone} must not survive into schema 2`);
  }
  assert.equal(line.promptSummary, 'hi'); // schema 2 still writes it, display only
  assert.equal(line.turnDecision, 'new_prompt');
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate falls back to the recorded prompt pair when the body is unreadable', async () => {
  const root = tmpRoot();
  // A body truncated at maxBodyBytes is not valid JSON — the pair decides.
  const file = copyInto(root, '2026-11-13', 's1.jsonl', [
    s1({ requestId: 'req_1', exchangeId: 'exc_1', promptMessageCount: 4, promptLastUserIdx: 3, wire: wire('{"messages":[{"role":"user","content":"trunc…[TRUNCATED]') }),
    s1({ requestId: 'req_2', exchangeId: 'exc_2', promptMessageCount: 5, promptLastUserIdx: 1, wire: wire('…[TRUNCATED]') }),
  ]);
  await migrateArchiveRoot(root, 2, { hotMs: 0 });

  const out = readLines(file);
  assert.deepEqual(
    out.map(l => [l.requestId, l.turnIndex, l.turnDecision]),
    [
      ['req_1', 1, 'new_prompt'],
      // lastUserIdx 1 < previous message count 4: tool-loop continuation
      ['req_2', 1, 'continuation'],
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

/** One pre-request-layer line: no gateway ids, only `traceId` + `spanId`. */
function preRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    id: 'evt_x',
    ts: 1000,
    spanId: 'span_c1',
    traceId: 'trace_1',
    sessionId: 'sess_legacy',
    model: 'm',
    status: 'ok',
    promptMessageCount: 2,
    promptLastUserIdx: 1,
    wire: wire(chatBody([{ role: 'user', content: 'hi' }])),
    ...over,
  };
}

test('V1ToV2Migrate rebuilds request identity from the span sequence of pre-request-layer lines', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const file = copyInto(root, '2026-11-11', 'legacy.jsonl', [
    preRequest({ ts: 1000, wire: wire(chatBody([user])) }),
    preRequest({ ts: 1010, direction: 'upstream', spanId: 'span_u1' }),
    preRequest({ ts: 1020, direction: 'upstream', phase: 'response', spanId: 'span_u1', status: 'error' }),
    preRequest({ ts: 1030, direction: 'upstream', spanId: 'span_u2' }),
    preRequest({ ts: 1040, direction: 'upstream', phase: 'response', spanId: 'span_u2' }),
    preRequest({ ts: 1050, phase: 'response' }),
  ]);

  const res = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 6, hot: 0, rejected: 0, unreadable: 0 });

  const out = readLines(file);
  const ids = new Set(out.map(l => l.requestId));
  assert.equal(ids.size, 1, 'one client request span, one reconstructed request');
  assert.match(String([...ids][0]), /^req_[0-9a-f]{24}$/);

  // One exchange = one id, shared by its request and response; attempt is the
  // upstream ordinal within the request.
  const exc = out.map(l => l.exchangeId);
  assert.match(String(exc[0]), /^exc_[0-9a-f]{24}$/);
  assert.equal(exc[0], exc[5], 'client request and response share their exchange id');
  assert.equal(exc[1], exc[2], 'upstream span u1 pairs up');
  assert.equal(exc[3], exc[4], 'upstream span u2 pairs up');
  assert.equal(new Set([exc[0], exc[1], exc[3]]).size, 3, 'one id per exchange');
  assert.deepEqual(out.map(l => l.attempt), [1, 1, 1, 2, 2, 1]);
  assert.equal(out[0].turnIndex, 1);
  assert.equal(out[0].isPromptStart, true);
  assert.equal(out[0].turnDecision, 'new_prompt');
  for (const line of out) {
    assert.equal(line.schema, 2);
    assert.equal(line.migratedFrom, 1);
    assert.equal(line.spanId, undefined, 'the legacy exchange vocabulary is dropped');
    assert.equal(line.traceId, undefined, 'connection scope is superseded by the request id');
  }

  // Idempotent: the rebuilt id is deterministic, so a second pass is a no-op.
  const again = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(again, { files: 0, lines: 0, hot: 0, rejected: 0, unreadable: 0 });
  assert.deepEqual(readLines(file).map(l => l.requestId), out.map(l => l.requestId));
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate separates sequential requests inside one connection trace', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const file = copyInto(root, '2026-11-11', 'two.jsonl', [
    preRequest({ ts: 1000, wire: wire(chatBody([user])) }),
    preRequest({ ts: 1005, phase: 'response' }),
    preRequest({ ts: 2000, spanId: 'span_c2', promptMessageCount: 4, promptLastUserIdx: 3,
      wire: wire(chatBody([user, { role: 'assistant', content: 'a' }, user])) }),
    preRequest({ ts: 2005, phase: 'response', spanId: 'span_c2' }),
  ]);

  await migrateArchiveRoot(root, 2, { hotMs: 0 });
  const out = readLines(file);
  const first = out[0].requestId;
  const second = out[2].requestId;
  assert.notEqual(first, second, 'traceId is connection scope, not request identity');
  assert.equal(out[0].turnIndex, 1);
  assert.equal(out[0].isPromptStart, true);
  assert.equal(out[2].turnIndex, 2);
  assert.equal(out[2].isPromptStart, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate gives an orphan upstream exchange its own prompt-less request', async () => {
  const root = tmpRoot();
  // An upstream exchange with no client request in the file. It cannot be
  // attributed to a prompt, but it must still be VISIBLE: an upgrade may not
  // cost the operator data it already has.
  const file = copyInto(root, '2026-11-11', 'orphan.jsonl', [
    preRequest({ ts: 1000, direction: 'upstream', spanId: 'span_u1' }),
    preRequest({ ts: 1010, direction: 'upstream', phase: 'response', spanId: 'span_u1' }),
  ]);

  const res = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 2, hot: 0, rejected: 0, unreadable: 0 });

  const out = readLines(file);
  assert.match(String(out[0].requestId), /^req_[0-9a-f]{24}$/);
  assert.equal(out[0].requestId, out[1].requestId); // one span, one request
  assert.equal(out[0].exchangeId, out[1].exchangeId);
  for (const line of out) {
    assert.equal(line.schema, 2);
    // No prompt evidence at all: NO_TURN is the first-class answer.
    assert.equal(line.turnIndex, null);
    assert.equal(line.isPromptStart, false);
    assert.equal(line.turnDecision, 'no_prompt');
  }
  // Nothing was moved aside: the live root is the only copy, and it grew.
  assert.ok(!fs.existsSync(path.join(root, 'capture-archive')));

  // …and the console actually shows it: one prompt-less request, not zero.
  const recorder = new CaptureRecorder({
    enabled: true,
    dir: root,
    retentionDays: 7,
    maxTotalMB: 512,
    maxBodyBytes: 1_048_576,
  });
  try {
    const read = await recorder.readEvents('2026-11-11', 'orphan.jsonl', 10);
    assert.equal(read.requests.length, 1);
    assert.equal(read.requests[0].turnIndex, null);
    assert.equal(read.requests[0].exchanges.length, 1); // both halves of one span
  } finally {
    recorder.stop();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate keeps an unclosed legacy request readable', async () => {
  const root = tmpRoot();
  // A file that ends mid-request (the writer was killed, or the shard was
  // rotated between the two halves). The request half is still history.
  const file = copyInto(root, '2026-11-11', 'ancient.jsonl', [
    preRequest({ ts: 1000, spanId: 'span_abc', traceId: 'trace_def' }),
  ]);

  const res = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 1, hot: 0, rejected: 0, unreadable: 0 });

  const [line] = readLines(file);
  assert.equal(line.schema, 2);
  assert.match(String(line.requestId), /^req_[0-9a-f]{24}$/);
  assert.match(String(line.exchangeId), /^exc_[0-9a-f]{24}$/);
  assert.equal(line.turnIndex, 1); // no recorded pair, but the body says new_prompt
  assert.equal(line.turnDecision, 'new_prompt');
  fs.rmSync(root, { recursive: true, force: true });
});

test('V1ToV2Migrate repairs a pathological span sequence without dropping a line', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const file = copyInto(root, '2026-11-11', 'messy.jsonl', [
    // request opens, then ANOTHER request opens before the first answered
    preRequest({ ts: 1000, wire: wire(chatBody([user])) }),
    preRequest({ ts: 1010, spanId: 'span_c2', wire: wire(chatBody([user, { role: 'assistant', content: 'a' }, user])) }),
    // a response whose span opened nothing
    preRequest({ ts: 1020, phase: 'response', spanId: 'span_ghost' }),
    // a line with no span at all
    preRequest({ ts: 1030, direction: 'upstream', spanId: undefined }),
  ]);

  const res = await migrateArchiveRoot(root, 2, { hotMs: 0 });
  assert.deepEqual(res, { files: 1, lines: 4, hot: 0, rejected: 0, unreadable: 0 });

  const out = readLines(file);
  assert.equal(out.length, 4, 'every line survives the pass');
  for (const line of out) {
    assert.equal(line.schema, 2);
    assert.equal(typeof line.requestId, 'string');
    assert.equal(typeof line.exchangeId, 'string');
    assert.equal(typeof line.attempt, 'number');
    assert.equal(line.spanId, undefined);
  }
  // The two real prompts keep their turn ordinals; the ghost response and the
  // span-less line get identities of their own rather than being folded in.
  assert.equal(out[0].turnIndex, 1);
  assert.equal(out[1].turnIndex, 2);
  assert.notEqual(out[2].requestId, out[0].requestId);
  assert.equal(out[2].turnDecision, 'no_prompt');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a migrated archive is readable by the real recorder (turn grouping, exchanges and attempts)', async () => {
  const root = tmpRoot();
  const user = { role: 'user', content: 'hi' };
  const tool = { role: 'tool', content: 'ok' };
  copyInto(root, '2026-11-13', 'sess_1.jsonl', [
    s1({ requestId: 'req_1', exchangeId: 'exc_1', wire: wire(chatBody([user])) }),
    s1({ requestId: 'req_1', exchangeId: 'exc_1', phase: 'response', wire: wire(chatBody([user])) }),
    s1({ direction: 'upstream', requestId: 'req_1', exchangeId: 'exc_2' }),
    s1({ direction: 'upstream', requestId: 'req_1', exchangeId: 'exc_2', phase: 'response' }),
    s1({ requestId: 'req_2', exchangeId: 'exc_3', wire: wire(chatBody([user, { role: 'assistant', content: null }, tool])) }),
  ]);
  await migrateArchiveRoot(root, 2, { hotMs: 0 });

  const recorder = new CaptureRecorder({
    enabled: true,
    dir: root,
    retentionDays: 7,
    maxTotalMB: 512,
    maxBodyBytes: 1_048_576,
  });
  try {
    const read = await recorder.readEvents('2026-11-13', 'sess_1.jsonl', 10);
    assert.equal(read.totalLines, 5);
    assert.equal(read.requests.length, 2); // schema-1 lines were invisible before
    assert.equal(read.totalTurns, 1);
    assert.deepEqual(
      read.requests.map(r => [r.requestId, r.turnIndex, r.isPromptStart, r.exchanges.length]),
      [
        ['req_1', 1, true, 2],
        ['req_2', 1, false, 1],
      ],
    );
  } finally {
    recorder.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each hop plans the shape the previous hop left, not the disk shape', async () => {
  // A second hop must never plan against schema-1 lines the first hop already
  // replaced: `begin()` sees exactly what it is about to migrate.
  const planned: number[] = [];
  class PlanningV3ToV4 extends CaptureArchiveMigrator {
    readonly from = 3;
    readonly to = 4;
    begin(plan: { readonly lines: readonly Record<string, unknown>[] }): void {
      planned.push(plan.lines.filter(l => l.v3 === true).length);
    }
    migrate(line: Record<string, unknown>): CaptureMigratorVerdict {
      return { ok: true, line: { ...line, v4: true } };
    }
  }
  const root = tmpRoot();
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, jsonl([{ schema: 2, id: 'a' }, { schema: 2, id: 'b' }]));
  const res = await migrateArchiveFile(file, 4, {
    chain: [() => new V2ToV3Migrate(), () => new PlanningV3ToV4()],
    hotMs: 0,
  });
  assert.deepEqual(res, { status: 'migrated', lines: 2, unreadable: 0 });
  assert.deepEqual(planned, [2], 'both lines already carry v3 when hop 3 -> 4 plans');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hop surveys one snapshot: its own rewrite is invisible to its later calls', async () => {
  // The plan is a per-hop snapshot, not the live working set. A step that
  // reads `ctx.lines` for a neighbour must see the shape it was handed, never
  // a file it is halfway through rewriting.
  const observed: number[][] = [];
  class ObservingV2ToV3 extends CaptureArchiveMigrator {
    readonly from = 2;
    readonly to = 3;
    migrate(
      line: Record<string, unknown>,
      ctx: { readonly lines: readonly Record<string, unknown>[] },
    ): CaptureMigratorVerdict {
      observed.push(ctx.lines.map(l => (l.v3 === true ? 1 : 0)));
      return { ok: true, line: { ...line, v3: true } };
    }
  }
  const root = tmpRoot();
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, jsonl([{ schema: 2, id: 'a' }, { schema: 2, id: 'b' }, { schema: 2, id: 'c' }]));
  const res = await migrateArchiveFile(file, 3, { chain: [() => new ObservingV2ToV3()], hotMs: 0 });
  assert.deepEqual(res, { status: 'migrated', lines: 3, unreadable: 0 });
  // Three calls, three identical pre-hop views — no index shows a line this
  // hop already produced.
  assert.deepEqual(observed, [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the registered chain carries the V1 -> V2 step', () => {
  assert.equal(CAPTURE_MIGRATORS.length, 1);
  const [only] = CAPTURE_MIGRATORS;
  const step = only();
  assert.equal(step.from, 1);
  assert.equal(step.to, 2);
});
