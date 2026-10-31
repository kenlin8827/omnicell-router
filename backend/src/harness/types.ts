/**
 * Harness domain vocabulary (ADR-0015).
 *
 * `client` = a runtime hooked for traffic (SupportedClient). `harness` = that runtime considered as an
 * artifact host. They are deliberately different vocabularies: hosts like Cursor/Zed will never be
 * traffic clients, and welding the two would pollute the traffic domain.
 */

import type { BrowseResult } from './common/market.js';

export type HarnessKind = 'skill' | 'mcp' | 'plugin';

export type HarnessHostId =
  | 'universal'
  | 'opencode'
  | 'claude'
  | 'codex'
  | 'pi'
  | 'dsh'
  | 'omp'
  | 'cursor'
  | 'github-copilot'
  | 'gemini-cli'
  | 'cline'
  | 'amp'
  | 'windsurf'
  | 'zed'
  | 'antigravity'
  | 'factory'
  | 'kimi'
  | 'grok';

/**
 * Where an artifact may be materialized: project-local or user-level.
 *
 * The TYPE keeps both because the adapters and writers model both; only `global` is ENABLED today
 * (`ENABLED_SCOPES` in `scopes.ts`) — see ADR-0015 §D2 "Scope".
 */
export type HarnessScope = 'global' | 'project';

/** Why a root exists — the resolver measures THIS PROCESS only (ADR-0015 §D2). */
export type RootOrigin = 'default' | 'env-override' | 'profile';

export interface ResolvedRoot {
  root: string;
  origin: RootOrigin;
  /** Root kind the host actually reads; `candidate` roots are lower precedence. */
  precedence: number;
}

/**
 * Per-copy state vocabulary — the ONLY state words allowed on disk (ADR-0015 §D8.7).
 *
 * `untracked` is a statement about OWNERSHIP (no manifest entry), never a restriction: an untracked
 * directory is removable like any other copy, because the removal op follows the artifact's landing
 * shape rather than its provenance (ADR-0015 §D8.10).
 */
export type CopyState = 'clean' | 'dirty' | 'missing' | 'foreign' | 'untracked';

/** Orthogonal to CopyState: what was proven about loading, not about content. */
export type CopyPlacement = 'materialized' | 'verified' | 'unverified';

export type TrustTier = 'official' | 'aggregator' | 'community' | 'manual';

export interface CopyRecord {
  scope: HarnessScope;
  host: HarnessHostId;
  /** Display hint only — the absolute `path` is the reconcile identity. */
  rootId: string;
  /**
   * Absolute on-disk path for a copy we materialized. For an `external` copy this is an OPAQUE
   * IDENTITY TOKEN (`<canonicalKey>#<harness>`), NOT a filesystem path — see `external`.
   */
  path: string;
  /**
   * Package-manager-managed copy with no path of our own (today: the `pi` subprocess install, which
   * materializes into the runtime's own store). Inventory must not stat/hash it and removal must not
   * move it — the apply-time subprocess exit code is the only proof, and the package is uninstalled
   * by the runtime's own package manager, not by us.
   */
  external?: boolean;
  contentHash: string;
  placement: CopyPlacement;
  /** Fast-path fingerprint: unchanged mtime+size means clean without re-hashing. */
  mtimeMs?: number;
  bytes?: number;
  installedAt: string;
}

/** Pinned provenance. A package has no commit; a repo has no integrity; a ClawHub skill pins the
 *  registry version whose deterministic archive was downloaded. */
export type Pin =
  | { git: { commitSha: string } }
  | { npm: { integrity: string } }
  | { clawhub: { slug: string; version: string } }
  | { adopted: true };

export interface ArtifactRecord {
  /**
   * `plugin:<harness>:<canonicalKey>` for kind `plugin` — the runtime is part of the identity,
   * because an plugin is code against ONE runtime's plugin API (one package installed into two
   * runtimes is two artifacts). `<kind>:<canonicalKey>` for every other kind (ADR-0015 §D7).
   */
  id: string;
  canonicalKey: string;
  kind: HarnessKind;
  /**
   * The runtime this artifact is an plugin OF; present iff `kind === 'plugin'` (ADR-0015 §D2:
   * an artifact declares its compatible hosts). For skill/mcp the host is a landing choice recorded
   * per copy, so no artifact-level harness exists.
   */
  harness?: HarnessHostId;
  name: string;
  /**
   * One-line description the SOURCE claimed at resolve time, recorded so an installed row can show
   * what the market showed. Absent on manifests written before this field existed, and unnecessary
   * for kinds whose text is readable from the installed content (a skill's `SKILL.md`): the view
   * prefers the installed text and falls back here (`inventory.ts` `toView`).
   */
  description?: string | null;
  sourceId: string;
  ref?: string;
  pin: Pin;
  contentHash: string;
  storeRef?: string;
  listedOn: string[];
  trust: TrustTier;
  copies: CopyRecord[];
}

export interface ManifestFile {
  /** v2 added the artifact-level `harness` dimension for plugins; v1 manifests migrate on read. */
  version: 1 | 2;
  artifacts: ArtifactRecord[];
}

/** `<ocrHome>/harness/claims.json` — one materialized path, one owning environment. */
export interface ClaimsFile {
  version: 1;
  claims: Record<string, { env: string; artifactId: string }>;
}

export interface CopyView {
  scope: HarnessScope;
  host: HarnessHostId;
  rootId: string;
  /** Identity token, not a location, when `external` is true. */
  path: string;
  /** Package-manager-managed (no own path) — the console shows "managed by the runtime", never a path. */
  external?: boolean;
  state: CopyState;
  placement: CopyPlacement;
  contentHash?: string;
  /**
   * Skill copies only: every host whose skills roots resolve to this directory, owner FIRST.
   *
   * `host` answers ownership (one directory, one owner — install/claims/removal), this answers
   * READERSHIP (the cross-agent `.agents/skills` tree is read by up to ten runtimes). Absent for
   * config-shaped copies, where the file IS the landing and its host is the only reader.
   */
  readers?: HarnessHostId[];
}

export interface ArtifactView {
  id: string;
  canonicalKey: string;
  kind: HarnessKind;
  /** The runtime an plugin is written for; absent for skill/mcp (host lives per copy). */
  harness?: HarnessHostId;
  name: string;
  /**
   * One-line description: the copy's own readable text when it has one (a skill's `SKILL.md`), else
   * the line the source or the package manifest recorded. Null when neither exists.
   */
  description: string | null;
  /** Source that produced this artifact; null for a purely local directory. */
  sourceId: string | null;
  /**
   * Surfaces this artifact was listed on when the install was requested, writer source first
   * (`['npm','pi-dev']` for a package taken from the Pi catalog). `sourceId` stays the identity of
   * the payload; this is the discovery facet the console's source chips narrow by.
   */
  listedOn: string[];
  trust: TrustTier;
  audit: { status: 'pass' | 'warn' | 'fail'; summary: string } | null;
  copies: CopyView[];
  /** Derived rollup, never persisted. */
  rollup: 'clean' | 'partial' | 'dirty' | 'missing' | 'shadowed';
}

export interface HarnessSourceView {
  id: string;
  /** Showcase catalog grouping ('default', 'enterprise', etc.). */
  catalog?: string;
  label: string;
  kinds: HarnessKind[];
  trust: TrustTier;
  /** Credential the source's OWN API demands (`oidc` = a closed, token-minted endpoint); `none` otherwise.
   *  Every source offered today is readable anonymously, so this is a declaration, not a gate. */
  auth: 'none' | 'oidc';
  /**
   * Harnesses this source's artifacts are bound to. ABSENT = the source is harness-agnostic
   * (skills/MCP land on whichever host the operator picks); present = the console may offer it only
   * for those harnesses (ADR-0015 §D2: a free checkbox list is forbidden).
   */
  hosts?: HarnessHostId[];
  enabled: boolean;
  /** True when this source has a browse adapter, i.e. a market chip for it can show results. */
  browsable?: boolean;
  /** Present when the source cannot answer right now — measured, not guessed. */
  unavailableReason?: string;
  /**
   * The orderings this source OFFICIALLY offers when browsing (ADR-0015 §D6), best default first.
   *
   * The console renders exactly this list and sends the chosen key back on `/browse` — it never
   * invents an order the upstream cannot serve, because a page-local re-sort of a paged catalog
   * would claim a global ranking nobody computed. `undefined` = one order only: the catalog's own.
   */
  sorts?: string[];
  /** The source's OWN browse function (declared by its adapter file). Absent = no market chip. */
  browse?: (query: string, limit: number, page: number, sort: string | undefined, fetchImpl?: typeof fetch) => Promise<BrowseResult>;
  lastSyncAt?: number;
}

/** Where a discovered row was read from — the runtime's own record, never a manifest entry. */
export type ExtDiscoveryOrigin = 'runtime-store' | 'config-array' | 'local-file';

/**
 * How to undo a runtime's own install record (ADR-0015 §D8.10).
 *
 * A discovered row has no manifest entry, so removal is not "delete our copy" — it is the inverse of
 * the shape the runtime landed it in. The descriptor travels WITH the row so the console never has to
 * guess, and so the plan can name the exact file and container it will touch:
 *   · `trash-path` — a real file/dir on disk (a loose `plugins/*.ts`, a path-shaped `plugin[]`
 *     entry). Reversible through the trash.
 *   · `drop-entry` — one string inside a JSON string array (`plugin[]`, pi's `packages[]`). Dropping
 *     the string is the inverse of installing it; for a package it removes the DECLARATION, not the
 *     bytes the runtime's package manager already put in its own store.
 *   · `drop-server` — one MEMBER of a JSON object (a server key inside the host's `mcp` container).
 *     Same principle as `drop-entry` with a different container shape: the key goes, its siblings and
 *     every hand-written comment in the runtime's file stay.
 */
export type DiscoveredRemoval =
  | { op: 'trash-path'; path: string }
  | { op: 'drop-entry'; file: string; container: string; entry: string }
  | { op: 'drop-server'; file: string; container: string; entry: string };

export interface DiscoveredArtifact {
  /**
   * Which kind the row belongs to. Discovery is ONE channel for every kind (a skill directory, a
   * package the runtime's manager installed, a loose plugin file), so the console can filter a
   * landing page without a second scan endpoint.
   */
  kind: HarnessKind;
  /**
   * The runtime whose own record the row was read from: set for `plugin` (its store /
   * declaration / loose directory) and for `mcp` (the `mcp` container of its config file). Absent for
   * `skill`, whose copies are grouped per directory NAME across every host that reads them.
   */
  harness?: HarnessHostId;
  /** Skill directory name / package name / loose file basename — the only identity available. */
  name: string;
  /**
   * One line read from the row's OWN material, null when that material carries none: a skill's
   * `SKILL.md` frontmatter, an installed package's `package.json`, a local file's header comment.
   * No registry round-trip — discovery stays a local scan.
   */
  description: string | null;
  /** One row per directory/package found; several hosts commonly read the same skill. */
  copies: CopyView[];
  hosts: HarnessHostId[];
  /**
   * Provenance of a discovered row: which of the runtime's own records produced it — its store, its
   * config array (`plugin[]`), its `mcp` container, or a loose file on disk. Display only — the row is
   * NEVER promoted to a manifest artifact (ADR-0015 §D8.10).
   */
  origin?: ExtDiscoveryOrigin;
  /** The file/dir the row was read from — a tooltip, never a reconcile identity. */
  observedFrom?: string;
  /** Version the runtime's own store records (its lock file), when one is available. */
  version?: string;
  /** Identity in the same namespace as `ArtifactRecord.canonicalKey`, when the row has one. */
  canonicalKey?: string;
  /**
   * The inverse of the runtime's own install record (ADR-0015 §D8.10). Present whenever the shape is
   * known, and ABSENT only when it is not — a row without it cannot be removed from this console.
   */
  removal?: DiscoveredRemoval;
}

export interface InventoryResponse {
  envName: string;
  envRoot: string;
  hostsScanned: number;
  artifacts: ArtifactView[];
  /**
   * On-disk rows with no manifest entry, for every kind — skills grouped per skill (NOT per
   * directory), plugins one row per package/file the runtime's own store declares.
   */
  discovered: DiscoveredArtifact[];
  /** Total copies behind `discovered` (a skill may live in several roots). */
  discoveredCopies: number;
}
