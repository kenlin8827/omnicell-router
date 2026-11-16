import { ChatCompletionRequest } from '../types/openai.js';

/**
 * Request traits — the rule-based request facts the routing pipeline still
 * consumes after the Layer 1 classifier was retired. Everything here is a
 * direct read of the request payload (no learned weights, no scoring).
 */

/**
 * True when the request declares a MACHINE-CHECKABLE output contract: an
 * explicit JSON `response_format`. This is what arms the orchestrator's
 * lite-first schema-assertion cascade (5A), and it must stay narrower than
 * "the request mentions structured data":
 *
 * `SchemaAssertion.validate(content, response_format)` has exactly one
 * contract to check — a declared JSON schema/shape. A `tools: []` list is NOT
 * one: a tool-call answer carries no content to validate, so a tools-only
 * request could never PASS the assertion, and the lite lead's generation was
 * paid for and discarded on every turn (proven: a tools-only auto request
 * reported `fallbackReason: 'JSON SyntaxError …'` and served plus). Arming the
 * cascade from `tools` therefore doubled upstream latency for agent traffic
 * while changing nothing about the answer.
 */
export function declaresJsonContract(request: ChatCompletionRequest): boolean {
  return (
    request.response_format?.type === 'json_object' ||
    request.response_format?.type === 'json_schema'
  );
}

/**
 * The recorded REQUEST FACT (trace / debugging): the payload carries an
 * explicit JSON response format or a tool/function list. Observational only —
 * it never arms the schema-assertion cascade (see `declaresJsonContract`).
 */
export function hasToolsOrSchema(request: ChatCompletionRequest): boolean {
  const hasTools = !!(request.tools && request.tools.length > 0);
  return declaresJsonContract(request) || hasTools;
}
