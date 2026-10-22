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
    ['empty model counts as auto', [trace(''), trace('')], 'auto'],
    ['padded alias routes trimmed → auto', [trace(' lite ')], 'auto'],
    ['padded concrete model stays explicit', [trace(' alibaba/qwen3.8-flash ')], 'explicit'],
    ['tier-forced aliases count as auto', [trace('lite'), trace('lite')], 'auto'],
    ['all four tier aliases count as auto', [trace('lite'), trace('plus'), trace('pro'), trace('ultra')], 'auto'],
    ['bare auto + tier-forced alias = same family → auto', [trace('auto'), trace('plus')], 'auto'],
    ['tier-forced alias + concrete model → mixed', [trace('lite'), trace('alibaba/qwen3.8-flash')], 'mixed'],
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
