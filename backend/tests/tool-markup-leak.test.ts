import { describe, expect, test } from 'bun:test';
import { countToolMarkupLeak, createToolMarkupScanner, detectToolMarkupLeak } from '../src/providers/compat/tool-markup-leak.js';
import type { CanonicalResponse } from '../src/ir/types';

/**
 * The spelling that actually reached the client from opencode zen relaying
 * DeepSeek V4: full-width U+FF5C bars, NO `DSML` marker anywhere.
 */
const REAL_LEAK =
  '<｜tool_calls｜> <｜invoke name="ls"> <｜parameter name="path">.</｜parameter> </｜invoke> ' +
  '<｜invoke name="ls"> <｜parameter name="path">src</｜parameter> </｜invoke> ' +
  '<｜invoke name="ls"> <｜parameter name="path">data</｜parameter> </｜invoke> </｜tool_calls｜>';

function responseWith(...texts: string[]): CanonicalResponse {
  return {
    id: 'resp_1',
    model: 'deepseek/deepseek-v4-flash',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_1',
        content: texts.map((text) => ({ type: 'text', text })),
      },
    ],
  } as CanonicalResponse;
}

describe('tool-markup leak detection', () => {
  test('counts the real full-width spelling without any DSML marker', () => {
    expect(countToolMarkupLeak(REAL_LEAK)).toBe(3);
  });

  test('counts the DSML-marked spelling', () => {
    const text = '<｜DSML｜tool_calls> <｜DSML｜invoke name="read"> </｜DSML｜invoke> </｜DSML｜tool_calls>';
    expect(countToolMarkupLeak(text)).toBe(1);
  });

  test('counts the plain spelling', () => {
    expect(countToolMarkupLeak('<|invoke name="ls">') ).toBe(1);
  });

  test('is zero for prose that merely mentions invoke', () => {
    expect(countToolMarkupLeak('I would invoke the ls tool, then read the README.')).toBe(0);
    expect(countToolMarkupLeak('')).toBe(0);
  });

  test('detect reports null for a clean response', () => {
    expect(detectToolMarkupLeak(responseWith('All good.'))).toBeNull();
  });

  test('detect reports the count across text parts', () => {
    expect(detectToolMarkupLeak(responseWith('thinking…', REAL_LEAK))).toEqual({ calls: 3 });
  });

  test('detect never edits the response', () => {
    const response = responseWith(REAL_LEAK);
    detectToolMarkupLeak(response);
    const item = response.output[0];
    expect(item.type).toBe('message');
    if (item.type === 'message' && item.content[0]?.type === 'text') {
      // Byte-identical: observing is not repairing (ADR-0034).
      expect(item.content[0].text).toBe(REAL_LEAK);
    }
  });

  test('detect ignores tool_call items', () => {
    const response = {
      id: 'r',
      model: 'm',
      status: 'completed',
      output: [
        { type: 'tool_call', id: 'c1', callId: 'c1', name: 'ls', arguments: '<｜invoke name="x">' },
      ],
    } as unknown as CanonicalResponse;
    expect(detectToolMarkupLeak(response)).toBeNull();
  });

  test('scanner sees a tag split across two deltas exactly once', () => {
    const scanner = createToolMarkupScanner();
    scanner.push('<｜tool_calls｜> <｜inv');
    scanner.push('oke name="ls"> </｜invoke>');
    expect(scanner.leak()).toEqual({ calls: 1 });
  });

  test('scanner counts separate deltas separately', () => {
    const scanner = createToolMarkupScanner();
    scanner.push('<｜invoke name="ls">');
    scanner.push('</｜invoke>');
    scanner.push('<｜invoke name="read">');
    expect(scanner.leak()).toEqual({ calls: 2 });
  });

  test('scanner stays quiet on ordinary text', () => {
    const scanner = createToolMarkupScanner();
    scanner.push('Running ');
    scanner.push('the suite now, ');
    scanner.push('it can invoke nothing.');
    expect(scanner.leak()).toBeNull();
  });
});
