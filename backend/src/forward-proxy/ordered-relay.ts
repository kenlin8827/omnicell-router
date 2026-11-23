/**
 * Orders what a decrypted client stream produced ahead of an asynchronous hop.
 *
 * The MITM leg reads the client's plaintext (a `tls.Socket`) and forwards it to
 * a loopback socket that feeds the inner HTTP server. Those two halves do not
 * become ready at the same moment: `net.connect()` returns a socket immediately
 * but connects on a later tick, while decrypted chunks keep arriving. Writing a
 * chunk to the (unconnected) socket queues it, so a later flush of the buffered
 * head lands AFTER it — the parser then reads a body fragment where it expects a
 * request line and answers `400` to a request it never saw. One small request
 * hides this (single chunk); a large prompt does not.
 *
 * So: everything pushed before `attach` is held, and `attach` hands the sink the
 * held bytes first, in order. After that, chunks go straight through.
 */
export class OrderedRelay {
  readonly #pending: Buffer[] = [];
  #sink: ((chunk: Buffer) => void) | undefined;

  /** Hold a chunk, or hand it to the sink once one is attached. */
  push(chunk: Buffer): void {
    if (this.#sink) {
      this.#sink(chunk);
      return;
    }
    this.#pending.push(chunk);
  }

  /**
   * Install the sink and flush what was held. `onAttach` runs after the flush,
   * so a caller can flip its own "connected" state knowing the backlog landed.
   */
  attach(sink: (chunk: Buffer) => void, onAttach?: () => void): void {
    this.#sink = sink;
    for (const chunk of this.#pending) sink(chunk);
    this.#pending.length = 0;
    onAttach?.();
  }

  /** Chunks held while no sink was attached (diagnostics / tests). */
  get held(): number {
    return this.#pending.length;
  }

  /** The held bytes in arrival order, joined — what a sniffer looks at. */
  snapshot(): Buffer {
    return Buffer.concat(this.#pending);
  }
}
