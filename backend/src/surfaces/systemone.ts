import type { DecisionSurface } from './types.js';

/**
 * The System One decision surface (wire 'systemone'). Surface DATA only —
 * the execution order lives in decision-pipeline.ts, and the executor
 * (protocols/systemone/decide.ts) is shared with the Layer 2 decision layer.
 *
 * Stateless decision wire: the named model is the model served (tier aliases
 * resolve to the access-filtered chain head; bare 'auto'/omit falls
 * back to `systemone.defaultModel`). `capture: 'configurable'` is the
 * protocol-level policy: the CLIENT leg may enter the
 * http-exchange capture only when `requestCapture.enabled` AND
 * `requestCapture.systemone.enabled` (the System One surface MASTER — off
 * silences BOTH legs; default ON, while the capture master is default OFF —
 * the decision payload is the client's internal state snapshot) are true,
 * and the pipeline emits only past every gate. A captured surface request
 * is FULL-CHAIN: the client exchange plus its upstream leg (the native
 * passthrough or the synthesized conversion call, per the resolved wire)
 * via the ctx handed to the executor; a decision model leg inside a routed chat turn is captured separately by
 * requestCapture.systemone.l2DecisionEnabled (sub-switch, effective only
 * when the surface master is on).
 */
export const systemoneSurface: DecisionSurface = {
  wire: 'systemone',
  exec: 'decision-pipeline',
  capture: 'configurable',
  routePath: '/v1/systemone',

  /**
   * Intentionally WIDER than routePath — by design. The MITM
   * forward-proxy leg must also claim System One-shaped decision traffic:
   * TypeSafe Jev (api.typesafe.ai/v1/systemone) and the Alibaba Bailian
   * compatible-mode decision endpoint both terminate in `/systemone`, and
   * the gateway serves them over the intercepted leg. Detection is the
   * table-driven suffix match in table.ts, so this string is the ONLY place
   * the widening lives.
   */
  detectSuffix: '/systemone',

  /**
   * OpenAI-ish envelope, verbatim semantics from the retired
   * routes/systemone.ts: {error:{message,type,code}} with
   * type = api_error for 5xx, invalid_request_error otherwise. Key insertion
   * order is wire-byte significant.
   */
  errorBody: (status: number, message: string, code?: string): unknown => {
    const error: Record<string, string> = {
      message,
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
    };
    if (code !== undefined) error.code = code;
    return { error };
  },
};
