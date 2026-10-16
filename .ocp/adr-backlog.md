# ADR backlog — deferred decisions ledger

Protocol (user-authorized, permanent): during the quota build-out we do NOT
write/amend ADRs per-change. Every decision that alters externally observable
behavior or a contract gets ONE line here — commit SHA + one sentence + the
ADR(s) it will touch. P12 backfills all of them in one pass (0009 revisions +
new ADRs 0010+ + AGENTS.md references). The code-half of the cleanup contract
(comments / test titles / doc residue) is NOT deferred.

> NOTE 2026-10-15: this ledger was lost between sessions (never git-tracked;
> not found in `%TEMP%\opencode\stale-handoffs-20261015\`). Reconstructed from
> commit history at P0 closeout. Entries below are reconstructed, not original.

## Ledger

- `c36c98c` + `4b8ed5a` — quota tracking v1 built directly against ADR-0009 (8 declaration rows, MiniMax adapters x4, L-d operator DSL, trace attribution, badge states, QuotaPage). ADR already written — no backfill needed, record only. → ADR-0009 (as shipped)
- `6e91c42` — carry-over baseline: last-probe raw HTTP capture (memory-only side table `recordHttp`/`getLastHttp` + console inspect endpoint), i18n window-name codes (`nameCode`/`enumCode`/`argPath`), shared `ProviderLogo` chip, QuotaPage restructured as upstream-nav directory. → ADR-0009 (display/observability plane), ADR-0006 (credential identity usage unchanged)
- (pending) — zh-CN quota badge vocabulary recast from 探测/验证 framing to 同步/更新 framing (product copy only; badge STATE ids unchanged). → ADR-0009 zh-CN mirror wording
- `a90c9f9` — P1 L-a inference-header passive harvest live: `harvestInferenceRatelimit` wired at `registry.execute` central success site + native systemone decision leg; upstream `Headers` travel on a JSON-invisible symbol carrier (`attachUpstreamResponseHeaders`), so client wire stays clean; measured snapshots refuse overwrite of probed/forked/declared; health-prober & L2-judge legs incidentally harvest too (ACCEPTED — display-only plane, real evidence). → ADR-0009 (measured source / headers channel section)
- (2026-10-16, Lite session) — MANUAL SNAPSHOT channel REMOVED by operator order (commit e918c3d built it `quota/manual.ts` + 3 routes + paste dialog; the follow-up removal cut all of it: files deleted, routes/i18n keys/types stripped, E2E drill data already cleared — zero residue, typecheck+tests green). KEPT from e918c3d: refresh-route whole-schedule guard, quota-page re-arm button + toast, synced-first sort. Cookie-class providers (xiaomi/MiMo, bailian console, longcat, sakana, …) currently have NO OCR display surface — console viewing only; if the P7/P8 session revisits this, coordinate BEFORE rebuilding: the operator just declined the paste UX.
- (2026-10-16, Lite session) — moonshotai + moonshotai-cn DSL rows RE-LANDED (static credit-pool Balance windows, G2 rows verified in the now-retired candidate ledger — purged from history 2026-10-16 per operator) — built-in coverage 12 -> 14; and the OCR-anchored quota sweep ran over 19 plan-variant ids (bucketed: covered / negative / unsearched-next-batches / P10-subscription / P7-cloud-sign / harvest-gate / redline; results kept in this ledger's next entries and the P5 batches). openai billing-shim pair NOT re-landed: it needs the folk-provenance streak machinery (P2's engine work, lost in the 01:31 reset) — owned by the active P9/P5 session, do not double-build.
