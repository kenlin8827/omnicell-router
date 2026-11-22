/**
 * A conversion that cannot be performed without changing meaning. The HTTP
 * layer maps this to `400 unsupported_parameter` (client fault) — an IR adapter
 * MUST throw this instead of silently dropping a load-bearing field.
 */
export class IrUnsupportedError extends Error {
  readonly statusCode = 400;

  constructor(
    /** Machine code, e.g. `input_file`, `tool_choice`, `response_format`. */
    readonly code: string,
    message: string,
    /** Protocol that cannot represent the feature (for the error detail). */
    readonly protocol?: string,
  ) {
    super(message);
    this.name = 'IrUnsupportedError';
  }
}

/** A southbound wire returned an error body; adapters use this for 502s. */
export class IrUpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'IrUpstreamError';
  }
}
