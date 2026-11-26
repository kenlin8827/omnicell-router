/**
 * The `local` provider — one addressable namespace over every live local run.
 *
 * ADR-0038 §1. Two things are deliberately separated here:
 *
 *  - the PROVIDER carries protocol, auth posture and transport policy (one
 *    `openai-chat` executor, no credential, never proxied — loopback);
 *  - the ENDPOINT belongs to the MODEL, because a local server's port is
 *    allocated per launch and is explicitly not a contract (ADR-0037 §5).
 *
 * A provider instance is therefore fixed while the endpoint is not: this class
 * is a DECORATOR over the ordinary chat executor. It resolves the base for the
 * model being served, caches one inner executor per base (very few bases — one
 * per live run), and delegates. `dialBaseFor(model)` is the seam that already
 * existed on `LLMProvider`; the stock executors ignore its `model` argument,
 * which is exactly why a per-model endpoint needed a decorator and not a
 * rewrite.
 *
 * The stopped case is a STATE, not a connection failure (ADR-0038 §3): it is
 * answered before any dial with `local_run_inactive` (503), and the error is
 * marked `breakerExempt` so an operator's deliberate stop can never trip a
 * breaker and turn into a cooldown.
 */
import { OpenAIChatProvider } from '../providers/executors/openai-chat.js';
import type { CallCredential, LLMProvider, UpstreamEventContext } from '../providers/base.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../ir/types.js';
import type { ModelRegistration, ProviderConfig } from '../config/types.js';
import { activeRunFor, servedNameFor, type LocalRun } from './runner.js';
import { beginRequest, completeRequest, failRequest, markFirstDelta } from './run-stats.js';
import { launchableEngines } from './engines.js';
import { listInstalledModels, profileFor, readInstalledModels, type InstalledModel } from './model-store.js';

/** The reserved provider id. Core-owned: never in `providers.json`. */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * A base URL that is NEVER dialed. `ProviderConfig.baseUrl` must be a string and
 * the console shows it; port 0 is the honest spelling of "this provider has no
 * single endpoint" (RFC 3986 allows no default port, and nothing binds :0).
 */
export const LOCAL_BASE_SENTINEL = 'http://127.0.0.1:0/v1';

/** Registry id for one installed model: `local/<name>` when the operator named
 *  the record (ADR-0038 §7), else `local/<repo>/<file>`. The unnamed spelling
 *  carries more than one slash — accepted deliberately: the provider field is
 *  explicit everywhere, and a flattened id would collide across owners. */
export function localModelId(model: InstalledModel): string {
  const name = model.name?.trim();
  return `${LOCAL_PROVIDER_ID}/${name || model.id}`;
}

/**
 * Registry-side model id → the installed-model row id, or null. The tail is
 * resolved against the registry: an operator name maps to its record first,
 * then a literal row id. An unresolvable tail still comes back as the slice —
 * the registration only exists while the record does, so this path serves the
 * "registered but stopped" error, and a foreign id never reaches it.
 */
export function installedIdFromLocal(registryModelId: string): string | null {
  const prefix = `${LOCAL_PROVIDER_ID}/`;
  if (!registryModelId.startsWith(prefix)) return null;
  const slice = registryModelId.slice(prefix.length);
  const state = readInstalledModels();
  for (const row of Object.values(state)) {
    if (row.name !== undefined && row.name === slice) return row.id;
  }
  return slice;
}

/** Base URL of a live run, or null when nothing is serving that model. */
export function localBaseFor(installedId: string): { base: string; run: LocalRun } | null {
  const run = activeRunFor(installedId);
  if (!run || run.status !== 'ready') return null;
  // The engine always binds loopback (ADR-0038 §4), so the gateway dials the
  // recorded host directly. A record persisted before that rule can still say
  // `0.0.0.0`; dialing loopback for it is both correct and the only address
  // that is guaranteed to answer.
  const host = run.host === '0.0.0.0' ? '127.0.0.1' : run.host;
  return { base: `http://${host}:${run.port}${run.apiPath}`, run };
}

/**
 * Resolution failure that must never look like an upstream fault.
 * `breakerExempt` is read by the orchestrator's failure recording; `statusCode`
 * is what the surfaces turn into the client's answer.
 */
export class LocalRunInactiveError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'local_run_inactive';
  public readonly breakerExempt = true;
  public readonly modelId: string;

  constructor(modelId: string, run: LocalRun | null) {
    const installedId = installedIdFromLocal(modelId);
    const detail = run && run.status === 'starting'
      ? `it is still loading (run ${run.id}); retry when the run reports ready`
      : 'it is not running right now; start it from the Local Models run page (/local-run)';
    super(
      `local model '${modelId}'${installedId ? '' : ' (unregistered)'} cannot be reached — ${detail}. ` +
        'Local runs are started by the gateway, not dialed directly: a stopped run is a state, not a broken endpoint.'
    );
    this.name = 'LocalRunInactiveError';
    this.modelId = modelId;
  }
}

/** One cache entry per base URL — ports are reused, so this stays tiny. */
function innerFor(base: string): OpenAIChatProvider {
  const config: ProviderConfig = {
    name: LOCAL_PROVIDER_ID,
    type: 'openai-chat',
    baseUrl: base,
    // A local engine authenticates nothing. An empty key makes the executor
    // emit no Authorization header at all.
    apiKey: '',
  };
  return new OpenAIChatProvider(config);
}

/**
 * The decorator. Chat-only by construction: a local engine speaks the OpenAI
 * chat surface, which is what every local runtime ships.
 */
export class LocalDialProvider implements LLMProvider {
  public readonly name = LOCAL_PROVIDER_ID;
  private readonly cache = new Map<string, OpenAIChatProvider>();

  private baseline(model: ModelRegistration): string {
    const installedId = installedIdFromLocal(model.id);
    const resolved = installedId ? localBaseFor(installedId) : null;
    if (!resolved) {
      // Distinguish "registered but not running" from "not a local model at
      // all": the second is a bug in the caller, the first is an operator state.
      if (!installedId) throw new Error(`provider '${LOCAL_PROVIDER_ID}' cannot serve '${model.id}' (not a local model id)`);
      throw new LocalRunInactiveError(model.id, activeRunFor(installedId));
    }
    return resolved.base;
  }

  private innerAt(base: string): OpenAIChatProvider {
    let inner = this.cache.get(base);
    if (!inner) {
      inner = innerFor(base);
      this.cache.set(base, inner);
    }
    return inner;
  }

  dialBaseFor(model: ModelRegistration): string | undefined {
    try {
      return this.baseline(model);
    } catch {
      // Egress reporting must never throw — an unserved model has no dial.
      return undefined;
    }
  }

  supportsStreaming(): boolean {
    // Every local engine this console launches streams. Reporting a capability
    // must not depend on a live run: the router asks before the dial.
    return true;
  }

  async createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<CanonicalResponse> {
    // Accounting seam (ADR-0040 §2): this decorator is the one place that knows
    // WHICH run answers and what the request cost. The gauges are released in
    // `finally` so a throw can never leak an in-flight slot.
    const runId = this.runIdFor(model);
    const mark = beginRequest(runId);
    try {
      const response = await this.innerAt(this.baseline(model)).createCompletion(
        request,
        model,
        upstreamEventContext,
        credential
      );
      completeRequest(
        runId,
        mark,
        {
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          cachedInputTokens: response.usage?.cachedInputTokens,
        },
        { streamed: false }
      );
      return response;
    } catch (err) {
      failRequest(runId, mark, err);
      throw err;
    }
  }

  createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<AsyncIterable<StreamEvent>> {
    // Both legs feed ONE accounting plane (ADR-0040 §2): the stream path
    // observes the same usage carrier the buffered leg reads, as it passes
    // through. The wrapper is the accounting boundary — a consumer that stops
    // early still settles the gauges, because the inner iterator is closed in
    // `finally`.
    const runId = this.runIdFor(model);
    const mark = beginRequest(runId);
    return this.innerAt(this.baseline(model))
      .createStream(request, model, upstreamEventContext, credential)
      .then((inner) => wrapStream(inner, runId, mark))
      .catch((err: unknown) => {
        failRequest(runId, mark, err);
        throw err;
      });
  }

  /** The run that will answer `model` — the same resolution `baseline()` dials.
   *  Falls back to the model id when no run is resolvable, which only happens
   *  on a path that then throws `LocalRunInactiveError` before any upstream
   *  call (so the counters are released by `catch`). */
  private runIdFor(model: ModelRegistration): string {
    const installedId = installedIdFromLocal(model.id);
    if (!installedId) return model.id;
    const run = activeRunFor(installedId);
    return run?.id ?? installedId;
  }
}

/**
 * Pass a provider stream through unchanged while counting it. Usage arrives on
 * the terminal `response.usage` event; the first text delta closes the TTFT
 * window and opens the decode window (ADR-0040 §3). The gauges settle exactly
 * once — on normal completion, on an upstream error, and on early close.
 */
async function* wrapStream(
  inner: AsyncIterable<StreamEvent>,
  runId: string,
  mark: ReturnType<typeof beginRequest>
): AsyncIterable<StreamEvent> {
  let usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  let settled = false;
  const settle = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (error === undefined) completeRequest(runId, mark, usage, { streamed: true });
    else failRequest(runId, mark, error);
  };
  try {
    for await (const event of inner) {
      if (event.type === 'response.output_text.delta') markFirstDelta(mark);
      else if (event.type === 'response.usage') {
        usage = {
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
          cachedInputTokens: event.usage?.cachedInputTokens,
        };
      }
      yield event;
    }
    settle();
  } catch (err) {
    settle(err);
    throw err;
  } finally {
    // An early `break` by the consumer closes this generator without reaching
    // the loops' end — settle there too, so an aborted request still counts.
    settle();
  }
}

/**
 * The registrations the pooled builder injects, one per installed model.
 *
 * `tier: undefined` is load-bearing: a local model joins NO pool unless a tier
 * member list claims `local/<id>` explicitly. Never auto-entering `auto` is the
 * difference between "I run this deliberately" and "the router quietly decided
 * to burn my GPU".
 *
 * `pricing: 0` is a DECLARED fact, not ADR-0035's banned fabrication: local
 * inference's marginal cost is genuinely zero, so cost surfaces read a true
 * number instead of "unknown".
 */
export function localModelRegistrations(): ModelRegistration[] {
  const out: ModelRegistration[] = [];
  for (const model of listInstalledModels()) {
    out.push(registrationFor(model));
  }
  return out;
}

function registrationFor(model: InstalledModel): ModelRegistration {
  return {
    id: localModelId(model),
    provider: LOCAL_PROVIDER_ID,
    upstreamModel: servedNameFor(model),
    // No home tier: see the note above — membership is opt-in.
    tier: undefined,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    wire: 'openai-chat',
  };
}

/** True when the row can be launched at all (any engine) — the console badge
 *  and the registration share this single answer. */
export function isRunnableLocal(model: InstalledModel): boolean {
  return (model.meta?.runnable ?? []).length > 0;
}

/** True when the row declares a complete profile for any profile-taking engine
 *  (ADR-0039 — was Strata-only, now whatever engines the registry ships). */
export function hasProfile(model: InstalledModel): boolean {
  for (const engine of launchableEngines()) {
    if (!engine.runtime?.profile) continue;
    if (profileFor(model, engine.id) !== undefined) return true;
  }
  return false;
}
