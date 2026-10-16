import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionEntryMode, type SessionEntryMode } from '../src/server.js';
import type { ExecutionTrace } from '../src/trace/tracker.js';

// Only request.model and routing.reasonCode are read by the classifier —
// build minimal fake traces instead of full pipeline runs.
const trace = (model: string, reasonCode?: string): ExecutionTrace =>
  ({ request: { model }, routing: { reasonCode } }) as unknown as ExecutionTrace;

describe('deriveSessionEntryMode (console tier-column entry mode)', () => {
  const cases: [string, ExecutionTrace[], SessionEntryMode][] = [
    ['bare auto turns → auto', [trace('auto'), trace('auto')], 'auto'],
    ['empty/default aliases count as auto', [trace(''), trace('default')], 'auto'],
    ['combo reasonCode turns → combo', [trace('my-combo', 'combo')], 'combo'],
    ['concrete model names → explicit', [trace('alibaba/qwen3.8-flash')], 'explicit'],
    ['auto + combo mix → mixed', [trace('auto'), trace('my-combo', 'combo')], 'mixed'],
    ['no traces → mixed (safe fallback)', [], 'mixed'],
  ];
  for (const [name, traces, expected] of cases) {
    it(name, () => {
      assert.equal(deriveSessionEntryMode(traces), expected);
    });
  }
});
