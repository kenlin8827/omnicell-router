import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boundCredentialLabelOf, currentModelOf, projectSessionEntity, deriveSessionEntryMode, promptTurnsOf, sessionIdSourceOf, sessionTitleOf } from '../src/session/session-row.js';
import type { ConversationSession } from '../src/session/session-manager.js';
import type { ExecutionTrace } from '../src/trace/tracker.js';

/**
 * The console session-row contract (ADR-0002 §3): rows are an EXECUTION view.
 * These are the guards that keep the routing anchor and the client IP inside
 * the gateway — they must fail if anyone reintroduces a `...session` spread or
 * re-points `currentModel` at the pin.
 */

const servedTrace = (modelUsed: string, provider: string): ExecutionTrace =>
  ({ execution: { modelUsed, provider } }) as unknown as ExecutionTrace;

describe('currentModelOf (execution view of a session)', () => {
  it('no traces → both halves null (session entity exists, nothing served yet)', () => {
    assert.deepEqual(currentModelOf([]), { currentModel: null, currentProvider: null });
  });

  it('reports the LAST served turn, not the first', () => {
    const traces = [
      servedTrace('lite-1', 'prov-a'),
      servedTrace('plus-2', 'prov-b'),
    ];
    assert.deepEqual(currentModelOf(traces), { currentModel: 'plus-2', currentProvider: 'prov-b' });
  });

  it('single trace → that trace', () => {
    assert.deepEqual(currentModelOf([servedTrace('only', 'prov')]), {
      currentModel: 'only',
      currentProvider: 'prov',
    });
  });
});

describe('promptTurnsOf (console Turns column ≠ traceCount)', () => {
  /** A trace with its WRITE-TIME turn boundary, never a text heuristic. */
  const turnTrace = (prompt: string): ExecutionTrace =>
    ({
      request: { userPromptSummary: prompt },
      isPromptStart: Boolean(prompt),
      turnIndex: prompt ? 1 : 1,
      turnDecision: prompt ? 'new_prompt' : 'continuation',
    }) as unknown as ExecutionTrace;

  it('counts only prompt-start traces (tool-loop continuations excluded)', () => {
    const traces = [
      turnTrace('fix the bug'),
      // Agent tool loop: continuation requests share the same turnIndex.
      turnTrace(''),
      turnTrace(''),
      turnTrace('now add tests'),
    ];
    assert.equal(promptTurnsOf(traces), 2);
  });

  it('no prompt-start → 0 (a session entity can exist before any served turn)', () => {
    assert.equal(promptTurnsOf([]), 0);
    assert.equal(promptTurnsOf([turnTrace(''), turnTrace('')]), 0);
  });
});

describe('projectSessionEntity (console whitelist)', () => {
  const entity = {
    id: 'sess_1',
    maxTier: 'plus',
    pinnedModel: 'anchor-model',
    pinnedProvider: 'anchor-provider',
    createdAt: 1,
    lastActiveAt: 2,
    historyTiers: ['lite', 'plus'],
    origin: { wire: 'openai', lookupType: 'header', clientIp: '10.0.0.9' },
    firstUserMessage: 'hello',
    boundKeyHashPrefix: 'abc123',
    boundAt: 4,
  } as unknown as ConversationSession;

  it('carries the whitelisted entity fields verbatim', () => {
    assert.deepEqual(projectSessionEntity(entity), {
      id: 'sess_1',
      maxTier: 'plus',
      createdAt: 1,
      lastActiveAt: 2,
        historyTiers: ['lite', 'plus'],
      firstUserMessage: 'hello',
      boundKeyHashPrefix: 'abc123',
      boundAt: 4,
    });
  });

  it('never publishes the routing pin or the client IP', () => {
    const row = projectSessionEntity(entity) as Record<string, unknown>;
    assert.equal('pinnedModel' in row, false, 'the session anchor is routing-internal (ADR-0002)');
    assert.equal('pinnedProvider' in row, false);
    assert.equal('origin' in row, false, 'origin.clientIp is not console data');
  });

  it('is a closed set — a new entity field stays internal by default', () => {
    const widened = { ...entity, futureInternalField: 'secret' } as unknown as ConversationSession;
    assert.equal('futureInternalField' in (projectSessionEntity(widened) as Record<string, unknown>), false);
  });
});

describe('sessionTitleOf (console title, entity-independent)', () => {
  const titleTrace = (firstUserSummary: string | undefined, userPromptSummary: string): ExecutionTrace =>
    ({ request: { firstUserSummary, userPromptSummary } }) as unknown as ExecutionTrace;

  it('reads the birth trace, never a later turn prompt', () => {
    const traces = [
      titleTrace('Plan a trip to Kyoto', 'Plan a trip to Kyoto'),
      titleTrace(undefined, 'Add a day in Osaka'),
    ];
    assert.equal(sessionTitleOf(traces), 'Plan a trip to Kyoto');
  });

  it('falls back to the opening turn summary on traces written before the field', () => {
    assert.equal(sessionTitleOf([titleTrace(undefined, 'legacy prompt')]), 'legacy prompt');
  });

  it('no traces → undefined (nothing to name yet)', () => {
    assert.equal(sessionTitleOf([]), undefined);
  });
});

// The classifier moved here with the row contract; one smoke case so a bad
// re-export in server.ts cannot silently break the console tier column.
describe('deriveSessionEntryMode (re-exported from the row contract)', () => {
  it('classifies an empty trace list as mixed (safe fallback)', () => {
    assert.equal(deriveSessionEntryMode([]), 'mixed');
  });
});

// The console cannot infer this from the id: a client-named id is adopted
// verbatim, so a 36-char UUID and a gateway `sess_` + 16 hex both land in the
// same column. These guards keep the marker truthful across both row shapes.
describe('sessionIdSourceOf (who minted the id)', () => {
  const lookupTrace = (sessionLookupType: string | undefined): ExecutionTrace =>
    ({ routing: { sessionLookupType } }) as unknown as ExecutionTrace;

  it('client-named layers → client', () => {
    for (const layer of ['explicit_header', 'embedded_user_id', 'request_user', 'header_fallback']) {
      assert.equal(sessionIdSourceOf([lookupTrace(layer)]), 'client', layer);
    }
  });

  it('gateway-minted / gateway-resolved layers → gateway', () => {
    // The content anchors, conversation key and client_ref alias all resolve an
    // id the GATEWAY minted — an alias binds a gateway session, never renames it.
    for (const layer of ['cold_start', 'prefix_chain', 'tail_anchor', 'conversation_key', 'client_ref']) {
      assert.equal(sessionIdSourceOf([lookupTrace(layer)]), 'gateway', layer);
    }
  });

  it('reads the BIRTH lookup, not a later anchor re-resolution', () => {
    // Turn 2 re-resolved the same client-named id through the content chain;
    // reading the latest turn would flip the marker to 'gateway'.
    const traces = [lookupTrace('explicit_header'), lookupTrace('prefix_chain')];
    assert.equal(sessionIdSourceOf(traces), 'client');
  });

  it('the entity birth lookup outranks the traces (the ring can evict the birth turn)', () => {
    assert.equal(sessionIdSourceOf([lookupTrace('prefix_chain')], 'embedded_user_id'), 'client');
  });

  it('no recorded lookup → undefined (console prints the id alone)', () => {
    assert.equal(sessionIdSourceOf([]), undefined);
    assert.equal(sessionIdSourceOf([lookupTrace(undefined)]), undefined);
  });
});

describe('boundCredentialLabelOf (display label of the bound credential)', () => {
  const chain = [
    { keyHashPrefix: 'aaaaaaaaaaaa', label: '  primary  ', key: 'k1' },
    { keyHashPrefix: 'bbbbbbbbbbbb', key: 'k2' },
  ];

  it('matches the serving chain by prefix and trims the operator label', () => {
    assert.equal(boundCredentialLabelOf(chain, 'aaaaaaaaaaaa'), 'primary');
  });

  it('unnamed credential / absent binding / missing chain → undefined (console falls back to #prefix)', () => {
    assert.equal(boundCredentialLabelOf(chain, 'bbbbbbbbbbbb'), undefined);
    assert.equal(boundCredentialLabelOf(chain, undefined), undefined);
    assert.equal(boundCredentialLabelOf(undefined, 'aaaaaaaaaaaa'), undefined);
  });

  it('a prefix that left the chain is not guessed from another provider', () => {
    // The route passes ONE provider's chain; an unknown prefix never matches.
    assert.equal(boundCredentialLabelOf(chain, 'cccccccccccc'), undefined);
  });
});
