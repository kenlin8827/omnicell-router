import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../ir/types.js';
import type { ModelRegistration } from '../config/types.js';
import type { UpstreamEventContext } from '../observability/upstream-events.js';
import type { CallCredential } from '../opencode/credentials/types.js';

export type { CallCredential, UpstreamEventContext };

/** The sole southbound execution contract: Canonical IR in, Canonical IR out. */
export interface LLMProvider {
  name: string;
  createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
    /** Resolved OCR conversation id. Independent of request capture. */
    sessionId?: string,
  ): Promise<CanonicalResponse>;

  /** Probe before fetch; absent createStream means buffered-only. */
  supportsStreaming?(model: ModelRegistration): boolean;

  /**
   * Base URL this transport will dial for `model`. The trace's egress stamp
   * resolves the outbound-proxy decision against THIS url at dial time —
   * never against registry-level provider config: a dispatching provider
   * dials a different base per wire. Absent = the transport does not report
   * its dial base (plugin-owned executors), which reads as UNKNOWN egress.
   */
  dialBaseFor?(model: ModelRegistration): string | undefined;

  /** Native upstream stream, decoded once at the protocol boundary. */
  createStream?(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
    /** Resolved OCR conversation id. Independent of request capture. */
    sessionId?: string,
  ): Promise<AsyncIterable<StreamEvent>>;
}
