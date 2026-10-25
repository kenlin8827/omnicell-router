import fs from 'node:fs';

/**
 * `renameSync` with the house retry policy — the ONLY way a tmp→final atomic persist lands.
 *
 * Why a retry exists at all: on Windows, an antivirus or the search indexer briefly holds a handle
 * on a just-written file, so the rename of a fresh tmp file intermittently fails with EPERM. The
 * window is tens of milliseconds; five attempts with a 10/20/30/40 ms backoff ride through it.
 *
 * Apply this to every persist whose failure surfaces as a user-visible error (config writes, state
 * journals, manifests). Best-effort renames stay bare: a `.corrupt.<ts>` quarantine or a daemon log
 * rotation losing one rename is not a data-loss event.
 */
export function renameWithRetry(src: string, dest: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < 4) {
        const until = Date.now() + (attempt + 1) * 10;
        while (Date.now() < until) {}
      }
    }
  }
  throw lastError;
}
