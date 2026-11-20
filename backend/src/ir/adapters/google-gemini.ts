import crypto from 'node:crypto';
import type { ModelRegistration } from '../../config/types.js';
import { EFFORT_TO_BUDGET } from '../../types/router.js';
import { IrUnsupportedError } from '../errors.js';
import type {
  CanonicalCandidate,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  OutputItem,
  Usage,
} from '../types.js';
import { assertCanonicalRequestSupported } from '../validate.js';

const PROTOCOL = 'google-gemini' as const;

type Wire = Record<string, any>;

function record(value: unknown): Wire {
  return value && typeof value === 'object' ? value as Wire : {};
}

function fail(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, PROTOCOL);
}

const GEMINI_SCHEMA_ALLOWED_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'anyOf', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength',
  'maxLength', 'pattern',
]);

function resolveSchemaRef(ref: string, root: Wire): Wire | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Wire)[part];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur as Wire : undefined;
}

function isNullSchema(node: unknown): boolean {
  return Boolean(node && typeof node === 'object' && !Array.isArray(node) && (node as Wire).type === 'null');
}

/**
 * Normalize standard JSON Schema (MCP/OpenAI/Zod) into Gemini's Schema subset:
 * resolves local `#/$defs/*` `$ref`s, folds null union branches into `nullable`,
 * converts `const` to single-value `enum`, and drops unsupported keywords
 * (`$schema`, `additionalProperties`, `default`, `title`, etc.).
 */
function sanitizeGeminiSchema(raw: unknown): Wire {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'object', properties: {} };
  }
  const root = raw as Wire;
  const visit = (node: unknown, seenRefs: Set<string>): Wire => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
    let source = node as Wire;
    if (typeof source.$ref === 'string') {
      const ref = source.$ref;
      if (!seenRefs.has(ref)) {
        const target = resolveSchemaRef(ref, root);
        if (target) {
          const nextSeen = new Set(seenRefs);
          nextSeen.add(ref);
          const resolved = visit(target, nextSeen);
          const { $ref: _ignored, ...rest } = source;
          if (Object.keys(rest).length === 0) return resolved;
          source = { ...resolved, ...rest };
        }
      }
    }
    const out: Wire = {};
    for (const key of Object.keys(source)) {
      if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) continue;
      out[key] = source[key];
    }
    if (source.const !== undefined && out.enum === undefined) {
      out.enum = [source.const];
    }
    if (Array.isArray(source.type)) {
      const nonNull = source.type.filter((t): t is string => typeof t === 'string' && t !== 'null');
      if (nonNull.length < source.type.length) out.nullable = true;
      if (nonNull.length === 1) {
        out.type = nonNull[0];
      } else if (nonNull.length > 1) {
        delete out.type;
        out.anyOf = nonNull.map((t) => ({ type: t }));
      } else {
        delete out.type;
      }
    } else if (source.type === 'null') {
      delete out.type;
      out.nullable = true;
    }
    if (Array.isArray(out.anyOf)) {
      const nonNullBranches = out.anyOf.filter((b: unknown) => !isNullSchema(b)).map((b: unknown) => visit(b, seenRefs));
      const hadNull = nonNullBranches.length < out.anyOf.length;
      if (hadNull) out.nullable = true;
      if (nonNullBranches.length === 1) {
        const single = nonNullBranches[0]!;
        delete out.anyOf;
        for (const [k, v] of Object.entries(single)) {
          if (out[k] === undefined) out[k] = v;
        }
      } else if (nonNullBranches.length > 1) {
        out.anyOf = nonNullBranches;
      } else {
        delete out.anyOf;
      }
    }
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
      const props: Wire = {};
      for (const [k, v] of Object.entries(out.properties as Wire)) {
        props[k] = visit(v, seenRefs);
      }
      out.properties = props;
      if (Array.isArray(out.required)) {
        const filtered = out.required.filter((r: unknown): r is string => typeof r === 'string' && Object.hasOwn(props, r));
        if (filtered.length > 0) out.required = filtered;
        else delete out.required;
      }
    }
    if (out.items !== undefined) {
      if (Array.isArray(out.items)) {
        out.items = out.items.map((item: unknown) => visit(item, seenRefs));
      } else if (out.items && typeof out.items === 'object') {
        out.items = visit(out.items, seenRefs);
      }
    }
    return out;
  };
  return visit(root, new Set());
}

function parseObject(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  } catch {
    return { result: raw };
  }
}

function parseToolArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The explicit error below is the functionCall contract.
  }
  return fail('tool_arguments', 'Gemini functionCall args require a JSON object string.');
}

function wrapToolResponse(raw: string): Record<string, any> {
  const parsed = parseObject(raw);
  return Object.keys(parsed).length ? parsed : { result: 'ok' };
}

function sourceToWire(part: Extract<ContentPart, { source: unknown }>): Wire {
  if (part.source.kind === 'base64') {
    return { inlineData: { mimeType: part.source.mediaType, data: part.source.data } };
  }
  if (part.source.kind === 'url') {
    return { fileData: { fileUri: part.source.url } };
  }
  return { fileData: { fileUri: part.source.fileId } };
}

function partToWire(part: ContentPart): Wire {
  if (part.type === 'extension') {
    if (part.protocol !== PROTOCOL) fail('content_part', `Cannot convert ${part.protocol} content.`);
    return record(part.payload);
  }
  if (part.type === 'text') {
    return { text: part.text, ...(part.signature ? { thoughtSignature: part.signature } : {}) };
  }
  if (part.type === 'image' || part.type === 'file' || part.type === 'audio') {
    return { ...sourceToWire(part), ...(part.signature ? { thoughtSignature: part.signature } : {}) };
  }
  fail('content_part', `Gemini cannot carry ${part.type} content.`);
}

function partFromWire(raw: unknown): { part?: ContentPart; reasoning?: string; reasoningSignature?: string; call?: OutputItem } {
  const value = record(raw);
  if (value.functionCall) {
    const call = record(value.functionCall);
    const id = `call_${crypto.randomBytes(8).toString('hex')}`;
    return {
      call: {
        type: 'tool_call', id, callId: id,
        name: String(call.name ?? ''), arguments: JSON.stringify(call.args ?? {}),
        ...(typeof value.thoughtSignature === 'string' ? { signature: value.thoughtSignature } : {}),
      },
    };
  }
  if (typeof value.text === 'string') {
    if (value.thought === true) {
      return {
        reasoning: value.text,
        ...(typeof value.thoughtSignature === 'string' ? { reasoningSignature: value.thoughtSignature } : {}),
      };
    }
    return {
      part: {
        type: 'text', text: value.text,
        ...(typeof value.thoughtSignature === 'string' ? { signature: value.thoughtSignature } : {}),
      },
    };
  }
  const inline = record(value.inlineData);
  if (typeof inline.data === 'string') {
    const mediaType = typeof inline.mimeType === 'string' ? inline.mimeType : 'application/octet-stream';
    const kind = mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('audio/') ? 'audio' : 'file';
    return {
      part: {
        type: kind,
        source: { kind: 'base64', mediaType, data: inline.data },
        ...(typeof value.thoughtSignature === 'string' ? { signature: value.thoughtSignature } : {}),
      } as ContentPart,
    };
  }
  return { part: { type: 'extension', protocol: PROTOCOL, payload: raw } };
}

/** Canonical IR → Gemini generateContent request. */
export function canonicalToGooglePayload(ir: CanonicalRequest, model: ModelRegistration): Wire {
  assertCanonicalRequestSupported(ir, PROTOCOL);
  const nameByCall = new Map<string, string>();
  for (const item of ir.input) if (item.type === 'tool_call') nameByCall.set(item.callId ?? item.id, item.name);
  const contents: Wire[] = [];
  let pendingRole: 'user' | 'model' | undefined;
  let pendingParts: Wire[] = [];
  const flush = (): void => {
    if (!pendingRole || !pendingParts.length) {
      pendingRole = undefined;
      pendingParts = [];
      return;
    }
    contents.push({ role: pendingRole, parts: pendingParts });
    pendingRole = undefined;
    pendingParts = [];
  };
  const append = (role: 'user' | 'model', parts: Wire[]): void => {
    if (!parts.length) return;
    if (pendingRole !== role) flush();
    pendingRole = role;
    pendingParts.push(...parts);
  };
  for (const item of ir.input) {
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') continue;
      append(item.role === 'assistant' ? 'model' : 'user', item.content.map(partToWire));
    } else if (item.type === 'reasoning') {
      if (item.encrypted) fail('reasoning_signature', 'Gemini reasoning replay cannot carry encrypted OpenAI/Anthropic thought blobs.');
      if (item.text || item.signature) {
        append('model', [{
          text: item.text ?? '',
          thought: true,
          ...(item.signature ? { thoughtSignature: item.signature } : {}),
        }]);
      }
    } else if (item.type === 'tool_call') {
      append('model', [{
        functionCall: { name: item.name, args: parseToolArguments(item.arguments) },
        ...(item.signature ? { thoughtSignature: item.signature } : {}),
      }]);
    } else if (item.type === 'tool_result') {
      if (!item.content.every((part) => part.type === 'text')) {
        fail('tool_result_content', 'Gemini functionResponse carries textual structured results only.');
      }
      const name = nameByCall.get(item.callId);
      if (!name) fail('tool_call_pairing', `No Gemini function call found for tool result "${item.callId}".`);
      append('user', [{
        functionResponse: {
          name,
          response: wrapToolResponse(item.content.map((part) => part.type === 'text' ? part.text : '').join('\n')),
        },
      }]);
    } else {
      fail('input_item', 'Gemini cannot resolve item references or foreign extension items.');
    }
  }
  flush();
  const systemText = [ir.instructions, ...ir.input.flatMap((item) => item.type === 'message' && (item.role === 'system' || item.role === 'developer')
    ? [item.content.map((part) => part.type === 'text' ? part.text : fail('system_part', 'Gemini system instructions carry text only.')).join('\n\n')]
    : [])].filter(Boolean).join('\n\n');
  const generation: Wire = {};
  const params = ir.generation;
  if (params?.maxOutputTokens !== undefined) generation.maxOutputTokens = params.maxOutputTokens;
  if (params?.temperature !== undefined && model.temperature !== false) generation.temperature = params.temperature;
  if (params?.topP !== undefined) generation.topP = params.topP;
  if (params?.topK !== undefined) generation.topK = params.topK;
  if (params?.stop?.length) generation.stopSequences = params.stop;
  if (params?.seed !== undefined) generation.seed = params.seed;
  if (params?.presencePenalty !== undefined) generation.presencePenalty = params.presencePenalty;
  if (params?.frequencyPenalty !== undefined) generation.frequencyPenalty = params.frequencyPenalty;
  if (ir.n !== undefined) generation.candidateCount = ir.n;
  if (ir.text?.format?.type === 'json_object') generation.responseMimeType = 'application/json';
  if (ir.text?.format?.type === 'json_schema') {
    generation.responseMimeType = 'application/json';
    generation.responseSchema = sanitizeGeminiSchema(ir.text.format.schema);
  }
  const effort = ir.reasoning?.effort;
  if (ir.reasoning?.budgetTokens !== undefined && ir.reasoning.budgetTokens >= 0) {
    generation.thinkingConfig = {
      thinkingBudget: ir.reasoning.budgetTokens,
      includeThoughts: ir.reasoning.budgetTokens > 0,
    };
  } else if (effort && effort !== 'none') {
    generation.thinkingConfig = { thinkingBudget: EFFORT_TO_BUDGET[effort], includeThoughts: true };
  }
  const declarations = ir.tools?.map((tool) => {
    if (tool.type !== 'function') fail('tool_type', `Gemini carries function declarations only, not ${tool.type}.`);
    return {
      name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      parameters: sanitizeGeminiSchema(tool.function.parameters),
    };
  });
  const mode = ir.toolChoice?.type === 'none' ? 'NONE'
    : ir.toolChoice?.type === 'required' || ir.toolChoice?.type === 'function' ? 'ANY'
      : ir.toolChoice?.type === 'auto' ? 'AUTO' : undefined;
  if (ir.toolChoice && !mode) fail('tool_choice', `Gemini cannot express ${ir.toolChoice.type}.`);
  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(Object.keys(generation).length ? { generationConfig: generation } : {}),
    ...(declarations?.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(mode ? {
      toolConfig: {
        functionCallingConfig: {
          mode,
          ...(ir.toolChoice?.type === 'function' ? { allowedFunctionNames: [ir.toolChoice.name] } : {}),
        },
      },
    } : {}),
  };
}

function audioTokens(raw: unknown): number | undefined {
  if (!Array.isArray(raw)) return undefined;
  const total = raw.reduce((sum, entry) => {
    const detail = record(entry);
    return detail.modality === 'AUDIO' && typeof detail.tokenCount === 'number' ? sum + detail.tokenCount : sum;
  }, 0);
  return total > 0 ? total : undefined;
}

function usageFromWire(raw: unknown): Usage {
  const usage = record(raw);
  const audioInputTokens = audioTokens(usage.promptTokensDetails);
  const audioOutputTokens = audioTokens(usage.candidatesTokensDetails);
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.totalTokenCount !== undefined ? { totalTokens: usage.totalTokenCount } : {}),
    ...(usage.cachedContentTokenCount !== undefined ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
    ...(usage.thoughtsTokenCount !== undefined ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
    ...(audioInputTokens !== undefined ? { audioInputTokens } : {}),
    ...(audioOutputTokens !== undefined ? { audioOutputTokens } : {}),
  };
}

/** Gemini generateContent response → Canonical IR. All candidates are retained. */
export function googleResponseToIR(data: unknown): CanonicalResponse {
  const body = record(data);
  const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!rawCandidates.length) {
    const blocked = record(body.promptFeedback);
    return {
      status: 'incomplete', reason: 'content_filter', output: [], usage: usageFromWire(body.usageMetadata),
      vendor: { google: { blockReason: blocked.blockReason ?? 'EMPTY_CANDIDATES' } },
    };
  }
  const candidates = rawCandidates.map((raw, index): CanonicalCandidate => {
    const candidate = record(raw);
    const output: OutputItem[] = [];
    for (const rawPart of record(candidate.content).parts ?? []) {
      const converted = partFromWire(rawPart);
      if (converted.call) output.push(converted.call);
      if (converted.reasoning !== undefined) {
        output.push({
          type: 'reasoning',
          text: converted.reasoning,
          ...(converted.reasoningSignature ? { signature: converted.reasoningSignature } : {}),
        });
      }
      if (converted.part) output.push({ type: 'message', role: 'assistant', content: [converted.part] });
    }
    const metadata = {
      ...(candidate.groundingMetadata !== undefined ? { groundingMetadata: candidate.groundingMetadata } : {}),
      ...(candidate.logprobsResult !== undefined ? { logprobsResult: candidate.logprobsResult } : {}),
    };
    if (Object.keys(metadata).length) {
      output.push({ type: 'extension', protocol: PROTOCOL, payload: { type: 'candidate_metadata', ...metadata } });
    }
    const finish = candidate.finishReason;
    const reason = output.some((item) => item.type === 'tool_call') ? 'tool_calls'
      : finish === 'MAX_TOKENS' ? 'length'
        : finish === 'SAFETY' || finish === 'RECITATION' || finish === 'PROHIBITED_CONTENT' ? 'content_filter' : 'stop';
    return {
      index: typeof candidate.index === 'number' ? candidate.index : index,
      status: reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed',
      reason,
      output,
    };
  });
  const primary = candidates[0]!;
  return {
    id: `google-${Date.now()}`,
    createdAt: Math.floor(Date.now() / 1000),
    status: primary.status,
    reason: primary.reason,
    output: primary.output,
    ...(candidates.length > 1 ? { candidates } : {}),
    usage: usageFromWire(body.usageMetadata),
  };
}

export { usageFromWire as googleUsageFromWire };
