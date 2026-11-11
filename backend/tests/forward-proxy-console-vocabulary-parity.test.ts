import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULE_EGRESSES, RULE_INGRESSES, RULE_WARNING_CODES } from '../src/forward-proxy/rules';

/**
 * The console mirror (`frontend/src/lib/api.ts`) re-declares the rule vocabulary
 * by hand — it is a wire contract, not an import, and nothing in the typechecker
 * compares the two sides. Without this link a value added on the backend reaches
 * the console as an option the console cannot render, or (for a lint code) as the
 * WRONG sentence: the row renderer used to fall through to "never reached" for
 * anything it did not recognize. Failing here is the intended outcome — the fix
 * is to mirror the value (and give it a message) in the same commit.
 */
const API = readFileSync(join(import.meta.dir, '..', '..', 'frontend', 'src', 'lib', 'api.ts'), 'utf8');

const union = (name: string): string[] => {
  const m = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(API);
  if (!m) throw new Error(`frontend/src/lib/api.ts no longer declares \`export type ${name}\``);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
};

const backend = (values: readonly string[]): string[] => [...values].sort();

describe('console vocabulary parity (backend ⇄ frontend/src/lib/api.ts)', () => {
  it('the ingress axis names the same three values', () => {
    expect(union('RuleIngress')).toEqual(backend(RULE_INGRESSES));
  });

  it('the egress axis names the same two values', () => {
    expect(union('RuleEgress')).toEqual(backend(RULE_EGRESSES));
  });

  it('every lint code has a console message', () => {
    expect(union('RuleWarningCode')).toEqual(backend(RULE_WARNING_CODES));
  });
});
