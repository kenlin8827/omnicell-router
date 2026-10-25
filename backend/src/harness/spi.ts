import type { HarnessHostId, HarnessKind, Pin, TrustTier } from './types.js';

/**
 * Source SPI (ADR-0015 §8).
 *
 * Sources ADAPT to one normalized payload shape; kind writers consume payloads and never learn a
 * vendor. A source declares which kinds it can resolve — every other (source, kind) pair renders in
 * the console as "cannot install", never as a runtime error ("a source that cannot produce a payload
 * is browse-only and says so").
 *
 * Split of concerns along the network/disk boundary:
 *  - `resolve` (per source) does ALL network work and answers with bytes + provenance;
 *  - writers (per kind) do ALL disk work: store, claims, host copies, manifest.
 */

/** MCP launch spec — the two shapes ADR-0015 §8 normalizes for the `mcp` kind.
 *
 *  Gate 4 of the write gates: secret/env values are NEVER carried or written — only the KEY NAMES
 *  (`envKeys` / `headerKeys`). The writer materializes `{env:KEY}` references; the operator supplies
 *  values in their own runtime (ADR-0006 stays untouched).
 */
export type McpLaunch =
  | { command: string; args?: string[]; envKeys?: string[] }
  | { url: string; transport: 'http' | 'sse' | 'stdio'; headerKeys?: string[] };

/** One file of a skill payload: repo-relative path + content bytes. */
export interface SkillFile {
  path: string;
  data: Buffer;
}

export type InstallPayload =
  | { kind: 'skill'; name: string; files: SkillFile[] }
  | { kind: 'mcp'; name: string; launch: McpLaunch }
  | { kind: 'extension'; name: string; pm: 'npm'; spec: string };

export interface ResolveOptions {
  /** Injectable fetch (house test style); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type ResolveFailureCode =
  | 'unsupported_source'
  | 'unsupported_kind'
  | 'no_artifact'
  | 'ambiguous'
  | 'too_large'
  | 'unavailable'
  | 'upstream';

export type ResolveOutcome =
  | {
      ok: true;
      /**
       * `<sourceId>:<ref>[#detail]` — the manifest canonicalKey. The artifactId is
       * `<kind>:<canonicalKey>`, except for `extension`, where the harness is part of the identity:
       * `extension:<harness>:<canonicalKey>`.
       */
      canonicalKey: string;
      /** Raw artifact name (vendor spelling); the writer normalizes it for target paths. */
      name: string;
      /**
       * The source's own one-line description for this exact artifact. Kinds whose installed
       * content carries its own text (a skill's `SKILL.md`) may leave it out; every other kind has
       * no other source of prose once installed, so the manifest stores it.
       */
      description?: string | null;
      payload: InstallPayload;
      pin: Pin;
      /** Filesystem-safe store token, unique per pinned revision. Absent for kinds with no store
       *  copy (e.g. `mcp`, which merges into host configs instead). */
      storeKey?: string;
    }
  | { ok: false; code: ResolveFailureCode; message: string; candidates?: string[] };

export interface SourceAdapter {
  id: string;
  /** Kinds this source can resolve to a payload. Everything else is a typed refusal. */
  kinds: HarnessKind[];
  trust: TrustTier;
  /**
   * Harnesses this source's artifacts are bound to (ADR-0015 §D2). ABSENT = harness-agnostic: the
   * operator picks the landing host, as with skills and MCP. Present = the source only serves those
   * runtimes, and an extension request for any other harness is refused before any network work.
   */
  hosts?: HarnessHostId[];
  /**
   * Resolve one reference (WITHOUT the `sourceId:` prefix) into an install payload.
   * `ref` may carry a `#detail` suffix pinning a sub-artifact (e.g. `owner/repo#skill-dir`).
   */
  resolve(ref: string, kind: HarnessKind, opts?: ResolveOptions): Promise<ResolveOutcome>;
}

/** Directory name → an artifact name the host resolvers accept (lowercase, dash-separated). */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
