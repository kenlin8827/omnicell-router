/**
 * HuggingFace Hub client for the Local Models marketplace.
 *
 * Three read shapes against the public Hub API (no SDK, fetch only):
 * - search: `GET /api/models?search=&filter=gguf` → the model cards the
 *   marketplace list renders (downloads/likes ordering is done server-side).
 * - files:  `GET /api/models/<repo>/tree/main?recursive=true` → every file
 *   with its real byte size (LFS pointers report `lfs.size`, and `lfs.oid`
 *   is the file's sha256 — that is the download verifier).
 * - download URL: `https://huggingface.co/<repo>/resolve/main/<path>` — the
 *   Hub serves these through its CDN with `Range` support, so the same
 *   resumable downloader the engine installer uses applies unchanged.
 *
 * GGUF filenames carry the metadata the UI shows for free (`Model-Q4_K_M.gguf`,
 * `Qwen3-30B-A3B-UD-Q4_K_XL-00001-of-00002.gguf`): the quant tag and the
 * parameter count are parsed here so every caller sees the same fields.
 * A repo behind a gate needs a token; `HF_TOKEN` (or `OCR_HF_TOKEN`) in the
 * gateway environment is forwarded as a bearer header when present.
 */

const USER_AGENT = 'omnicell-router';

import { resolveHfEndpoint, resolveHfToken } from './settings.js';

/**
 * Hub base URL: console setting first (the local-models settings page), then
 * `HF_ENDPOINT` / `OCR_HF_ENDPOINT` (the huggingface-cli spellings) pointing
 * at a mirror — hf-mirror.com is the common choice where the hub is not
 * directly reachable; the API surface (`/api/models`, `resolve/main`) matches.
 */
export function hfEndpoint(): string {
  return resolveHfEndpoint().url;
}

/** Search + tree responses share this subset of the Hub's model shape. */
export interface HfModelSummary {
  id: string;
  likes: number;
  downloads: number;
  tags: string[];
  pipelineTag?: string;
  lastModified?: string;
  gated?: boolean;
}

export interface HfFileEntry {
  path: string;
  size: number;
  /** sha256 when the file is LFS-backed (every GGUF above the pointer limit is). */
  sha256?: string;
  /** Parsed quant tag (`Q4_K_M`), absent for non-GGUF files. */
  quant?: string;
  /** Parsed parameter count in billions (8 → 8B), absent when unparseable. */
  paramsB?: number;
}

/** Optional bearer token for gated repos (console setting, then `HF_TOKEN`). */
function hfHeaders(): Record<string, string> {
  const token = resolveHfToken().token;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function hfJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: hfHeaders(), signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 429) throw new Error('HuggingFace rate limited this gateway (429); retry later');
    if (res.status === 401 || res.status === 403) throw new Error(`HuggingFace refused the request (${res.status}); a gated repo needs HF_TOKEN`);
    if (res.status === 404) throw new Error('model not found on HuggingFace');
    throw new Error(`HuggingFace request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Search GGUF-serving model cards, most-downloaded first. */
export async function searchHfModels(query: string, limit = 24, signal?: AbortSignal): Promise<HfModelSummary[]> {
  const q = query.trim();
  const url = new URL(`${hfEndpoint()}/api/models`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 50)));
  if (q) url.searchParams.set('search', q);
  // Tag filter: only repos that actually serve GGUF weights. Without it the
  // Hub returns every name match (original safetensors repos included) and the
  // expanded rows dead-end at "no GGUF files".
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  const raw = await hfJson<Array<Record<string, unknown>>>(url.toString(), signal);
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    likes: typeof row.likes === 'number' ? row.likes : 0,
    downloads: typeof row.downloads === 'number' ? row.downloads : 0,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [],
    ...(typeof row.pipeline_tag === 'string' ? { pipelineTag: row.pipeline_tag } : {}),
    ...(typeof row.lastModified === 'string' ? { lastModified: row.lastModified } : {}),
    ...(row.gated === true ? { gated: true } : {}),
  })).filter((model) => model.id);
}

/** Repo id guard: `owner/name`, nothing else reaches the URL path. */
export function isValidRepoId(repo: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\/[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/.test(repo);
}

const QUANT_RE = /\b(I?Q[2-8]_[A-Z0-9_]+|UD-I?Q[2-8]_[A-Z0-9_]+|BF16|F16|FP16|FP32|F32|IQ[1-4]_[A-Z]+)\b/i;

/** llama.cpp split weights: `…-00001-of-00002.gguf` (exactly 5 digits). */
export const SHARD_RE = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i;

/** One downloadable unit: a plain file, or a complete split-weight set. */
export interface HfShardGroup {
  /** Shard 1 — the entry the registry row and llama-server anchor at. */
  primary: HfFileEntry;
  /** Every shard, primary first; length 1 for plain single-file models. */
  parts: HfFileEntry[];
  /** Sum of all parts' bytes (what the fit/speed hints should read). */
  totalSize: number;
}

/**
 * Collapse a repo tree's split weights into one unit per group, keyed by
 * directory + base name + shard count. llama-server is handed shard 1 and
 * discovers the siblings itself, so a group downloads and registers as ONE
 * model. Incomplete groups are NOT collapsed: the partial files stay
 * individual entries so the operator sees exactly what the Hub serves.
 */
export function groupHfShards(files: HfFileEntry[]): HfShardGroup[] {
  const singles: HfFileEntry[] = [];
  const groups = new Map<string, { total: number; parts: Map<number, HfFileEntry> }>();
  for (const file of files) {
    const base = file.path.slice(file.path.lastIndexOf('/') + 1);
    const match = SHARD_RE.exec(base);
    if (!match) {
      singles.push(file);
      continue;
    }
    const dir = file.path.slice(0, file.path.length - base.length).toLowerCase();
    const key = `${dir}::${match[1].toLowerCase()}::${match[3]}`;
    let group = groups.get(key);
    if (!group) {
      group = { total: Number(match[3]), parts: new Map() };
      groups.set(key, group);
    }
    group.parts.set(Number(match[2]), file);
  }
  const out: HfShardGroup[] = singles.map((file) => ({ primary: file, parts: [file], totalSize: file.size }));
  for (const group of groups.values()) {
    const parts: HfFileEntry[] = [];
    for (let part = 1; part <= group.total; part += 1) {
      const entry = group.parts.get(part);
      if (!entry) {
        // Incomplete: surface every present shard as its own row instead.
        for (const partial of group.parts.values()) out.push({ primary: partial, parts: [partial], totalSize: partial.size });
        parts.length = 0;
        break;
      }
      parts.push(entry);
    }
    if (parts.length === 0) continue;
    out.push({ primary: parts[0], parts, totalSize: parts.reduce((sum, part) => sum + part.size, 0) });
  }
  return out;
}

/** The quant tag in a GGUF filename (`Model-Q4_K_M.gguf` → `Q4_K_M`). */
export function parseGgufQuant(filename: string): string | undefined {
  const match = QUANT_RE.exec(filename);
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * Parameter count in billions from any name segment (`30B-A3B` → 30,
 * `0.6B` → 0.6, `135M` → 0.135). The B form wins over M when both appear.
 */
export function parseParamsB(name: string): number | undefined {
  for (const match of name.matchAll(/[._-](\d+(?:\.\d+)?)B\b/gi)) {
    const value = Number(match[1]);
    if (value > 0 && value < 2000) return value;
  }
  for (const match of name.matchAll(/[._-](\d+)M\b/g)) {
    const value = Number(match[1]);
    if (value > 0) return value / 1000;
  }
  return undefined;
}

/** The Hub's tree endpoint, flattened: only files, GGUF entries annotated. */
export async function fetchHfModelFiles(repo: string, signal?: AbortSignal): Promise<HfFileEntry[]> {
  if (!isValidRepoId(repo)) throw new Error('invalid model id');
  const raw = await hfJson<Array<Record<string, unknown>>>(`${hfEndpoint()}/api/models/${repo}/tree/main?recursive=true`, signal);
  if (!Array.isArray(raw)) return [];
  const files: HfFileEntry[] = [];
  for (const row of raw) {
    if (row.type !== 'file' || typeof row.path !== 'string') continue;
    const lfs = (row.lfs ?? null) as { size?: unknown; oid?: unknown } | null;
    const size = typeof lfs?.size === 'number' ? lfs.size : typeof row.size === 'number' ? row.size : 0;
    const oid = typeof lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(lfs.oid) ? lfs.oid : undefined;
    const isGguf = row.path.toLowerCase().endsWith('.gguf');
    files.push({
      path: row.path,
      size,
      ...(oid ? { sha256: oid } : {}),
      ...(isGguf ? { quant: parseGgufQuant(row.path) } : {}),
      ...(isGguf ? { paramsB: parseParamsB(row.path) ?? parseParamsB(repo) } : {}),
    });
  }
  return files;
}

/** Resumable download URL for one repo file (the Hub honors Range). */
export function hfFileUrl(repo: string, filename: string): string {
  return `${hfEndpoint()}/${repo}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

/** Format helpers the console and the marketplace rows share. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
