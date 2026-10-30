/**
 * Runnable check for the guardrails matrix join/fold semantics
 * (cp-check minimum for frontend logic — this repo has no browser-test
 * runner). Run: `bun scripts/check-guardrails-matrix.ts` — exits non-zero
 * on any failed assertion.
 */
import {
  buildPairCards,
  effectiveState,
  effectiveCooldown,
  isTakenDown,
  isModelWideTrip,
  type PairCard,
} from '../frontend/src/lib/guardrails-matrix';
import type { BreakerInfo, CredentialHealth } from '../frontend/src/lib/api';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
};

const snap = (over: Partial<BreakerInfo> & { modelId: string; provider: string }): BreakerInfo => ({
  state: 'CLOSED',
  consecutiveFailures: 0,
  totalRequests: 0,
  totalSuccesses: 0,
  totalFailures: 0,
  remainingCooldownMs: 0,
  currentCooldownMs: 0,
  halfOpenProbes: 0,
  ...over,
});

const acct = (over: Partial<CredentialHealth> & { id: string; providerId: string }): CredentialHealth => ({
  type: 'api',
  active: true,
  routable: true,
  suspect: false,
  disabled: false,
  openPairs: 0,
  ...over,
});

const LABELS = { unnamed: '未命名', configKey: '配置密钥' };

// --- multi-credential cross + pair join -----------------------------------
{
  const model = snap({ modelId: 'zhipu/glm-4.5', provider: 'zhipu' });
  const pair = snap({ modelId: 'zhipu/glm-4.5', provider: 'zhipu', state: 'OPEN', remainingCooldownMs: 5000, keyHashPrefix: 'k1' });
  const cards = buildPairCards(
    [model],
    [pair],
    [acct({ id: 'a1', providerId: 'zhipu', label: 'Z-1 主力', keyHashPrefix: 'k1' }), acct({ id: 'a2', providerId: 'zhipu', keyHashPrefix: 'k2' })],
    [],
    LABELS
  );
  check('cross = models × credentials (2 cards)', cards.length === 2);
  const c1 = cards.find((c) => c.prefix === 'k1')!;
  const c2 = cards.find((c) => c.prefix === 'k2')!;
  check('labeled row keeps its label', c1.label === 'Z-1 主力');
  check('unlabeled row reads 未命名, never the credentialId', c2.label === '未命名');
  check('pair breaker joins its card (snapSource=pair)', c1.snap === pair && c1.snapSource === 'pair');
  check('healthy sibling has no snap but keeps modelSnap', c2.snap === undefined && c2.modelSnap === model);
  check('healthy sibling stays CLOSED (fold never paints)', effectiveState(c2) === 'CLOSED');
}
// --- model fold is CONTEXT, never painted onto cards -------------------------
{
  const model = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', remainingCooldownMs: 9000 });
  const cards = buildPairCards(
    [model],
    [],
    [acct({ id: 'a1', providerId: 'p', keyHashPrefix: 'k1' }), acct({ id: 'a2', providerId: 'p', keyHashPrefix: 'k2' })],
    [],
    LABELS
  );
  // A model fold OPEN with NO tuple breakers means nothing failed on these
  // credentials yet — the cards must stay healthy (the old fold-painting made
  // one credential's trip look like every credential tripped).
  check('model fold alone never trips pair cards', cards.every((c) => effectiveState(c) === 'CLOSED'));
  check('cooldown never folds from the model breaker', cards.every((c) => effectiveCooldown(c) === 0));
  check('cards still carry the fold for context', cards.every((c) => c.modelSnap === model));
}

// --- single-credential mirror ----------------------------------------------
{
  const model = snap({ modelId: 'p/y', provider: 'p', state: 'HALF_OPEN' });
  const cards = buildPairCards([model], [], [acct({ id: 'a1', providerId: 'p', keyHashPrefix: 'k1' })], [], LABELS);
  check('chain of 1 mirrors the model breaker', cards[0].snap === model && cards[0].snapSource === 'model-mirror');
  check('mirror state reads through to the card', effectiveState(cards[0]) === 'HALF_OPEN');
}

// --- chainless provider: synthetic config-key column -------------------------
{
  const model = snap({ modelId: 'm/z', provider: 'm' });
  const cards = buildPairCards([model], [], [], [], LABELS);
  check('chainless model gets one synthetic card', cards.length === 1 && cards[0].synthetic);
  check('synthetic label is 配置密钥', cards[0].label === '配置密钥');
}

// --- orphan breaker: inline chain head vs rotated key ------------------------
{
  const orphan = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', keyHashPrefix: 'k9' });
  const inline = buildPairCards([], [orphan], [], [{ provider: 'p', keyHashPrefix: 'k9' }], LABELS);
  check('orphan prefix in the credential directory ⇒ 配置密钥', inline[0].label === '配置密钥' && !inline[0].unmatched);
  const rotated = buildPairCards([], [orphan], [], [], LABELS);
  check('orphan prefix nowhere known ⇒ bare #hash + unmatched', rotated[0].label === '#k9' && rotated[0].unmatched === true);
}

// --- orphan keeps its model breaker fold ------------------------------------
{
  const model = snap({ modelId: 'q/x', provider: 'q', state: 'CLOSED' });
  const orphan = snap({ modelId: 'q/x', provider: 'q', state: 'OPEN', keyHashPrefix: 'k7' });
  const cards = buildPairCards([model], [orphan], [], [], LABELS);
  const pairCard = cards.find((c: PairCard) => c.prefix === 'k7')!;
  check('orphan card owns its tuple (snapSource=pair)', pairCard.snapSource === 'pair' && pairCard.snap === orphan);
  check('orphan card attaches the model breaker for folding', pairCard.modelSnap === model && effectiveState(pairCard) === 'OPEN');
}

// --- takedown dimension is independent of breaker state ---------------------
{
  const healthy = { snap: undefined, disabled: false, suspect: false };
  const taken = { snap: undefined, disabled: true, suspect: false };
  const suspect = { snap: undefined, disabled: false, suspect: true };
  const tripped = { snap: { state: 'OPEN' }, disabled: false, suspect: false };
  check('isTakenDown: disabled or suspect, regardless of breaker state',
    isTakenDown(taken as never) && isTakenDown(suspect as never) && !isTakenDown(healthy as never) && !isTakenDown(tripped as never));
  check('effectiveState ignores takedown (pure tuple truth)', effectiveState(taken as never) === 'CLOSED' && effectiveState(tripped as never) === 'OPEN');
}

// --- a credential-scope trip never reads as a model-level takedown -----------
{
  const accts = [
    acct({ id: 'a1', providerId: 'p', keyHashPrefix: 'k1' }),
    acct({ id: 'a2', providerId: 'p', keyHashPrefix: 'k2' }),
  ];
  // The fold is the worst tuple, so a credential-scoped trip on k1 raises it —
  // but it is NOT a model-layer trip: the healthy sibling card must not render
  // "model-level", and its action must stay a card-scoped trip.
  const fold = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', scope: 'credential' });
  const pair = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', keyHashPrefix: 'k1', scope: 'credential' });
  const cards = buildPairCards([fold], [pair], accts, [], LABELS);
  check('credential-scope fold is never model-wide', cards.every((c) => !isModelWideTrip(c)));
  const sibling = cards.find((c) => c.prefix === 'k2')!;
  check('healthy sibling stays CLOSED under a credential-scope fold', effectiveState(sibling) === 'CLOSED' && !isModelWideTrip(sibling));

  // A genuine model-scope trip (every tuple carries the label) does qualify.
  const modelFold = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', scope: 'model' });
  const wide = buildPairCards([modelFold], [], accts, [], LABELS);
  check('model-scope fold is model-wide', wide.every((c) => isModelWideTrip(c)));
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall guardrails-matrix checks passed');
