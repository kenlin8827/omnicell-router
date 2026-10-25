import zlib from 'node:zlib';
import type { SourceAdapter, ResolveOptions, ResolveOutcome, SkillFile } from '../spi.js';
import { normalizeName } from '../spi.js';
import type { TreeEntry } from '../tree.js';
import { skillDirs } from '../tree.js';

/**
 * GitHub source adapter (ADR-0015 §8) — the network half of a skill install.
 *
 * One tarball request instead of one per file: raw.githubusercontent is not reachable from every
 * network (TLS errors from some hosts), and the blob API would spend the 60/hour anonymous budget on
 * a single skill. The commit IS the pin — no branch names survive into the payload.
 *
 * Payload caps (tarball slice limits, enforced before any disk write):
 *  - 200 files / 8 MiB per skill;
 *  - a repo without SKILL.md is not a skill and is refused;
 *  - several candidates are reported as `ambiguous`, never guessed — the console picks one and
 *    re-resolves with a `#dir`-pinned ref.
 */

const API = 'https://api.github.com';
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
/** A tarball is not a bomb the way a crafted deflate stream is, but it is still remote input: cap
 *  what ONE gunzip call may materialize, so a nested-compression payload cannot allocate freely. */
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 60_000;

interface TarEntry {
  path: string;
  data: Buffer;
}

/**
 * Read a response body under a byte cap. `arrayBuffer()` trusts `content-length`, which a chunked or
 * length-less answer does not have to state — one unbounded buffer is all a bad server needs.
 * Returns null past the cap.
 */
async function readBodyCapped(res: Response, cap: number): Promise<Buffer | null> {
  const stream = res.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Minimal tar reader for GitHub's tarball response: 512-byte ustar headers + prefix, nothing exotic. */
export function readTarball(buffer: Buffer): TarEntry[] {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES });
  const out: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    // ustar string fields are NUL-padded; a bare NUL-padded prefix field is TRUTHY as a string and
    // would wrap every path in garbage — always cut at the first NUL. Spaces inside a name are legal
    // and preserved.
    const read = (start: number, end: number) =>
      header.subarray(start, end).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = read(0, 100);
    const prefix = read(345, 500);
    const size = parseInt(read(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    if (type === '0') {
      out.push({ path: prefix ? `${prefix}/${name}` : name, data: tar.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'omnicellrouter-harness',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const githubAdapter: SourceAdapter = {
  id: 'github',
  kinds: ['skill'],
  trust: 'community',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (kind !== 'skill') {
      return { ok: false, code: 'unsupported_kind', message: `source 'github' cannot resolve kind '${kind}'` };
    }
    if (!/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(ref)) {
      return { ok: false, code: 'no_artifact', message: `invalid reference '${ref}' (expected owner/name[#dir])` };
    }
    const [repoPath, pinnedDir] = ref.split('#');
    const [owner, repoName] = repoPath.split('/');

    // 1. Repo metadata + resolved commit.
    const repoInfo = await fetchJson<{ default_branch?: string }>(fetchImpl, `${API}/repos/${repoPath}`, METADATA_TIMEOUT_MS);
    if (!repoInfo) return { ok: false, code: 'upstream', message: `cannot read ${repoPath} from GitHub` };
    const branch = repoInfo.default_branch || 'main';
    const commit = await fetchJson<{ sha?: string }>(fetchImpl, `${API}/repos/${repoPath}/commits/${branch}`, METADATA_TIMEOUT_MS);
    const commitSha = commit?.sha;
    if (!commitSha) return { ok: false, code: 'upstream', message: `cannot resolve ${branch} of ${repoPath}` };

    // 2. Which directory is the skill?
    const tree = await fetchJson<{ tree?: TreeEntry[] }>(fetchImpl, `${API}/repos/${repoPath}/git/trees/${commitSha}?recursive=1`, METADATA_TIMEOUT_MS);
    if (!tree) return { ok: false, code: 'upstream', message: 'cannot read the repository tree' };
    const dirs = skillDirs(tree.tree ?? []);
    if (dirs.length === 0) {
      return { ok: false, code: 'no_artifact', message: 'repository contains no SKILL.md' };
    }
    let skillDir: string;
    if (pinnedDir) {
      if (!dirs.includes(pinnedDir)) {
        return {
          ok: false,
          code: 'no_artifact',
          message: `pinned directory '${pinnedDir}' holds no SKILL.md at ${commitSha.slice(0, 7)}`,
          candidates: dirs,
        };
      }
      skillDir = pinnedDir;
    } else if (dirs.length > 1) {
      return {
        ok: false,
        code: 'ambiguous',
        message: `${dirs.length} skills in this repository — pick one to install`,
        candidates: dirs,
      };
    } else {
      skillDir = dirs[0]!;
    }

    // 3. One tarball request, unpacked and capped before anything reaches disk. Refuse oversized
    //    downloads BEFORE buffering them — the file caps below guard disk, this one guards memory.
    const tarRes = await fetchImpl(`${API}/repos/${repoPath}/tarball/${commitSha}`, {
      headers: headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
    }).catch(() => null);
    if (!tarRes || !tarRes.ok) {
      return { ok: false, code: 'upstream', message: 'failed to download the repository tarball' };
    }
    const declaredLength = Number(tarRes.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BYTES) {
      return { ok: false, code: 'too_large', message: `${Math.round(declaredLength / 1024 / 1024)} MiB tarball exceeds the 8 MiB cap` };
    }
    const archive = await readBodyCapped(tarRes, MAX_BYTES);
    if (!archive) {
      return { ok: false, code: 'too_large', message: `tarball exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MiB cap` };
    }
    let entries: TarEntry[];
    try {
      entries = readTarball(archive);
    } catch (e) {
      return { ok: false, code: 'upstream', message: `cannot unpack the tarball: ${e instanceof Error ? e.message : e}` };
    }
    // GitHub wraps the tree in `<repo>-<sha>/`; drop that segment before matching the skill dir.
    // Payload paths are relative to the ARTIFACT root (the skill dir), not the repo root — writers
    // materialize them verbatim.
    const prefix = skillDir ? `${skillDir}/` : '';
    const selected: SkillFile[] = entries
      .map((entry) => ({ path: entry.path.split('/').slice(1).join('/'), data: entry.data }))
      .filter((entry) => entry.path && (prefix ? entry.path.startsWith(prefix) : !entry.path.includes('/')))
      .map((entry) => ({ path: prefix ? entry.path.slice(prefix.length) : entry.path, data: entry.data }));
    if (selected.length === 0) {
      return { ok: false, code: 'no_artifact', message: 'skill directory is empty' };
    }
    if (selected.length > MAX_FILES) {
      return { ok: false, code: 'too_large', message: `${selected.length} files exceeds the ${MAX_FILES}-file cap` };
    }
    const totalBytes = selected.reduce((sum, entry) => sum + entry.data.length, 0);
    if (totalBytes > MAX_BYTES) {
      return { ok: false, code: 'too_large', message: `${Math.round(totalBytes / 1024)} KiB exceeds the 8 MiB cap` };
    }

    const name = skillDir ? skillDir.split('/').pop()! : repoName;
    return {
      ok: true,
      canonicalKey: `github:${ref.split('#')[0]}${skillDir ? `#${skillDir}` : ''}`,
      name,
      payload: { kind: 'skill', name, files: selected },
      pin: { git: { commitSha } },
      // Two skills from one repo must not share a store slot — the dir token disambiguates.
      storeKey: `${owner}__${repoName}@${commitSha.slice(0, 7)}${skillDir ? `__${normalizeName(skillDir)}` : ''}`,
    };
  },
};
