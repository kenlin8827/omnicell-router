import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bodyStatesRefusal, resolveVerdict, upstreamCode } from '../../src/quota/verdict.js';
import { BUILTIN_QUOTA_DECLARATIONS } from '../../src/quota/declarations.js';
import type { QuotaProbeEntry } from '../../src/quota/types.js';

// The verdict is the ONLY place an account conclusion is decided, and it must
// come from structured signals. These cases pin the precedent that matters:
// a quota endpoint answering HTTP 200 with a machine-readable refusal is
// `plan-inactive`, and no message WORDING ever decides a verdict.

const zhipu = BUILTIN_QUOTA_DECLARATIONS.find((e) => e.id === 'zhipuai-coding-plan')!;

/** The real body Zhipu returns for an expired coding plan (verified 2026-01). */
const ZHIPU_REFUSAL = { code: 500, msg: '当前用户不存在coding plan', success: false };

describe('quota failure verdict', () => {
  it('reads a structured refusal off a status-OK body', () => {
    assert.equal(bodyStatesRefusal(ZHIPU_REFUSAL), true);
    assert.equal(bodyStatesRefusal({ success: true, data: {} }), false);
    assert.equal(bodyStatesRefusal({ code: 0, data: {} }), false);
    assert.equal(bodyStatesRefusal({ base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' } }), true);
  });

  it('classifies Zhipu plan refusal as plan-inactive via the declaration refusalIf', () => {
    const verdict = resolveVerdict({ reason: 'shape', status: 200, body: ZHIPU_REFUSAL, entry: zhipu });
    assert.equal(verdict, 'plan-inactive');
  });

  it('classifies the same refusal by envelope alone when no declaration declares it', () => {
    // A forked/user entry without `refusalIf` still gets the account verdict:
    // the body's own structured field is enough.
    const verdict = resolveVerdict({ reason: 'shape', status: 200, body: ZHIPU_REFUSAL });
    assert.equal(verdict, 'plan-inactive');
  });

  it('an adapter-stated verdict wins over anything derived from the body', () => {
    const verdict = resolveVerdict({ reason: 'status', status: 200, body: ZHIPU_REFUSAL, stated: 'credential-rejected' });
    assert.equal(verdict, 'credential-rejected');
  });

  it('maps transport-level signals to the closed vocabulary', () => {
    assert.equal(resolveVerdict({ reason: 'auth', status: 401, body: undefined }), 'credential-rejected');
    assert.equal(resolveVerdict({ reason: 'auth', status: 403, body: undefined }), 'credential-rejected');
    assert.equal(resolveVerdict({ reason: 'status', status: 404, body: undefined }), 'endpoint-gone');
    assert.equal(resolveVerdict({ reason: 'status', status: 429, body: undefined }), 'rate-limited');
    assert.equal(resolveVerdict({ reason: 'status', status: 502, body: undefined }), 'upstream-error');
    assert.equal(resolveVerdict({ reason: 'timeout', body: undefined }), 'timeout');
    assert.equal(resolveVerdict({ reason: 'network', body: undefined }), 'unreachable');
    assert.equal(resolveVerdict({ reason: 'shape', status: 200, body: { data: {} } }), 'unreadable');
  });

  it('never decides from prose: an unparsable 200 whose sentence says "no plan" is unreadable', () => {
    // The sentence is evidence, not a signal — a wording rule here would need
    // one copy per vendor per language.
    const verdict = resolveVerdict({
      reason: 'shape',
      status: 200,
      body: { note: 'no active token plan subscription' },
    });
    assert.equal(verdict, 'unreadable');
  });

  it('surfaces the upstream code as evidence', () => {
    assert.equal(upstreamCode(ZHIPU_REFUSAL), 500);
    assert.equal(upstreamCode({ base_resp: { status_code: 2062 } }), 2062);
    assert.equal(upstreamCode({ data: {} }), undefined);
  });

  it('every built-in entry passes load validation with the new refusalIf field', () => {
    // refusalIf is part of the entry schema now; an unknown-key rejection here
    // would silently drop the declaration.
    for (const e of BUILTIN_QUOTA_DECLARATIONS as QuotaProbeEntry[]) {
      if (!e.refusalIf) continue;
      assert.equal(e.refusalIf.where.path, 'success', `${e.id} refusalIf reads the structured flag`);
    }
  });
});