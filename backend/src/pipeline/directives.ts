import type { CacheBreakpoint, ContentPart, InputItem, Role } from '../ir/types.js';
import { EFFORT_LADDER, ReasoningEffort, TierLevel, TIER_RANK, downgradeReasoning } from '../types/router.js';
import { DEFAULT_DIRECTIVE_PREFIX } from '../config/defaults.js';

/**
 * Control directives — the EXPLICIT escalation surface that replaced the
 * heuristic repeated-prompt ladder. Two independent contracts:
 *
 * SCRUB (unconditional while enabled, every request): every reserved token is
 * removed from EVERY message of EVERY role (system / developer / user /
 * assistant / tool, text parts included). The upstream-facing payload must be
 * byte-equivalent to the one a client would send if it had never typed a
 * directive, so the prefix cache stays stable across turns and no reserved word
 * ever reaches a vendor. Unknown tokens are scrubbed too (a typo must not
 * leak), and are reported for the operator ledger.
 *
 * APPLY (positional, stateless): only the LAST client-authored `user` message
 * may carry an actionable directive, and it acts on THAT turn only. Clients
 * resend the whole history every turn, so applying effects from earlier
 * messages would re-escalate the session on every request. Position-only
 * effectiveness is what makes repeat sends idempotent.
 *
 * PREFIX: the namespace is CONFIGURABLE (`directives.prefix`, default `@ocr-`)
 * because 'ocr' is a common industry acronym — an OCR-domain prompt may
 * legitimately contain `@ocr-pipeline`, and a reserved namespace must be
 * relocatable without a code change. Tokens are `<prefix><suffix>`, so the
 * prefix carries its own trailing separator (`-`, `_`, `.` or `:`).
 *
 * Overlays never touch the session ratchet: a tier step here is a per-turn
 * override (turn scope). Downgrades are legal ONLY through these directives —
 * no automatic mechanism (L0 rules / experience table / L2) ever steps down.
 *
 * Prompt injection note: tool results and assistant text are scrubbed but
 * NEVER effective — otherwise a fetched web page could force tier upgrades
 * (cost amplification).
 */

const TIER_LEVELS: readonly TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/**
 * Two forms per axis, one suffix each (`<prefix><suffix>`):
 *   STEP  `tier-up` / `tier-down` / `effort-up` / `effort-down` — one rung,
 *         relative to what the turn would otherwise have served.
 *   PIN   `tier-<lite|plus|pro|ultra>` / `effort-<none|low|…|max>` — name the
 *         exact level for this turn. This is the manual override the ceiling
 *         makes necessary: the session ratchet caps AUTOMATIC escalation, so
 *         "I know I want ultra, now" must be expressible in one token instead
 *         of counting `-up` presses.
 *
 * One content-level form outside the axes:
 *   `continue` — NO tier/effort effect at all. Its whole semantics are the
 *         scrub plus the directive-only drop: alone on the last user message
 *         the turn continues the previous assistant reply at the unchanged
 *         level. Exists so "just keep going" is expressible without borrowing
 *         an axis token's side effect.
 *
 * The pinned payload is carried inside the action string (`tier_set:ultra`),
 * so both forms flow through the same array and every consumer stays total.
 */
export type DirectiveAction =
  | 'tier_up'
  | 'tier_down'
  | 'effort_up'
  | 'effort_down'
  | 'continue'
  | `tier_set:${TierLevel}`
  | `effort_set:${ReasoningEffort}`;

export const DIRECTIVE_STEP_SUFFIXES = ['tier-up', 'tier-down', 'effort-up', 'effort-down'] as const;

/** Every suffix the namespace reserves: 4 steps + continue + 4 tier pins + 6 effort pins. */
export function directiveSuffixes(): string[] {
  return [
    ...DIRECTIVE_STEP_SUFFIXES,
    'continue',
    ...TIER_LEVELS.map((t) => `tier-${t}`),
    ...EFFORT_LADDER.map((e) => `effort-${e}`),
  ];
}

const ACTION_OF_SUFFIX: Record<string, DirectiveAction> = {
  'tier-up': 'tier_up',
  'tier-down': 'tier_down',
  'effort-up': 'effort_up',
  'effort-down': 'effort_down',
  'continue': 'continue',
};

/** Suffix → action, steps first, then pins; `undefined` = unknown token. */
function actionOfSuffix(suffix: string): DirectiveAction | undefined {
  const step = ACTION_OF_SUFFIX[suffix];
  if (step) return step;
  if (suffix.startsWith('tier-')) {
    const level = suffix.slice('tier-'.length);
    if ((TIER_LEVELS as readonly string[]).includes(level)) return `tier_set:${level}` as DirectiveAction;
    return undefined;
  }
  if (suffix.startsWith('effort-')) {
    const level = suffix.slice('effort-'.length);
    if ((EFFORT_LADDER as readonly string[]).includes(level)) return `effort_set:${level}` as DirectiveAction;
  }
  return undefined;
}

/**
 * Validate/normalize an operator-configured prefix. Anything unusable falls
 * back to the default — a bad value must never widen or narrow the reserved
 * namespace silently. Shape: `@` + a short slug + a trailing separator
 * (`-`, `_`, `.` or `:`), lower-case, so `<prefix><suffix>` stays unambiguous.
 */
export function resolveDirectivePrefix(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_DIRECTIVE_PREFIX;
  const p = raw.trim().toLowerCase();
  if (p.length < 3 || p.length > 32) return DEFAULT_DIRECTIVE_PREFIX;
  if (!/^@[a-z0-9][a-z0-9._:-]*$/.test(p)) return DEFAULT_DIRECTIVE_PREFIX;
  if (!/[-._:]$/.test(p)) return DEFAULT_DIRECTIVE_PREFIX;
  return p;
}

/** The whole reserved vocabulary for a (normalized) prefix — docs, UI and tests. */
export function directiveTokens(prefix: string = DEFAULT_DIRECTIVE_PREFIX): string[] {
  const p = resolveDirectivePrefix(prefix);
  return directiveSuffixes().map((suffix) => `${p}${suffix}`);
}

interface PrefixRegexes {
  /** Non-global probe: "does this text mention the namespace at all?". */
  probe: RegExp;
  /** Global scan: one match per reserved token (known or not). */
  scan: RegExp;
}

const REGEX_CACHE = new Map<string, PrefixRegexes>();

/**
 * Both regexes carry a word-character left boundary: ordinary prose that merely
 * CONTAINS the substring (the e-mail `alice@ocr-corp.com`, a handle in a code
 * block) stays outside the namespace — scrubbing must never rewrite user
 * content that did not address the gateway.
 */
function regexesFor(prefix: string): PrefixRegexes {
  const cached = REGEX_CACHE.get(prefix);
  if (cached) return cached;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?<![A-Za-z0-9])';
  const built: PrefixRegexes = {
    probe: new RegExp(`${boundary}${escaped}`, 'i'),
    scan: new RegExp(`${boundary}${escaped}[a-z0-9_-]+`, 'gi'),
  };
  // Bounded: only hand-edited configs can grow this, and clearing is cheap.
  if (REGEX_CACHE.size > 16) REGEX_CACHE.clear();
  REGEX_CACHE.set(prefix, built);
  return built;
}

export interface DirectiveHit {
  token: string;
  action: DirectiveAction;
  /** Index in the ORIGINAL input array (survives item drops). */
  messageIndex: number;
  role: Role | 'tool';
}

export interface UnknownDirective {
  token: string;
  messageIndex: number;
  role: Role | 'tool';
}

export interface DirectiveScan {
  input: InputItem[];
  instructions?: string;
  prefix?: string;
  active: boolean;
  effective: DirectiveHit[];
  all: DirectiveHit[];
  unknown: UnknownDirective[];
  droppedMessages: number;
  lastUserDropped: boolean;
}

/**
 * Strip every reserved token from one text block. A line that becomes blank
 * ONLY because of the removal is dropped entirely.
 */
function scrubText(text: string, regexes: PrefixRegexes, onHit: (token: string) => void): string {
  if (!regexes.probe.test(text)) return text;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (!regexes.probe.test(line)) {
      kept.push(line);
      continue;
    }
    const replaced = line.replace(regexes.scan, (token: string) => { onHit(token); return ''; });
    const tidied = replaced.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '').trimStart();
    if (tidied.trim() !== '') kept.push(tidied);
  }
  return kept.join('\n');
}

function canCarryCache(
  part: ContentPart | undefined,
): part is Exclude<ContentPart, { type: 'refusal' | 'extension' }> {
  return Boolean(part && part.type !== 'refusal' && part.type !== 'extension');
}

function scrubParts(
  content: ContentPart[],
  regexes: PrefixRegexes,
  onHit: (token: string) => void,
): ContentPart[] {
  let changed = false;
  const next: ContentPart[] = [];
  let pendingCache: CacheBreakpoint | undefined;
  for (const part of content) {
    let current = part;
    if (part.type === 'text' && regexes.probe.test(part.text)) {
      const text = scrubText(part.text, regexes, onHit);
      if (text !== part.text) {
        changed = true;
        current = { ...part, text };
      }
    }
    if (current.type === 'text' && current.text.trim() === '') {
      changed = true;
      if (current.cache) {
        const prev = next[next.length - 1];
        if (canCarryCache(prev) && !prev.cache) {
          next[next.length - 1] = { ...prev, cache: current.cache };
        } else if (!pendingCache) {
          pendingCache = current.cache;
        }
      }
      continue;
    }
    if (pendingCache && canCarryCache(current) && !current.cache) {
      current = { ...current, cache: pendingCache };
      pendingCache = undefined;
    }
    next.push(current);
  }
  return changed || next.length !== content.length ? next : content;
}

/** Pure one-pass scrub over canonical messages, tool results, and optional instructions. */
export function scanDirectives(
  input: readonly InputItem[],
  prefix: string | null = DEFAULT_DIRECTIVE_PREFIX,
  instructions?: string,
): DirectiveScan {
  if (prefix === null) {
    return {
      input: [...input],
      ...(instructions !== undefined ? { instructions } : {}),
      active: false, effective: [], all: [], unknown: [],
      droppedMessages: 0, lastUserDropped: false,
    };
  }
  const namespace = resolveDirectivePrefix(prefix);
  const regexes = regexesFor(namespace);
  const all: DirectiveHit[] = [];
  const unknown: UnknownDirective[] = [];
  let scrubbedInstructions = instructions;
  if (instructions !== undefined && regexes.probe.test(instructions)) {
    const onInstructionHit = (token: string): void => {
      const lower = token.toLowerCase();
      const action = actionOfSuffix(lower.slice(namespace.length));
      if (action) all.push({ token: lower, action, messageIndex: -1, role: 'system' });
      else unknown.push({ token: lower, messageIndex: -1, role: 'system' });
    };
    scrubbedInstructions = scrubText(instructions, regexes, onInstructionHit);
  }
  const scrubbed: InputItem[] = [];
  let lastUserIndex = -1;
  for (let index = 0; index < input.length; index++) {
    const item = input[index]!;
    if (item.type === 'message' && item.role === 'user') lastUserIndex = index;
  }
  let droppedMessages = 0;
  const droppedIndices: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index]!;
    if (item.type !== 'message' && item.type !== 'tool_result') {
      scrubbed.push(item);
      continue;
    }
    if (!item.content.some((part) => part.type === 'text' && regexes.probe.test(part.text))) {
      scrubbed.push(item);
      continue;
    }
    const role: Role | 'tool' = item.type === 'tool_result' ? 'tool' : item.role;
    const onHit = (token: string): void => {
      const lower = token.toLowerCase();
      const action = actionOfSuffix(lower.slice(namespace.length));
      if (action) all.push({ token: lower, action, messageIndex: index, role });
      else unknown.push({ token: lower, messageIndex: index, role });
    };
    const next = { ...item, content: scrubParts(item.content, regexes, onHit) };
    if (next.type === 'message' && next.role === 'user' && next.content.length === 0) {
      droppedMessages += 1;
      droppedIndices.push(index);
      continue;
    }
    scrubbed.push(next);
  }
  const effective = all.filter((hit) => hit.messageIndex === lastUserIndex && hit.role === 'user');
  return {
    input: scrubbed,
    ...(scrubbedInstructions !== undefined ? { instructions: scrubbedInstructions } : {}),
    prefix: namespace, active: true, effective, all, unknown, droppedMessages,
    lastUserDropped: lastUserIndex >= 0 && droppedIndices.includes(lastUserIndex),
  };
}

/**
 * Scrub a parsed JSON wire body without changing its protocol envelope.
 * Capture uses this projection so the archive keeps the client's own fields
 * while reserved tokens still cannot reach disk. Objects and arrays are
 * copied only when a descendant changes; the execution request is untouched.
 */
export function scrubWireDirectives<T>(value: T, prefix: string | null = DEFAULT_DIRECTIVE_PREFIX): T {
  if (prefix === null) return value;
  const regexes = regexesFor(resolveDirectivePrefix(prefix));
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return scrubText(current, regexes, () => {});
    if (Array.isArray(current)) {
      let changed = false;
      const next = current.map((entry) => {
        const scrubbed = visit(entry);
        if (scrubbed !== entry) changed = true;
        return scrubbed;
      });
      return changed ? next : current;
    }
    if (current && typeof current === 'object') {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        const scrubbed = visit(entry);
        next[key] = scrubbed;
        if (scrubbed !== entry) changed = true;
      }
      return changed ? next : current;
    }
    return current;
  };
  return visit(value) as T;
}

/** Net signed SUM of one axis's tokens: each up counts +1, each down counts -1. */
function netDelta(actions: readonly DirectiveAction[], axis: 'tier' | 'effort'): number {
  let delta = 0;
  for (const action of actions) {
    if (axis === 'tier') {
      if (action === 'tier_up') delta += 1;
      else if (action === 'tier_down') delta -= 1;
    } else if (action === 'effort_up') delta += 1;
    else if (action === 'effort_down') delta -= 1;
  }
  return delta;
}

/** Last PIN on one axis (last one wins; steps on that axis are then ignored). */
function lastPin(actions: readonly DirectiveAction[], axis: 'tier' | 'effort'): string | undefined {
  const prefix = `${axis}_set:`;
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].startsWith(prefix)) return actions[i].slice(prefix.length);
  }
  return undefined;
}

/** How many STEP tokens on one axis were outranked by a pin on the same axis. */
function stepCount(actions: readonly DirectiveAction[], axis: 'tier' | 'effort'): number {
  const up = `${axis}_up`;
  const down = `${axis}_down`;
  return actions.filter((a) => a === up || a === down).length;
}

const TIER_BY_RANK: Record<number, TierLevel> = Object.fromEntries(
  (Object.keys(TIER_RANK) as TierLevel[]).map((t) => [TIER_RANK[t], t])
) as Record<number, TierLevel>;

const MIN_TIER_RANK = 1; // lite
const MAX_TIER_RANK = 4; // ultra
const MAX_EFFORT_RANK = EFFORT_LADDER.length - 1; // max

export interface TierDirectiveResult {
  tier: TierLevel;
  /** Net requested step (-2...+2); 0 for a pin or when no step is present. */
  delta: number;
  changed: boolean;
  /** True when the requested step ran past lite/ultra and was clipped. */
  clamped: boolean;
  /** True when this axis carried a directive at all (pin or non-zero step). */
  applied: boolean;
  /** True when the axis was PINNED to an absolute level. */
  pinned: boolean;
  /** Direction relative to the baseline ('none' when the level is unchanged). */
  direction: 'up' | 'down' | 'none';
  /** Suffix that won, for reason strings (`tier-up`, `tier-ultra`). */
  suffix?: string;
  /** STEP tokens outranked by a pin on this axis (ledgered, never silent). */
  ignoredSteps: number;
}

/**
 * Per-turn tier overlay. Applied AFTER the session ratchet (the ratchet must
 * never see it, so the session ceiling and pin stay untouched) - which is
 * exactly why a PIN is worth having: the ratchet bounds AUTOMATIC escalation,
 * so reaching a specific level has to be expressible without counting presses.
 *
 * A pin is a manual override, so it may point BELOW the automatic decision -
 * that is an explicit downgrade (ADR-0011 section 6 allows those only on user
 * instruction), ledgered with its direction. When a pin and steps share an
 * axis, the LAST pin wins and the steps are reported as ignored.
 */
export function applyTierDirectives(actions: readonly DirectiveAction[], baseTier: TierLevel): TierDirectiveResult {
  const pin = lastPin(actions, 'tier');
  const baseRank = TIER_RANK[baseTier] ?? 2;
  if (pin) {
    const tier = pin as TierLevel;
    const rank = TIER_RANK[tier] ?? baseRank;
    return {
      tier,
      delta: 0,
      changed: tier !== baseTier,
      clamped: false,
      applied: true,
      pinned: true,
      direction: rank > baseRank ? 'up' : rank < baseRank ? 'down' : 'none',
      suffix: `tier-${tier}`,
      ignoredSteps: stepCount(actions, 'tier'),
    };
  }
  const delta = netDelta(actions, 'tier');
  if (delta === 0) {
    return {
      tier: baseTier,
      delta: 0,
      changed: false,
      clamped: false,
      applied: false,
      pinned: false,
      direction: 'none',
      ignoredSteps: 0,
    };
  }
  const requested = baseRank + delta;
  const rank = Math.min(MAX_TIER_RANK, Math.max(MIN_TIER_RANK, requested));
  const tier = TIER_BY_RANK[rank] ?? baseTier;
  return {
    tier,
    delta,
    changed: tier !== baseTier,
    clamped: rank !== requested,
    applied: true,
    pinned: false,
    direction: tier === baseTier ? 'none' : delta > 0 ? 'up' : 'down',
    suffix: delta > 0 ? 'tier-up' : 'tier-down',
    ignoredSteps: 0,
  };
}

export interface EffortDirectiveResult {
  effort: ReasoningEffort | undefined;
  delta: number;
  changed: boolean;
  /** True when the ladder ends, a pin's capability gap, or an empty set clipped it. */
  clamped: boolean;
  applied: boolean;
  pinned: boolean;
  direction: 'up' | 'down' | 'none';
  suffix?: string;
  ignoredSteps: number;
}

/**
 * Per-turn effort overlay on top of the effective baseline - whatever ask is in
 * play when the directive is applied (client value -> entry/L2 injection ->
 * model `defaultEffort`). The STEP form is relative to what the turn would
 * otherwise have served, mirroring the tier axis; the PIN form names the exact
 * level.
 *
 * Capability handling for STEP is deliberately NOT the generic
 * degraded-or-equal clamp:
 *
 *   - UP - the model's supported set is treated as the servable RANGE
 *     `[min(supported), max(supported)]`. A rung inside that range is served
 *     verbatim (a sparse ladder such as ['low','high'] still serves 'medium':
 *     the model has rungs on both sides, so the level is meaningful to it);
 *     a rung above the range clips to its ceiling; a rung BELOW the range keeps
 *     the baseline instead of falling into a downgrade (an up-ask must never
 *     serve less thinking than it started with - ADR-0003 honesty rule).
 *   - DOWN - plain degraded-or-equal: the highest supported level at/below the
 *     ask. Downward over-shoot is legal there (the promise is only "never
 *     ABOVE what was asked").
 *
 * A PIN is capability-clamped the way a client's explicit field is
 * (degraded-or-equal, honestly reported as `clamped`), because a pin is an
 * absolute ask, not a direction. A model declaring an explicit EMPTY support
 * set makes effort directives a no-op; a model declaring neither support field
 * still gets the raised ask, which the executor then honestly degrades
 * (`reasoningDegraded`).
 */
export function applyEffortDirectives(
  actions: readonly DirectiveAction[],
  baseEffort: ReasoningEffort | undefined,
  supportedEfforts?: readonly ReasoningEffort[],
  /** The model's vendor forbids thinking-off (ADR-0035). A step or pin that
   *  cannot land at-or-above a declared rung serves the LOWEST declared rung
   *  rather than the `none` this model cannot answer. */
  alwaysThink = false
): EffortDirectiveResult {
  const supportedEmpty = !!supportedEfforts && supportedEfforts.length === 0;
  const noop = (delta: number, pinned: boolean, suffix?: string): EffortDirectiveResult => ({
    effort: baseEffort,
    delta,
    changed: false,
    clamped: true,
    applied: true,
    pinned,
    direction: 'none',
    suffix,
    ignoredSteps: stepCount(actions, 'effort'),
  });

  const pin = lastPin(actions, 'effort');
  if (pin) {
    const target = pin as ReasoningEffort;
    const suffix = `effort-${target}`;
    if (supportedEmpty) return noop(0, true, suffix);
    const served = downgradeReasoning(target, supportedEfforts, alwaysThink);
    const baseRank = baseEffort === undefined ? -1 : EFFORT_LADDER.indexOf(baseEffort);
    const servedRank = EFFORT_LADDER.indexOf(served);
    return {
      effort: served,
      delta: 0,
      changed: served !== baseEffort,
      clamped: served !== target,
      applied: true,
      pinned: true,
      direction: servedRank === baseRank ? 'none' : servedRank > baseRank ? 'up' : 'down',
      suffix,
      ignoredSteps: stepCount(actions, 'effort'),
    };
  }

  const delta = netDelta(actions, 'effort');
  if (delta === 0) {
    return {
      effort: baseEffort,
      delta: 0,
      changed: false,
      clamped: false,
      applied: false,
      pinned: false,
      direction: 'none',
      ignoredSteps: 0,
    };
  }
  // No effort in play and the directive asks to go DOWN - there is nothing
  // below "unspecified", and injecting an explicit 'none' would change the
  // wire for no gain.
  if (baseEffort === undefined && delta < 0) return noop(delta, false);
  // A model with no explicit effort control cannot serve any step.
  if (supportedEmpty) return noop(delta, false);
  const baseRank = baseEffort === undefined ? 0 : EFFORT_LADDER.indexOf(baseEffort);
  const requestedRank = baseRank + delta;
  const candidate = EFFORT_LADDER[Math.min(MAX_EFFORT_RANK, Math.max(0, requestedRank))];

  if (delta > 0 && supportedEfforts && supportedEfforts.length > 0) {
    const ranks = supportedEfforts
      .map((e) => EFFORT_LADDER.indexOf(e))
      .filter((r) => r >= 0)
      .sort((a, b) => a - b);
    const minRank = ranks[0];
    const maxRank = ranks[ranks.length - 1];
    // Below everything the model can do: keep the baseline rather than letting
    // a "think more" ask collapse to 'none'.
    if (requestedRank < minRank) return noop(delta, false);
    const served = EFFORT_LADDER[Math.min(requestedRank, maxRank)];
    return {
      effort: served,
      delta,
      changed: served !== baseEffort,
      clamped: served !== candidate,
      applied: true,
      pinned: false,
      direction: served === baseEffort ? 'none' : 'up',
      suffix: 'effort-up',
      ignoredSteps: 0,
    };
  }

  const served = downgradeReasoning(candidate, supportedEfforts, alwaysThink);
  return {
    effort: served,
    delta,
    changed: served !== baseEffort,
    clamped: served !== candidate || requestedRank < 0 || requestedRank > MAX_EFFORT_RANK,
    applied: true,
    pinned: false,
    direction: served === baseEffort ? 'none' : delta > 0 ? 'up' : 'down',
    suffix: delta > 0 ? 'effort-up' : 'effort-down',
    ignoredSteps: 0,
  };
}
