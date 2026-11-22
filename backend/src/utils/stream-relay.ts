import type { StreamEvent } from '../ir/types.js';
import type { ReasoningEffort } from '../types/router.js';

/** Routing facts available before an upstream attempt emits its first event. */
export interface StreamRoutingFacts {
  modelUsed?: string;
  tierUsed?: string;
  layerUsed?: 'layer0' | 'entry' | 'layer2';
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: string;
  requestId?: string;
  requestedEffort?: ReasoningEffort;
  variantUsed?: string;
  /** OUTBOUND protocol id of the attempt that is about to emit (`protocolForWire`
   *  of the candidate's wire) — the stream's X-OCR-Protocol, staged with the
   *  rest of the routing facts. */
  protocolUsed?: string;
}

/**
 * Client-facing relay for one canonical upstream event stream.
 *
 * The commit boundary is the first byte sent to the client. Before it, an
 * attempt may fail over; after it, replaying another candidate would duplicate
 * output, so the pipeline must close the stream instead.
 */
export interface StreamRelay {
  /** Stage routing headers for the attempt that is about to emit. */
  stageRouting(facts: StreamRoutingFacts): void;
  /** Forward one canonical event in arrival order; await applies client backpressure. */
  onChunk(event: StreamEvent): void | Promise<void>;
  /** Record the actual upstream transport for observability. */
  onTransport?(kind: 'sse' | 'buffered'): void;
  /** True once any byte has reached the client. */
  readonly committed: boolean;
}
