/**
 * Git tree utilities shared by source adapters (ADR-0015 §8).
 *
 * Pure functions — no network, no disk — so adapters stay thin and the SKILL.md discovery rules are
 * testable without a GitHub round-trip.
 */

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** Every directory holding a `SKILL.md`, shortest first (root `''` sorts before subdirectories). */
export function skillDirs(entries: TreeEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const segments = entry.path.split('/');
    if (segments[segments.length - 1].toLowerCase() !== 'skill.md') continue;
    dirs.add(segments.slice(0, -1).join('/'));
  }
  return [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
