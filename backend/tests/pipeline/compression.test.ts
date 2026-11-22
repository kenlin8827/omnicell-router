import { describe, expect, test } from 'bun:test';
import { detectContentKind } from '../../src/compression/detect.js';
import {
  compressBuildLog,
  compressGitLog,
  compressGitDiff,
  compressGrepHits,
  compressPathList,
  compressDirListing,
  compressFsTree,
  compressNumberedFile,
  compressGeneric,
} from '../../src/compression/compressors.js';
import { compressToolOutputs, formatCompressionLog } from '../../src/compression/tool-output.js';
import { compressWithHeadroom } from '../../src/compression/headroom.js';
import { injectCaveman } from '../../src/compression/caveman.js';
import { applyCompression } from '../../src/compression/index.js';
import { CAVEMAN_PROMPTS } from '../../src/compression/caveman-prompts.js';
import { ChatCompletionRequest } from '../../src/types/openai.js';
import { CompressionConfig } from '../../src/config/types.js';
import { GIT_LOG_ENTRIES_MAX } from '../../src/compression/constants.js';
import { messagesOf, toIR } from '../helpers/ir.js';

// ── detectContentKind ───────────────────────────────────────────────────────

describe('detectContentKind', () => {
  test('detects git log', () => {
    const text = 'commit a1b2c3d4e5f6\nAuthor: A <a@b.c>\nDate: today\n\n    subject line\n'.repeat(20);
    expect(detectContentKind(text)).toBe('git-log');
  });

  test('detects git diff', () => {
    const text = 'diff --git a/x.ts b/x.ts\n@@ -1,3 +1,4 @@\n-old\n+new\n' + 'ctx\n'.repeat(600);
    expect(detectContentKind(text)).toBe('git-diff');
  });

  test('detects git status long form', () => {
    const text = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(10);
    expect(detectContentKind(text)).toBe('git-status');
  });

  test('detects build log', () => {
    const text = 'npm warn deprecated foo@1.0.0\n'.repeat(30);
    expect(detectContentKind(text)).toBe('build-log');
  });

  test('detects build log — pnpm / tsc / pytest / go test / MSBuild', () => {
    expect(detectContentKind('ERR_PNPM_PEER_DEP_ISSUES\n'.repeat(10))).toBe('build-log');
    expect(detectContentKind('src/a.ts: error TS2304: Cannot find name.\n'.repeat(10))).toBe('build-log');
    expect(detectContentKind('FAILED tests/test_a.py::test_x\n'.repeat(10))).toBe('build-log');
    expect(detectContentKind('--- FAIL: TestFoo (0.01s)\n'.repeat(10))).toBe('build-log');
    expect(detectContentKind('Program.cs: error CS1002: ; expected\n'.repeat(10))).toBe('build-log');
  });

  test('compressBuildLog extracts pytest failures and folds progress', () => {
    const lines = [
      'Downloading pytest (120 KB)',
      'Downloading attrs (60 KB)',
      'FAILED tests/test_a.py::test_x',
      'FAILED tests/test_b.py::test_y',
      '2 failed, 41 passed in 3.2s',
    ];
    const text = lines.join('\n');
    const out = compressBuildLog(text);
    expect(out).toContain('progress: 2 steps');
    expect(out).toContain('error: FAILED tests/test_a.py::test_x');
    expect(out).toContain('2 failed, 41 passed in 3.2s');
    expect(out.length).toBeLessThan(text.length + 200); // summary form
  });

  test('detects grep hits', () => {
    const text = 'src/a.ts:42:const x = 1;\n'.repeat(30);
    expect(detectContentKind(text)).toBe('grep-hits');
  });

  test('detects path lists', () => {
    const text = './src/a.ts\n./src/b.ts\n./src/c.ts\n./src/d.ts\n./src/e.ts\n';
    expect(detectContentKind(text)).toBe('path-list');
  });

  test('falls back to generic for repetitive multi-line noise', () => {
    const text = Array.from({ length: 30 }, (_, i) => `log line ${i % 3} with enough content to pad`).join('\n');
    expect(detectContentKind(text)).toBe('generic');
  });
});

// ── compressToolOutputs ─────────────────────────────────────────────────────

function reqWithToolContent(content: string) {
  return toIR({
    model: 'auto',
    messages: [
      { role: 'user', content: 'run git status' },
      { role: 'tool', tool_call_id: 'call_1', content },
    ],
  });
}

describe('compressToolOutputs', () => {
  test('disabled → null, messages untouched', () => {
    const req = reqWithToolContent('On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(10));
    const before = JSON.stringify(req);
    expect(compressToolOutputs(req, false)).toBeNull();
    expect(JSON.stringify(req)).toBe(before);
  });

  test('compresses git status tool output and reports stats', () => {
    const req = reqWithToolContent('On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40));
    const stats = compressToolOutputs(req, true);
    expect(stats).not.toBeNull();
    expect(stats!.hits.length).toBeGreaterThan(0);
    expect(stats!.hits[0].kind).toBe('git-status');
    const out = messagesOf(req)[1].content as string;
    expect(out.length).toBeLessThan(stats!.bytesBefore);
    expect(out).toContain('branch: main');
    expect(out).toContain('modified(40)');
  });

  test('compresses grep hits into per-file summary', () => {
    const text = Array.from({ length: 50 }, (_, i) => `src/mod${i % 5}.ts:${i + 1}:const value${i} = ${i};`).join('\n');
    const req = reqWithToolContent(text);
    const stats = compressToolOutputs(req, true);
    expect(stats!.hits[0]?.kind).toBe('grep-hits');
    const out = messagesOf(req)[1].content as string;
    expect(out).toContain('50 matches / 5 files');
    expect(out.length).toBeLessThan(text.length);
  });

  test('skips blobs smaller than MIN_BLOB_BYTES', () => {
    const req = reqWithToolContent('tiny');
    const stats = compressToolOutputs(req, true);
    expect(stats!.hits.length).toBe(0);
    expect(messagesOf(req)[1].content).toBe('tiny');
  });

  test('never grows the input (safety net)', () => {
    const text = 'a.ts:1:x\n'.repeat(80);
    const req = reqWithToolContent(text);
    compressToolOutputs(req, true);
    expect((messagesOf(req)[1].content as string).length).toBeLessThanOrEqual(text.length);
  });

  test('prepends a token-saver marker with kind and line counts', () => {
    const text = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40);
    const req = reqWithToolContent(text);
    compressToolOutputs(req, true);
    const out = messagesOf(req)[1].content as string;
    expect(out).toMatch(
      /^\[token-saver: git-status \d+->\d+ lines; rerun a narrower command or pipe through head\/tail for full output\]\n/
    );
    expect(out).toContain('branch: main');
  });

  test('marker eating the saving → original passes through untouched', () => {
    // One consecutive duplicate pair: dedup saves ~20B, less than the marker
    // (~110B), so the marker accounting must reject the compression.
    const lines = Array.from({ length: 20 }, (_, i) => `noise line number ${String(i).padStart(2, '0')} abc`);
    lines.push(lines[19]);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThanOrEqual(500); // above MIN_BLOB_BYTES
    const req = reqWithToolContent(text);
    const stats = compressToolOutputs(req, true);
    expect(stats!.hits.length).toBe(0);
    expect(messagesOf(req)[1].content).toBe(text);
  });

  test('compresses text parts inside array-form tool content', () => {
    const gitStatusText = 'On branch dev\nChanges to be committed:\n  new file:   x.ts\n'.repeat(40);
    const req = toIR({
      model: 'auto',
      messages: [
        { role: 'user', content: 'status?' },
        { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: gitStatusText }] },
      ],
    });
    const stats = compressToolOutputs(req, true);
    expect(stats!.hits.length).toBe(1);
    const item = req.input[1];
    expect(item?.type).toBe('tool_result');
    const part = item?.type === 'tool_result' ? item.content[0] : undefined;
    expect(part?.type).toBe('text');
    expect(part?.type === 'text' ? part.text.length : 0).toBeLessThan(gitStatusText.length);
  });

  test('leaves non-tool messages untouched', () => {
    const text = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40);
    const req = toIR({
      model: 'auto',
      messages: [{ role: 'user', content: text }],
    });
    const stats = compressToolOutputs(req, true);
    expect(stats!.hits.length).toBe(0);
    expect(messagesOf(req)[0].content).toBe(text);
  });

  test('formatCompressionLog summarizes hits', () => {
    const req = reqWithToolContent('On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40));
    const stats = compressToolOutputs(req, true);
    const log = formatCompressionLog(stats);
    expect(log).toContain('[compression:rtk]');
    expect(log).toContain('git-status');
  });
});

// ── compressor contracts & regressions ──────────────────────────────────────

describe('compressor contracts', () => {
  test('compressBuildLog keeps npm error / pnpm error lines (npm ≥9 renamed npm ERR!)', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `npm warn deprecated pkg${i}@1.0.0`),
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      'pnpm error ERR_PNPM_PEER_DEP_ISSUES unmet peer dependencies',
    ];
    const out = compressBuildLog(lines.join('\n'));
    expect(out).toContain('error: npm error code ERESOLVE');
    expect(out).toContain('error: npm error ERESOLVE unable to resolve dependency tree');
    expect(out).toContain('error: pnpm error ERR_PNPM_PEER_DEP_ISSUES');
    expect(out).toContain('warn: +17 more'); // 20 warns, first 3 shown
  });

  test('compressBuildLog keeps F#/BASIC diagnostic warnings (FS|BC)', () => {
    const out = compressBuildLog('File.fs: warning FS0025: Incomplete pattern match\n'.repeat(5));
    expect(out).toContain('warn: File.fs: warning FS0025: Incomplete pattern match');
  });

  test('compressGitDiff: per-file +/- counts, context lines dropped', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 123..456 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' context line',
      '-old line',
      '+new line',
    ].join('\n');
    const out = compressGitDiff(text);
    expect(out).toContain('src/a.ts: +1 -1');
    expect(out).toContain('+new line');
    expect(out).toContain('-old line');
    expect(out).not.toContain('context line');
  });

  test('compressGitLog: truncation marker only when actually truncated', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => `commit ${String(i).padStart(7, '0')}abcdef\nsubject line ${i}`).join('\n');
    expect(compressGitLog(mk(GIT_LOG_ENTRIES_MAX))).not.toContain('truncated');
    expect(compressGitLog(mk(GIT_LOG_ENTRIES_MAX + 5))).toContain(`truncated at ${GIT_LOG_ENTRIES_MAX}`);
  });

  test('compressGrepHits: groups Windows drive-letter paths by full path', () => {
    const text = 'C:\\src\\a.ts:12:alpha\nC:\\src\\a.ts:40:beta\nC:\\src\\b.ts:7:gamma';
    const out = compressGrepHits(text);
    expect(out).toContain('3 matches / 2 files');
    expect(out).toContain('C:\\src\\a.ts (2)');
    expect(out).toContain('12: alpha');
  });

  test('compressPathList: groups by directory with bounded listing', () => {
    const text = Array.from({ length: 20 }, (_, i) => `src/mod/f${i}.ts`).join('\n');
    const out = compressPathList(text);
    expect(out).toContain('20 paths / 1 dirs');
    expect(out).toContain('src/mod (20):');
    expect(out).toContain('+12'); // 20 names, first 8 shown
  });

  test('compressDirListing: drops noise dirs, humanizes sizes', () => {
    const text = [
      'total 8',
      '-rw-r--r-- 1 ken ken 2048 Jan  1 10:00 app.ts',
      'drwxr-xr-x 2 ken ken 4096 Jan  1 10:00 node_modules',
      'drwxr-xr-x 2 ken ken 4096 Jan  1 10:00 src',
    ].join('\n');
    const out = compressDirListing(text);
    expect(out).toContain('dirs(1): src');
    expect(out).toContain('app.ts 2.0K');
    expect(out).not.toContain('node_modules');
  });

  test('compressFsTree: strips glyphs, keeps hierarchy, drops summary line', () => {
    const text = '.\n├── src\n│   └── a.ts\n└── README.md\n\n2 directories, 2 files';
    const out = compressFsTree(text);
    expect(out).toContain('src');
    expect(out).toContain('a.ts');
    expect(out).not.toContain('├');
    expect(out).not.toContain('directories');
  });

  test('compressNumberedFile: head + tail with elision marker', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}|line ${i + 1}`);
    const out = compressNumberedFile(lines.join('\n'));
    expect(out).toContain('…… elided 120 lines ……');
    expect(out).toContain('1|line 1');
    expect(out).toContain('300|line 300');
  });

  test('compressGeneric: collapses consecutive duplicate runs', () => {
    const out = compressGeneric('same line\nsame line\nsame line\nother');
    expect(out).toContain('same line  (×3)');
    expect(out).toContain('other');
  });

  test('detects dir-listing / fs-tree / numbered-file / Windows grep', () => {
    const ls = Array.from({ length: 6 }, (_, i) => `-rw-r--r-- 1 ken ken ${1000 + i} Jan  1 10:00 file${i}.ts`).join('\n');
    expect(detectContentKind(ls)).toBe('dir-listing');
    const tree = '.\n├── src\n│   ├── a.ts\n│   ├── b.ts\n│   ├── c.ts\n│   └── d.ts\n└── README.md';
    expect(detectContentKind(tree)).toBe('fs-tree');
    const numbered = Array.from({ length: 30 }, (_, i) => `${i + 1}|content line ${i + 1}`).join('\n');
    expect(detectContentKind(numbered)).toBe('numbered-file');
    expect(detectContentKind('C:\\src\\a.ts:12:const x = 1;\n'.repeat(10))).toBe('grep-hits');
  });
});

// ── caveman ─────────────────────────────────────────────────────────────────

describe('injectCaveman', () => {
  test('appends prompt to existing system message', () => {
    const req = toIR({
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(injectCaveman(req, 'full')).toBe(true);
    const sys = messagesOf(req)[0].content as string;
    expect(sys).toContain('You are helpful.');
    expect(sys).toContain(CAVEMAN_PROMPTS.full);
  });

  test('creates system message at index 0 when absent', () => {
    const req = toIR({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(injectCaveman(req, 'lite')).toBe(true);
    expect(messagesOf(req)[0].role).toBe('system');
    expect(messagesOf(req)[0].content).toBe(CAVEMAN_PROMPTS.lite);
  });

  test('idempotent — second injection is a no-op', () => {
    const req = toIR({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(injectCaveman(req, 'ultra')).toBe(true);
    const snapshot = JSON.stringify(req);
    expect(injectCaveman(req, 'ultra')).toBe(false);
    expect(JSON.stringify(req)).toBe(snapshot);
  });

  test('invalid level is a no-op', () => {
    const req = toIR({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(injectCaveman(req, 'not-a-level')).toBe(false);
    expect(messagesOf(req).length).toBe(1);
  });

  test('handles array-form system content', () => {
    const req = toIR({
      model: 'auto',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Base rules.' }] },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(injectCaveman(req, 'wenyan')).toBe(true);
    const item = req.input[0];
    const parts = item?.type === 'message' ? item.content : [];
    expect(parts.some((part) => part.type === 'text' && part.text === CAVEMAN_PROMPTS.wenyan)).toBe(true);
    // idempotent on array form too
    expect(injectCaveman(req, 'wenyan')).toBe(false);
  });
});

// ── headroom (fail-open; no live sidecar needed) ────────────────────────────

describe('compressWithHeadroom', () => {
  const msgs = [{ role: 'user' as const, content: 'hello' }];

  test('disabled → null', async () => {
    expect(await compressWithHeadroom(msgs, 'm', { enabled: false, url: 'http://127.0.0.1:9' })).toBeNull();
  });

  test('missing url → null', async () => {
    expect(await compressWithHeadroom(msgs, 'm', { enabled: true })).toBeNull();
  });

  test('unreachable sidecar fails open (null), does not throw', async () => {
    const result = await compressWithHeadroom(msgs, 'm', {
      enabled: true,
      url: 'http://127.0.0.1:9', // discard port — connection refused
      timeoutMs: 800,
    });
    expect(result).toBeNull();
  });
});

// ── applyCompression orchestration ──────────────────────────────────────────

describe('applyCompression', () => {
  test('undefined config → no-op', async () => {
    const req = reqWithToolContent('x');
    const outcome = await applyCompression(req, undefined);
    expect(outcome.rtk).toBeNull();
    expect(outcome.headroom).toBeNull();
    expect(outcome.cavemanInjected).toBe(false);
  });

  test('rtk + caveman run together; headroom skipped without url', async () => {
    const cfg: CompressionConfig = {
      rtk: { enabled: true },
      headroom: { enabled: true }, // no url → fail-open skip
      caveman: { enabled: true, level: 'full' },
    };
    const req = reqWithToolContent('On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40));
    const outcome = await applyCompression(req, cfg, 'sess_test');
    expect(outcome.rtk?.hits.length).toBeGreaterThan(0);
    expect(outcome.headroom).toBeNull();
    expect(outcome.cavemanInjected).toBe(true);
    // caveman injected a system message at index 0
    expect(messagesOf(req)[0].role).toBe('system');
  });
});
