import type { SourceAdapter, ResolveOptions, ResolveOutcome, SkillFile } from '../spi.js';
import {
  CLAWHUB_MAX_BYTES,
  CLAWHUB_MAX_FILES,
  ZipTooLargeError,
  downloadClawHubZip,
  fetchClawHubLatestVersion,
  readZip,
} from '../clawhub.js';

/**
 * ClawHub source adapter (ADR-0015 §8) — the install half of `harness/clawhub.ts`.
 *
 * ClawHub skills are published to the registry's OWN store, not to a GitHub repository: a browse row
 * carries no repo, so the pin cannot be a commit. The pin is the registry VERSION instead — the
 * resolve reads the newest published semver, downloads THAT version's deterministic ZIP, and the
 * manifest records `{ clawhub: { slug, version } }` + a content hash over the landed files. A
 * `ref` alone is still never a pin: version + contentHash are the ClawHub counterpart of the
 * commitSha + contentHash rule (ADR-0015 §D5).
 *
 * Payload caps are the GitHub adapter's (200 files / 8 MiB), enforced before any disk write. An
 * archive without a root `SKILL.md` is not a skill and is refused; the archive's remaining files
 * (ClawHub's own `skill-card.md`, `agents/*.yaml`, `_meta.json`) travel verbatim — third-party
 * content is data (ADR-0015 §D9), and a host that does not read one simply ignores it.
 */

const REF = /^([\w.-]+)\/([\w.-]+)$/;

export const clawhubAdapter: SourceAdapter = {
  id: 'clawhub',
  kinds: ['skill'],
  trust: 'community',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (kind !== 'skill') {
      return { ok: false, code: 'unsupported_kind', message: `source 'clawhub' cannot resolve kind '${kind}'` };
    }
    const match = REF.exec(ref);
    if (!match) {
      return { ok: false, code: 'no_artifact', message: `invalid reference '${ref}' (expected owner/slug)` };
    }
    const owner = match[1]!;
    const slug = match[2]!;

    // 1. The newest published version — the pin. A registry that lists none has no installable skill.
    const listed = await fetchClawHubLatestVersion(slug, owner, fetchImpl);
    if (!listed.ok) {
      return { ok: false, code: listed.code, message: listed.message };
    }
    if (!listed.version) {
      return { ok: false, code: 'no_artifact', message: `ClawHub lists no version of '${owner}/${slug}'` };
    }
    const version = listed.version;

    // 2. That version's deterministic ZIP, capped before buffering touches memory.
    const download = await downloadClawHubZip(slug, owner, version, fetchImpl);
    if (!download.ok) {
      return {
        ok: false,
        code: download.code,
        message: download.message,
        ...(download.candidates ? { candidates: download.candidates } : {}),
      };
    }
    let entries;
    try {
      entries = readZip(download.zip);
    } catch (e) {
      if (e instanceof ZipTooLargeError) return { ok: false, code: 'too_large', message: e.message };
      return { ok: false, code: 'upstream', message: `cannot unpack the skill archive: ${e instanceof Error ? e.message : e}` };
    }
    if (!entries.some((entry) => entry.path === 'SKILL.md')) {
      return { ok: false, code: 'no_artifact', message: 'skill archive contains no SKILL.md' };
    }
    if (entries.length > CLAWHUB_MAX_FILES) {
      return { ok: false, code: 'too_large', message: `${entries.length} files exceeds the ${CLAWHUB_MAX_FILES}-file cap` };
    }
    const files: SkillFile[] = entries.map((entry) => ({ path: entry.path, data: entry.data }));
    const totalBytes = files.reduce((sum, entry) => sum + entry.data.length, 0);
    if (totalBytes > CLAWHUB_MAX_BYTES) {
      return { ok: false, code: 'too_large', message: `${Math.round(totalBytes / 1024)} KiB exceeds the 8 MiB cap` };
    }

    return {
      ok: true,
      canonicalKey: `clawhub:${owner}/${slug}`,
      name: slug,
      payload: { kind: 'skill', name: slug, files },
      pin: { clawhub: { slug: `${owner}/${slug}`, version } },
      // One pinned revision, one store slot — the version token disambiguates re-installs after an
      // update, the same job the commit sha does for a GitHub skill.
      storeKey: `clawhub__${owner}__${slug}@${version}`,
    };
  },
};
