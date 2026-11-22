/**
 * Opt-in live-provider contract checks. This file is deliberately outside the
 * hermetic test runner: it performs paid network calls only when BOTH
 * OCR_LIVE_TEST=1 and OCR_LIVE_PROVIDERS are explicitly supplied.
 *
 * Example (PowerShell):
 *   $env:OCR_LIVE_TEST='1'
 *   $env:OCR_LIVE_PROVIDERS='chat,responses,anthropic,google'
 *   $env:OCR_LIVE_CHAT_API_KEY='...'
 *   $env:OCR_LIVE_CHAT_MODEL='...'
 *   bun run test:live
 *
 * Repeat the API_KEY/MODEL pair for each selected protocol. BASE_URL and
 * TIMEOUT_MS are optional. No configured provider, credential or OCR home is
 * read implicitly; a missing configuration is SKIPPED, never counted as pass.
 */
import type { ModelRegistration, ProviderConfig } from '../backend/src/config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../backend/src/ir/types.js';
import type { LLMProvider } from '../backend/src/providers/base.js';
import { OpenAIChatProvider } from '../backend/src/providers/executors/openai-chat.js';
import { OpenAIResponsesProvider } from '../backend/src/providers/executors/openai-responses.js';
import { AnthropicMessagesProvider } from '../backend/src/providers/executors/anthropic-messages.js';
import { GoogleGeminiProvider } from '../backend/src/providers/executors/google-gemini.js';
import { createEventAccumulator } from '../backend/src/ir/stream.js';

type Protocol = 'chat' | 'responses' | 'anthropic' | 'google';
type CheckStatus = 'pass' | 'fail' | 'skipped';

interface CheckResult {
  protocol: Protocol;
  check: string;
  status: CheckStatus;
  elapsedMs: number;
  detail?: string;
}

const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'google'];
const selected = (process.env.OCR_LIVE_PROVIDERS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (process.env.OCR_LIVE_TEST !== '1' || selected.length === 0) {
  console.error('Live checks are disabled. Set OCR_LIVE_TEST=1 and OCR_LIVE_PROVIDERS=chat,responses,anthropic,google explicitly.');
  process.exit(2);
}
const unknown = selected.filter((value) => !protocols.includes(value as Protocol));
if (unknown.length) {
  console.error(`Unknown live protocol(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const timeoutMs = Number(process.env.OCR_LIVE_TIMEOUT_MS ?? 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  console.error('OCR_LIVE_TIMEOUT_MS must be a number >= 1000.');
  process.exit(2);
}

function env(protocol: Protocol, suffix: string): string | undefined {
  return process.env[`OCR_LIVE_${protocol.toUpperCase()}_${suffix}`]?.trim() || undefined;
}

function providerFor(protocol: Protocol): { provider: LLMProvider; model: ModelRegistration } | undefined {
  const prefix = protocol.toUpperCase();
  const apiKey = env(protocol, 'API_KEY');
  const upstreamModel = env(protocol, 'MODEL');
  if (!apiKey || !upstreamModel) return undefined;
  const defaults: Record<Protocol, { type: ProviderConfig['type']; wire: ModelRegistration['wire']; baseUrl: string }> = {
    chat: { type: 'openai-chat', wire: 'openai-chat', baseUrl: 'https://api.openai.com/v1' },
    responses: { type: 'openai-responses', wire: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { type: 'anthropic-messages', wire: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
    google: { type: 'google-gemini', wire: 'google-gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  };
  const selected = defaults[protocol];
  const protoTimeoutRaw = env(protocol, 'TIMEOUT_MS');
  const protoTimeoutMs = protoTimeoutRaw !== undefined ? Number(protoTimeoutRaw) : timeoutMs;
  const effectiveTimeoutMs = Number.isFinite(protoTimeoutMs) && protoTimeoutMs >= 1_000 ? protoTimeoutMs : timeoutMs;
  const config: ProviderConfig = {
    name: `live-${protocol}`,
    type: selected.type,
    baseUrl: env(protocol, 'BASE_URL') ?? selected.baseUrl,
    apiKey,
    timeoutMs: effectiveTimeoutMs,
    streamTimeoutMs: effectiveTimeoutMs,
    streamIdleTimeoutMs: Math.min(effectiveTimeoutMs, 120_000),
    ...(protocol === 'chat' && env(protocol, 'ORGANIZATION') ? { organization: env(protocol, 'ORGANIZATION') } : {}),
  };
  const model: ModelRegistration = {
    id: `live-${protocol}/contract`,
    provider: config.name,
    upstreamModel,
    tier: 'plus',
    wire: selected.wire,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    // Live checks use the least common denominator supported by all providers.
    supportsDeveloperRole: false,
  };
  const provider = protocol === 'chat' ? new OpenAIChatProvider(config)
    : protocol === 'responses' ? new OpenAIResponsesProvider(config)
      : protocol === 'anthropic' ? new AnthropicMessagesProvider(config)
        : new GoogleGeminiProvider(config);
  if (!provider.createStream) throw new Error(`${prefix} provider has no native stream implementation.`);
  return { provider, model };
}

function textRequest(stream: boolean): CanonicalRequest {
  return {
    model: 'live-contract',
    stream,
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Reply briefly with OCR_LIVE_OK.' }] }],
    generation: { maxOutputTokens: 128 },
  };
}

function toolRequest(stream: boolean): CanonicalRequest {
  return {
    model: 'live-contract',
    stream,
    input: [{
      type: 'message', role: 'user',
      content: [{ type: 'text', text: 'Call ocr_live_echo exactly once with value "gateway". Do not answer in prose.' }],
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'ocr_live_echo',
        description: 'Return the supplied contract-test value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    }],
    toolChoice: { type: 'required' },
    generation: { maxOutputTokens: 256 },
  };
}

function textOf(response: CanonicalResponse): string {
  return response.output.flatMap((item) => item.type === 'message'
    ? item.content.flatMap((part) => part.type === 'text' ? [part.text] : [])
    : []).join('');
}

function assertTerminal(response: CanonicalResponse): void {
  if (response.status === 'failed') throw new Error(response.error?.message ?? String(response.reason ?? 'Provider returned a failed response.'));
  if (response.status !== 'completed' && response.status !== 'incomplete') {
    throw new Error(`Unexpected terminal status: ${response.status}`);
  }
}

function assertText(response: CanonicalResponse): string {
  assertTerminal(response);
  const text = textOf(response).trim();
  if (!text) throw new Error('No assistant text was decoded.');
  return `${text.length} text chars; usage ${response.usage.inputTokens}+${response.usage.outputTokens}; cached ${response.usage.cachedInputTokens ?? 'not reported'}`;
}

function assertTool(response: CanonicalResponse): string {
  assertTerminal(response);
  const call = response.output.find((item) => item.type === 'tool_call');
  if (!call || call.type !== 'tool_call') throw new Error('No tool call was decoded.');
  if (call.name !== 'ocr_live_echo') throw new Error(`Unexpected tool name: ${call.name || '(empty)'}`);
  const args = JSON.parse(call.arguments) as { value?: unknown };
  if (args.value !== 'gateway') throw new Error('Tool arguments did not preserve the requested value.');
  return `${call.name}; cached ${response.usage.cachedInputTokens ?? 'not reported'}`;
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<CanonicalResponse> {
  const accumulator = createEventAccumulator();
  for await (const event of stream) accumulator.push(event);
  return accumulator.finish();
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const protocol of protocols) {
    const secret = env(protocol, 'API_KEY');
    if (!secret) continue;
    message = message.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) message = message.split(encoded).join('[REDACTED]');
  }
  return message.slice(0, 2_000);
}

const results: CheckResult[] = [];
for (const protocol of [...new Set(selected)] as Protocol[]) {
  let target: ReturnType<typeof providerFor>;
  try {
    target = providerFor(protocol);
  } catch (error) {
    results.push({ protocol, check: 'setup', status: 'fail', elapsedMs: 0, detail: safeError(error) });
    continue;
  }
  if (!target) {
    results.push({ protocol, check: 'setup', status: 'skipped', elapsedMs: 0, detail: `Set OCR_LIVE_${protocol.toUpperCase()}_API_KEY and _MODEL to enable.` });
    continue;
  }
  const cases: { name: string; run: () => Promise<string> }[] = [
    { name: 'buffered-text', run: async () => assertText(await target.provider.createCompletion(textRequest(false), target.model)) },
    { name: 'native-stream-text', run: async () => assertText(await drain(await target.provider.createStream!(textRequest(true), target.model))) },
    { name: 'buffered-tool', run: async () => assertTool(await target.provider.createCompletion(toolRequest(false), target.model)) },
    { name: 'native-stream-tool', run: async () => assertTool(await drain(await target.provider.createStream!(toolRequest(true), target.model))) },
  ];
  for (const test of cases) {
    const started = performance.now();
    try {
      const detail = await test.run();
      results.push({ protocol, check: test.name, status: 'pass', elapsedMs: Math.round(performance.now() - started), detail });
    } catch (error) {
      results.push({ protocol, check: test.name, status: 'fail', elapsedMs: Math.round(performance.now() - started), detail: safeError(error) });
    }
  }
}

for (const result of results) {
  const mark = result.status === 'pass' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  console.log(`${mark.padEnd(4)} ${result.protocol.padEnd(9)} ${result.check.padEnd(19)} ${String(result.elapsedMs).padStart(6)} ms${result.detail ? ` — ${result.detail}` : ''}`);
}
const count = (status: CheckStatus) => results.filter((result) => result.status === status).length;
console.log(`LIVE TOTAL: ${count('pass')} pass, ${count('fail')} fail, ${count('skipped')} skipped. Skipped is not verified.`);
if (count('fail') > 0 || count('pass') === 0) process.exit(1);
