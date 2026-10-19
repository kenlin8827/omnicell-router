/**
 * Unified provider/model catalog — normalized across sources.
 *
 * Data shapes are aligned 1:1 with the OpenCode / models.dev standard metadata
 * schema (snake_case): models carry `tool_call`, `limit{context,output}`,
 * `cost{input,output,cache_read,cache_write}`, `attachment`, `temperature`,
 * `modalities` — so normalizer output is near-identity and writing definitions
 * into the defs file needs no reshaping. Pricing/cost unit: USD per 1M tokens
 * (models.dev `cost` is already $/1M; OpenRouter is converted at the source).
 */

import type { ReasoningEffort } from '../../types/router.js';

export type CatalogSourceId =
  | 'opencode'
  | 'models-dev'
  | 'openrouter'
  | 'openai-compatible'
  | 'config'
  | 'custom'
  | 'mapped'
  | 'service';

export interface CatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogLimit {
  context?: number;
  /** max INPUT tokens (models.dev `limit.input`) — prompt-side cap, distinct from context */
  input?: number;
  output?: number;
}

export interface CatalogModalities {
  input?: string[];
  output?: string[];
}

/** One models.dev `reasoning_options` entry — loose shape, tolerant of upstream schema drift. */
export interface CatalogReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  [k: string]: unknown;
}

export interface CatalogModel {
  id: string;
  name?: string;
  /**
   * Model-level AI-SDK package override (models.dev `model.provider.npm`).
   * Beats the provider-level npm when present — e.g. opencode(Zen) is
   * `@ai-sdk/openai-compatible` overall, but `gpt-6-luna` carries
   * `@ai-sdk/openai`, i.e. Responses-API-only, and Zen rejects it on the
   * chat/completions wire with `ModelProtocolUnsupported`.
   */
  npm?: string;
  /** Model-default thinking level (OCR extension — pinned when the client omits `reasoning_effort`). */
  defaultEffort?: ReasoningEffort;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  /**
   * Hidden from the model catalog — kept in the aggregate (the catalog viewer
   * still lists it) but excluded from the boot-direct routing pool, so
   * `/v1/models` omits it and nothing can be pinned to it. Written by the
   * overrides layer (`OverrideEntry.disabled`) and, for hand-written configs,
   * carried over from a def-level `disabled` flag.
   */
  disabled?: boolean;
  /**
   * models.dev `reasoning_options` — the model's real reasoning-tier declaration,
   * kept verbatim (the shape varies per vendor): `{type:'effort', values:[...]}`
   * = exact tier table / `{type:'budget_tokens', min}` = continuous budget /
   * `{type:'toggle'}` = on-off only. boot-direct derives
   * supportedReasoningEfforts from this instead of assuming "boolean expands
   * into the full ladder".
   */
  reasoningOptions?: CatalogReasoningOption[];
  /**
   * Named thinking-level variants (def shape `{id, settings{reasoningEffort}}`,
   * routable as sibling `<id>-<variant>` ids and via `#variant` syntax).
   * Sourced values never carry it; overrides.json materializes it.
   */
  variants?: { id: string; settings?: { reasoningEffort?: string } }[];
  /** interleaved thinking output field (models.dev `interleaved.field`, e.g. 'reasoning_content') */
  interleaved?: { field?: string };
  /** structured/JSON output support (models.dev `structured_output`) */
  structured_output?: boolean;
  /** model lifecycle: 'deprecated' | 'beta' | 'alpha' (models.dev `status`) */
  status?: string;
  // ── passthrough display metadata (non-routing; kept verbatim for UI/future consumers) ──
  description?: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  knowledge?: string;
  canonical_model_id?: string;
  /** models.dev `experimental` blob (e.g. { modes: { fast: { cost, provider } } }) — verbatim */
  experimental?: Record<string, unknown>;
  modalities?: CatalogModalities;
  cost?: CatalogCost;
  limit?: CatalogLimit;
  source: CatalogSourceId;
}

export interface CatalogProviderRecord {
  id: string;
  name?: string;
  /** models.dev logo asset (svg); frontend falls back to an initial-letter avatar on error */
  logo?: string;
  npm?: string;
  /** default API base from the catalog */
  api?: string;
  /** effective base URL override (defs-file definition wins, then live service) */
  baseURL?: string;
  doc?: string;
  env?: string[];
  /** defined in the defs file's providers map */
  custom: boolean;
  /** has a usable credential (auth.json entry or inline key) */
  connected: boolean;
  sources: CatalogSourceId[];
  models: CatalogModel[];
}

export interface CatalogSourceState<T> {
  fetchedAt: number;
  data: T;
}
