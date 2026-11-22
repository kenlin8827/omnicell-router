import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../../src/types/openai.js';
import type { CanonicalRequest, CanonicalResponse, InputItem, OutputItem } from '../../src/ir/types.js';
import type { ModelRegistration } from '../../src/config/types.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { chatRequestToIR, chatResponseToIR, irToChatRequest, irToChatResponse } from '../../src/ir/adapters/openai-chat.js';
import { anthropicResponseToIR, canonicalToAnthropicPayload } from '../../src/ir/adapters/anthropic-messages.js';
import { canonicalToGooglePayload, googleResponseToIR } from '../../src/ir/adapters/google-gemini.js';
import { canonicalToResponsesPayload, responsesResponseToIR } from '../../src/ir/adapters/openai-responses.js';
import { UpstreamError } from '../../src/resilience/error-classifier.js';
import { scanDirectives } from '../../src/pipeline/directives.js';
import { Layer2Decision } from '../../src/router/layer2-decision.js';

/** Build the production IR explicitly at the test boundary. */
export function toIR<T extends ChatCompletionRequest>(request: T): CanonicalRequest & T {
  const controls = Object.fromEntries(Object.entries(request).filter(([key]) => key.startsWith('__simulate_')));
  return { ...chatRequestToIR(request), ...controls } as CanonicalRequest & T;
}

export function processIR(
  orchestrator: import('../../src/pipeline/orchestrator.js').PipelineOrchestrator,
  request: ChatCompletionRequest & Record<string, unknown>,
  context?: Parameters<typeof orchestrator.process>[1],
  relay?: Parameters<typeof orchestrator.process>[2],
) {
  return orchestrator.process(toIR(request), context, relay);
}

export function evaluateIR(
  request: ChatCompletionRequest,
  ...args: Parameters<typeof Layer2Decision.evaluate> extends [unknown, ...infer Rest] ? Rest : never
) {
  return Layer2Decision.evaluate(toIR(request), ...args);
}

export function resolveIR(
  manager: SessionManager,
  request: ChatCompletionRequest,
  ...args: Parameters<SessionManager['resolveSessionId']> extends [unknown, ...infer Rest] ? Rest : never
) {
  return manager.resolveSessionId(toIR(request), ...args);
}

export function messagesOf(request: CanonicalRequest): ChatMessage[] {
  return irToChatRequest(request, request.model).messages;
}

export function scanChatDirectives(
  messages: ChatMessage[],
  prefix?: string | null,
) {
  const scan = scanDirectives(inputOf(messages), prefix);
  return { ...scan, messages: messagesOf({ model: 'auto', input: scan.input }) };
}

export function inputOf(messages: ChatMessage[]): InputItem[] {
  return chatRequestToIR({ model: 'auto', stream: false, messages }).input;
}

export function outputOf(message: ChatMessage | string): OutputItem[] {
  const normalized: ChatMessage = typeof message === 'string'
    ? { role: 'assistant', content: message }
    : { ...message, role: 'assistant' };
  return chatResponseToIR({
    id: 'test-response', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, message: normalized as ChatCompletionResponse['choices'][number]['message'], finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }).output;
}

export function responseIR(text = 'ok', overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'resp_test', createdAt: 1, model: 'upstream-model', status: 'completed', reason: 'stop',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text }] }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ...overrides,
  };
}

export function chatOf(response: CanonicalResponse, model = response.model ?? 'test-model'): ChatCompletionResponse {
  return irToChatResponse(response, response.id ?? 'test-response', model);
}

export function responseToIR(response: ChatCompletionResponse): CanonicalResponse {
  return chatResponseToIR(response);
}

export function registerTurn(
  manager: import('../../src/session/session-manager.js').SessionManager,
  sessionId: string,
  messages: ChatMessage[],
  assistant: ChatMessage | string,
): void {
  manager.registerCompletedTurn(sessionId, SessionManager.serializeInput(inputOf(messages)), outputOf(assistant));
}

export const buildAnthropicPayload = (request: ChatCompletionRequest, model: ModelRegistration): Record<string, unknown> =>
  canonicalToAnthropicPayload(toIR(request), model);
export const anthropicToChatCompletion = (data: unknown, model: ModelRegistration): ChatCompletionResponse => {
  const response = anthropicResponseToIR(data);
  return irToChatResponse(response, response.id ?? 'anthropic-test', model.id);
};
export const buildGooglePayload = (request: ChatCompletionRequest, model: ModelRegistration): Record<string, unknown> =>
  canonicalToGooglePayload(toIR(request), model);
export const googleToChatCompletion = (data: unknown, model: ModelRegistration): ChatCompletionResponse => {
  const response = googleResponseToIR(data);
  return irToChatResponse(response, response.id ?? 'google-test', model.id);
};
export const buildResponsesPayload = (request: ChatCompletionRequest, model: ModelRegistration): Record<string, unknown> =>
  canonicalToResponsesPayload(toIR(request), model);
export const responsesToChatCompletion = (data: unknown, model: ModelRegistration): ChatCompletionResponse => {
  const body = data as { status?: string; error?: { message?: string } };
  if (body.status === 'failed') {
    throw new UpstreamError({ message: body.error?.message || 'Upstream Responses turn failed.', status: 502 });
  }
  const response = responsesResponseToIR(data);
  return irToChatResponse(response, response.id ?? 'responses-test', model.id);
};
