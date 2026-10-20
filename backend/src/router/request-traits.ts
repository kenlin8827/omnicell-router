import { ChatCompletionRequest } from '../types/openai.js';

/**
 * Request traits — the rule-based request facts the routing pipeline still
 * consumes after the Layer 1 classifier was retired. Everything here is a
 * direct read of the request payload (no learned weights, no scoring):
 * the one live consumer is the structured-output gate that arms the
 * orchestrator's lite-first schema-assertion cascade (5A).
 */

/** True when the request pins a machine-checked output contract: an explicit
 *  JSON response format or a tool/function list the model may call. */
export function hasToolsOrSchema(request: ChatCompletionRequest): boolean {
  const hasJsonFormat =
    request.response_format?.type === 'json_object' ||
    request.response_format?.type === 'json_schema';
  const hasTools = !!(request.tools && request.tools.length > 0);
  return hasJsonFormat || hasTools;
}
