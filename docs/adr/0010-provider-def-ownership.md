# ADR-0010: Provider Definition Ownership — the OCR Defs File, opencode.jsonc as a Materialization Target

## Status

Implemented — 2026-10-20 (stages: the defs store + one-shot jsonc port; the funnel swap across CRUD/boot/view; materialize-then-push sync with REPLACE semantics; the CLI hook rework). Amends the boot source in ADR-0005 §2(a).

## Decision

### 1. One truth per artifact class — connection defs join credentials

Provider CONNECTION definitions — id, name, npm wire package, baseURL, headers, env slots, canonical/body, node-static models — are owned by OCR in `<ocrHome>/custom-providers.json`, GLOBAL (not per-environment; same book as `credentials.json`, ADR-0007 file conventions). `opencode.jsonc` leaves the truth chain ENTIRELY: no console route, no boot path, no view may read or write it as truth. It is a MATERIALIZATION TARGET — a sync-client artifact the opencode adapter regenerates from the defs file, exactly as `opencode.db`/`auth.json` are for keys (ADR-0006). Hand-edited jsonc defs are not a source of anything; the §4 one-shot import is the only client→OCR def motion that will ever exist.

### 2. The file — a shape-preserving port of the jsonc providers node

`custom-providers.json`: `version: 1`, atomic temp+rename, shape = the CURRENT jsonc `providers` node verbatim (id → `{ name?, npm?, options: { baseURL?, headers? }, models?, env?, canonical?, body? }`). The node parser in `user-config.ts` (CURRENT shape only; `env:[VAR]` names materialize to `{env:X}` templates — boot-direct.ts:13,22 loads nodes through this one funnel) is UNCHANGED: boot-direct and the console routes swap the loader's SOURCE, not the grammar. Boundary with the catalog layer: node-static models ride the def (as today's jsonc nodes do); pulled/overlaid models stay in `catalog/custom.json` (add-only overlay, untouched — the custom-store.ts:12-14 precedence survives as-is).

### 3. Boot pool — same three sources, new (a)

ADR-0005 §2 restates as: (a) `custom-providers.json` provider nodes, (b) the boot-bound credential chain (ADR-0006), (c) the catalog. Failure doctrine unchanged: an unroutable provider is EXCLUDED and reported, never a boot abort; an unreadable defs file is a loud degraded badge (the credential-store doctrine, mirrored). The pool stays boot-scoped (ADR-0005 §1 — no pool-rebuild endpoint appears).

### 4. One-shot migration

At boot, marker-absent and jsonc `providers` non-empty ⇒ import verbatim into the defs file (idempotent: whole-node upsert by id), record the completion marker in the `credential-store.json` ledger (the standalone-import pattern, factory.ts). jsonc stays BYTE-IDENTICAL on disk (never delete an upstream artifact — cp-dataloss doctrine), so a v2 CLI keeps its pre-migration view until sync materializes fresher defs. Import failure = loud degraded state, marker withheld, retried next boot.

### 5. Sync contract — keys AND defs, write-only

The opencode v2 client's write direction materializes BOTH artifact classes: keys (existing `pushOcrIntoV2`) and defs — render the defs file into jsonc's `providers` node via the comment-preserving jsonc writer, then `POST /api/location/reload` so a running service registers the ids (the reload self-heal in `resolveIntegrationId` survives unchanged). The v2 writable gate (`declaredProviderIds`) consults the DEFS FILE, not jsonc. Read direction stays credentials-only — defs NEVER flow client→OCR. v1 client: keys only, no defs (legacy degraded face; no def-rewrite surface).

### 6. Console + UI de-opencode-ization

Provider CRUD rewrites onto the defs store (`upsertCustomProvider`/`getProviderNodeById` become defs-file operations). The connected view = defs file ∪ bound-store credentials; grid order reads defs-file sequence (jsonc order dies with the coupling). The page retitles to "Provider Management"; `opencode.jsonc` appears only inside the sync-client panel. The catalog needs no de-coupling — models.dev is fetched directly (sources/models-dev.ts), no opencode involvement. The same connected union governs the catalog aggregation (model list): each aggregated provider's `connected` ORs in bound-store credential presence (and the credentials file mtime joins the aggregation signature, so key add/remove rebuilds without a restart). The aggregation reads the defs file ONLY — the frozen auth.json snapshot feeds no view; its sole remaining readers are the credentials layer's one-shot import and v1 sync client.

## Consequences

- A client that never syncs sees nothing new BY DESIGN: the old "instantly shared through jsonc" coupling is the thing being removed. Post-migration, a v2 CLI keeps its imported (byte-identical) defs until write-sync materializes updates.
- Truth-per-class is now uniform: `credentials.json` (keys) · `custom-providers.json` (connection defs) · `catalog/*` (models+pricing) · `opencode.jsonc` (client copy). Every "stored in X" claim on the console maps to exactly one owner file.
- Cleanup contract: `rg "upsertCustomProvider|getProviderNodeById|opencode\.jsonc" backend/src frontend/src` must reduce to the sync adapter's materialization path, the migration's read-once path, and sync-panel i18n strings. The provider-def-opencode-v2-write-routes.test.ts family rewrites onto the defs store; boot-direct tests re-seed defs files instead of jsonc.
