/**
 * The catalog-def CONTRACT (ADR-0035). These cases are not about one vendor —
 * they pin the shared rules every model-service plugin's mapping must satisfy,
 * which is the whole reason `toOcrDef` exists. `qoder-models` and
 * `workbuddy-models` both route through it, so a regression here is a
 * regression in every plugin at once — exactly the blast radius the extraction
 * was meant to make visible instead of silent.
 *
 * Each describe block names the rule it defends; a failure tells you which
 * promise the next plugin would break.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LADDER } from '../../src/types/router.js';
import { normalizeEfforts, toOcrDef } from '../../src/plugins/catalog-def.js';

type Def = Record<string, unknown>;
const opts = (def: Def): unknown => def.reasoningOptions;
const values = (def: Def): unknown => (opts(def) as { values?: unknown }[] | undefined)?.[0]?.values;

describe('toOcrDef — rule 1: an effort TABLE is the only level declaration', () => {
  it('publishes a declared table verbatim, in ladder order', () => {
    // Vendors hand back an unordered object (`{high, low, max}`), so the mapper
    // restores ladder order — otherwise the console shows max before low.
    const def = toOcrDef({ id: 'm', reasoning: { efforts: ['max', 'low', 'high'] } });
    assert.deepEqual(values(def), ['low', 'high', 'max']);
  });

  it('drops a level the gateway ladder cannot name', () => {
    const def = toOcrDef({ id: 'm', reasoning: { efforts: ['low', 'ultra', 'high'] } });
    assert.deepEqual(values(def), ['low', 'high']);
  });

  it('omits none entirely when the model always thinks', () => {
    // The 1210 fix: with no `none` in the ladder, `downgradeReasoning` can
    // never emit "thinking off" for a model whose vendor refuses it.
    const def = toOcrDef({ id: 'm', reasoning: { efforts: ['low', 'high', 'max'], disableable: false } });
    assert.deepEqual(values(def), ['low', 'high', 'max']);
    assert.equal((values(def) as string[]).includes('none'), false);
  });

  it('never resurrects none through the empty-table fallback', () => {
    // Contradictory vendor data: an always-think model whose only declared
    // level is `none`. Stripping it empties the table; the fallback must NOT
    // re-publish the unstripped efforts — that would re-advertise the exact
    // level the on/off fact forbids and re-open the 1210 refusal.
    const def = toOcrDef({ id: 'm', reasoning: { efforts: ['none'], disableable: false } });
    assert.equal(def.reasoning, true);
    assert.equal('reasoningOptions' in def, false, 'no ladder rather than a forbidden none');
    assert.equal('defaultEffort' in def, false);
    // The on/off fact must ride the def: without it the boot ladder would
    // expand the bare boolean into the FULL ladder including `none` and the
    // router would reproduce the refusal (RISK-1, routing-plane withholding).
    assert.equal(def.reasoningDisableable, false);
  });

  it('carries the always-think fact on EVERY disableable:false def, table or not', () => {
    const table = toOcrDef({ id: 'm', reasoning: { efforts: ['low', 'high'], disableable: false } });
    assert.equal(table.reasoningDisableable, false);
    const booleanOnly = toOcrDef({ id: 'm', reasoning: { disableable: false } });
    assert.equal(booleanOnly.reasoning, true);
    assert.equal(booleanOnly.reasoningDisableable, false);
    // Off allowed / not stated: the field stays absent (undefined = unstated).
    assert.equal('reasoningDisableable' in toOcrDef({ id: 'm', reasoning: { disableable: true } }), false);
    assert.equal('reasoningDisableable' in toOcrDef({ id: 'm', reasoning: { efforts: ['low'] } }), false);
    assert.equal('reasoningDisableable' in toOcrDef({ id: 'm' }), false);
  });

  it('turns a single pinned gear into a one-value table, never a toggle', () => {
    const def = toOcrDef({ id: 'm', reasoning: { fixedEffort: 'high' } });
    assert.deepEqual(opts(def), [{ type: 'effort', values: ['high'] }]);
    assert.equal(def.defaultEffort, 'high');
  });

  it('emits a bare toggle ONLY when the vendor declared on/off and no levels', () => {
    const def = toOcrDef({ id: 'm', reasoning: { disableable: true } });
    assert.deepEqual(opts(def), [{ type: 'toggle' }]);
  });

  it('claims no level control at all when the vendor declared neither', () => {
    // A level-less toggle resolves to `[]` — an EMPTY ladder — which
    // `downgradeReasoning` collapses to 'none' for every request. Omitting the
    // options leaves the router on its documented boolean expansion.
    const def = toOcrDef({ id: 'm', reasoning: {} });
    assert.equal(def.reasoning, true);
    assert.equal('reasoningOptions' in def, false);
  });

  it('carries no reasoning at all for a non-reasoning row', () => {
    const def = toOcrDef({ id: 'm' });
    assert.equal('reasoning' in def, false);
    assert.equal('reasoningOptions' in def, false);
  });

  it('keeps a defaultEffort only when the table contains it', () => {
    assert.equal(toOcrDef({ id: 'm', reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } }).defaultEffort, 'high');
    assert.equal('defaultEffort' in toOcrDef({ id: 'm', reasoning: { efforts: ['low', 'high'], defaultEffort: 'max' } }), false);
  });
});

describe('toOcrDef — rule 2: nothing the vendor did not declare', () => {
  it('omits tool_call / temperature / structured_output when undeclared instead of guessing true', () => {
    const def = toOcrDef({ id: 'm' });
    assert.equal('tool_call' in def, false);
    assert.equal('temperature' in def, false);
    assert.equal('structured_output' in def, false);
  });

  it('carries an explicit false through (declared unsupported is a fact)', () => {
    const def = toOcrDef({ id: 'm', toolCall: false, temperature: false, structuredOutput: false });
    assert.equal(def.tool_call, false);
    assert.equal(def.temperature, false);
    assert.equal(def.structured_output, false);
  });

  it('omits interleaved when undeclared, and carries the field when declared', () => {
    assert.equal('interleaved' in toOcrDef({ id: 'm' }), false);
    assert.deepEqual(toOcrDef({ id: 'm', interleavedField: 'thinking' }).interleaved, { field: 'thinking' });
  });
});

describe('toOcrDef — rule 3: attachment and modalities are one fact', () => {
  it('declares both spellings for an image-capable row', () => {
    const def = toOcrDef({ id: 'm', inputModalities: ['text', 'image'] });
    assert.equal(def.attachment, true);
    assert.deepEqual(def.modalities, { input: ['text', 'image'] });
  });

  it('emits the full modality vocabulary the vendor declared', () => {
    // models.dev input vocabulary: text | image | audio | video | pdf. The
    // contract must EXPRESS all of them even though the current qoder rows only
    // publish a vision boolean.
    const def = toOcrDef({ id: 'm', inputModalities: ['text', 'image', 'audio', 'video', 'pdf'], outputModalities: ['text', 'image'] });
    assert.deepEqual(def.modalities, { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text', 'image'] });
    assert.equal(def.attachment, true);
  });

  it('does NOT set attachment for a pdf-only or audio-only row', () => {
    // `attachment` is the vision boolean; carrying a document is a different
    // capability and must not make the console show an image badge.
    const def = toOcrDef({ id: 'm', inputModalities: ['text', 'pdf'] });
    assert.equal('attachment' in def, false);
    assert.deepEqual(def.modalities, { input: ['text', 'pdf'] });
  });

  it('declares neither block for a text-only row', () => {
    // Restating "text works" is not a capability declaration.
    const def = toOcrDef({ id: 'm', inputModalities: ['text'], outputModalities: ['text'] });
    assert.equal('attachment' in def, false);
    assert.equal('modalities' in def, false);
  });

  it('declares neither block when the vendor said nothing', () => {
    const def = toOcrDef({ id: 'm' });
    assert.equal('attachment' in def, false);
    assert.equal('modalities' in def, false);
  });
});

describe('toOcrDef — rule 4: limit.input is a prompt cap, never inferred', () => {
  it('keeps context and output separate from a prompt cap', () => {
    const def = toOcrDef({ id: 'm', limit: { context: 200_000, output: 32_000 } });
    assert.deepEqual(def.limit, { context: 200_000, output: 32_000 });
  });

  it('carries a declared input cap through', () => {
    const def = toOcrDef({ id: 'm', limit: { context: 1_000_000, input: 180_000 } });
    assert.deepEqual(def.limit, { context: 1_000_000, input: 180_000 });
  });

  it('drops zero and negative budgets rather than publishing them', () => {
    assert.equal('limit' in toOcrDef({ id: 'm', limit: { context: 0, output: -1 } }), false);
  });
});

describe('toOcrDef — cost, disabled, passthrough', () => {
  it('maps camelCase cost to the models.dev snake_case spelling', () => {
    const def = toOcrDef({ id: 'm', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } });
    assert.deepEqual(def.cost, { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 });
  });

  it('never invents a cost when the vendor has none', () => {
    assert.equal('cost' in toOcrDef({ id: 'm' }), false);
  });

  it('marks a vendor-disabled row so it leaves the routing pool', () => {
    assert.equal(toOcrDef({ id: 'm', disabled: true }).disabled, true);
    assert.equal('disabled' in toOcrDef({ id: 'm', disabled: false }), false);
  });

  it('keeps unmapped vendor fields verbatim for a later promotion', () => {
    const def = toOcrDef({ id: 'm', vendor: { price_factor: 0.8 } });
    assert.deepEqual(def.vendor, { price_factor: 0.8 });
  });

  it('always carries the id', () => {
    assert.equal(toOcrDef({ id: 'gmodel_latest' }).id, 'gmodel_latest');
  });
});

describe('normalizeEfforts', () => {
  it('accepts only ladder members, case-insensitively, without duplicates', () => {
    assert.deepEqual(normalizeEfforts(['HIGH', 'low', 'low', 'nope']), ['high', 'low']);
  });

  it('returns the whole declared set when the vendor lists every level', () => {
    assert.deepEqual(normalizeEfforts([...EFFORT_LADDER]), [...EFFORT_LADDER]);
  });

  it('tolerates a missing or non-array declaration', () => {
    assert.deepEqual(normalizeEfforts(undefined), []);
  });
});