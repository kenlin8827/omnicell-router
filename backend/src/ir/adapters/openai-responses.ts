import crypto from 'node:crypto';
import { RESPONSES_CALL_ID_MAX_LEN, RESPONSES_TOOL_ITEM_ID_MAX_LEN } from '../../config/defaults.js';
import type { ModelRegistration } from '../../config/types.js';
import { IrUnsupportedError } from '../errors.js';
import { DATA_URL_RE } from '../media.js';
import type {
  Annotation,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  InputItem,
  OutputItem,
  ToolDef,
  Usage,
} from '../types.js';
import { assertCanonicalRequestSupported } from '../validate.js';
import { CALL_ID_PREFIX, upstreamToolCallId } from '../tool-identity.js';

const PROTOCOL = 'openai-responses' as const;

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

function annotationFromWire(raw: unknown): Annotation {
  const a = record(raw);
  if (a.type === 'url_citation' && typeof a.url === 'string') {
    return {
      type: 'url_citation', url: a.url,
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(typeof a.start_index === 'number' ? { startIndex: a.start_index } : {}),
      ...(typeof a.end_index === 'number' ? { endIndex: a.end_index } : {}),
    };
  }
  if (a.type === 'file_citation' && typeof a.file_id === 'string') {
    return {
      type: 'file_citation', fileId: a.file_id,
      ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
      ...(typeof a.index === 'number' ? { index: a.index } : {}),
    };
  }
  if (a.type === 'file_path' && typeof a.file_id === 'string') {
    return { type: 'file_path', fileId: a.file_id, ...(typeof a.index === 'number' ? { index: a.index } : {}) };
  }
  return { type: 'extension', protocol: PROTOCOL, payload: raw };
}

function annotationToWire(annotation: Annotation): Record<string, unknown> {
  switch (annotation.type) {
    case 'url_citation':
      return {
        type: 'url_citation', url: annotation.url,
        ...(annotation.title !== undefined ? { title: annotation.title } : {}),
        ...(annotation.startIndex !== undefined ? { start_index: annotation.startIndex } : {}),
        ...(annotation.endIndex !== undefined ? { end_index: annotation.endIndex } : {}),
      };
    case 'file_citation':
      return {
        type: 'file_citation', file_id: annotation.fileId,
        ...(annotation.filename !== undefined ? { filename: annotation.filename } : {}),
        ...(annotation.index !== undefined ? { index: annotation.index } : {}),
      };
    case 'file_path':
      return { type: 'file_path', file_id: annotation.fileId, ...(annotation.index !== undefined ? { index: annotation.index } : {}) };
    case 'extension':
      if (annotation.protocol !== PROTOCOL) {
        throw new IrUnsupportedError('annotation', `Cannot convert ${annotation.protocol} annotation.`, PROTOCOL);
      }
      return record(annotation.payload);
  }
}

function partFromWire(raw: unknown): ContentPart {
  const p = record(raw);
  if ((p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
    return {
      type: 'text', text: p.text,
      ...(Array.isArray(p.annotations) ? { annotations: p.annotations.map(annotationFromWire) } : {}),
      ...(Array.isArray(p.logprobs) ? { logprobs: p.logprobs } : {}),
      ...(p.prompt_cache_breakpoint ? { cache: { raw: p.prompt_cache_breakpoint } } : {}),
    };
  }
  if (p.type === 'refusal' && typeof p.refusal === 'string') return { type: 'refusal', text: p.refusal };
  if (p.type === 'input_image') {
    if (typeof p.file_id === 'string' && p.file_id) {
      return {
        type: 'image', source: { kind: 'file', fileId: p.file_id },
        ...(p.detail && p.detail !== 'original' ? { detail: p.detail } : {}),
      };
    }
    if (typeof p.image_url === 'string' && p.image_url) {
      const match = DATA_URL_RE.exec(p.image_url);
      return {
        type: 'image',
        source: match ? { kind: 'base64', mediaType: match[1]!, data: match[2]! } : { kind: 'url', url: p.image_url },
        ...(p.detail && p.detail !== 'original' ? { detail: p.detail } : {}),
      };
    }
  }
  if (p.type === 'input_file') {
    const common = { ...(typeof p.filename === 'string' ? { filename: p.filename } : {}) };
    if (typeof p.file_id === 'string' && p.file_id) {
      return { type: 'file', source: { kind: 'file', fileId: p.file_id }, ...common };
    }
    if (typeof p.file_url === 'string' && p.file_url) {
      return { type: 'file', source: { kind: 'url', url: p.file_url }, ...common };
    }
    if (typeof p.file_data === 'string' && p.file_data) {
      const match = DATA_URL_RE.exec(p.file_data);
      if (match) {
        return {
          type: 'file', source: { kind: 'base64', mediaType: match[1]!, data: match[2]! },
          ...common,
        };
      }
    }
  }
  if (p.type === 'input_image' || p.type === 'input_file') {
    fail('content_part', `Invalid ${p.type}: no supported source was provided.`);
  }
  return { type: 'extension', protocol: PROTOCOL, payload: raw };
}

export function responsesPartToWire(part: ContentPart, role: 'user' | 'assistant'): Record<string, unknown> {
  if (part.type === 'extension') {
    if (part.protocol !== PROTOCOL) throw new IrUnsupportedError('content_part', `Cannot convert ${part.protocol} content.`, PROTOCOL);
    // A COPY, exactly as at item level (`openai-responses-output.ts`): rendering must never
    // alias the canonical object the session store and capture hold, or the next field the
    // encoder stamps onto the wire shape would edit the operator's record of the upstream
    // body. The item copy and this one are ONE rule, not two conventions.
    return { ...record(part.payload) };
  }
  if (part.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text,
      ...(part.annotations ? { annotations: part.annotations.map(annotationToWire) } : {}),
      ...(part.logprobs ? { logprobs: part.logprobs } : {}),
      ...(part.cache?.raw ? { prompt_cache_breakpoint: part.cache.raw } : {}),
    };
  }
  if (part.type === 'refusal') return { type: 'refusal', refusal: part.text };
  if (part.type === 'image') {
    return {
      type: 'input_image',
      ...(part.source.kind === 'url' ? { image_url: part.source.url } : {}),
      ...(part.source.kind === 'base64' ? { image_url: dataUrl(part.source.mediaType, part.source.data) } : {}),
      ...(part.source.kind === 'file' ? { file_id: part.source.fileId } : {}),
      ...(part.detail ? { detail: part.detail } : {}),
    };
  }
  if (part.type === 'file') {
    return {
      type: 'input_file',
      ...(part.source.kind === 'url' ? { file_url: part.source.url } : {}),
      ...(part.source.kind === 'base64' ? { file_data: dataUrl(part.source.mediaType, part.source.data) } : {}),
      ...(part.source.kind === 'file' ? { file_id: part.source.fileId } : {}),
      ...(part.filename ? { filename: part.filename } : {}),
    };
  }
  throw new IrUnsupportedError('audio_part', 'Responses adapter cannot carry input audio.', PROTOCOL);
}

export function responsesToolToWire(tool: ToolDef): Record<string, unknown> {
  if (tool.type === 'extension') {
    if (tool.protocol !== PROTOCOL) throw new IrUnsupportedError('tool_type', `Cannot convert ${tool.protocol} tool.`, PROTOCOL);
    return record(tool.payload);
  }
  if (tool.type === 'function') {
    return {
      type: 'function', name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
    };
  }
  if (tool.type === 'custom') {
    return {
      type: 'custom', name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.format !== undefined ? { format: tool.format } : {}),
    };
  }
  return { type: tool.kind, ...record(tool.config) };
}

/**
 * Responses tool items carry their own item `id`, distinct from the correlation
 * `call_id`, and upstreams reject an id that does not begin with the item-type
 * prefix (`Invalid 'input[2].id': Expected an ID that begins with 'fc'`).
 * Carriers without item ids (chat, Anthropic, Gemini) put the tool-call id in
 * both slots, so the Responses adapters derive one. Two invariants:
 *
 * - Deterministic: the same history MUST yield the same id on every turn, or
 *   the replayed prompt prefix turns over and the upstream prompt cache misses.
 * - Injective: distinct tool-call ids MUST NOT collapse onto one item id. The
 *   chat client controls `tool_calls[].id`, so an id that is not safe both in
 *   charset and length is hashed instead of sanitized/truncated — dropping
 *   characters or a tail would silently merge two calls into one id. What MAY be
 *   shortened is the DIGEST (to RESPONSES_TOOL_ITEM_ID_MAX_LEN, because the
 *   item-type prefix eats the room RESPONSES_CALL_ID_MAX_LEN gives a bare
 *   correlation id), never the original string.
 */
/**
 * The item-id namespace for a tool call (`fc_` for a function call, `ctc_` for a custom one).
 * Declared once because the anchor mint in `openai-responses-output.ts` has to agree with it:
 * a minted id that missed this prefix would come back double-prefixed.
 */
export function toolItemPrefix(custom: boolean): string {
  return custom ? 'ctc_' : 'fc_';
}

export function responsesToolItemId(id: string, custom: boolean): string {
  const prefix = toolItemPrefix(custom);
  if (id.startsWith(prefix)) return id;
  if (idShape(RESPONSES_TOOL_ITEM_ID_MAX_LEN).test(id)) return prefix + id;
  return prefix + idDigest(id, RESPONSES_TOOL_ITEM_ID_MAX_LEN);
}

/**
 * The one id charset both Responses id fields share, written once so the two
 * budgets can never grow different rules (sha256 hex is inside it, which is what
 * makes a hashed id legal).
 */
function idShape(maxLen: number): RegExp {
  return new RegExp(`^[A-Za-z0-9_-]{1,${maxLen}}$`);
}

/**
 * sha256 hex, shortened only as far as the destination field requires — callers
 * subtract their own prefix (and any suffix they append) from the budget first.
 * A budget above sha256's own 64 hex chars is satisfied by the full digest, so only
 * the LOW side needs a guard: `slice(0, 0)` returns the whole digest and a NEGATIVE
 * length returns `64 - n` characters, so an unguarded non-positive budget hands back
 * a 64-char id when the caller asked for none. The floor makes a zero/negative budget
 * yield ONE character — a caller that over-subtracts then gets an id that is still too
 * long for its field (visible, and our own gate rewrites it), which is honest in a way
 * a silent 64-char digest would not be.
 */
export function idDigest(id: string, maxLen: number): string {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, Math.max(maxLen, 1));
}

/** Charset + length budget for `call_id` (see RESPONSES_CALL_ID_MAX_LEN). */
const CALL_ID_SHAPE = idShape(RESPONSES_CALL_ID_MAX_LEN);

/**
 * Whether an id is ALREADY a legal `call_id`, so any projector can keep it byte-identical.
 * Exported because the markup-recovery mint (`providers/compat/tool-markup-recovery.ts`) has
 * to answer the same question about a response id it is about to embed — and because
 * `slice`/`replace` on an id is never the right answer there (sanitising a response id is
 * lossy, so it can alias two responses onto one correlation id). One charset, one predicate.
 */
export function isCanonicalResponsesCallId(id: string): boolean {
  return CALL_ID_SHAPE.test(id);
}

/**
 * The `call_` correlation namespace is declared once, in `ir/tool-identity.ts`, because the
 * upstream readers mint ids there and the markup-recovery mint builds ids in the same
 * namespace — two declarations would be two drift twins of one rule.
 */

/**
 * Canonical correlation id -> Responses `call_id`, with the same two invariants as
 * `responsesToolItemId` plus the one it lacked: a FIELD BUDGET. Upstream Responses
 * APIs validate this string's length, and a client id that arrived from another
 * carrier (chat owns `tool_calls[].id`; the cursor-gateway loop re-injects the id a
 * PREVIOUS upstream minted) would otherwise leave here verbatim and answer 400
 * `Invalid 'input[N].call_id': string too long, maximum 64 characters`.
 *
 * THIS IS THE ONLY PROJECTION POINT, and that is load-bearing. Canonical state —
 * `CanonicalResponse.output[].callId`, the session store a `store: true` Responses
 * chain replays, and the capture rows — keeps the ORIGINAL id, because projecting
 * there would break the other carriers (Anthropic `tool_use.id` has its own length
 * rule). If the outbound RESPONSE leg projected too, a client would hold digests
 * while the chain replays originals, and the two would meet as one history: an
 * unpaired orphan, `repairToolCallPairing` synthesising
 * "Tool call was cancelled before returning a result." over the client's real
 * result, and no error anywhere. One projector on one leg keeps every plane in one
 * naming system: a client replays the original it was handed, and this function
 * turns it into the same digest on every turn.
 *
 * Four properties, all load-bearing:
 *
 * - Inside the field (its charset AND its length) -> BYTE-IDENTICAL. Most traffic
 *   never sees a rewrite, so carriers that key on the `call_` / `toolu_` shape keep
 *   seeing it. `call_id` needs no item-type prefix (that is why `responsesToolItemId`
 *   adds one and this does not have to), so the budget is spent entirely on the id.
 * - Deterministic: the same history yields the same id on every turn, or the
 *   replayed prompt prefix busts the upstream prompt cache.
 * - Injective: truncating the ORIGINAL to the budget is NOT the fallback — ids
 *   that share a 64-char prefix would silently merge, and a merged correlation id
 *   merges two tool results onto one call with no error anywhere. The replacement
 *   is a `sha256` digest (`call_` + 59 hex = 64, so 236 bits and no realistic
 *   collision), and it keeps the `call_` shape because consumers, session stores
 *   and operator greps key on it.
 * - A PROJECTION: `responsesCallId(responsesCallId(x)) === responsesCallId(x)`,
 *   because the hashed form is itself inside the field. The correlation id
 *   flows back through the gateway (a client replays whatever id it was handed, and
 *   an extension item may carry one verbatim), so a map that is not idempotent
 *   would name the same call differently on two turns of one session.
 *
 * An empty id has no faithful representation — pairing is impossible without it —
 * so it is refused in the plane's own envelope (`tool_call_id` is the machine code the
 * client sees) rather than minted a placeholder, which would merge every unlabelled
 * call onto one id, or relayed as `""` for the upstream to reject in a language the
 * client cannot read. An EMPTY `call_id` counts as absent and falls back to the item
 * id **when the caller has one to offer** — that is the tool-call branch, which passes
 * `item.id`; a tool RESULT has no id of its own, so there the refusal above is what
 * happens. The two carriers agree on the anchor because `chat`
 * writes `callId = id`, and the inbound Responses reader does `call_id ?? id`; a
 * stored turn from before the minting fix can carry `call_id: ""` beside a real item
 * id. This is the LAST-MILE half of that contract: an empty correlation id is legal on
 * the Chat and Anthropic outbound wires, so it is refused only when the dialed carrier
 * requires one. The consequence is that the refusal is an `IrUnsupportedError`, which is
 * NOT failover-eligible — correct for a malformed body every candidate would receive
 * alike, but it means such a request ends here instead of trying the next model.
 */
export function responsesCallId(callId: string | undefined, fallback?: string): string {
  const id = callId || fallback || '';
  if (!id) {
    throw new IrUnsupportedError(
      'tool_call_id', 'Responses tool items require a non-empty correlation id.', PROTOCOL,
    );
  }
  return isCanonicalResponsesCallId(id)
    ? id
    : CALL_ID_PREFIX + idDigest(id, RESPONSES_CALL_ID_MAX_LEN - CALL_ID_PREFIX.length);
}

/**
 * Passthrough is not exemption on the leg we control. A built-in Responses item
 * (`web_search_call`, `mcp_call`, `image_generation_call`, a `computer_call` a
 * plugin parsed as an extension) carries `call_id` too, and an over-budget one
 * answers 400 for exactly the reason a tool item does — so an outbound extension
 * payload's correlation id goes through the same map. The payload is COPIED, never
 * mutated in place: the same object is what capture and the session store read, and
 * rewriting the original there would silently edit the client's prompt and put the
 * two naming planes out of step. A NESTED `call_id` is deliberately not walked: a foreign
 * built-in shape is not ours to relabel, and rewriting unknown payload keys would put the
 * map's idempotence on the vendor's structure rather than on our own field. An absent or
 * empty `call_id` is left alone, because
 * this payload is not ours to label — refusing a foreign built-in item over a field
 * shape we merely inferred would reject requests that work today.
 */
function withNormalizedCallId(payload: Record<string, unknown>): Record<string, unknown> {
  const callId = payload.call_id;
  if (typeof callId !== 'string' || callId === '') return payload;
  return { ...payload, call_id: responsesCallId(callId) };
}

function itemToWire(item: InputItem): Record<string, unknown> | Record<string, unknown>[] | null {
  if (item.type === 'extension') {
    if (item.protocol !== PROTOCOL) throw new IrUnsupportedError('input_item', `Cannot convert ${item.protocol} item.`, PROTOCOL);
    return withNormalizedCallId(record(item.payload));
  }
  if (item.type === 'item_reference') return { type: 'item_reference', id: item.id };
  if (item.type === 'reasoning') {
    if (item.signature) throw new IrUnsupportedError('reasoning_signature', 'Responses cannot replay a foreign reasoning signature.', PROTOCOL);
    return {
      type: 'reasoning',
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      summary: item.summary?.map((text) => ({ type: 'summary_text', text })) ?? [],
      ...(item.text ? { content: [{ type: 'reasoning_text', text: item.text }] } : {}),
      ...(item.encrypted ? { encrypted_content: item.encrypted } : {}),
    };
  }
  if (item.type === 'tool_call') {
    if (item.signature) throw new IrUnsupportedError('tool_call_signature', 'Responses cannot replay a foreign tool-call signature.', PROTOCOL);
    const custom = item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call';
    return {
      type: custom ? 'custom_tool_call' : 'function_call',
      id: responsesToolItemId(item.id, custom),
      call_id: responsesCallId(item.callId, item.id),
      name: item.name,
      ...(custom ? { input: item.arguments } : { arguments: item.arguments }),
      ...(item.status ? { status: item.status } : {}),
    };
  }
  if (item.type === 'tool_result') {
    if (item.isError) throw new IrUnsupportedError('tool_result_error', 'Responses has no lossless is_error field for tool output.', PROTOCOL);
    const parts = item.content.map((p) => responsesPartToWire(p, 'user'));
    const textOnly = parts.every((p) => p.type === 'input_text');
    return {
      type: item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call_output' ? 'custom_tool_call_output' : 'function_call_output',
      call_id: responsesCallId(item.callId),
      output: textOnly ? parts.map((p) => String(p.text ?? '')).join('\n') : parts,
    };
  }
  if (item.role === 'system' || item.role === 'developer') {
    // Plain system/developer text folds into top-level `instructions`. Keep the
    // input message only when a cache breakpoint must survive on a part/item.
    const hasCache = Boolean(item.cache)
      || item.content.some((part) => 'cache' in part && Boolean(part.cache));
    if (!hasCache) return null;
    return {
      type: 'message',
      role: item.role,
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      content: item.content.map((p) => responsesPartToWire(p, 'user')),
    };
  }
  const role = item.role === 'assistant' ? 'assistant' : 'user';
  return {
    type: 'message', role,
    ...(item.id ? { id: item.id } : {}),
    ...(item.status ? { status: item.status } : {}),
    content: item.content.map((p) => responsesPartToWire(p, role)),
  };
}

/** Canonical IR → OpenAI Responses request. No request-object spreading. */
export function canonicalToResponsesPayload(
  ir: CanonicalRequest,
  model: ModelRegistration,
  stream = false,
): Record<string, any> {
  assertCanonicalRequestSupported(ir, PROTOCOL);
  const instructions = [
    ...(ir.instructions ? [ir.instructions] : []),
    ...ir.input.flatMap((item) => {
      if (item.type !== 'message' || (item.role !== 'system' && item.role !== 'developer')) return [];
      const hasCache = Boolean(item.cache)
        || item.content.some((part) => 'cache' in part && Boolean(part.cache));
      if (hasCache) return [];
      return item.content.map((p) => p.type === 'text'
        ? p.text
        : fail('system_part', 'Responses system/developer instructions carry text only.'));
    }),
  ].filter(Boolean).join('\n\n');
  const input = ir.input.flatMap((item) => {
    const converted = itemToWire(item);
    if (!converted) return [];
    return Array.isArray(converted) ? converted : [converted];
  });
  const include = [...(ir.include ?? [])];
  if (ir.reasoning?.include && !include.includes('reasoning.encrypted_content')) include.push('reasoning.encrypted_content');
  if ((ir.logprobs === true || ir.topLogprobs !== undefined) && !include.includes('message.output_text.logprobs')) {
    include.push('message.output_text.logprobs');
  }
  return {
    model: model.upstreamModel,
    input,
    stream,
    ...(ir.logprobs === true || ir.topLogprobs !== undefined ? { top_logprobs: ir.topLogprobs ?? 0 } : {}),
    ...(instructions ? { instructions } : {}),
    ...(ir.generation?.maxOutputTokens !== undefined ? { max_output_tokens: ir.generation.maxOutputTokens } : {}),
    ...(ir.generation?.temperature !== undefined && model.temperature !== false
      ? { temperature: ir.generation.temperature }
      : {}),
    ...(ir.generation?.topP !== undefined ? { top_p: ir.generation.topP } : {}),
    ...(ir.tools?.length ? { tools: ir.tools.map(responsesToolToWire) } : {}),
    ...(ir.toolChoice
      ? {
        tool_choice: ir.toolChoice.type === 'function' || ir.toolChoice.type === 'custom'
          ? { type: ir.toolChoice.type, name: ir.toolChoice.name }
          : ir.toolChoice.type === 'allowed'
            ? { type: 'allowed_tools', mode: ir.toolChoice.mode, tools: ir.toolChoice.tools }
            : ir.toolChoice.type,
      }
      : {}),
    ...(ir.parallelToolCalls !== undefined ? { parallel_tool_calls: ir.parallelToolCalls } : {}),
    ...(ir.text
      ? {
        text: {
          ...(ir.text.format
            ? {
              format: ir.text.format.type === 'json_schema'
                ? {
                  type: 'json_schema', name: ir.text.format.name ?? 'output', schema: ir.text.format.schema,
                  ...(ir.text.format.description !== undefined ? { description: ir.text.format.description } : {}),
                  ...(ir.text.format.strict !== undefined ? { strict: ir.text.format.strict } : {}),
                }
                : ir.text.format,
            }
            : {}),
          ...(ir.text.verbosity ? { verbosity: ir.text.verbosity } : {}),
        },
      }
      : {}),
    ...(ir.reasoning
      ? {
        reasoning: {
          // Canonical ladder includes `max`; Responses wire stops at `xhigh`.
          ...(ir.reasoning.effort
            ? { effort: ir.reasoning.effort === 'max' ? 'xhigh' : ir.reasoning.effort }
            : {}),
          ...(ir.reasoning.budgetTokens !== undefined ? { max_tokens: ir.reasoning.budgetTokens } : {}),
          ...(ir.reasoning.summary ? { summary: ir.reasoning.summary } : {}),
        },
      }
      : {}),
    ...(ir.cache?.key ? { prompt_cache_key: ir.cache.key } : {}),
    ...(ir.cache?.retention ? { prompt_cache_retention: ir.cache.retention } : {}),
    ...(ir.cache?.options ? { prompt_cache_options: ir.cache.options } : {}),
    ...(ir.store !== undefined ? { store: ir.store } : {}),
    ...(ir.previousResponseId ? { previous_response_id: ir.previousResponseId } : {}),
    ...(ir.conversation !== undefined ? { conversation: ir.conversation } : {}),
    ...(ir.prompt ? { prompt: ir.prompt } : {}),
    ...(ir.background !== undefined ? { background: ir.background } : {}),
    ...(include.length ? { include } : {}),
    ...(ir.truncation ? { truncation: ir.truncation } : {}),
    ...(ir.serviceTier ? { service_tier: ir.serviceTier } : {}),
    ...(ir.safetyIdentifier ? { safety_identifier: ir.safetyIdentifier } : {}),
    ...(ir.user ? { user: ir.user } : {}),
    ...(ir.metadata ? { metadata: ir.metadata } : {}),
  };
}

function fail(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, PROTOCOL);
}

function responsesPartText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) fail('instructions', 'Responses instructions content must be text.');
  return content.map((raw) => {
    const part = record(raw);
    if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') return part.text;
    return fail('instructions', 'Responses instructions arrays accept text content only.');
  }).join('\n\n');
}

function instructionsFromWire(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw || undefined;
  if (!Array.isArray(raw)) fail('instructions', 'Responses instructions must be a string or message array.');
  const text = raw.map((item) => {
    if (typeof item === 'string') return item;
    const message = record(item);
    if (message.type !== undefined && message.type !== 'message') {
      return fail('instructions', 'Responses instructions arrays accept message items only.');
    }
    return responsesPartText(message.content);
  }).filter(Boolean).join('\n\n');
  return text || undefined;
}

function toolsFromWire(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail('tools', 'Responses tools must be an array.');
  return raw.map((entry): ToolDef => {
    const tool = record(entry);
    if (tool.type === 'function') {
      if (typeof tool.name !== 'string') fail('tool', 'Responses function tools require a name.');
      return {
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: record(tool.parameters) } : {}),
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        },
      };
    }
    if (tool.type === 'custom') {
      if (typeof tool.name !== 'string') fail('tool', 'Responses custom tools require a name.');
      const format = record(tool.format);
      return {
        type: 'custom', name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.format !== undefined ? {
          format: format.type === 'grammar'
            ? {
              type: 'grammar' as const,
              definition: String(format.definition ?? ''),
              syntax: format.syntax === 'regex' ? 'regex' as const : 'lark' as const,
            }
            : { type: 'text' as const },
        } : {}),
      };
    }
    if (typeof tool.type !== 'string' || !tool.type) fail('tool_type', 'Responses tools require a type.');
    const { type, ...config } = tool;
    return { type: 'builtin', kind: type, config };
  });
}

function toolChoiceFromWire(raw: unknown): CanonicalRequest['toolChoice'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'auto' || raw === 'none' || raw === 'required') return { type: raw };
  const choice = record(raw);
  if ((choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string') {
    return { type: choice.type, name: choice.name };
  }
  if (choice.type === 'allowed_tools' && (choice.mode === 'auto' || choice.mode === 'required') && Array.isArray(choice.tools)) {
    const tools = choice.tools.map((rawTool: unknown) => {
      const tool = record(rawTool);
      if ((tool.type !== 'function' && tool.type !== 'custom') || typeof tool.name !== 'string') {
        return fail('allowed_tools', 'Responses allowed_tools entries require a function/custom type and name.');
      }
      return { type: tool.type, name: tool.name };
    });
    return { type: 'allowed', mode: choice.mode, tools };
  }
  return fail('tool_choice', 'Unsupported Responses tool_choice.');
}

export function responsesInputToIR(raw: unknown): InputItem[] {
  if (typeof raw === 'string') {
    return raw ? [{ type: 'message', role: 'user', content: [{ type: 'text', text: raw }] }] : [];
  }
  if (!Array.isArray(raw)) fail('input', 'Responses input must be a string or item array.');
  return raw.flatMap((entry): InputItem[] => {
    const item = record(entry);
    const type = item.type ?? 'message';
    if (type === 'message') {
      const role = item.role ?? 'user';
      if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
        fail('role', `Unsupported Responses message role: ${String(role)}.`);
      }
      const content = typeof item.content === 'string'
        ? [{ type: 'text' as const, text: item.content }]
        : Array.isArray(item.content)
          ? item.content.map(partFromWire)
          : fail('content', 'Responses message content must be a string or part array.');
      return [{
        type: 'message', role,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        content,
      }];
    }
    if (type === 'item_reference' && typeof item.id === 'string') return [{ type: 'item_reference', id: item.id }];
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text as string] : [])
        : undefined;
      const content = Array.isArray(item.content)
        ? item.content.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text as string] : [])
        : [];
      return [{
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        ...(content.length ? { text: content.join('\n') } : {}),
        ...(summary ? { summary } : {}),
        ...(typeof item.signature === 'string' ? { signature: item.signature } : {}),
        ...(typeof item.encrypted_content === 'string' ? { encrypted: item.encrypted_content } : {}),
      }];
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      // The REQUEST plane keeps the name the client sent. This is the one reader that must NOT
      // mint: a harness resends the whole history every turn, so a random name invented here
      // would make the canonical envelope differ per resend and the outbound prefix would
      // change bytes on every turn — a cache miss the client can neither see nor fix. An item
      // id is a legitimate fallback because the client wrote it. A call named by NOTHING is
      // refused at the outbound gate (`responsesCallId`), never silently renamed here.
      const wireCallId = typeof item.call_id === 'string' ? item.call_id : '';
      const wireItemId = typeof item.id === 'string' ? item.id : '';
      const callId = wireCallId || wireItemId;
      const id = wireItemId || callId;
      const args = type === 'custom_tool_call' ? item.input : item.arguments;
      return [{
        type: 'tool_call', id, callId,
        name: String(item.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        ...(type === 'custom_tool_call' ? { vendor: { [PROTOCOL]: { itemType: type } } } : {}),
      }];
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (typeof item.call_id !== 'string') fail('tool_result', 'Responses tool outputs require call_id.');
      const content = typeof item.output === 'string'
        ? [{ type: 'text' as const, text: item.output }]
        : Array.isArray(item.output)
          ? item.output.map(partFromWire)
          : fail('tool_result', 'Responses tool output must be a string or content-part array.');
      return [{
        type: 'tool_result', callId: item.call_id, content,
        ...(type === 'custom_tool_call_output' ? { vendor: { [PROTOCOL]: { itemType: type } } } : {}),
      }];
    }
    return [{ type: 'extension', protocol: PROTOCOL, payload: entry }];
  });
}

/** OpenAI Responses request → Canonical IR. No Chat-shaped intermediate. */
export function responsesRequestToIR(body: unknown): CanonicalRequest {
  const req = record(body);
  if (req.input === undefined || req.input === null) fail('input', 'Invalid request: "input" is required.');
  const input = responsesInputToIR(req.input);
  if (input.length === 0) fail('input', 'Invalid request: "input" resolved to an empty item list.');
  const format = record(record(req.text).format);
  let text: CanonicalRequest['text'];
  if (format.type !== undefined || record(req.text).verbosity !== undefined) {
    let parsedFormat: NonNullable<CanonicalRequest['text']>['format'];
    if (format.type === undefined || format.type === 'text') parsedFormat = { type: 'text' };
    else if (format.type === 'json_object') parsedFormat = { type: 'json_object' };
    else if (format.type === 'json_schema') {
      if (typeof format.name !== 'string' || !format.schema || typeof format.schema !== 'object') {
        fail('response_format', 'Responses json_schema text.format requires name and schema.');
      }
      parsedFormat = {
        type: 'json_schema', name: format.name, schema: record(format.schema),
        ...(typeof format.description === 'string' ? { description: format.description } : {}),
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      };
    } else fail('response_format', `Unsupported Responses text.format: ${String(format.type)}.`);
    const verbosity = record(req.text).verbosity;
    if (verbosity !== undefined && verbosity !== 'low' && verbosity !== 'medium' && verbosity !== 'high') {
      fail('text_verbosity', `Unsupported Responses text.verbosity: ${String(verbosity)}.`);
    }
    text = { format: parsedFormat, ...(verbosity ? { verbosity } : {}) };
  }
  const reasoningWire = record(req.reasoning);
  const effort = reasoningWire.effort;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(effort))) {
    fail('reasoning_effort', `Unsupported Responses reasoning effort: ${String(effort)}.`);
  }
  const generation = {
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === 'number' ? { topP: req.top_p } : {}),
    ...(typeof req.max_output_tokens === 'number' ? { maxOutputTokens: req.max_output_tokens } : {}),
  };
  const instructions = instructionsFromWire(req.instructions);
  const tools = toolsFromWire(req.tools);
  const toolChoice = toolChoiceFromWire(req.tool_choice);
  return {
    model: typeof req.model === 'string' && req.model.trim() ? req.model.trim() : 'auto',
    stream: req.stream === true,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(typeof req.parallel_tool_calls === 'boolean' ? { parallelToolCalls: req.parallel_tool_calls } : {}),
    ...(Object.keys(generation).length ? { generation } : {}),
    ...(text ? { text } : {}),
    ...(req.reasoning !== undefined ? {
      reasoning: {
        ...(effort ? { effort: effort as NonNullable<CanonicalRequest['reasoning']>['effort'] } : {}),
        ...(typeof reasoningWire.max_tokens === 'number' ? { budgetTokens: reasoningWire.max_tokens } : {}),
        ...(typeof reasoningWire.summary === 'string' ? { summary: reasoningWire.summary as 'auto' | 'concise' | 'detailed' } : {}),
      },
    } : {}),
    ...(req.prompt_cache_key || req.prompt_cache_retention || req.prompt_cache_options ? {
      cache: {
        ...(typeof req.prompt_cache_key === 'string' ? { key: req.prompt_cache_key } : {}),
        ...(typeof req.prompt_cache_retention === 'string' ? { retention: req.prompt_cache_retention } : {}),
        ...(req.prompt_cache_options && typeof req.prompt_cache_options === 'object' ? { options: record(req.prompt_cache_options) } : {}),
      },
    } : {}),
    ...(typeof req.top_logprobs === 'number' ? { topLogprobs: req.top_logprobs } : {}),
    ...(typeof req.store === 'boolean' ? { store: req.store } : {}),
    ...(typeof req.previous_response_id === 'string' ? { previousResponseId: req.previous_response_id } : {}),
    ...(req.conversation !== undefined ? { conversation: req.conversation as CanonicalRequest['conversation'] } : {}),
    ...(req.prompt !== undefined ? { prompt: req.prompt as CanonicalRequest['prompt'] } : {}),
    ...(typeof req.background === 'boolean' ? { background: req.background } : {}),
    ...(Array.isArray(req.include) ? { include: req.include as string[] } : {}),
    ...(req.truncation !== undefined ? { truncation: req.truncation as 'auto' | 'disabled' } : {}),
    ...(typeof req.service_tier === 'string' ? { serviceTier: req.service_tier } : {}),
    ...(typeof req.safety_identifier === 'string' ? { safetyIdentifier: req.safety_identifier } : {}),
    ...(typeof req.user === 'string' ? { user: req.user } : {}),
    ...(req.metadata && typeof req.metadata === 'object' ? { metadata: record(req.metadata) } : {}),
  };
}

function usageFromWire(raw: unknown): Usage {
  const u = record(raw);
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
    ...(u.input_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: u.input_tokens_details.cached_tokens }
      : {}),
    ...(u.input_tokens_details?.audio_tokens !== undefined ? { audioInputTokens: u.input_tokens_details.audio_tokens } : {}),
    ...(u.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: u.output_tokens_details.reasoning_tokens }
      : {}),
    ...(u.output_tokens_details?.audio_tokens !== undefined
      ? { audioOutputTokens: u.output_tokens_details.audio_tokens }
      : {}),
    ...(u.output_tokens_details?.accepted_prediction_tokens !== undefined
      ? { acceptedPredictionTokens: u.output_tokens_details.accepted_prediction_tokens }
      : {}),
    ...(u.output_tokens_details?.rejected_prediction_tokens !== undefined
      ? { rejectedPredictionTokens: u.output_tokens_details.rejected_prediction_tokens }
      : {}),
  };
}

export function responsesResponseToIR(data: unknown): CanonicalResponse {
  const body = record(data);
  const output: OutputItem[] = [];
  for (const raw of Array.isArray(body.output) ? body.output : []) {
    const item = record(raw);
    if (item.type === 'reasoning') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .flatMap((part) => typeof record(part).text === 'string' ? [record(part).text] : [])
        .join('\n');
      output.push({
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(text ? { text } : {}),
        ...(Array.isArray(item.summary)
          ? { summary: item.summary.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text] : []) }
          : {}),
        ...(typeof item.encrypted_content === 'string' ? { encrypted: item.encrypted_content } : {}),
      });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const callId = upstreamToolCallId(typeof item.call_id === 'string' ? item.call_id
        : typeof item.id === 'string' ? item.id : undefined);
      const args = item.type === 'custom_tool_call' ? item.input : item.arguments;
      output.push({
        type: 'tool_call', id: typeof item.id === 'string' && item.id ? item.id : callId, callId,
        name: String(item.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.type === 'custom_tool_call' ? { vendor: { [PROTOCOL]: { itemType: item.type } } } : {}),
      });
    } else if (item.type === 'message') {
      output.push({
        type: 'message', role: 'assistant',
        ...(item.id ? { id: item.id } : {}),
        ...(item.status ? { status: item.status } : {}),
        content: (Array.isArray(item.content) ? item.content : []).map(partFromWire),
      });
    } else {
      output.push({ type: 'extension', protocol: PROTOCOL, payload: raw });
    }
  }
  const incomplete = body.status === 'incomplete';
  const failed = body.status === 'failed';
  const reason = failed ? 'error' : incomplete
    ? body.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length'
    : output.some((item) => item.type === 'tool_call') ? 'tool_calls' : 'stop';
  return {
    ...(body.id ? { id: body.id } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(typeof body.created_at === 'number' ? { createdAt: body.created_at } : {}),
    status: failed ? 'failed' : incomplete ? 'incomplete' : 'completed',
    reason,
    output,
    usage: usageFromWire(body.usage),
    ...(body.service_tier ? { serviceTier: body.service_tier } : {}),
    ...(body.previous_response_id ? { previousResponseId: body.previous_response_id } : {}),
    ...(body.error ? { error: { code: body.error.code, message: body.error.message ?? 'Responses turn failed.' } } : {}),
  };
}

export {
  annotationFromWire as responsesAnnotationFromWire,
  partFromWire as responsesPartFromWire,
  usageFromWire as responsesUsageFromWire,
};
