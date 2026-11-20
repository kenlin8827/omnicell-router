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
  ): Promise<CanonicalResponse>;

  /** Probe before fetch; absent createStream means buffered-only. */
  supportsStreaming?(model: ModelRegistration): boolean;

  /** Native upstream stream, decoded once at the protocol boundary. */
  createStream?(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>>;
}
