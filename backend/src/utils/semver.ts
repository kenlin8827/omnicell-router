/**
 * Semver comparison for the two places that must order versions locally:
 * client CLI minimum-version gates and the release update check. One parser
 * keeps both answers identical (`1.2.10` > `1.2.9`, prerelease < release).
 *
 * Tolerant by design: builds and client probes sometimes report `v1.2.3`,
 * `1.2` or a vendor prefix. Anything that is not a version at all compares
 * equal (0) — fail-open, never a crash.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty = a normal release. */
  prerelease: string[];
}

const VERSION_RE = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same core triple.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i];
    const bi = b[i];
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** -1 / 0 / 1; unparseable inputs compare equal (0). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return compareParsed(pa, pb);
}

/** Strictly newer — false when either side is not parseable, so a junk
 *  current version never manufactures an update notice. */
export function isNewerVersion(candidate: string, base: string): boolean {
  const pc = parseVersion(candidate);
  const pb = parseVersion(base);
  if (!pc || !pb) return false;
  return compareParsed(pc, pb) > 0;
}
