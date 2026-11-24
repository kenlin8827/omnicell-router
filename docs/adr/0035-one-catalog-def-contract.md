# ADR-0035 — One Catalog-Def Contract For Every Model-Service Plugin

- Status: Accepted (implemented)
- Date: 2026-11-21

## Context

A model-service plugin (`-models` half, ADR-0017) answers one question for the
gateway: *what is this vendor model?* The answer is a models.dev-shaped model def
written into `<ocrHome>/providers.json`, and the gateway reads it for routing,
capability badges, the effort ladder, and the console catalog. Each plugin used
to build that def by hand, in its own `xxxCatalogToDef`.

Two plugins, two answers, one of them wrong:

- `workbuddy-models` published `reasoningOptions` from the vendor's own effort
  table, and documented *why* a level-less `toggle` is unsafe.
- `qoder-models` wrote `reasoningOptions: [{type:'toggle'}]` for **every**
  reasoning model, justified in a comment as "the catalog publishes no tier
  table, and the gateway must never CLAIM a level ladder it has no evidence for".

That comment was false. The qoder catalog row carries the table:

```json
"thinking_config": {
  "disabled": {},
  "enabled": { "efforts": { "high": {"is_default": true}, "low": {}, "max": {} },
               "is_default": true }
}
```

The plugin dropped the field, wrote a toggle, and the toggle was worse than
nothing. `effortLadderFor` (`backend/src/providers/boot-direct.ts`) resolves a
level-less toggle to `[]`, and `downgradeReasoning` (`backend/src/types/router.ts`)
returns `candidates[0] ?? 'none'` — so **every** requested effort level collapsed
to `none`. A client asking GLM-5.4 for `high` silently got the cheapest depth.
On the models whose vendor forbids turning thinking off (`thinking_config` with
an `enabled` block and no `disabled` block), `none` is not merely cheapest but
rejected: HTTP 400, upstream code `1210`
(`该模型始终思考，不支持关闭思考；请使用 low、high 或 max` — "this model always
thinks and cannot turn thinking off; use low, high or max").

The failure was silent by construction: no client error on the models that
tolerate `none`, just a wrong depth and a wrong bill; a 400 only on the models
that refuse it. Nothing in the gateway could detect it, because the gateway was
told "this model has no explicit level control" and behaved correctly given that
lie.

## Decision

**1. One mapper, and no plugin hand-builds a def.** `toOcrDef` in
`backend/src/plugins/catalog-def.ts` turns a normalized `VendorCapabilities`
into the def the pull engine writes. Plugins translate their vendor's
vocabulary into `VendorCapabilities` and nothing else. A plugin that wants to
diverge must change the contract, where every other plugin and the shared test
suite see it.

**2. An effort table is the only level declaration.** `{type:'effort',values}`
is emitted from a declared table (or a single pinned gear, as a one-value
table). A bare `{type:'toggle'}` is emitted **only** when the vendor declares
on/off and no levels — that is the one case where it is true. A model whose
vendor forbids thinking-off is marked `disableable: false`, which withholds
`none` from its ladder so the router can never request it. The withholding is
absolute: even a contradictory vendor table whose only level is `none` yields
the boolean alone (no ladder), never a fallback that re-publishes the stripped
`none` — the fallback would re-open the exact refusal this rule exists to
prevent. The fact also travels ON the def as `reasoningDisableable: false`:
the boot ladder (`effortLadderFor`) and every routing resolution
(`modelSupportsEfforts`, the orchestrator clamps, the System One decision
pin) strip `none` from the resolved set — a bare reasoning boolean expands to
the full ladder INCLUDING `none`, so without the carried fact an always-think
model with no table would still be offered thinking-off and reproduce the
refusal. When such a model must serve a fixed choice and the ask sits BELOW its
declared floor, the serve lands on its lowest declared rung (`downgradeReasoning`
third argument), never on the `none` the vendor rejects — the flag is the ONLY
thing that may answer below an ask. Routing is exempt: an unreachable ask makes
the candidate SKIPPED there, because choosing a model is not a promise to serve
one. A vendor that says
"it reasons" and publishes no table yields the boolean alone: no invented
ladder, and no toggle that would erase the client's level.

**3. Nothing is invented.** `tool_call`, `temperature`, `structured_output`,
`limit.input` and `cost` are omitted unless the vendor declared them. A wrong
`true` makes the gateway send a parameter the upstream rejects; a wrong `false`
hides a capability the model has. `undefined` means "not stated" and stays
unstated.

**4. `attachment` and `modalities.input` are one fact, and the modality
vocabulary is the full models.dev one.** `text | image | audio | video | pdf`
for input, `text | image | audio` for output. `attachment` is the vision
boolean specifically, so a pdf-only row declares `modalities` without
`attachment`. A text-only row declares neither block — restating that text works
is not a capability claim.

**5. Vendor vocabulary OCR cannot express yet is kept verbatim under `vendor`.**
It is never read by routing; it exists so a later field can be promoted without
re-pulling every model.

**6. A declared table is re-ordered by the gateway's own ladder, never by the
vendor's key order.** Vendors publish `efforts` as an unordered OBJECT
(`{"high":…,"low":…,"max":…}`), so the key order carries no meaning. The mapper
sorts the kept values against `EFFORT_LADDER` before emitting them, because the
console renders the list verbatim and a `defaultEffort` read out of an
arbitrarily-ordered list appears to sit at the wrong end of the ladder.
`normalizeEfforts` also drops any level the gateway ladder cannot name, rather
than leaking an unroutable string into `supportedReasoningEfforts`.

## Who reads the def

The contract only earns its keep if the fields reach a consumer. The current
consumers of the fields the mapper emits:

| Def field | Consumer |
| --- | --- |
| `reasoningOptions` | `effortLadderFor` (`providers/boot-direct.ts`) → `downgradeReasoning` (`types/router.ts`) → the wire's effort parameter |
| `defaultEffort` | tier/entry effort defaults and the console's pre-selected level |
| `attachment` | console capability badge (`routes/console.ts`), `providers/virtual-meta.ts` |
| `modalities.input` | client agent assignment (`cli/clients/model-meta.ts`) |
| `limit` / `cost` | context headroom and the console's capability view (`providers/virtual-meta.ts`); `cost` also derives `pricing` and the cache-support hint (`providers/boot-direct.ts`). Price never decides tier membership |
| `disabled` | routing-pool exclusion |

The modality vocabulary is deliberately wider than its consumers: `audio`,
`video` and `pdf` have **no consumer today** (`model-meta.ts` inspects only
`image`). The contract is allowed to carry them so the day a plugin declares one
the fact is recorded rather than lost, but declaring them does **not** buy
admission control yet. Do not read the vocabulary's existence as a promise that
the capability is acted on.

## Consequences

- The rules are pinned in `backend/tests/plugins/catalog-def-contract.test.ts`,
  one `describe` per rule, run once for the shared mapper rather than
  re-implemented per plugin.
- `qoder-models` stops sending `reasoning_effort: 'none'` to models that refuse
  it, so the 400/1210 disappears at the source. Its `1210` replay
  (`effortClampTarget` / `clampThinkingOn` in `provider.ts`) is demoted to a
  safety net for an unmapped model or a newly-refusing upstream, not the
  primary defence. Both callers share one implementation: the stream loop and
  the console probe. The probe builds its body from the model's REAL def
  (`capabilities.reasoning` derived from the provider def, not a hardcoded
  `isReasoning: false`), so "Test" exercises the same wire the router does —
  a green probe means the inference path is green, and a red one is the real
  refusal rather than a probe-only artifact.
- Requested effort levels actually reach the wire again: a client asking for
  `high` gets `high`, and the console shows the vendor's real table.
- A future plugin cannot reintroduce the bug quietly: it has no def to build.
- `qoder-models`' `auto` / `fast` rows publish `is_reasoning: true` with
  `thinking_config: null` — routing aliases with no level declaration. They
  carry the boolean and no `reasoningOptions`, which is the honest answer and
  the documented boolean expansion, not a toggle.

## Alternatives rejected

- **Per-plugin mappers with a shared doc.** That is what existed; a doc did not
  stop the drift, because the drift was invisible until a bill or a 400 exposed
  it.
- **Have plugins import the mapper from the backend at runtime, types only.**
  Plugins are bundled self-contained (`pack.ts` inlines relative imports), so a
  relative runtime import is fine — but a plugin must not reach into arbitrary
  backend modules. `catalog-def.ts` is deliberately dependency-free apart from
  the `EFFORT_LADDER` constant it must agree with.
- **Infer the ladder by probing the vendor.** Probed live across 11 models × 7
  levels: the accepted set matches `thinking_config` exactly, and
  `reasoning_content` length is not a usable tier signal (GLM-5.4 returned
  exactly 1147 reasoning characters at every level). Probing would add a
  credential-bearing request per model to learn what the catalog already says.