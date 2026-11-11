import { describe, expect, it } from 'bun:test';
import { MAX_UPSTREAM_TEXT_BYTES, readTextCapped } from '../src/harness/net.js';
import { browseSkillsSh } from '../src/harness/skill/skills-sh.js';

/**
 * The shared bounded body read (ADR-0015 §D6 caps discipline).
 *
 * A reader parses a PAGE of rows, never an archive, so the honest answers are small. What is pinned
 * here is that an oversized answer is REFUSED rather than buffered — a fast upstream can stream far
 * more bytes than the per-attempt timeout would suggest — and that the refusal arrives as the
 * reader's own failure vocabulary (`badPayload`), never as a thrown exception.
 */

function chunked(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

const encoder = new TextEncoder();

describe('readTextCapped', () => {
  it('reads a normal body whole, across a multi-byte character split between chunks', async () => {
    const bytes = encoder.encode('{"skills":["技能"]}');
    // Split INSIDE the first CJK character: only a streaming decoder reassembles it.
    const cut = bytes.indexOf(0xe6) + 1;
    const read = await readTextCapped(chunked([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(read).toEqual({ ok: true, text: '{"skills":["技能"]}' });
  });

  it('refuses a streamed body that crosses the cap and reports what it saw', async () => {
    const cap = 1024;
    const read = await readTextCapped(chunked([new Uint8Array(600), new Uint8Array(600)]), cap);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.cap).toBe(cap);
    // One chunk of overshoot at most: the stream is cancelled as soon as it crosses.
    expect(read.bytes).toBe(1200);
  });

  it('refuses on a declared Content-Length without buffering the body at all', async () => {
    const neverRead = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('body must not be read when the declared length already breaks the cap');
      },
    });
    const read = await readTextCapped(new Response(neverRead, { headers: { 'content-length': '99999999' } }));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.bytes).toBe(99_999_999);
  });

  it('keeps the production cap large enough for a real catalog page', async () => {
    expect(MAX_UPSTREAM_TEXT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

describe('a reader answers an oversized upstream as a failure, not an exception', () => {
  it('skills.sh refuses a body past the cap with its own reason', async () => {
    const huge = new Uint8Array(MAX_UPSTREAM_TEXT_BYTES + 1);
    const browsed = await browseSkillsSh('', 24, 1, undefined, async () =>
      chunked([huge], { 'content-type': 'application/json' })
    );
    expect(browsed.ok).toBe(false);
    if (browsed.ok) return;
    expect(browsed.code).toBe('upstream');
    expect(browsed.reason).toBe('badPayload');
    expect(browsed.message).toContain('refused');
  });
});
