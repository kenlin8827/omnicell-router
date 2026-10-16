# Quota fullscope v6 — execution todos (handoff: quota-fullscope-kickoff.md)

## P0 Baseline (pre-P1 housekeeping)
- [done] Survey dirty tree → baseline committed `6e91c42`; P0 closeout verified 2026-10-15 23:5x local: typecheck green, `bun run test` 1514 pass/0 fail/110 files, CJK residue clean (allowlist only). Tail residue committed separately (zh-CN wording). adr-backlog.md was LOST between sessions → reconstructed at P0 closeout (now committed).
- [next] → moved into P1 batch (done in `a90c9f9`): nameCode/enumCode/argPath (dsl), recordHttp/getLastHttp + putMeasured precedence (store), engine http capture — quota-harvest.test.ts new (24), +42 tests total

## P1 L-a header harvest (zero probe calls) — DONE `a90c9f9`
- [x] Read ADR-0008 §5 capture plane (ratelimit trio) + ExecutionTrace.accountKeyHashPrefix plumbing
- [x] Passive QuotaSnapshot(source=measured) from inference responses; source:headers channel live (registry.execute central site + native systemone leg; symbol carrier)
- [x] Tests: fixture-driven, badge migration measured→stale etc.
- [open] Frontend display gaps (reported by node-dev, NOT yet done — held back because a parallel session is editing QuotaPage/i18n right now): no vocabulary for source=measured (badge renders identical to probed), entryId 'headers' raw mono text, new nameCodes requests/tokens/inputTokens/outputTokens/rateLimit missing from quotaPage.wn.* → zh page shows English.
- [P9 queue] From P1 review P2s: inline `15*60_000` literals in declarations.ts/engine.ts/prober.ts converge to MEASURED_TTL_MS; per-turn putMeasured→scheduleSave write density (skip write when window content unchanged); bare-float-seconds legacy reset shape (needs parseResetTime widening — ripples all DSL resetAt); streaming legs must attach the header carrier when real upstream streaming ships (createStream currently has zero callers).

## P2 billing-shim fallback family (built-in declarations, /v1/dashboard/billing/*)
## P3 local ledger aggregation (pair usage GROUP BY, no-endpoint providers fallback view)
## P4 candidate ledger + cooldown alignment (candidate ledger retired 2026-10-16 — purged from history per operator; research context lives in the P5/P6/P10 batch lines below, quota-bar utility import, quota_events trip→cooldown)
## P5 batch ingestion (G2/G3 per batch; bailian→dashscope; volcengine→P7 if AK/SK)
## P6 self-hosted gateway family presets (L-d family templates + console one-click)
## P7 AK/SK cloud-sign family (design-first, adr-backlog entry, approval gate)
## P8 manual snapshot (console JSON paste → source=manual TTL)
## P9 unified model audit (converge parallel shapes into single QuotaSnapshot read/write path)
## P10 C3 OAuth subscription face (design sub-phases a-d, risk list to user first)
## P11 soft gating — NOT scheduled (needs separate user approval)
## P12 wrap-up (ADR backfill per adr-backlog, AGENTS.md refs, e2e, doc-half cleanup sweep)
