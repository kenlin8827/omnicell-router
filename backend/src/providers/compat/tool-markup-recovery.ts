/**
 * Provider-layer tool-call markup recovery (ADR-0034).
 *
 * Endpoint/model policy (opencode.ai zen + deepseek-v4 DSML) lives HERE — on
 * the southbound execution boundary — not in the vendor-neutral `ir/` core.
 * `registry.execute` decides whether to enable recovery; this module owns how.
 */
import { randomUUID } from 'node:crypto';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  FunctionTool,
  OutputItem,
  StreamEvent,
  ToolCallItem,
} from '../../ir/types.js';
import { detectToolMarkupLeak } from './tool-markup-leak.js';

/** A narrowly-scoped repair for the one endpoint/model family observed leaking. */
export type ToolMarkupRecovery = 'dsml';

export interface RecoveredToolCall {
  name: string;
  arguments: string;
}

interface TextRecovery {
  text: string;
  calls: RecoveredToolCall[];
}

type TagKind = 'tool_calls' | 'invoke' | 'parameter';
interface Tag {
  kind: TagKind;
  closing: boolean;
  start: number;
  end: number;
  raw: string;
  name?: string;
  stringValue?: boolean;
}

interface Span {
  start: number;
  end: number;
}

type ParseResult =
  | { status: 'valid'; end: number; calls: RecoveredToolCall[] }
  | { status: 'invalid' | 'incomplete' };

const TAG = /<(?:[|\uFF5C\s]*\/)?[|\uFF5C\s]*(?:DSML[|\uFF5C\s]*)?(?:tool_calls|invoke|parameter)\b[^>]*>/gi;
const STREAM_PENDING_MAX_CHARS = 1024 * 1024;

function callableTools(request: CanonicalRequest): Map<string, FunctionTool> {
  if (request.toolChoice?.type === 'none' || request.toolChoice?.type === 'custom') return new Map();
  const allowed = request.toolChoice?.type === 'function'
    ? new Set([request.toolChoice.name])
    : request.toolChoice?.type === 'allowed'
      ? new Set(request.toolChoice.tools.filter((tool) => tool.type === 'function').map((tool) => tool.name))
      : null;
  return new Map((request.tools ?? []).flatMap((tool) => {
    if (tool.type !== 'function' || (allowed && !allowed.has(tool.function.name))) return [];
    return [[tool.function.name, tool.function]];
  }));
}

/** Endpoint + model + request scope; provider ids deliberately play no role. */
export function toolMarkupRecoveryFor(
  request: CanonicalRequest,
  model: ModelRegistration,
  config: ProviderConfig | undefined,
): ToolMarkupRecovery | null {
  // Token, not a substring: `deepseek-v4-flash` matches; `deepseek-v40` does not.
  if (!config || callableTools(request).size === 0 || !/(?:^|[^a-z0-9])deepseek-v4(?:$|[^a-z0-9])/i.test(model.upstreamModel)) return null;
  try {
    const url = new URL(config.baseUrl);
    if (url.hostname !== 'opencode.ai' || url.pathname.replace(/\/+$/, '') !== '/zen/v1') return null;
    return 'dsml';
  } catch {
    return null;
  }
}

function fencedSpans(text: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  let open: { start: number; marker: string } | null = null;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(offset, end);
    if (!open) {
      const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (match) open = { start: offset, marker: match[1]! };
    } else {
      const close = new RegExp(`^[ \\t]{0,3}${open.marker[0]}{${open.marker.length},}[ \\t]*\\r?(?:\\n|$)`);
      if (close.test(line)) {
        spans.push({ start: open.start, end });
        open = null;
      }
    }
    offset = end;
  }
  if (open) spans.push({ start: open.start, end: text.length });
  // Inline code is prose too. Mask paired (and conservatively, unterminated)
  // backtick spans outside fenced blocks before looking for invoke tags.
  let cursor = 0;
  while (cursor < text.length) {
    const fenced = spans.find((span) => cursor >= span.start && cursor < span.end);
    if (fenced) {
      cursor = fenced.end;
      continue;
    }
    const start = text.indexOf('`', cursor);
    if (start === -1) break;
    const containing = spans.find((span) => start >= span.start && start < span.end);
    if (containing) {
      cursor = containing.end;
      continue;
    }
    const marker = text.slice(start).match(/^`+/)?.[0] ?? '`';
    const close = text.indexOf(marker, start + marker.length);
    const end = close === -1 ? text.length : close + marker.length;
    spans.push({ start, end });
    cursor = end;
  }
  return spans.sort((a, b) => a.start - b.start);
}

function inSpans(index: number, spans: Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function tagAt(text: string, start: number): Tag | null {
  TAG.lastIndex = start;
  const match = TAG.exec(text);
  if (!match || match.index !== start) return null;
  const raw = match[0];
  const kind = raw.match(/(?:tool_calls|invoke|parameter)\b/i)?.[0].toLowerCase() as TagKind | undefined;
  if (!kind) return null;
  return {
    kind,
    closing: /^<[|\uFF5C\s]*\//.test(raw),
    start,
    end: start + raw.length,
    raw,
    name: raw.match(/\bname\s*=\s*"([^"]*)"/i)?.[1],
    stringValue: /\bstring\s*=\s*"true"/i.test(raw) ? true : /\bstring\s*=\s*"false"/i.test(raw) ? false : undefined,
  };
}

function nextTag(text: string, from: number, fences: Span[]): Tag | null {
  TAG.lastIndex = from;
  let match = TAG.exec(text);
  while (match && inSpans(match.index, fences)) match = TAG.exec(text);
  return match ? tagAt(text, match.index) : null;
}

function schemaType(schema: Record<string, unknown> | undefined): string[] {
  const type = schema?.type;
  return typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((value): value is string => typeof value === 'string') : [];
}

function valueMatchesSchema(value: unknown, schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return true;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((entry) => typeof entry === 'object' && entry && valueMatchesSchema(value, entry as Record<string, unknown>));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = schemaType(schema);
  if (types.includes('null') && value === null) return true;
  if (types.includes('string') && typeof value === 'string') return true;
  if (types.includes('number') && typeof value === 'number' && Number.isFinite(value)) return true;
  if (types.includes('integer') && typeof value === 'number' && Number.isInteger(value)) return true;
  if (types.includes('boolean') && typeof value === 'boolean') return true;
  if (types.includes('array') && Array.isArray(value)) {
    const items = typeof schema.items === 'object' && schema.items ? schema.items as Record<string, unknown> : undefined;
    return value.every((entry) => valueMatchesSchema(entry, items));
  }
  if ((types.includes('object') || (!types.length && (schema.properties || schema.required))) && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = typeof schema.properties === 'object' && schema.properties
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    if (required.some((key) => !Object.hasOwn(record, key))) return false;
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(record).every(([key, entry]) => !Object.hasOwn(properties, key) || valueMatchesSchema(entry, properties[key]));
  }
  return types.length === 0;
}

function parameterValue(raw: string, tag: Tag, schema: Record<string, unknown> | undefined): { ok: boolean; value?: unknown } {
  if (tag.stringValue === true) {
    return valueMatchesSchema(raw, schema) ? { ok: true, value: raw } : { ok: false };
  }
  try {
    const value = JSON.parse(raw);
    if (valueMatchesSchema(value, schema)) return { ok: true, value };
  } catch {
    // Fall through to schema-guided string acceptance below.
  }
  // Real DSML emissions may omit string="true" (even for numeric- or
  // boolean-looking strings like "123" or "true"). The request schema, not a
  // fallback cast, is what makes treating the body as a string safe.
  if (tag.stringValue === undefined && schemaType(schema).includes('string') && valueMatchesSchema(raw, schema)) {
    return { ok: true, value: raw };
  }
  return { ok: false };
}

function parseInvoke(text: string, open: Tag, tools: Map<string, FunctionTool>, fences: Span[]): ParseResult {
  const tool = open.name ? tools.get(open.name) : undefined;
  if (!tool) return { status: 'invalid' };
  const properties = typeof tool.parameters?.properties === 'object' && tool.parameters.properties
    ? tool.parameters.properties as Record<string, Record<string, unknown>>
    : {};
  const args: Record<string, unknown> = Object.create(null);
  let cursor = open.end;
  while (cursor <= text.length) {
    const tag = nextTag(text, cursor, fences);
    if (!tag) return { status: 'incomplete' };
    if (text.slice(cursor, tag.start).trim()) return { status: 'invalid' };
    if (tag.closing && tag.kind === 'invoke') {
      return valueMatchesSchema(args, tool.parameters)
        ? { status: 'valid', end: tag.end, calls: [{ name: open.name!, arguments: JSON.stringify(args) }] }
        : { status: 'invalid' };
    }
    if (tag.closing || tag.kind !== 'parameter' || !tag.name || Object.hasOwn(args, tag.name)) return { status: 'invalid' };
    const close = nextTag(text, tag.end, fences);
    if (!close) return { status: 'incomplete' };
    if (!close.closing || close.kind !== 'parameter') return { status: 'invalid' };
    const paramSchema = Object.hasOwn(properties, tag.name) ? properties[tag.name] : undefined;
    const converted = parameterValue(text.slice(tag.end, close.start), tag, paramSchema);
    if (!converted.ok) return { status: 'invalid' };
    args[tag.name] = converted.value;
    cursor = close.end;
  }
  return { status: 'incomplete' };
}

function parseWrapper(text: string, open: Tag, tools: Map<string, FunctionTool>, fences: Span[]): ParseResult {
  const calls: RecoveredToolCall[] = [];
  let cursor = open.end;
  while (cursor <= text.length) {
    const tag = nextTag(text, cursor, fences);
    if (!tag) return { status: 'incomplete' };
    if (text.slice(cursor, tag.start).trim()) return { status: 'invalid' };
    if (tag.closing && tag.kind === 'tool_calls') {
      return calls.length ? { status: 'valid', end: tag.end, calls } : { status: 'invalid' };
    }
    if (tag.closing || tag.kind !== 'invoke') return { status: 'invalid' };
    const parsed = parseInvoke(text, tag, tools, fences);
    if (parsed.status !== 'valid') return parsed;
    calls.push(...parsed.calls);
    cursor = parsed.end;
  }
  return { status: 'incomplete' };
}

function parsePrefix(text: string, tools: Map<string, FunctionTool>, fences: Span[]): ParseResult {
  const open = tagAt(text, 0);
  if (!open || open.closing || inSpans(0, fences)) return { status: 'invalid' };
  if (open.kind === 'invoke') return parseInvoke(text, open, tools, fences);
  if (open.kind === 'tool_calls') return parseWrapper(text, open, tools, fences);
  return { status: 'invalid' };
}

function findMatchingCloseEnd(
  text: string,
  from: number,
  kind: 'tool_calls' | 'invoke',
  fences: Span[],
): number | null {
  let scan = from;
  let depth = 1;
  while (scan < text.length) {
    const tag = nextTag(text, scan, fences);
    if (!tag) return null;
    if (tag.kind === kind && !tag.closing) depth += 1;
    else if (tag.kind === kind && tag.closing) {
      depth -= 1;
      if (depth === 0) return tag.end;
    }
    scan = tag.end;
  }
  return null;
}

export function recoverToolMarkupText(text: string, request: CanonicalRequest): TextRecovery {
  const tools = callableTools(request);
  if (!text || tools.size === 0) return { text, calls: [] };
  const fences = fencedSpans(text);
  const spans: Span[] = [];
  const calls: RecoveredToolCall[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = nextTag(text, cursor, fences);
    if (!open) break;
    if (open.closing || (open.kind !== 'invoke' && open.kind !== 'tool_calls')) {
      cursor = open.end;
      continue;
    }
    const parsed = open.kind === 'invoke' ? parseInvoke(text, open, tools, fences) : parseWrapper(text, open, tools, fences);
    if (parsed.status === 'valid') {
      spans.push({ start: open.start, end: parsed.end });
      calls.push(...parsed.calls);
      cursor = parsed.end;
    } else if (open.kind === 'tool_calls') {
      // A malformed wrapper is indivisible: skip the entire matching wrapper
      // (depth-aware) so no inner sibling is rescued while later independent
      // blocks still remain recoverable.
      const closeEnd = findMatchingCloseEnd(text, open.end, 'tool_calls', fences);
      if (closeEnd !== null) cursor = closeEnd;
      else break;
    } else {
      // Invalid bare invoke: skip the whole body when a matching close exists
      // (depth-aware) so nested markup inside stays ordinary text.
      const closeEnd = findMatchingCloseEnd(text, open.end, 'invoke', fences);
      if (closeEnd !== null) cursor = closeEnd;
      else break;
    }
  }
  if (!calls.length) return { text, calls: [] };
  let clean = '';
  let copied = 0;
  for (const span of spans) {
    clean += text.slice(copied, span.start);
    copied = span.end;
  }
  clean += text.slice(copied);
  return { text: clean, calls };
}

function placeholder(call: ToolCallItem): boolean {
  const args = call.arguments.trim();
  return !args || args === '{}';
}

function syntheticId(responseId: string, candidateIndex: number, sequence: number): string {
  const safe = responseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(-64) || randomUUID();
  return `call_${safe}_dsml_${candidateIndex}_${sequence}`;
}

function reconcileOutput(
  output: OutputItem[],
  calls: RecoveredToolCall[],
  responseId: string,
  candidateIndex: number,
): { output: OutputItem[]; applied: number } {
  const next = output.map((item) => item.type === 'tool_call' ? { ...item } : item);
  const remaining: RecoveredToolCall[] = [];
  let applied = 0;
  for (const call of calls) {
    const native = next.find((item): item is ToolCallItem => item.type === 'tool_call' && item.name === call.name && placeholder(item));
    if (native) {
      native.arguments = call.arguments;
      applied += 1;
      continue;
    }
    // A same-name native with real args already owns the call — never duplicate.
    if (next.some((item) => item.type === 'tool_call' && item.name === call.name && !placeholder(item))) continue;
    remaining.push(call);
  }
  let sequence = 0;
  for (const call of remaining) {
    const id = syntheticId(responseId, candidateIndex, ++sequence);
    next.push({ type: 'tool_call', id, callId: id, status: 'completed', name: call.name, arguments: call.arguments });
    applied += 1;
  }
  return { output: next, applied };
}

function finishResponse(response: CanonicalResponse, recovered: number): CanonicalResponse {
  const leak = detectToolMarkupLeak(response);
  return {
    ...response,
    ...(recovered > 0 ? {
      reason: response.status === 'completed' ? 'tool_calls' : response.reason,
      toolTextRecovery: { kind: 'dsml' as const, calls: recovered },
    } : {}),
    ...(leak ? { toolMarkupLeak: leak } : { toolMarkupLeak: undefined }),
  };
}

/** Collect verbatim user / tool_result text so echo recovery cannot upgrade it. */
function inputTextEchoSet(request: CanonicalRequest): Set<string> {
  const out = new Set<string>();
  for (const item of request.input) {
    if (item.type === 'message' && item.role === 'user') {
      for (const part of item.content) {
        if (part.type === 'text' && part.text.trim()) out.add(part.text.trim());
      }
    }
    if (item.type === 'tool_result') {
      for (const part of item.content) {
        if (part.type === 'text' && part.text.trim()) out.add(part.text.trim());
      }
    }
  }
  return out;
}

export function recoverToolMarkupInResponse(response: CanonicalResponse, request: CanonicalRequest): CanonicalResponse {
  if (response.status === 'failed') return finishResponse(response, 0);
  const responseId = response.id ?? randomUUID();
  const echoed = inputTextEchoSet(request);
  let recovered = 0;
  const convert = (output: OutputItem[], candidateIndex: number): OutputItem[] => {
    const calls: RecoveredToolCall[] = [];
    const next = output.map((item) => {
      if (item.type !== 'message') return item;
      let changed = false;
      const content: ContentPart[] = [];
      for (const part of item.content) {
        if (part.type !== 'text') {
          content.push(part);
          continue;
        }
        // ADR-0034: never recover markup that is an exact echo of user/tool input.
        if (echoed.has(part.text.trim())) {
          content.push(part);
          continue;
        }
        const result = recoverToolMarkupText(part.text, request);
        if (!result.calls.length) {
          content.push(part);
          continue;
        }
        changed = true;
        calls.push(...result.calls);
        if (result.text) content.push({ ...part, text: result.text });
      }
      return changed ? { ...item, content } : item;
    });
    if (!calls.length) return next;
    const reconciled = reconcileOutput(next, calls, responseId, candidateIndex);
    recovered += reconciled.applied;
    return reconciled.output;
  };
  const output = convert(response.output, 0);
  const candidates = response.candidates?.map((candidate) => ({
    ...candidate,
    // Some accumulators mirror the primary output in candidates[0]. Convert
    // that shared candidate once, not once per representation.
    output: candidate.index === 0 && candidate.output === response.output
      ? output
      : convert(candidate.output, candidate.index),
  }));
  if (!recovered) return finishResponse(response, 0);
  return finishResponse({ ...response, output, ...(candidates ? { candidates } : {}) }, recovered);
}

interface TextState {
  pending: string;
  clean: string;
  /** Source blocks suppressed pending a successful terminal event. */
  suppressed: string[];
  finalized: boolean;
  passthrough: boolean;
  /** Whether the start of `pending` is at the beginning of a line. */
  atLineStart: boolean;
  /** Opening backtick marker when inside an unterminated inline code span. */
  inlineMarker: string | null;
}

interface CandidateState {
  texts: Map<string, TextState>;
  recovered: RecoveredToolCall[];
  native: Map<number, ToolCallItem>;
  nextIndex: number;
}

function fenceStart(text: string, atLineStart: boolean): number {
  const match = atLineStart
    ? /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/.exec(text)
    : /\n[ \t]{0,3}(?:`{3,}|~{3,})/.exec(text);
  return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : -1;
}

function fenceEnd(text: string): number | null {
  const newline = text.indexOf('\n');
  const first = text.slice(0, newline === -1 ? text.length : newline);
  const marker = first.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
  if (!marker) return null;
  let offset = newline === -1 ? text.length : newline + 1;
  const close = new RegExp(`^[ \\t]{0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?(?:\\n|$)`);
  while (offset < text.length) {
    const next = text.indexOf('\n', offset);
    const end = next === -1 ? text.length : next + 1;
    if (close.test(text.slice(offset, end))) return end;
    offset = end;
  }
  return null;
}

function couldBeTagPrefix(text: string): boolean {
  // Once `>` is present and tagAt() already returned null, no more bytes can
  // turn this prefix into a valid DSML tag.
  if (text.includes('>')) return false;
  const compact = text.toLowerCase().replace(/[|\uFF5C\s]/g, '');
  const prefixes = [
    '<dsmltool_calls', '</dsmltool_calls', '<dsmlinvoke', '</dsmlinvoke', '<dsmlparameter', '</dsmlparameter',
    '<tool_calls', '</tool_calls', '<invoke', '</invoke', '<parameter', '</parameter',
  ];
  return prefixes.some((prefix) => {
    if (prefix.startsWith(compact)) return true;
    if (!compact.startsWith(prefix)) return false;
    // After the keyword completes, the next character must be a word boundary,
    // not another identifier char (so `<parameters>` or `<invoke_other>` never stall).
    const kw = prefix.replace(/^<\/?(?:dsml)?/, '');
    const idx = text.toLowerCase().indexOf(kw);
    if (idx < 0) return false;
    const next = text[idx + kw.length];
    return next === undefined || !/[a-z0-9_]/i.test(next);
  });
}

function inlineCodeStart(text: string): number {
  return text.indexOf('`');
}

function inlineCodeEnd(text: string): number | null {
  const marker = text.match(/^`+/)?.[0];
  if (!marker) return null;
  const close = text.indexOf(marker, marker.length);
  return close === -1 ? null : close + marker.length;
}

/**
 * Incremental IR-event rewriter. Text passes immediately unless it can still
 * become a fence or tool tag. Tool items are reconciled at EOS so an upstream
 * empty native placeholder and a recovered call can never both execute.
 */
export function createToolMarkupStreamRecovery(request: CanonicalRequest): {
  push(event: StreamEvent): StreamEvent[];
  finish(terminal?: StreamEvent): StreamEvent[];
  finishResponse(response: CanonicalResponse): CanonicalResponse;
} {
  const tools = callableTools(request);
  const echoed = inputTextEchoSet(request);
  const candidates = new Map<number, CandidateState>();
  let responseId: string = randomUUID();
  let recovered = 0;
  let finished = false;
  const candidate = (index: number): CandidateState => {
    let state = candidates.get(index);
    if (!state) {
      state = { texts: new Map(), recovered: [], native: new Map(), nextIndex: 0 };
      candidates.set(index, state);
    }
    return state;
  };
  const textState = (state: CandidateState, event: { index: number; partIndex: number }): TextState => {
    const key = `${event.index}:${event.partIndex}`;
    let text = state.texts.get(key);
    if (!text) {
      text = { pending: '', clean: '', suppressed: [], finalized: false, passthrough: false, atLineStart: true, inlineMarker: null };
      state.texts.set(key, text);
    }
    return text;
  };
  const drain = (state: CandidateState, text: TextState, final: boolean): string[] => {
    const emitted: string[] = [];
    if (text.finalized) return emitted;
    const emit = (value: string): void => {
      if (!value) return;
      text.clean += value;
      text.atLineStart = value.endsWith('\n');
      emitted.push(value);
    };
    if (text.passthrough) {
      emit(text.pending);
      text.pending = '';
      if (final) text.finalized = true;
      return emitted;
    }
    while (text.pending) {
      if (text.pending.length > STREAM_PENDING_MAX_CHARS) {
        text.passthrough = true;
        text.inlineMarker = null;
        emit(text.pending);
        text.pending = '';
        break;
      }
      if (text.inlineMarker) {
        const close = text.pending.indexOf(text.inlineMarker);
        if (close !== -1) {
          const end = close + text.inlineMarker.length;
          emit(text.pending.slice(0, end));
          text.pending = text.pending.slice(end);
          text.inlineMarker = null;
          continue;
        }
        if (!final) {
          const trailingTicks = text.pending.match(/`+$/)?.[0].length ?? 0;
          const keep = Math.min(trailingTicks, text.inlineMarker.length - 1);
          const flushLen = text.pending.length - keep;
          if (flushLen > 0) {
            emit(text.pending.slice(0, flushLen));
            text.pending = text.pending.slice(flushLen);
          }
          break;
        }
        emit(text.pending);
        text.pending = '';
        text.inlineMarker = null;
        break;
      }
      const lessThan = text.pending.indexOf('<');
      const fence = fenceStart(text.pending, text.atLineStart);
      const inline = inlineCodeStart(text.pending);
      const starts = [lessThan, fence, inline].filter((index) => index >= 0);
      if (!starts.length) {
        if (!final) {
          // Hold trailing line-start indent (1-3 spaces/tabs) or partial fence
          // (`~` / `~~` / `` ` `` / `` `` ``) so split fences keep atLineStart.
          const fenceTail = (
            text.atLineStart
              ? /(?:^|\n)([ \t]{1,3}|[ \t]{0,3}(?:~{1,2}|`{1,2}))$/
              : /\n([ \t]{1,3}|[ \t]{0,3}(?:~{1,2}|`{1,2}))$/
          ).exec(text.pending);
          if (fenceTail) {
            const keepFrom = text.pending.length - fenceTail[1]!.length;
            if (keepFrom > 0) emit(text.pending.slice(0, keepFrom));
            text.pending = text.pending.slice(keepFrom);
            break;
          }
        }
        emit(text.pending);
        text.pending = '';
        break;
      }
      const start = Math.min(...starts);
      if (start > 0) {
        if (!final && start === inline && /^`{1,2}$/.test(text.pending.slice(start))) {
          const prefix = text.pending.slice(0, start);
          const indentMatch = (text.atLineStart ? /(?:^|\n)([ \t]{0,3})$/ : /\n([ \t]{0,3})$/).exec(prefix);
          if (indentMatch) {
            const keepFrom = start - indentMatch[1]!.length;
            if (keepFrom > 0) emit(text.pending.slice(0, keepFrom));
            text.pending = text.pending.slice(keepFrom);
            break;
          }
        }
        emit(text.pending.slice(0, start));
        text.pending = text.pending.slice(start);
        continue;
      }
      if (fence === 0) {
        const end = fenceEnd(text.pending);
        if (end !== null) {
          emit(text.pending.slice(0, end));
          text.pending = text.pending.slice(end);
          continue;
        }
        if (!final) break;
        emit(text.pending);
        text.pending = '';
        break;
      }
      if (inline === 0) {
        const end = inlineCodeEnd(text.pending);
        if (end !== null) {
          emit(text.pending.slice(0, end));
          text.pending = text.pending.slice(end);
          continue;
        }
        if (!final) {
          const marker = text.pending.match(/^`+/)![0];
          // Wait for at least one non-backtick char so a split opening run
          // (e.g. "`" + "``" at line start) can still become a fence or multi-tick marker.
          if (marker.length === text.pending.length) break;
          emit(marker);
          text.pending = text.pending.slice(marker.length);
          text.inlineMarker = marker;
          continue;
        }
        emit(text.pending);
        text.pending = '';
        break;
      }
      const open = tagAt(text.pending, 0);
      if (!open && !final && couldBeTagPrefix(text.pending)) break;
      const parsed = open ? parsePrefix(text.pending, tools, fencedSpans(text.pending)) : { status: 'invalid' as const };
      if (parsed.status === 'valid') {
        const chunk = text.pending.slice(0, parsed.end);
        // Same echo rule as the buffered path: never upgrade verbatim user /
        // tool_result text into an executable tool_call (ADR-0034).
        const full = `${text.clean}${chunk}`.trim();
        if (echoed.has(chunk.trim()) || echoed.has(full)) {
          emit(chunk);
          text.pending = text.pending.slice(parsed.end);
          continue;
        }
        state.recovered.push(...parsed.calls);
        text.suppressed.push(chunk);
        text.pending = text.pending.slice(parsed.end);
        continue;
      }
      if (parsed.status === 'incomplete' && !final) break;
      if (open && !open.closing && (open.kind === 'tool_calls' || open.kind === 'invoke')) {
        // Malformed wrapper / invoke is indivisible (ADR-0034): skip the whole
        // matching block as plain text instead of advancing by 1 char and
        // rescuing an inner sibling invoke.
        const closeEnd = findMatchingCloseEnd(text.pending, open.end, open.kind, fencedSpans(text.pending));
        if (closeEnd !== null) {
          emit(text.pending.slice(0, closeEnd));
          text.pending = text.pending.slice(closeEnd);
          continue;
        }
        if (!final && open.kind === 'tool_calls') break;
      }
      // Invalid or truncated markup remains ordinary text. Emitting only the
      // first character lets the loop find any later valid, independent block.
      emit(text.pending[0]!);
      text.pending = text.pending.slice(1);
    }
    if (final) {
      emit(text.pending);
      text.pending = '';
      text.finalized = true;
    }
    return emitted;
  };
  const emitTools = (state: CandidateState, candidateIndex: number, includeRecovered: boolean): StreamEvent[] => {
    const events: StreamEvent[] = [];
    const native = [...state.native.entries()].sort(([a], [b]) => a - b);
    const remaining: RecoveredToolCall[] = [];
    let applied = 0;
    for (const call of includeRecovered ? state.recovered : []) {
      const placeholderEntry = native.find(([, item]) => item.name === call.name && placeholder(item));
      if (placeholderEntry) {
        placeholderEntry[1].arguments = call.arguments;
        applied += 1;
        continue;
      }
      if (native.some(([, item]) => item.name === call.name && !placeholder(item))) continue;
      remaining.push(call);
    }
    const emitCall = (index: number, item: ToolCallItem): void => {
      events.push({ type: 'response.output_item.added', candidateIndex, index, item: { ...item, arguments: '' } });
      events.push({ type: 'response.function_call.arguments.delta', candidateIndex, index, argumentsDelta: item.arguments });
      events.push({ type: 'response.function_call.arguments.done', candidateIndex, index, arguments: item.arguments });
      events.push({ type: 'response.output_item.done', candidateIndex, index, item: { ...item } });
    };
    native.forEach(([index, item]) => emitCall(index, item));
    let sequence = 0;
    for (const call of remaining) {
      const id = syntheticId(responseId, candidateIndex, ++sequence);
      const index = state.nextIndex++;
      emitCall(index, { type: 'tool_call', id, callId: id, status: 'completed', name: call.name, arguments: call.arguments });
      applied += 1;
    }
    if (includeRecovered) recovered += applied;
    state.recovered = [];
    return events;
  };
  const finish = (terminal?: StreamEvent): StreamEvent[] => {
    if (finished) return [];
    finished = true;
    const events: StreamEvent[] = [];
    const includeRecovered = !terminal || terminal.type === 'response.completed' || terminal.type === 'response.incomplete';
    for (const [candidateIndex, state] of candidates) {
      for (const [key, text] of state.texts) {
        const [index, partIndex] = key.split(':').map(Number);
        if (!includeRecovered && text.suppressed.length) {
          // A failed turn must not execute a recovered call, but its source is
          // still upstream output. Re-emit what was suppressed instead of
          // silently deleting it; clients cannot retract deltas already sent.
          const restored = text.suppressed.join('');
          const previousClean = text.clean;
          text.clean += restored;
          if (text.finalized) {
            events.push(
              { type: 'response.content_part.added', candidateIndex, index: index!, partIndex: partIndex!, part: { type: 'text', text: previousClean } },
              { type: 'response.output_text.delta', candidateIndex, index: index!, partIndex: partIndex!, text: restored },
              { type: 'response.output_text.done', candidateIndex, index: index!, partIndex: partIndex!, text: text.clean },
              { type: 'response.content_part.done', candidateIndex, index: index!, partIndex: partIndex!, part: { type: 'text', text: text.clean } },
            );
          } else {
            events.push({ type: 'response.output_text.delta', candidateIndex, index: index!, partIndex: partIndex!, text: restored });
          }
        }
        drain(state, text, true).forEach((value) => events.push({
          type: 'response.output_text.delta', candidateIndex, index: index!, partIndex: partIndex!, text: value,
        }));
      }
      events.push(...emitTools(state, candidateIndex, includeRecovered));
    }
    if (terminal) events.push(terminal);
    return events;
  };
  return {
    push(event): StreamEvent[] {
      if (finished) return [event];
      if (event.type === 'response.created') {
        if (event.id) responseId = event.id;
        return [event];
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error') {
        return finish(event);
      }
      const candidateIndex = event.candidateIndex ?? 0;
      const state = candidate(candidateIndex);
      if ('index' in event) state.nextIndex = Math.max(state.nextIndex, event.index + 1);
      if (event.type === 'response.output_text.delta') {
        const text = textState(state, event);
        text.pending += event.text;
        return drain(state, text, false).map((value) => ({ ...event, text: value }));
      }
      if (event.type === 'response.output_text.done') {
        const text = textState(state, event);
        const events = drain(state, text, true).map((value): StreamEvent => ({
          type: 'response.output_text.delta', candidateIndex, index: event.index, partIndex: event.partIndex, text: value,
        }));
        events.push({ ...event, text: text.clean });
        return events;
      }
      if (event.type === 'response.content_part.done' && event.part.type === 'text') {
        return [{ ...event, part: { ...event.part, text: textState(state, event).clean } }];
      }
      if (event.type === 'response.output_item.done' && event.item.type === 'message') {
        return [{
          ...event,
          item: {
            ...event.item,
            content: event.item.content.map((part, partIndex) => part.type === 'text'
              ? { ...part, text: textState(state, { index: event.index, partIndex }).clean }
              : part),
          },
        }];
      }
      if (event.type === 'response.output_item.added' && event.item.type === 'tool_call') {
        state.native.set(event.index, { ...event.item });
        return [];
      }
      if (event.type === 'response.function_call.arguments.delta') {
        const item = state.native.get(event.index);
        if (item) item.arguments += event.argumentsDelta;
        return [];
      }
      if (event.type === 'response.function_call.arguments.done') {
        const item = state.native.get(event.index);
        if (item) item.arguments = event.arguments;
        return [];
      }
      if (event.type === 'response.output_item.done' && event.item.type === 'tool_call') {
        state.native.set(event.index, { ...event.item });
        return [];
      }
      return [event];
    },
    finish,
    finishResponse(response): CanonicalResponse {
      return finishResponse(response, recovered);
    },
  };
}
