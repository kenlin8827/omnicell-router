import { describe, expect, test } from 'bun:test';
import { routingModeForceTier } from '../src/router/index.js';

describe('routingModeForceTier', () => {
  test('returns undefined for smart mode / missing mode', () => {
    expect(routingModeForceTier('auto', undefined, 'smart')).toBeUndefined();
    expect(routingModeForceTier('auto', undefined, undefined)).toBeUndefined();
  });

  test('cost/quality force tier for auto-ish requests only', () => {
    expect(routingModeForceTier('auto', undefined, 'cost')).toBe('lite');
    expect(routingModeForceTier('pro', undefined, 'quality')).toBe('pro');
    expect(routingModeForceTier('gpt-5', undefined, 'cost')).toBeUndefined();
  });

  test('existing force_tier wins over global mode', () => {
    expect(routingModeForceTier('auto', { force_tier: 'plus' }, 'cost')).toBeUndefined();
  });
});
