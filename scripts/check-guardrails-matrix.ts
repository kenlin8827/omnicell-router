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
  check('effective state folds model breaker into every card', effectiveState(c2) === 'CLOSED');
}

// --- model-level trip folds into all pair cards -----------------------------
{
  const model = snap({ modelId: 'p/x', provider: 'p', state: 'OPEN', remainingCooldownMs: 9000 });
  const cards = buildPairCards(
    [model],
    [],
    [acct({ id: 'a1', providerId: 'p', keyHashPrefix: 'k1' }), acct({ id: 'a2', providerId: 'p', keyHashPrefix: 'k2' })],
    [],
    LABELS
  );
  check('model OPEN ⇒ every pair card OPEN', cards.every((c) => effectiveState(c) === 'OPEN'));
  check('cooldown folds from the model breaker', cards.every((c) => effectiveCooldown(c) === 9000));
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
  check('orphan card attaches the model breaker for folding', pairCard.modelSnap === model && effectiveState(pairCard) === 'OPEN');
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall guardrails-matrix checks passed');
