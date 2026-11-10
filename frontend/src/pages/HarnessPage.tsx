import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, ChevronDown, FolderGit2, FolderCog, Database, Download, ExternalLink, FolderTree, Globe, Inbox, Info, LayoutGrid, List, Maximize2, Minimize2, Pencil, Plus, RefreshCw, Save, Search, Settings2, ShieldAlert, SquareCheck, Star, Terminal, Trash2, X } from 'lucide-react';
import {
  api,
  type HarnessArtifactView,
  type HarnessCopyView,
  type HarnessDiscoveredArtifact,
  type HarnessHostView,
  type HarnessInstallTarget,
  type HarnessInventoryResponse,
  type HarnessMarketDetail,
  type HarnessMarketItem,
  type HarnessMcpLaunch,
  type HarnessMcpRegistryArgument,
  type HarnessMcpRegistryCandidate,
  type HarnessMcpRegistryPackage,
  type HarnessSourceView,
  type McpCliFormat,
  type McpRuntimeReport,
  type McpRuntimeStatus,
  type ProjectItem,
} from '../lib/api';
import { ProjectsDialog } from '../components/ProjectsDialog';
import { SegGroup } from '../components/SegGroup';
import { RadioGroup, type RadioGroupOption } from '../components/RadioGroup';
import { Field, FormSection } from '../components/Form';
import { Switch } from '../components/Switch';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { SuggestInput } from '../components/SuggestInput';
import { InfoTip } from '../components/InfoTip';
import { ScrollTable, type ScrollTableColumn } from '../components/ScrollTable';
import { Pagination } from '../components/Pagination';
import { Dialog } from '../components/Dialog';
import { DsnBuilder } from '../components/DsnBuilder';
import { ReadmeMarkdown, readmeBaseHref } from '../lib/readme-markdown';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useI18n } from '../i18n/I18nContext';
import { HarnessSourcesDrawer } from '../components/HarnessSourcesDrawer';
import { BrandIcon } from '../components/BrandIcons';
import { FONT_MONO } from '../lib/fonts';
import { repoOfKey } from '../lib/harness-keys';
import { DSH_PROFILE_NAME_RE } from '../lib/defaults';
import { argRowTokens, argRowsFromArgv, formatArgLine, parseArgLine } from '../lib/mcp-args';
import { RUNTIME_BADGE, runtimeNeedsAttention } from '../lib/mcp-runtime';
import { isDsnFlag, maskDsn } from '../lib/dsn';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

/**
 * Harness pages (ADR-0015) — four routes over one component.
 *
 * Two orthogonal axes, never collapsed:
 *   presence   — the directory exists on this machine (tracked + local)
 *   provenance — a source pin exists for it. Provenance decides WHERE a removal writes, never
 *                WHETHER it is offered: the op follows the artifact's landing shape (a file tree goes
 *                to the trash, a config member is dropped from its own file), so an untracked copy is
 *                fully removable — only a `foreign` claim (another environment's path) refuses.
 *
 * The third axis is the HARNESS, and it exists for all three kinds — but it answers a different
 * question per kind, and that difference is the whole point of the rail copy:
 *   · skills     — one `.agents/skills` tree is loaded by up to fifteen runtimes, but the rail lists
 *                  only runtimes whose CLI is installed on this machine — WRITES stay owner-only
 *                  (`KIND_META.skill.installAxis`): materializing the same directory once per
 *                  reader would be fifteen writes of one tree.
 *   · mcp        — an MCP server is one payload written into ONE OR MORE clients' config files, so
 *                  the page is pinned to one landing harness and the install may fan out from there.
 *   · plugins — code against ONE runtime's plugin API, so the runtime is part of the artifact's
 *                  identity: it is the page's scope and the install's only target.
 *
 * The page therefore pins one harness (no "all") wherever the kind has a host axis, and shows only
 * that runtime's artifacts.
 *
 * The row stays clean: one uninstall action per row (the label renders localized through the i18n
 * table). Which LOCATIONS to remove is decided inside a dialog (checkbox per `host + scope`), because
 * ticking is a decision, not a table column. Every copy is listed and stays tickable; the page's
 * harness decides only the DEFAULT TICK (the same `copyServes` predicate the rail counts with), and
 * those copies are listed first. One runtime's page never preselects another runtime's copy.
 */

type Kind = 'skill' | 'mcp' | 'plugin';
/** `issues` is a health filter, not a provenance one: it keeps what needs attention (missing,
 *  foreign) and drops the rows that are simply fine. */
type Filter = 'all' | 'issues';

/** How a host can take this kind, as the flag the catalog reports. `landing` is the whole reason a
 *  rail exists: a host without one cannot be written to, and offering it would be a checkbox that
 *  only ever produces a refusal. */
interface KindMeta {
  /** Host flag declaring a verified LANDING, or `null` when the kind has no harness axis. */
  landing: 'hasSkills' | 'hasMcp' | 'hasExt' | null;
  /**
   * Which hosts an install may write to.
   *
   * `landing` — the verified landing flag decides (an MCP config, a plugin API).
   * `skills-owner` — the OWNER of a skills directory decides, never its readers: fifteen runtimes read
   * one `.agents/skills` tree, so offering every reader as a target would write the same directory
   * fifteen times. The rail still lists the owner's page (that is the one-click integrated set).
   */
  installAxis: 'landing' | 'skills-owner';
  /** URL segment carrying the harness id: `/harness/<route>/<harness>`. */
  route: string;
  /** Console title / "installed" count noun. */
  titleKey: string;
  /** Bare artifact noun used by the global/project inventory tabs. */
  scopeKindKey: string;
  installedKey: string;
  /** Market tab + market card title. Per-kind, not one shared "Marketplace": each axis browses its
   *  OWN registries (`sources[].kinds`), so a fixed noun would label the MCP page a skill market. */
  marketKey: string;
  /** One install writes to ONE runtime (`single`), or one payload fans out to N landings (`multi`). */
  installMode: 'single' | 'multi';
  /** Copy for an install that can target only one runtime — present exactly when it is `single`. */
  singleHintKey?: string;
  /** The inventory carries a local discovery scan (`discovered[]`), so "tracked" is not the total. */
  discovery: boolean;
  /** Extra line under an empty list, for a kind with no discovery scan. */
  emptyNoteKey?: string;
  /** Rail copy — present exactly when the kind has a host axis (the rail exists only then). The
   *  TITLE is not here: one column header, one word ("Harness"), because it is the same control on all
   *  three pages. What differs per kind is what the pick MEANS, and that is the hint's job. */
  rail?: { hintKey: string; emptyKey: string };
}

const KIND_META: Record<Kind, KindMeta> = {
  skill: {
    // A skill lands in a DIRECTORY, and one directory is read by up to fifteen runtimes. The rail lists
    // the OWNER (the one-click installable set) — writes stay owner-only (`installAxis`), or the
    // same tree would be materialized once per reader.
    landing: 'hasSkills',
    installAxis: 'skills-owner',
    route: 'skills',
    titleKey: 'nav.skills',
    scopeKindKey: 'harness.scopeKindSkill',
    installedKey: 'harness.installedSkills',
    marketKey: 'harness.marketSkills',
    installMode: 'multi',
    discovery: true,
    rail: {
      hintKey: 'harness.skillsOnly',
      emptyKey: 'harness.skillsNoHarness',
    },
  },
  mcp: {
    landing: 'hasMcp',
    installAxis: 'landing',
    route: 'mcp',
    titleKey: 'nav.mcp',
    scopeKindKey: 'harness.scopeKindMcp',
    installedKey: 'harness.installedMcp',
    marketKey: 'harness.marketMcp',
    // A market MCP row installs through the shared Add/Edit sheet to the page's pinned landing
    // ONLY (ADR-0015 §D11 amendment): one server, one client config — no multi-client fan-out. The
    // backend still accepts `hosts[]` for a future surface, but the console writes one at a time.
    installMode: 'single',
    // The MCP landing is a config OBJECT (`mcp` inside the host's own file), and reading it is the
    // same observation the plugin page does over `plugin[]`: a server the operator added by hand
    // is installed, shows up here, and is removable by dropping that member from its own file.
    discovery: true,
    rail: {
      hintKey: 'harness.mcpOnly',
      emptyKey: 'harness.mcpNoHarness',
    },
  },
  plugin: {
    landing: 'hasExt',
    installAxis: 'landing',
    route: 'plugins',
    titleKey: 'nav.plugins',
    scopeKindKey: 'harness.scopeKindPlugin',
    installedKey: 'harness.installedPlugins',
    marketKey: 'harness.marketPlugins',
    installMode: 'single',
    singleHintKey: 'harness.pluginOnly',
    // Plugins DO get a discovery scan: the runtime's own store is readable (pi's
    // `settings.json` `packages[]`, opencode's `plugin[]`, claude's `installed_plugins.json`
    // `plugins` map). Those rows are observation of an install
    // we did not make — and they are removable all the same, because the scan hands the console the
    // inverse of the record it read (ADR-0015 §D8.10).
    discovery: true,
    emptyNoteKey: 'harness.extScopeNote',
    rail: {
      hintKey: 'harness.pluginOnly',
      emptyKey: 'harness.extNoHarness',
    },
  },
};


/**
 * Market orderings, keyed by the sort key a source DECLARES (`sorts` on `/sources`).
 *
 * The keys are the upstream's own vocabulary (ClawHub: `downloads` / `stars` / `updated`; npm:
 * `relevance`; the Pi catalog: `downloads` / `recent`), so this table only supplies the words. A
 * key with no entry renders verbatim — an upstream that gains an ordering must not print an i18n key.
 */
const MARKET_SORT_KEY: Record<string, string> = {
  catalog: 'harness.marketSortCatalog',
  name: 'harness.marketSortName',
  stars: 'harness.marketSortStars',
  updated: 'harness.marketSortUpdated',
  downloads: 'harness.marketSortDownloads',
  relevance: 'harness.marketSortRelevance',
  recent: 'harness.marketSortRecent',
  'all-time': 'harness.marketSortAllTime',
  trending: 'harness.marketSortTrending',
  hot: 'harness.marketSortHot',
};

/** Market context line (under the source chips), keyed by the browse adapter's `noteCode` (the
 *  backend's `note` is the fallback). `{n}` carries the full-catalog search cap a cursor endpoint
 *  imposes; the two live directories each explain their own ranking. */
const NOTE_KEY: Record<string, string> = {
  'pi-dev': 'harness.marketNote.piDev',
  'clawhub-catalog': 'harness.marketNote.clawhubCatalog',
  'clawhub-search': 'harness.marketNote.clawhubSearch',
  'skills-sh-board': 'harness.marketNote.skillsShBoard',
  'skills-sh-search': 'harness.marketNote.skillsShSearch',
  'dsh-plugin-net': 'harness.marketNote.dshPluginNet',
};

/** Why the market could not be read, keyed by the backend's `reason`. The backend's English
 *  `message` is the fallback for a reason this table does not know — a localizable failure must
 *  never reach an operator as the backend's own sentence. */
const BROWSE_ERROR_KEY: Record<string, string> = {
  network: 'harness.browseError.network',
  timeout: 'harness.browseError.timeout',
  http: 'harness.browseError.http',
  rateLimited: 'harness.browseError.rateLimited',
  unavailable: 'harness.browseError.unavailable',
  markupChanged: 'harness.browseError.markupChanged',
  badPayload: 'harness.browseError.badPayload',
  unsupportedSource: 'harness.browseError.unsupportedSource',
};

/** One failed market read: the translatable reason when the backend named one, plus the English
 *  sentence that stands in when it did not. */
interface MarketFailure {
  message: string;
  reason?: string;
  reasonParams?: Record<string, string>;
}

function marketFailure(e: unknown): MarketFailure {
  const err = e as { reason?: unknown; reasonParams?: unknown } | null;
  return {
    message: e instanceof Error ? e.message : String(e),
    ...(typeof err?.reason === 'string' ? { reason: err.reason } : {}),
    ...(err?.reasonParams && typeof err.reasonParams === 'object'
      ? { reasonParams: err.reasonParams as Record<string, string> }
      : {}),
  };
}

/**
 * The star count a market row should print.
 *
 * Three states: a number the source published, a number the operator resolved on demand this session
 * (keyed by repo), or `null` — "no count yet". The last must not collapse into `0`: npm publishes
 * downloads, the Pi catalog publishes downloads, and neither ever said "nobody starred this".
 */
function starOf(item: HarnessMarketItem, resolved: Record<string, number>): number | null {
  if (!item.repo) return item.stars;
  return resolved[item.repo.toLowerCase()] ?? item.stars;
}

/** GitHub-style compact count: exact below 1000, then 1.2K / 12.3K / 1.2M. The cell is narrow and the
 *  orderings are the source's own, so abbreviation costs nothing but scanability — yet it does drop
 *  digits, so every abbreviated cell carries the exact value in its `title`. Same shape as
 *  SessionsPage's tokenDisplay, deliberately a separate formatter: different threshold, different
 *  consumer, and promoting either to a shared helper would weld them together. */
const STARS_FMT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const formatStars = (n: number): string => (n >= 1000 ? STARS_FMT.format(n) : String(n));

/**
 * What the detail dialog needs. A marketplace row already carries these fields; an INSTALLED row
 * names its artifact only through `canonicalKey` (`npm:<pkg>` / `github:<owner>/<repo>#<dir>` /
 * `git:github.com/<owner>/<repo>` / `mp-<slug>:<owner>/<repo>#` / `clawhub:<owner>/<slug>` /
 * `manual:<name>`), so its subject is derived from that — the backend then reads the same registry
 * document or repository it reads for a market row.
 */
interface DetailSubject {
  /** Stable identity: the translation cache key and the request guard. */
  key: string;
  name: string;
  description: string | null;
  /** Where "open in browser" goes, when the subject has a public page. */
  url?: string | null;
  /** `owner/repo` the README is read from. */
  repo?: string;
  /** The portable handle the backend may parse for an npm package (`npm:<name>`). */
  packageKey?: string;
  /** Present ONLY for a marketplace row: install is offered for those, never for a row that is
   *  already on disk (its own action is removal). */
  market?: HarnessMarketItem;
}

/** A market row as a detail subject — every field is already there. */
const subjectFromMarket = (item: HarnessMarketItem): DetailSubject => ({
  key: item.id,
  name: item.name,
  description: item.description,
  url: item.url ?? undefined,
  ...(item.repo ? { repo: item.repo } : {}),
  packageKey: item.key,
  market: item,
});

/** An installed row as a detail subject — the identity comes from its `canonicalKey`. */
const subjectFromRow = (row: Row): DetailSubject => {
  const canonical = row.canonicalKey ?? '';
  const repo = repoOfKey(canonical);
  const pkg = /^npm:(.+)$/.exec(canonical)?.[1];
  // A ClawHub skill names no repository and no package: its detail is read from the registry's own
  // record, keyed by the `owner/slug` pair the canonical key already carries.
  const clawhub = /^clawhub:([\w.-]+\/[\w.-]+)$/.exec(canonical)?.[1];
  const clawhubUrl = clawhub
    ? `https://clawhub.ai/${clawhub.split('/')[0]}/skills/${clawhub.split('/')[1]}`
    : undefined;
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    ...(repo ? { repo, url: `https://github.com/${repo}` } : {}),
    ...(pkg ? { packageKey: `npm:${pkg}`, url: `https://www.npmjs.com/package/${pkg}` } : {}),
    ...(clawhub ? { packageKey: `clawhub:${clawhub}`, url: clawhubUrl } : {}),
  };
};

interface Row {
  key: string;
  name: string;
  canonicalKey: string | null;
  description: string | null;
  /** GitHub repository this row names (`github:owner/repo#dir`, a runtime store's
   *  `git:github.com/owner/repo`, an operator marketplace's `mp-<slug>:owner/repo#`), resolved by
   *  `repoOfKey` — never a second identity — and the ONLY rows whose star count can be resolved: an
   *  npm package has no repository to ask GitHub about. */
  repo: string | null;
  copies: HarnessCopyView[] | HarnessDiscoveredArtifact['copies'];
  hosts: string[];
  tracked: boolean;
  sourceId: string | null;
  catalog?: string;
  channel?: string;
  /** Surfaces this row was listed on at install time, writer source first. Empty for a discovered
   *  row: the runtime's own store is not a marketplace, so it was listed on nothing. */
  listedOn: string[];
  state: string;
  /** Discovered plugin rows carry the runtime record they were read from (`runtime-store` …). */
  origin?: HarnessDiscoveredArtifact['origin'];
  /** Version the runtime's own store records — rendered as `@x.y.z` beside the name. */
  version?: string;
  /** DSH only: installed but absent from the selected `dsh.profile.bundles`. */
  enabled?: boolean;
  /** How to undo the runtime's own install record; present for a discovered plugin row. */
  removal?: HarnessDiscoveredArtifact['removal'];
  /**
   * Live MCP status reported by the runtime for this server key. Absent for non-MCP rows, for a
   * runtime that exposes no status surface, and for a daemon that is not running — absence is
   * "unknown", never a health verdict (`McpRuntimeReport`).
   */
  runtime?: { host: string; status: McpRuntimeStatus; error?: string };
  artifact?: HarnessArtifactView;
}

const MONO: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 'var(--text-sm)' };

/**
 * Name column: the row's identity, plus the version the runtime's own store records.
 *
 * A discovered pi package answers its exact version from the runtime's lock file, and that number is
 * the whole reason a "package manager" row is worth showing — a name alone cannot tell an operator
 * whether the plugin they see is the one they installed. A tracked artifact carries no such field
 * here (its provenance is the manifest), so the suffix is simply absent.
 */
/** Installed-row name. `onOpen` turns it into the detail dialog's opener; a row with no public
 *  identity (a manual MCP server) still opens — the dialog simply has less to say. */
const NameCell: React.FC<{ row: Row; onOpen?: (row: Row) => void; disabledLabel?: string }> = ({ row, onOpen, disabledLabel }) => (
  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, maxWidth: '100%', fontWeight: 'var(--font-semibold)' }}>
    {onOpen ? (
      <button type="button" className="harness-detail-link" onClick={() => onOpen(row)}>
        {row.name}
      </button>
    ) : (
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
    )}
    {row.version && (
      <span style={{ ...MONO, fontWeight: 'var(--font-regular)', color: 'var(--text-dim)', flex: '0 0 auto' }}>@{row.version}</span>
    )}
    {row.enabled === false && disabledLabel && (
      <span className="chip" style={{ flex: '0 0 auto', fontWeight: 'var(--font-regular)' }}>{disabledLabel}</span>
    )}
  </span>
);

const TH: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  borderBottom: '1px solid var(--divider)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'middle',
};

/** Value columns (source / host / state / action) center: they hold short tokens, not prose. */
const TH_CENTER: React.CSSProperties = { ...TH, textAlign: 'center' };
const TD_CENTER: React.CSSProperties = { ...TD, textAlign: 'center' };

/** Parameter table cells: the shared ScrollTable owns the head, borders and vertical centering. */
const MCP_TABLE_CELL: React.CSSProperties = { padding: '8px 10px' };

/** Compact toolbar control metrics — the host picker and the search field sit on one line, so
 *  they must be pixel-identical: same font size, same padding, same border box. */
/** Header toolbars mix `.btn`, `.input` and segmented switches: they all take this height, so a row
 *  never shows three slightly different control heights. 34px (not 30) because a 12px mono
 *  placeholder inside a 30px box left only ~8px of vertical slack and read as cramped. */
const HEADER_CONTROL_HEIGHT = 34;

/** The chip row's band (source chips ≈26.5px, `.btn-sm` ≈28.5px). A control moved into that row takes
 *  THIS height, not the 34px header band — otherwise the row grows around the one tall control and the
 *  chips beside it stop sharing a baseline. */
const CHIP_ROW_CONTROL_HEIGHT = 28;

const TOOLBAR_CONTROL: React.CSSProperties = {
  fontSize: 'var(--text-md)',
  padding: '7px 10px',
  boxSizing: 'border-box',
  height: `${HEADER_CONTROL_HEIGHT}px`,
};

const HOSTS_PREVIEW = 3;

/** Rows per marketplace page. One number for every source: the adapters clamp it to their own cap
 *  (GitHub/npm answer 50 at most), and a catalog no longer needs a bigger page now that "next" exists. */
const MARKET_PAGE_SIZE = 24;

/** host id → vendored brand asset (frontend/src/assets/brands/<name>.svg) */
const HOST_BRAND: Record<string, string> = {
  opencode: 'opencode',
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
  dsh: 'dsh',
  omp: 'omp',
  grok: 'grok',
  kimi: 'kimi',
  openclaw: 'openclaw',
  amp: 'amp',
  cursor: 'cursor',
  cline: 'cline',
  zed: 'zed',
  windsurf: 'windsurf',
  antigravity: 'antigravity',
  factory: 'factory',
  'gemini-cli': 'gemini-cli',
};

/** Brand mark when one is vendored, otherwise a neutral glyph at the same size. */
const HostIcon: React.FC<{ host: string; size?: number }> = ({ host, size = 13 }) => {
  const brand = HOST_BRAND[host];
  if (brand) return <BrandIcon name={brand} size={size} />;
  return <Terminal size={size} aria-hidden style={{ flexShrink: 0 }} />;
};

/** One host as a picker option. The vendor note in parentheses is dropped: the brand mark already
 *  carries the identity, and the rail/filter/install list all read better without it. */
const hostOption = (host: HarnessHostView): ComboboxOption => ({
  value: host.id,
  label: host.label.replace(/\s*\([^)]*\)\s*$/, ''),
  icon: <HostIcon host={host.id} size={16} />,
});

/**
 * Manual MCP draft — the console's `manual:` install path (ADR-0015 §D6 "manual"), extended by the
 * registry-driven parameter form (2026-11-01 amendment).
 *
 * A draft started from the free-form fields carries key NAMES only. A draft filled from a registry
 * `server.json` also carries the declared inputs (`params`) and CLI arguments (`args`), so the form
 * can render the right control per parameter instead of asking the operator to type a command line.
 */
type McpTransport = 'stdio' | 'sse';

/** stdio has two shapes: a runner + package (the argv is built for you) or a raw command line. */
type McpStdioMode = 'advanced' | 'custom';
const MCP_RUNNERS = ['npx', 'bunx', 'uvx'] as const;
type McpRunner = (typeof MCP_RUNNERS)[number];
/** What a runner needs in front of the package spec (`npx` asks y/N without `-y`). */
const MCP_RUNNER_FLAGS: Record<McpRunner, string[]> = { npx: ['-y'], bunx: [], uvx: [] };
const MCP_PKG_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.-]+)?$/i;
/** uvx resolves PEP 508 requirements: `name`, `name==1.2.3`. */
const MCP_PYPI_PKG_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:==[\w.-]+)?$/i;
const mcpPkgValid = (runner: McpRunner, pkg: string): boolean =>
  runner === 'uvx' ? MCP_PYPI_PKG_RE.test(pkg.trim()) : MCP_PKG_RE.test(pkg.trim());
/** A token in an existing argv that names a package for the given runner. */
const mcpPkgToken = (runner: McpRunner, arg: string): boolean =>
  runner === 'uvx' ? MCP_PYPI_PKG_RE.test(arg) : MCP_PKG_RE.test(arg);

/** A runner's argv: its install flags, the package spec, then whatever else the draft holds. */
const mcpStdioArgv = (draft: McpDraft): string[] => {
  const extra = parseArgLine(draft.argsText);
  if (draft.mode === 'custom') return extra;
  const pkg = draft.pkg.trim();
  return pkg ? [...MCP_RUNNER_FLAGS[draft.runner], pkg, ...extra] : extra;
};

/** The executable the draft writes: the runner in standard mode, the typed command otherwise. */
const mcpStdioCommand = (draft: McpDraft): string =>
  draft.mode === 'custom' ? draft.command.trim() : draft.runner;

/** One editable launch parameter: an argv entry, an environment variable, or a request header. */
interface McpParamRow {
  id: string;
  /** `--flag` for argv, empty for a positional value; the variable / header NAME otherwise. */
  name: string;
  value: string;
  description?: string;
  required?: boolean;
  /** Written into the launch line. Empty optional rows start unchecked and fold under the
   *  candidate group; checking one is how the operator picks it without typing a value. */
  selected?: boolean;
  secret?: boolean;
  format?: McpCliFormat;
  placeholder?: string;
  choices?: string[];
}

interface McpDraft {
  name: string;
  transport: McpTransport;
  /** stdio only: standard = runner + package spec, custom = raw command + args. */
  mode: McpStdioMode;
  runner: McpRunner;
  /** Package spec for standard mode (`@scope/name@1.2.3`). */
  pkg: string;
  command: string;
  /** Space-separated argv tail; a value containing spaces is quoted. */
  argsText: string;
  /** Environment variable KEYS an existing stdio entry declares; carried through an edit unchanged. */
  envRows: McpParamRow[];
  url: string;
  /** Remote only: request headers. A blank value keeps the runtime's stored value or writes its
   *  environment reference; a typed value is stored literally and never read back (gate 4). */
  headerRows: McpParamRow[];
  /** Header keys whose stored value already exists (a literal or `{file:...}`) — names only. */
  headerSetKeys: string[];
  /** Registry arguments (kept across an edit) plus the selection the editor last applied. */
  args: McpParamRow[];
}

/** A fresh server starts in CUSTOM mode: the raw executable + argv is the runtime's own shape. */
const EMPTY_MCP_DRAFT: McpDraft = {
  name: '',
  transport: 'stdio',
  mode: 'custom',
  runner: 'npx',
  pkg: '',
  command: '',
  argsText: '',
  envRows: [],
  url: '',
  headerRows: [],
  headerSetKeys: [],
  args: [],
};

const MCP_NAME_RE = /^[\w.-]+$/;
/** Server name becomes an object key: these rewrite the prototype instead. */
const MCP_RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const MCP_URL_RE = /^https?:\/\/\S+$/i;

let mcpArgRowSeq = 0;
const nextArgRowId = (): string => `arg-${++mcpArgRowSeq}`;

/** Reverse-render argv into editable rows, attaching the page's row ids. */
const argRowsWithIds = (tokens: string[]): McpParamRow[] =>
  argRowsFromArgv(tokens).map((row) => ({ id: nextArgRowId(), name: row.flag, value: row.value, selected: true }));

/** A registry-declared named argument may arrive without its dash; the stored name always keeps it. */
const mcpFlagToken = (name: string): string => {
  const flag = name.trim();
  return flag && !/^--?/.test(flag) ? `--${flag}` : flag;
};

/** Compose one row back into argv tokens — `name` carries the flag. */
const mcpParamTokens = (row: McpParamRow): string[] =>
  argRowTokens({ flag: mcpFlagToken(row.name), value: row.value });

/**
 * The table's name cell hides the dash prefix: the operator edits `transport`, while the stored
 * name keeps `--` so apply round-trips. A dash typed by hand wins (`-p` stays single).
 */
const mcpRowNameText = (row: McpParamRow): string => row.name.replace(/^--?/, '');

const mcpRowNamePatch = (row: McpParamRow, text: string): Partial<McpParamRow> => {
  const typed = /^(--?)(.+)$/.exec(text);
  if (typed) return { name: `${typed[1]}${typed[2]}` };
  const prefix = row.name.startsWith('--') ? '--' : row.name.startsWith('-') ? '-' : '--';
  return { name: text === '' ? '' : `${prefix}${text}` };
};

/**
 * Fold declared parameters into a table: a matching name keeps the value already typed, and the
 * declaration's description / required / choices replace whatever the table held before.
 */
const mergeMcpParamRows = (rows: McpParamRow[], declared: McpParamRow[]): McpParamRow[] => {
  const merged = [...rows];
  for (const row of declared) {
    const index = merged.findIndex((item) =>
      row.name !== '' ? item.name === row.name : item.name === '' && item.value === row.value
    );
    if (index < 0) {
      merged.push(row);
      continue;
    }
    const prev = merged[index]!;
    merged[index] = { ...row, id: prev.id, value: prev.value !== '' ? prev.value : row.value, selected: prev.selected ?? row.selected };
  }
  return merged;
};

const mcpNameInvalid = (name: string): boolean => {
  const value = name.trim();
  return !value || !MCP_NAME_RE.test(value) || MCP_RESERVED_NAMES.has(value);
};

/** The launch half alone: an EDIT keeps an existing name, which may predate the install grammar. */
const mcpDraftLaunchReady = (draft: McpDraft): boolean =>
  draft.transport === 'sse'
    ? MCP_URL_RE.test(draft.url.trim())
    : draft.mode === 'advanced'
      ? mcpPkgValid(draft.runner, draft.pkg)
      : draft.command.trim() !== '';

const mcpDraftReady = (draft: McpDraft): boolean => !mcpNameInvalid(draft.name) && mcpDraftLaunchReady(draft);

/** Named rows that carry a value — the map the writer merges over the runtime's own entry. */
const mcpValueMap = (rows: McpParamRow[]): Record<string, string> =>
  Object.fromEntries(
    rows
      .filter((row) => row.name.trim() !== '' && row.value !== '')
      .map((row) => [row.name.trim(), row.value] as const)
  );

const mcpLaunchFromDraft = (draft: McpDraft): HarnessMcpLaunch => {
  if (draft.transport === 'sse') {
    const rows = draft.headerRows.filter((row) => row.name.trim() !== '');
    const headerKeys = rows.map((row) => row.name.trim());
    const headerValues = mcpValueMap(rows);
    return {
      url: draft.url.trim(),
      transport: 'sse',
      ...(headerKeys.length > 0 ? { headerKeys } : {}),
      ...(Object.keys(headerValues).length > 0 ? { headerValues } : {}),
    };
  }
  const envRows = draft.envRows.filter((row) => row.name.trim() !== '');
  const envKeys = envRows.map((row) => row.name.trim());
  const envValues = mcpValueMap(envRows);
  const args = mcpStdioArgv(draft);
  return {
    command: mcpStdioCommand(draft),
    ...(args.length > 0 ? { args } : {}),
    ...(envKeys.length > 0 ? { envKeys } : {}),
    ...(Object.keys(envValues).length > 0 ? { envValues } : {}),
  };
};

/** Pre-fill the install form for a MARKET MCP row (ADR-0015 §D11 amendment): the row's package
 *  launch, expressed as the same stdio draft the Add/Edit sheet edits. The market key carries no
 *  version (it is resolved at INSTALL time, §D9), so the prefill shows the bare runner spec; the
 *  backend re-applies the resolved pin to every operator-edited launch. `null` for a key with no
 *  package form (a git-backed row resolves server-side; the sheet has nothing to prefill).
 *  An untouched form therefore installs the resolver's pinned command unchanged (§D9).
 *  `name` is the entry KEY the row answered (`serverName`), never the package identity the row is
 *  browsed by: the field is read-only, so it must show what the landing will carry. */
const mcpDraftFromMarketKey = (name: string, key: string): McpDraft | null => {
  let command = '';
  let argsText = '';
  if (key.startsWith('npm:')) {
    command = 'npx';
    argsText = `-y ${key.slice(4)}`;
  } else if (key.startsWith('pypi:')) {
    command = 'uvx';
    argsText = key.slice(5);
  } else {
    return null;
  }
  const stdio = parseStdioLaunch({ command, args: parseArgLine(argsText) });
  return { ...EMPTY_MCP_DRAFT, name, ...stdio };
};

/** A command line stored as one string (or a hand-written entry) reads back as exe + tokens. */
const splitCommand = (command: string): { exe: string; tokens: string[] } => {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { exe: parts[0] ?? '', tokens: parts.slice(1) };
};

/** Read an existing stdio launch back into the form: runner + package when the shape allows it. */
const parseStdioLaunch = (launch: { command: string; args?: string[] }): Pick<McpDraft, 'mode' | 'runner' | 'pkg' | 'command' | 'argsText'> => {
  const { exe, tokens } = splitCommand(launch.command);
  const runner = MCP_RUNNERS.find((item) => item === exe.toLowerCase());
  const argv = [...tokens, ...(launch.args ?? [])];
  if (!runner) return { mode: 'custom', runner: 'npx', pkg: '', command: exe, argsText: formatArgLine(argv) };
  const pkgIndex = argv.findIndex((arg) => mcpPkgToken(runner, arg) && !MCP_RUNNER_FLAGS[runner].includes(arg));
  if (pkgIndex < 0) return { mode: 'custom', runner, pkg: '', command: runner, argsText: formatArgLine(argv) };
  const pkg = argv[pkgIndex]!;
  const rest = argv.filter((arg, i) => i !== pkgIndex && !MCP_RUNNER_FLAGS[runner].includes(arg));
  return { mode: 'advanced', runner, pkg, command: runner, argsText: formatArgLine(rest) };
};

/** Pre-fill the shared form from an EXISTING launch: stdio and remote open different halves.
 *  `setKeys` names the header/env keys whose stored value must not be overwritten by an empty form
 *  field — the badge is the only thing the console learns about it (gate 4). */
const mcpDraftFromLaunch = (name: string, launch: HarnessMcpLaunch, setKeys: string[] = []): McpDraft => {
  if (!('command' in launch)) {
    return {
      ...EMPTY_MCP_DRAFT,
      name,
      transport: 'sse',
      url: launch.url,
      headerRows: (launch.headerKeys ?? []).map((key) => ({ id: nextArgRowId(), name: key, value: '' })),
      headerSetKeys: setKeys,
    };
  }
  return {
    ...EMPTY_MCP_DRAFT,
    ...parseStdioLaunch(launch),
    name,
    // Carried through an edit untouched: the writer keeps every key it does not hear about.
    envRows: (launch.envKeys ?? []).map((key) => ({ id: nextArgRowId(), name: key, value: '' })),
  };
};

/** Best-effort npm package behind an existing launch, used to prefill the registry search box. */
const mcpPackageHint = (launch: HarnessMcpLaunch): string => {
  if (!('command' in launch)) return '';
  const { exe, tokens } = splitCommand(launch.command);
  const runner = MCP_RUNNERS.find((item) => item === exe.toLowerCase());
  if (!runner) return '';
  return [...tokens, ...(launch.args ?? [])].find(
    (arg) => mcpPkgToken(runner, arg) && !MCP_RUNNER_FLAGS[runner].includes(arg)
  ) ?? '';
};

const mcpArgRow = (arg: HarnessMcpRegistryArgument): McpParamRow => ({
  id: nextArgRowId(),
  name: arg.type === 'named' ? mcpFlagToken(arg.name) : '',
  value: arg.default ?? '',
  // A declared default is written at once; a required declaration stays visible for its value.
  selected: arg.required === true || (arg.default ?? '') !== '',
  ...(arg.required ? { required: true } : {}),
  ...(arg.secret ? { secret: true } : {}),
  ...(arg.format ? { format: arg.format } : {}),
  ...(arg.description ? { description: arg.description } : {}),
  ...(arg.choices ? { choices: arg.choices } : {}),
});

/**
 * Turn one registry package into form fields — the bridge from `server.json` to a launch.
 *
 * The npm shape fills the ADVANCED form (runner + package spec): the argv is composed by the form,
 * so `npx -y` is never forgotten and the operator can switch to the custom form for anything the
 * registry cannot express. Fixed arguments keep registry order and stay after the package. Registry
 * environment variables are NOT copied into a new launch: DBHub declares only env vars while its
 * real launch surface is `--transport` / `--port` / `--dsn`, and the sheet reads those from the
 * package itself (see the CLI probe) instead of writing a runtime environment nobody asked for.
 */
const mcpDraftFromPackage = (
  pkg: HarnessMcpRegistryPackage
): Pick<
  McpDraft,
  'transport' | 'mode' | 'runner' | 'pkg' | 'command' | 'argsText' | 'url' | 'args' | 'envRows' | 'headerRows'
> | null => {
  if (pkg.registryType === 'remote') {
    // `remotes[].transport.headers` is the only parameter surface a remote server declares
    // statically: prefill the names it requires, plus a pinned/default value when it has one.
    return {
      transport: 'sse',
      mode: 'advanced',
      runner: 'npx',
      pkg: '',
      command: 'npx',
      argsText: '',
      url: pkg.url ?? '',
      args: [],
      envRows: [],
      headerRows: pkg.headers.map((header) => ({
        id: nextArgRowId(),
        name: header.name,
        value: header.value ?? header.default ?? '',
        ...(header.description ? { description: header.description } : {}),
        ...(header.required ? { required: true } : {}),
        ...(header.secret ? { secret: true } : {}),
        ...(header.placeholder ? { placeholder: header.placeholder } : {}),
        ...(header.choices ? { choices: header.choices } : {}),
      })),
    };
  }
  if (pkg.registryType === 'pypi' && pkg.transport === 'stdio') {
    // PyPI publishes no author runtime arguments here: the launch is `uvx <pkg>==<version>`, the
    // Python twin of the npm form, and the operator continues in the parameter table if needed.
    const spec = pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
    return {
      transport: 'stdio',
      mode: 'advanced',
      runner: 'uvx',
      pkg: spec,
      command: 'uvx',
      argsText: '',
      url: '',
      args: [],
      envRows: [],
      headerRows: [],
    };
  }
  if (pkg.registryType !== 'npm' || pkg.transport !== 'stdio') return null;

  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : `${pkg.identifier}@latest`;
  const fixed: string[] = [];
  const rows: McpParamRow[] = [];
  for (const arg of pkg.args) {
    if (arg.value !== undefined) fixed.push(arg.type === 'named' ? `${arg.name}=${arg.value}` : arg.value);
    else rows.push(mcpArgRow(arg));
  }
  // A registry default is applied immediately; the row stays so the editor can change it.
  const initial = [...fixed, ...rows.flatMap((row) => (row.value !== '' ? mcpParamTokens(row) : []))];
  return {
    transport: 'stdio',
    mode: 'advanced',
    runner: 'npx',
    pkg: spec,
    command: 'npx',
    argsText: formatArgLine(initial),
    url: '',
    args: rows,
    envRows: [],
    headerRows: [],
  };
};

/** Gate plan rows, shared by the market install sheet and the manual MCP sheet. */
const InstallGatePlan: React.FC<{ targets: HarnessInstallTarget[]; descKey: string }> = ({ targets, descKey }) => {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          padding: '8px 10px',
          border: '1px solid var(--divider)',
          borderRadius: 8,
          background: 'var(--chip-bg)',
        }}
      >
        <ShieldAlert size={14} style={{ flex: '0 0 auto', color: 'var(--accent-rose)' }} aria-hidden />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{t(descKey)}</span>
      </div>
      {targets.map((target, index) => (
        <div
          key={`${target.host}:${index}`}
          style={{
            border: '1px solid var(--divider)',
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)' }}>
            <HostIcon host={target.host} size={14} />
            {target.host}
          </span>
          {target.refused ? (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>{target.refused}</span>
          ) : target.echo ? (
            /* The verbatim command apply will run — never summarised, never reformatted. */
            <code
              style={{
                ...MONO,
                padding: '6px 8px',
                background: 'var(--chip-bg)',
                borderRadius: 6,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {target.echo}
            </code>
          ) : target.file ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <code style={{ ...MONO, color: 'var(--text-dim)', overflowX: 'auto' }}>{target.file}</code>
              {target.container && <code style={{ ...MONO, color: 'var(--text-dim)' }}>{target.container}</code>}
            </div>
          ) : null}
          {/* Gate 2's other half: which keys the merge adds or overwrites, exactly as the writer
              planned them. A name collision is an overwrite, and it must be visible before confirm. */}
          {((target.addedKeys?.length ?? 0) > 0 || (target.changedKeys?.length ?? 0) > 0) && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-snug)' }}>
              {target.addedKeys && target.addedKeys.length > 0 && (
                <>
                  {t('harness.mcpPlanAdd')}{' '}
                  <code style={MONO}>{target.addedKeys.join(', ')}</code>
                </>
              )}
              {target.addedKeys && target.addedKeys.length > 0 && target.changedKeys && target.changedKeys.length > 0
                ? ' · '
                : null}
              {target.changedKeys && target.changedKeys.length > 0 && (
                <>
                  {t('harness.mcpPlanChange')}{' '}
                  <code style={MONO}>{target.changedKeys.join(', ')}</code>
                </>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

/**
 * Does one COPY belong to the page's harness?
 *
 * Two answers, one predicate: ownership (`copy.host`) is who the copy is recorded under — the
 * landing that was written; readership (`copy.readers`, skills only) is every runtime that loads
 * that directory. A skill materialized once in `.agents/skills` is read by fifteen runtimes, so asking
 * only about `host` would show it under one rail entry and hide it under the other fourteen.
 */
const copyServes =
  (harnessId: string) =>
  (copy: { host: string; readers?: string[] }): boolean =>
    copy.host === harnessId || (copy.readers ?? []).includes(harnessId);

/**
 * Does an artifact belong to the page's harness?
 *   · an plugin is written against ONE runtime's plugin API, so the runtime is part of its
 *     IDENTITY (`artifact.harness`) — a copy list alone would miss a package that is recorded but
 *     not yet materialized;
 *   · an MCP artifact is one server that may sit in several clients' configs at once, and a skill is
 *     one directory several runtimes read, so the COPY is the landing there and `artifact.harness` is
 *     unset — reading it would hide every artifact that has copies on this page.
 */
const scopedTo = (kind: Kind, harnessId: string) => (artifact: HarnessArtifactView): boolean =>
  (kind === 'plugin' && artifact.harness === harnessId) || artifact.copies.some(copyServes(harnessId));

/** The same question for a discovered row: its copies carry readership, and an plugin row also
 *  names its runtime at the row level (the store it was read from). */
const rowServes = (harnessId: string) => (item: HarnessDiscoveredArtifact): boolean =>
  item.harness === harnessId || item.copies.some(copyServes(harnessId));

/**
 * The shared cross-agent skills location (`~/.agents/skills`, ADR-0015 D3 R2).
 *
 * `universal` is a HOST id, not a runtime: it owns that directory (first adapter in registry order)
 * and every `readsUniversal` runtime loads it. So on a skills page pinned to one runtime, a row whose
 * copies carry this host is NOT private to that runtime — the same row sits under all fifteen rail
 * entries, which is exactly why the pinned page cannot answer "what is actually mine" on its own.
 */
const SHARED_HOST = 'universal';

/** Up to this many profile choices, render radio cards; beyond it, the filterable combobox. */
const PROFILE_RADIO_MAX = 5;

/** Sentinel for "type a profile name that does not exist yet". The backend validates the real
 *  name; the vendor CLI creates the profile on the first install. */
const CUSTOM_PROFILE = '__custom_profile__';

/** Id accepted by the backend install-log ring; UUID when the browser exposes it. */
const newInstallLogId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Health predicate for ONE artifact — the rail counts artifacts, the table counts rows, and both
 * must answer the same question. A copy that is GONE or owned by another environment, or a rollup
 * that reports the same (`missing`, `partial`, `shadowed`).
 *
 * `dirty` is deliberately NOT a member. A file the runtime itself rewrites, or a config file shared
 * with another tool, drifts without anything being broken — reporting that as a health problem
 * taught the operator to distrust the badge. Drift stays where it has consequences: the removal
 * picker names it per copy, and the removal plan refuses to discard it without `discardLocalEdits`.
 */
const artifactNeedsAttention = (artifact: HarnessArtifactView): boolean =>
  artifact.copies.some((c) => c.state === 'missing' || c.state === 'foreign') ||
  artifact.rollup === 'missing' ||
  artifact.rollup === 'partial' ||
  artifact.rollup === 'shadowed';

/**
 * The row form of the same predicate: a tracked row asks its artifact, a discovered row asks its
 * copies (there is no rollup to consult — the runtime's own store is the only record), and an MCP
 * row ALSO asks the runtime's live answer: a config member can be intact on disk while the server
 * failed to connect, which is exactly the false "clean" the runtime status exists to prevent.
 *
 * This is the one filter worth having. Provenance is a column (the `source` cell already answers it),
 * not a browsing mode: splitting the list into "tracked" and "local" made the SAME artifact look like
 * two different kinds of thing and hid the fact that both are removable.
 */
const needsAttention = (row: Row): boolean =>
  runtimeNeedsAttention(row.runtime) ||
  (row.tracked && row.artifact
    ? artifactNeedsAttention(row.artifact)
    : row.copies.some((c) => c.state === 'missing' || c.state === 'foreign'));

/**
 * The harness rail: the page's first axis, as a vertical picker left of the content column.
 * Kind-agnostic on purpose — which hosts have an axis, what a click does and what the pick MEANS are
 * the caller's decisions (`KIND_META`), so all three kinds share one implementation.
 *
 *    ┌ HARNESS ────────┐   ← `harness.railTitle`, the same word on every page (CSS uppercases it)
 *    │ [filter…      ] │   ← only when the catalog is long enough for the input to earn its row
 *    │ ▪ opencode   3  │   ← HostIcon + label + landed count (+ health dot when not clean)
 *    │ ▫ show 6 more   │   ← collapsed tail (hosts neither integrated nor landed) behind one click
 *    └ only opencode's ────┘   ← hintKey names the pick, "only {name}'s …" (emptyKey instead when nothing has one)
 */
const HarnessRail: React.FC<{
  hosts: ComboboxOption[];
  counts: Record<string, { count: number; warn: boolean }>;
  activeId: string;
  onSelect: (id: string) => void;
  hintKey: string;
  emptyKey: string;
  /** The host catalog + inventory arrive from one slow scan; until they do the rail would read as
   *  "no harness on this machine", which is a claim — show the spinner instead of the empty line. */
  loading: boolean;
  /** Hosts the page holds back until "load more" is clicked; 0 renders nothing. */
  hiddenCount: number;
  /** Whether the hidden tail is currently revealed (the row then offers "collapse" instead). */
  expanded: boolean;
  /** Length of the default (clients-integrated) block; when the tail is revealed, a divider
   *  separates it from the appended hidden hosts. */
  primaryCount: number;
  onToggle: () => void;
}> = ({ hosts, counts, activeId, onSelect, hintKey, emptyKey, loading, hiddenCount, expanded, primaryCount, onToggle }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  /** The bottom hint names the harness it scopes — the display label of the rail's current pick. */
  const activeLabel = hosts.find((o) => o.value === activeId)?.label;
  // The input costs a row of width and a row of height, so it only appears once the catalog is longer
  // than a glance can scan — the same threshold the shared `Combobox` uses for its own filter.
  const canFilter = hosts.length > 8;
  const needle = filter.trim().toLowerCase();
  // The ACTIVE host is never filtered away: the rail must always answer "where am I", even while the
  // operator is typing a name that excludes it.
  const visible = hosts.filter(
    (option) =>
      option.value === activeId || !needle || `${option.label} ${option.value}`.toLowerCase().includes(needle)
  );
  // Two containers by construction: the primary block, and the hidden tail in its own group that
  // only mounts once expanded — the seam between them is structural, not a divider inside a list.
  const primaryEnd = Math.min(primaryCount, hosts.length);
  const blocks = [
    { key: 'primary', options: visible.slice(0, primaryEnd) },
    ...(expanded && primaryEnd < visible.length
      ? [{ key: 'hidden', options: visible.slice(primaryEnd) }]
      : []),
  ];
  const renderRow = (option: ComboboxOption) => {
    const active = option.value === activeId;
    const cell = counts[option.value] ?? { count: 0, warn: false };
    return (
      <button
        key={option.value}
        type="button"
        className="harness-rail-row"
        // Selected state, not a toggle: the row IS the scope of the page beside it.
        aria-current={active ? 'true' : undefined}
        aria-label={t('harness.railAria')
          .replace('{name}', option.label)
          .replace('{count}', String(cell.count))}
        title={t('harness.railCount').replace('{n}', String(cell.count))}
        // The row hands the pick to `onSelect`; what a pick RESETS is the page's business
        // (it lives with the URL effect so Back/Forward replays the same chain).
        onClick={() => onSelect(option.value)}
      >
        {option.icon}
        <span className="harness-rail-label">{option.label}</span>
        {cell.warn && <span className="harness-rail-dot" aria-hidden />}
        <span className="harness-rail-count" aria-hidden>
          {cell.count}
        </span>
      </button>
    );
  };
  return (
    <nav className="harness-rail" aria-label={t('harness.railTitle')}>
      {/* Two boxes, two jobs: the nav stretches to the frame's full height (the border has to reach
          the bottom of the content column), the inner list pins sticky (the picker stays in view
          while the page scrolls). */}
      <div className="harness-rail-inner">
        <div className="harness-rail-title">{t('harness.railTitle')}</div>
        {canFilter && (
          <div className="harness-rail-filter">
            <Search size={11} aria-hidden />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('harness.railFilter')}
              aria-label={t('harness.railFilter')}
              spellCheck={false}
            />
            {filter && (
              <button
                type="button"
                className="harness-rail-filter-clear"
                onClick={() => setFilter('')}
                aria-label={t('common.clear')}
                title={t('common.clear')}
              >
                <X size={11} aria-hidden />
              </button>
            )}
          </div>
        )}
        {hosts.length === 0 ? (
          loading ? (
            <span className="harness-rail-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} aria-hidden />
              {t('harness.scanning')}
            </span>
          ) : (
            <span className="harness-rail-hint">{t(emptyKey)}</span>
          )
        ) : visible.length === 0 ? (
          // Filtered to nothing: say so, and keep the field usable — an empty rail with no explanation
          // reads as "this machine has no runtimes".
          <span className="harness-rail-empty">{t('harness.railNoMatch')}</span>
        ) : (
          blocks.map((block) => (
            <div key={block.key} className={`harness-rail-group harness-rail-group-${block.key}`}>
              {block.options.map(renderRow)}
            </div>
          ))
        )}
        {(hiddenCount > 0 || expanded) && (
          <button type="button" className="harness-rail-row" onClick={onToggle}>
            <span className="harness-rail-label" style={{ color: 'var(--text-dim)' }}>
              {hiddenCount > 0
                ? t('harness.railMore').replace('{n}', String(hiddenCount))
                : t('harness.railLess')}
            </span>
          </button>
        )}
      </div>
      {/* Bottom-anchored: the card is full height, so the explanation sits at its foot —
          trailing the rows directly leaves a band of dead space above the border. No active label
          means an empty rail (the emptyKey line above already says so), and a hint with a hole where
          the harness name belongs is worse than no hint. */}
      {activeLabel && <div className="harness-rail-hint">{t(hintKey, { name: activeLabel })}</div>}
    </nav>
  );
};

export const HarnessPage: React.FC<{ kind: Kind }> = ({ kind }) => {
  const { t, lang } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  /** `:harness` exists only on a landing route; skills have no such segment (reads as undefined). */
  const params = useParams<{ harness?: string }>();
  /** Everything kind-specific sits in this one table — the branches below read fields, never kinds. */
  const meta = KIND_META[kind];
  const { landing, discovery, installMode, route, rail: railCopy, emptyNoteKey } = meta;

  /** The raw `:harness` segment — read early: the page-tab gate below consults the picked host's
   *  capability before `harness` itself is validated against the rail catalog. */
  const requestedHarness = landing ? (params.harness ?? '') : '';

  // Project management & scope view state
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [, setActiveProjectId] = useState<string | null>(null);
  /** Project pick used when the URL carries no explicit one (see `selectedProjectId` below). */
  const [fallbackProjectId, setFallbackProjectId] = useState<string | null>(null);
  const [projectsDialogOpen, setProjectsDialogOpen] = useState(false);
  const [installScope, setInstallScope] = useState<'global' | 'project'>('global');
  /** Per-profile plugin stores (DSH): the profile the open install sheet targets. */
  const [installProfile, setInstallProfile] = useState('');
  /** Free-text profile name, used when the operator picks the custom row. */
  const [customProfile, setCustomProfile] = useState('');
  const [installProjectId, setInstallProjectId] = useState<string | null>(null);
  /** Host catalog — declared before the page-tab gate and the scope helpers that consult it. */
  const [hosts, setHosts] = useState<HarnessHostView[]>([]);

  /** Scopes the host's adapter declares for one kind (ADR-0015 §D2, served as `kindScopes` by
   *  /hosts). An absent host or field answers BOTH, so a stale payload never hides a scope the
   *  backend would accept. */
  const kindScopesFor = (hostId: string, k: Kind): ('global' | 'project')[] =>
    hosts.find((h) => h.id === hostId)?.kindScopes?.[k] ?? ['global', 'project'];

  /** Project is offered only when EVERY target host declares a project landing for the kind — a
   *  host without one is refused by the writer anyway, so asking first would fake a choice. */
  const projectScopeAllowed = (hostIds: string[], k: Kind): boolean =>
    hostIds.length > 0 && hostIds.every((id) => kindScopesFor(id, k).includes('project'));

  /** The scope an install actually targets: a picked `project` coerces to `global` when the target
   *  set cannot land it (the chip is hidden in the same render; this is the submit-path backstop). */
  const coercedScope = (hostIds: string[], k: Kind): 'global' | 'project' =>
    installScope === 'project' && projectScopeAllowed(hostIds, k) ? 'project' : 'global';

  const refreshProjects = useCallback(async () => {
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
      setActiveProjectId(data.activeId);
      setFallbackProjectId((prev) => prev ?? data.activeId ?? data.projects[0]?.id ?? null);
      setInstallProjectId((prev) => prev ?? data.activeId ?? data.projects[0]?.id ?? null);
    } catch {
      // Tolerate error during initial load
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);
  const [inventory, setInventory] = useState<HarnessInventoryResponse | null>(null);
  /** Live MCP status (`kind === 'mcp'` only): null until the probe answers, and null on a page
   *  that has no MCP axis. Rows never invent a status from this — a missing entry is unknown. */
  const [mcpRuntime, setMcpRuntime] = useState<McpRuntimeReport | null>(null);
  const [runtimeProbing, setRuntimeProbing] = useState(false);
  const [sources, setSources] = useState<HarnessSourceView[]>([]);
  const [activeCatalog, setActiveCatalog] = useState('all');
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * Page tab, held in the URL (`?tab=market` or `?tab=project`).
   *
   * A reload must land on the view the operator was reading, and the market re-opens its own list
   * from the same address (its load effect keys on `tab`). Every kind forks the installed view into
   * two page-level tabs — global and project — aligned with the market tab in the same SegGroup.
   * `global` is the default and stays implicit. The write REPLACES:
   * switching a view is not a navigation step, and spending a history entry here would bury the
   * rail picks that Back is meant to replay.
   */
  const tabRaw = searchParams.get('tab');
  /** The project VIEW answers to the same per-host×kind capability as the install sheet
   *  (ADR-0015 §D2): a harness with no project landing for this kind gets no project tab, and a
   *  stale `?tab=project` coerces to global rather than rendering a view that can never fill.
   *  The raw pick stays in the URL — switching back to a capable harness restores it. */
  const projectTabOk = kindScopesFor(requestedHarness, kind).includes('project');
  const tab: 'global' | 'project' | 'market' =
    tabRaw === 'market' ? 'market' : tabRaw === 'project' && projectTabOk ? 'project' : 'global';
  const setTab = useCallback(
    (next: 'global' | 'project' | 'market'): void => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'global') params.delete('tab');
          else params.set('tab', next);
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  /**
   * Project pick (`?project=<id>`), held in the URL. A reload must reopen the same project; the
   * param is inert outside the project tab. A stale id (project deleted elsewhere) falls through
   * to the seeded default rather than blanking the picker.
   */
  const urlProjectId = searchParams.get('project');
  const selectedProjectId =
    urlProjectId && projects.some((p) => p.id === urlProjectId) ? urlProjectId : fallbackProjectId;
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const setSelectedProjectId = useCallback(
    (id: string | null): void => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (id) params.set('project', id);
          else params.delete('project');
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  /** The inventory request is scoped only where it can differ: the skills project tab with a pick. */
  const inventoryProjectId = tab === 'project' ? selectedProjectId : null;
  /** Landing pages are bound to ONE harness (no "all"): the target runtime is part of the landing,
   *  so the pick lives in the URL and is resolved against the host catalog below. */
  const [marketCatalog, setMarketCatalog] = useState('default');
  /**
   * The row order asked of the source — one of the keys the source DECLARES in `sorts`
   * (`/api/admin/harness/sources`), never a console-invented one. Empty = the source's own default.
   *
   * Ordering is the UPSTREAM's: GitHub ranks by `sort=stars|forks|updated` server-side and the
   * catalogs have exactly one order of their own. A page-local re-sort would claim a global ranking
   * nobody computed, so the console asks instead of rearranging.
   */
  const [marketSort, setMarketSort] = useState('');
  /** The field holds text; a request is spent only when a query is COMMITTED (Enter, source switch,
   *  clear). The market is a third-party catalog billing per call (anonymous GitHub: 10 req/min), so
   *  what the operator is still typing must never reach it. */
  const [marketQ, setMarketQ] = useState('');
  /** The committed query — the one the shown list answers. Not the field's text. */
  const [marketSubmittedQ, setMarketSubmittedQ] = useState('');
  const [marketItems, setMarketItems] = useState<HarnessMarketItem[]>([]);
  /** Market context line — the adapter's `noteCode` plus its params, localized at render time;
   *  `text` is the backend's English `note`, shown only for a code this table has no string for. */
  const [marketNote, setMarketNote] = useState<{
    text?: string;
    code?: string;
    params?: Record<string, string>;
  } | null>(null);
  const [marketError, setMarketError] = useState<MarketFailure | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  /** 1-based market page. The source decides what a page is worth (GitHub/npm page server-side,
   *  the catalogs slice a cached list), so the console asks for "page N" and never slices itself. */
  const [marketPage, setMarketPage] = useState(1);
  /** Whether the answered page has a successor. A source that reports no total has no page count,
   *  so this flag — not arithmetic — is what enables "next". */
  const [marketHasMore, setMarketHasMore] = useState(false);
  /** Rows the source reports for this query, when it reports one. */
  const [marketTotal, setMarketTotal] = useState<number | null>(null);
  /** Catalogs whose source reported an AUTHORITATIVE row total (not a cursor's lower bound and not a
   *  windowed search cap). Only those get a chip count: an unknown size stays silent, not "24+". */
  const [marketCatalogCounts, setMarketCatalogCounts] = useState<Record<string, number>>({});
  /** What `marketTotal` counts: `window` = reachable rows only, so the pager keeps the number for its
   *  page buttons but must not print it as the catalog's size (a windowed search's cap). */
  const [marketTotalScope, setMarketTotalScope] = useState<'catalog' | 'window'>('catalog');
  /**
   * Stars resolved on demand, keyed by `owner/repo` (lowercase).
   *
   * Most catalogs publish no star count, so their rows arrive with `stars: null`.
   * Resolving is an EXPLICIT act — one GitHub search per click, for one row or the whole page — and
   * the answer is kept for the session so paging back and forth never spends the quota twice. The map
   * outlives a page turn; it is dropped with the page itself, never merged into the row objects (a
   * browse answer stays what the source said).
   */
  const [starMap, setStarMap] = useState<Record<string, number>>({});
  /** Repositories with a lookup in flight (one row's or the whole page's): the cell spins instead of
   *  re-asking, and every star control is disabled while one is outstanding. */
  const [starPending, setStarPending] = useState<readonly string[]>([]);
  const starsBusy = starPending.length > 0;
  /** The market's scroll container: a new page must start at its top, not at the old offset. */
  const marketScrollRef = useRef<HTMLDivElement | null>(null);
  /** Monotonic request id — a response is rendered only while it still owns the table. */
  const marketReqRef = useRef(0);
  const [installTarget, setInstallTarget] = useState<HarnessMarketItem | null>(null);
  /** The market row whose detail dialog is open, plus the long-form half the backend answered for
   *  it. The row is the dialog's skeleton (name, description, link) — the read only ADDS, so a
   *  failed read never blocks the dialog. */
  const [detailSubject, setDetailSubject] = useState<DetailSubject | null>(null);
  const [detail, setDetail] = useState<HarnessMarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailure, setDetailFailure] = useState<MarketFailure | null>(null);
  /** Monotonic request id — a late answer must not repaint a dialog for a different row. */
  const detailReqRef = useRef(0);
  /** The dialog's own size: a peek by default, the whole viewport when the README needs it. */
  const [detailFull, setDetailFull] = useState(false);
  /** README translation, keyed to the exact source it was made from (`src`), exactly like `tr`:
   *  a re-read row whose body changed must not keep yesterday's translation. */
  const [detailTr, setDetailTr] = useState<{ src: string; text: string; model: string } | null>(null);
  const [detailTrBusy, setDetailTrBusy] = useState(false);
  /** Chunk progress of a running translation, drawn in the button. Null outside a run. */
  const [detailProgress, setDetailProgress] = useState<{ done: number; total: number } | null>(null);
  /** Seconds since the current translation started: proves the run is alive while all workers wait. */
  const [detailElapsed, setDetailElapsed] = useState(0);
  /** Per-dialog view toggle: the translation is shown until the operator asks for the source text. */
  const [detailShowSrc, setDetailShowSrc] = useState(false);
  /** The README arrived in the console's own language (the backend followed its localized edition or
   *  detected the script): translating it again is pure waste, so the button is not offered. */
  const detailReadmeLocalized = !!detail?.readmeLang && detail.readmeLang === lang;
  const [installHosts, setInstallHosts] = useState<string[]>([]);
  const [installBusy, setInstallBusy] = useState(false);
  /** Mirrored stdout/stderr of the running plugin install (empty outside one). */
  const [installLog, setInstallLog] = useState('');
  /** Set while the post-install result is on screen; the footer stops being an install action. */
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);
  /** Gate 3: the plan the backend refuses to execute until a human reads it. Kept separately from
   *  `installTarget` so the confirmation dialog can show the exact commands on its own surface. */
  const [installGate, setInstallGate] = useState<{ targets: HarnessInstallTarget[]; skillDir?: string } | null>(null);
  /** Manual MCP sheet: the draft while editing, and the backend's merge plan after `confirm_required`. */
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null);
  const [mcpGate, setMcpGate] = useState<{
    targets: HarnessInstallTarget[];
    payload: { name: string; launch: HarnessMcpLaunch };
  } | null>(null);
  /** Market MCP install: the row being installed through the shared Add/Edit sheet, plus the
   *  resolver's pinned launch (prefilled). An UNTOUCHED form sends no override, so the resolver's
   *  own command installs (ADR-0015 §D9). Single landing — the page's pinned harness. */
  const [mcpMarket, setMcpMarket] = useState<{
    item: HarnessMarketItem;
    defaultLaunch: HarnessMcpLaunch;
  } | null>(null);
  /** Market install gate (gate 2): the merge plan, plus the draft/item/default it was computed
   *  from, so the confirm re-send is identical to the first request. */
  const [mcpMarketGate, setMcpMarketGate] = useState<{
    targets: HarnessInstallTarget[];
    draft: McpDraft;
    item: HarnessMarketItem;
    defaultLaunch: HarnessMcpLaunch;
  } | null>(null);
  /** Edit sheet: the existing server's identity (the NAME is read-only) and its manifest record. */
  const [mcpEdit, setMcpEdit] = useState<{
    name: string;
    artifactId?: string;
    /** The copy the CURRENT view edits — the project tab edits the project landing, not the global one. */
    scope: 'global' | 'project';
    projectId?: string;
  } | null>(null);
  const [mcpEditLoading, setMcpEditLoading] = useState(false);
  /** Edit gate's plan; the draft is the one the plan was computed from. */
  const [mcpEditGate, setMcpEditGate] = useState<{ targets: HarnessInstallTarget[]; draft: McpDraft } | null>(null);
  /** Registry lookup for the launch-argument editor: the search box, its candidates, and the pick. */
  const [mcpDetectQ, setMcpDetectQ] = useState('');
  const [mcpDetecting, setMcpDetecting] = useState(false);
  const [mcpCandidates, setMcpCandidates] = useState<HarnessMcpRegistryCandidate[]>([]);
  const [mcpPick, setMcpPick] = useState('');
  /** The visual parameter editor; null = closed. */
  const [mcpArgsEditor, setMcpArgsEditor] = useState<McpParamRow[] | null>(null);
  /** The enlarged single-value editor opened from a row's expand button; null = closed. */
  const [mcpValueEditor, setMcpValueEditor] = useState<{ id: string; name: string; value: string } | null>(null);
  const [mcpDsnBuilder, setMcpDsnBuilder] = useState<{ id: string; name: string; value: string } | null>(null);
  /** Empty rows are candidates that fold under their own header; filled rows always show. */
  const [mcpAlternatesOpen, setMcpAlternatesOpen] = useState(true);
  // Open when an install fails with `ambiguous` — or with a stale `#dir` pin the adapter answers
  // `no_artifact` for — and the backend lists the directories that DO hold a SKILL.md (ADR-0015 §8).
  // Keeps the install dialog underneath (hosts/scope live there); confirming re-invokes the same
  // install with a `#dir`-pinned key.
  const [skillPick, setSkillPick] = useState<{ repo: string; candidates: string[]; value: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [picker, setPicker] = useState<{ row: Row; picked: Set<string> } | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /** Set by the sources drawer on every successful mutation; consumed on close to decide whether
   *  the market behind the drawer must re-read (a ref-only flag: no re-render on each mutation). */
  const sourcesDirtyRef = useRef(false);
  /** Bumped AFTER the source list reloads following a drawer mutation: the market federation
   *  iterates `activeCatalogSources`, so a newly added `mp-` chip must exist before the refetch. */
  const [marketRefreshTick, setMarketRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Translated text, keyed by row/item id. `src` pins the exact original it was produced from —
   *  re-downloading a skill whose description changed must not resurface the previous translation. */
  const [tr, setTr] = useState<Record<string, { src: string; text: string; model: string }>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [hostFilter, setHostFilter] = useState('');
  /** Hide the rows that live in the shared `.agents` tree — ON by default. The shared set is the SAME
   *  under every rail entry (fifteen runtimes read it), so leading a pinned page with it hides the one
   *  thing that page exists to answer: what was installed for THIS runtime. The rail cannot express
   *  that complement, and the switch is one tick away for anyone who wants the full list back. */
  const [hideShared, setHideShared] = useState(true);
  /** Batch progress; null when idle. `failed` accumulates across chunks. */
  const [batch, setBatch] = useState<{ done: number; total: number; failed: number } | null>(null);
  /** Pagination is a view concern: filters and translation always act on the whole list. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [layout, setLayout] = useState<'list' | 'card'>(() =>
    // Card is the default; only an explicit operator choice of 'list' sticks.
    localStorage.getItem(`harness.view.${kind}`) === 'list' ? 'list' : 'card'
  );
  const [showAllHosts, setShowAllHosts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Latest-call token for overlapping probes: a refresh and a drawer-open can fire two runs,
   *  and only the NEWER result may win the last-write race (stale verdicts / spinner flicker). */
  const probeSeq = useRef(0);

  /** Live MCP probe, deliberately NOT part of `load()`'s awaited set: the probe can sit for tens
   *  of seconds (one timed CLI/HTTP call per host), and the inventory is true without it. The page
   *  renders from on-disk state first; verdicts pop in whenever the runtimes answer. A failed probe
   *  keeps the last known verdicts — absence asserts nothing new. */
  const probeRuntime = async () => {
    if (kind !== 'mcp') return;
    const seq = ++probeSeq.current;
    setRuntimeProbing(true);
    try {
      const runtime = await api.harnessMcpRuntime();
      if (seq === probeSeq.current) setMcpRuntime(runtime);
    } catch {
      /* no live answer; the on-disk state stands alone */
    } finally {
      if (seq === probeSeq.current) setRuntimeProbing(false);
    }
  };

  /** Monotonic request id for inventory loads: switching tabs/projects fires overlapping reads,
   *  and only the NEWEST answer may paint the table (an older one names another project). */
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    void probeRuntime();
    try {
      const [inv, src, hostList] = await Promise.all([
        api.harnessInventory(inventoryProjectId ? { projectId: inventoryProjectId } : undefined),
        api.harnessSources(),
        api.harnessHosts(),
      ]);
      if (seq !== loadSeq.current) return;
      setInventory(inv);
      setHosts(hostList.hosts);
      setSources(src.sources.filter((s) => s.kinds.includes(kind)));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, inventoryProjectId]);

  useEffect(() => {
    localStorage.setItem(`harness.view.${kind}`, layout);
  }, [layout, kind]);

  /**
   * Scope filter: the global tab shows ONLY global copies, the project tab ONLY copies belonging to
   * the selected project. An external copy (CLI/package-manager landing) carries an identity token
   * in `path`, so its project attribution comes from the recorded `projectRoot`, not a path prefix.
   */
  const copyMatchesScope = useCallback(
    (copy: { scope: 'global' | 'project'; path: string; projectRoot?: string }): boolean => {
      if (tab === 'global') return copy.scope === 'global';
      if (tab === 'project') {
        if (copy.scope !== 'project') return false;
        // No project picked = the project view has nothing to show. Listing every project copy
        // here would attribute copies to a project the operator never selected.
        if (!selectedProject?.path) return false;
        const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
        if (copy.projectRoot) return norm(copy.projectRoot) === norm(selectedProject.path);
        const normCopy = copy.path.replace(/\\/g, '/').toLowerCase();
        const normProj = selectedProject.path.replace(/\\/g, '/').toLowerCase();
        return normCopy.startsWith(normProj.endsWith('/') ? normProj : normProj + '/');
      }
      return true;
    },
    [tab, selectedProject]
  );

  const trackedRows = useMemo(() => {
    const list = (inventory?.artifacts ?? []).filter((a) => a.kind === kind);
    return list
      .map((artifact) => {
        const matchingCopies = artifact.copies.filter(copyMatchesScope);
        if (matchingCopies.length === 0) return null;
        // The backend's rollup covers EVERY copy; the row shows one scope, so a global row must not
        // read "dirty" because a project copy of the same artifact drifted (and vice versa).
        const rollup: HarnessArtifactView['rollup'] = matchingCopies.some((c) => c.state === 'dirty')
          ? 'dirty'
          : matchingCopies.some((c) => c.state === 'missing')
            ? 'missing'
            : matchingCopies.some((c) => c.state === 'foreign')
              ? 'partial'
              : 'clean';
        return {
          ...artifact,
          copies: matchingCopies,
          rollup,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [inventory, kind, copyMatchesScope]);

  const discoveredRows = useMemo(() => {
    if (!discovery || !inventory) return [];
    const list = inventory.discovered.filter((item) => item.kind === kind);
    return list
      .map((item) => {
        const matchingCopies = item.copies.filter(copyMatchesScope);
        if (matchingCopies.length === 0) return null;
        return {
          ...item,
          copies: matchingCopies,
          hosts: [...new Set(matchingCopies.map((c) => c.host))],
        };
      })
      .filter((item): item is HarnessDiscoveredArtifact => item !== null);
  }, [discovery, inventory, kind, copyMatchesScope]);

  /** `host + server` → the runtime's answer. Only reachable hosts contribute: an unreachable
   *  daemon is "no live claim", and its rows keep their on-disk state alone. */
  const runtimeIndex = useMemo(() => {
    const byKey = new Map<string, NonNullable<Row['runtime']>>();
    for (const host of mcpRuntime?.hosts ?? []) {
      if (!host.reachable) continue;
      for (const server of host.servers) {
        byKey.set(`${host.host}\u0000${server.name}`, {
          host: host.host,
          status: server.status,
          ...(server.error ? { error: server.error } : {}),
        });
      }
    }
    return byKey;
  }, [mcpRuntime]);

  /** The runtime verdict is live, not a page-load snapshot: opening the sources drawer re-probes,
   *  so a server that failed (or came back) while the tab sat idle cannot keep a stale badge. */
  useEffect(() => {
    if (!sourcesOpen || kind !== 'mcp') return;
    void probeRuntime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesOpen, kind]);

  /** THE PINNED HARNESS's verdict, nothing else: a page is pinned to one harness, so its rows
   *  answer "does this server work THERE" — kimi failing must never repaint a claude row (and
   *  vice versa), same server or not. No verdict for this host = unknown, never healthy. */
  const runtimeFor = (name: string): Row['runtime'] =>
    kind === 'mcp' ? runtimeIndex.get(`${harness}\u0000${name}`) : undefined;

  /** A drawer row is a SOURCE (a package), not the landed artifact: resolve the artifact by its
   *  canonical key, then answer with THE PINNED HARNESS's own live verdict only. No verdict for
   *  this host = unknown. */
  const sourceRuntimeFor = (entry: { type?: 'github' | 'npm' | 'pypi'; repo: string }): Row['runtime'] => {
    if (kind !== 'mcp') return undefined;
    const canonical = `${entry.type ?? 'npm'}:${entry.repo}`;
    const artifact = trackedRows.find((a) => a.kind === 'mcp' && a.canonicalKey === canonical);
    return artifact ? runtimeFor(artifact.name) : undefined;
  };

  /** Every host the kind has an axis for, BEFORE the presence filter. Rail counts are computed
   *  over this full list so a landed-but-undetected host still carries its number. */
  const landingHosts = useMemo(
    () => (landing ? hosts.filter((h) => h[landing]) : []),
    [hosts, landing]
  );

  /** Rail counts over EVERY axis host — the count is a property of the host, not of whether the
   *  rail currently shows it. Reuses `scopedTo`/`rowServes`, so the rail can never disagree with
   *  the table it selects. */
  const railCounts = useMemo(() => {
    const counts: Record<string, { count: number; warn: boolean }> = {};
    for (const host of landingHosts) {
      const hits = trackedRows.filter(scopedTo(kind, host.id));
      const found = discoveredRows.filter(rowServes(host.id));
      // THIS host's verdict only: the rail dot answers "is anything broken on THIS harness" —
      // a kimi failure must not light the claude rail (and vice versa), same server or not.
      const runtimeWarn =
        kind === 'mcp' &&
        (hits.some((artifact) => runtimeNeedsAttention(runtimeIndex.get(`${host.id}\u0000${artifact.name}`))) ||
          found.some((item) => runtimeNeedsAttention(runtimeIndex.get(`${host.id}\u0000${item.name}`))));
      counts[host.id] = {
        count: hits.length + found.length,
        warn: hits.some(artifactNeedsAttention) || runtimeWarn,
      };
    }
    return counts;
  }, [landingHosts, trackedRows, discoveredRows, kind, runtimeIndex]);

  /** The harness segment the URL asks for, validated against the catalog: an unknown or missing
   *  id is not a harness, it is a broken URL. Validated against every axis host (not just the
   *  admitted ones) so a deep link to a collapsed host still pins its page. */
  const harness = useMemo(
    () => (landingHosts.some((h) => h.id === requestedHarness) ? requestedHarness : ''),
    [landingHosts, requestedHarness]
  );

  /** The hosts the ONE-CLICK integration covers — a frontend mirror of the
   *  harness host set, not the client ids (`opencode-proxy` folds to `opencode`).
   *  Hosts OUTSIDE this set are never admitted by default, however installed they are. */
  const ONE_CLICK_HOSTS: Record<string, true> = { opencode: true, claude: true, codex: true, pi: true, dsh: true, omp: true, grok: true, kimi: true, openclaw: true };

  /** ONE comparator for BOTH rail containers: `universal` pinned FIRST (always visible, top of
   *  the primary container), then the backend's popularity rank — the SAME rank that orders the
   *  Clients page's adapter roster (ADR-0015). Catalog order breaks ties. The order is a pure
   *  function of the host catalog — no click, selection or expand state feeds it, so interacting
   *  with the rail can never reshuffle either container. */
  const compareHosts = useCallback((a: HarnessHostView, b: HarnessHostView) => {
    return (a.id === SHARED_HOST ? -1 : a.rank) - (b.id === SHARED_HOST ? -1 : b.rank);
  }, []);

  /** Primary-container membership, INDEPENDENT of every interaction: exactly the clients
   *  integration (detected one-click hosts) — the hidden container holds everything else,
   *  including `universal`... which still renders FIRST, in the primary container. */
  const isPrimaryHost = useCallback(
    (h: HarnessHostView) => h.id === SHARED_HOST || (ONE_CLICK_HOSTS[h.id] && h.detected === true),
    []
  );

  /** Default admission: exactly the clients integration (detected one-click hosts). Everything
   *  else — `universal`, detected hosts outside the one-click set, hosts without presence
   *  markers — hides in the second container behind one "load more" click. */
  const admittedHosts = useMemo(() => {
    const set = new Set<string>();
    for (const h of landingHosts) {
      if (showAllHosts || isPrimaryHost(h)) {
        set.add(h.id);
      }
    }
    return set;
  }, [landingHosts, showAllHosts, isPrimaryHost]);

  const harnessOptions = useMemo(() => {
    // Catalog index as the tie-break keeps unranked hosts in a stable, predictable spot.
    const catIndex = new Map(landingHosts.map((h, i) => [h.id, i]));
    const ordered = [...landingHosts].sort(
      (a, b) => compareHosts(a, b) || (catIndex.get(a.id) ?? 0) - (catIndex.get(b.id) ?? 0)
    );
    // Two containers: primary (admitted) first, hidden tail appended — each sorted by the SAME
    // comparator above, so expanding never reshuffles either block.
    return [
      ordered.filter((h) => admittedHosts.has(h.id)),
      ordered.filter((h) => !admittedHosts.has(h.id)),
    ].flat().map((h) => hostOption(h));
  }, [landingHosts, admittedHosts, compareHosts]);
  /** How many non-integrated hosts the collapsed rail is holding back (the "load more" badge). */
  const hiddenHostCount = showAllHosts ? 0 : landingHosts.filter((h) => !admittedHosts.has(h.id)).length;

  /** The exclusion earns its place only where readership creates a shared set (skills) and the page
   *  is pinned to a runtime other than that shared location itself. */
  const canHideShared = kind === 'skill' && harness !== '' && harness !== SHARED_HOST;

  // The URL is the single source of truth for a landing page's harness. Once the catalog arrives, a
  // missing or unknown segment is REPLACED (never pushed) with the first DETECTED harness (one
  // whose rows are landed also qualifies — see `harnessOptions`):
  // a stale bookmark lands somewhere valid, and Back never bounces between two dead URLs. A rescan
  // re-runs this effect and leaves a valid pick untouched. The query rides along — a hand-typed
  // `?tab=market` without a segment must keep the view it names.
  useEffect(() => {
    if (!landing || harness) return;
    const first = harnessOptions[0];
    if (!first) return;
    navigate(`/harness/${route}/${first.value}${location.search}`, { replace: true });
  }, [landing, harness, harnessOptions, route, navigate, location.search]);

  // A harness change leaves the TAB alone: the operator picked a runtime, not a view. The query
  // rides along with the rail pick (see `pickHarness`), and Back/Forward replays the address it
  // recorded, so the view they were reading survives both. Resetting on the resolved param would
  // also fight the mount that completes a bookmark without a harness segment.

  /** Tracked artifacts narrowed to the pinned harness ('' = the un-pinned case does not occur:
   *  the redirect effect above replaces a missing segment before rows render). */
  const scopedTrackedRows = useMemo(
    () => (harness ? trackedRows.filter(scopedTo(kind, harness)) : trackedRows),
    [trackedRows, kind, harness]
  );

  /** Discovery rows for THIS page: the scan is one channel for every kind, so both axes are
   *  filtered here — `kind` always, the harness only where the page is pinned to one. */
  const scopedDiscovered = useMemo(
    () => discoveredRows.filter((item) => !landing || rowServes(harness)(item)),
    [discoveredRows, landing, harness]
  );

  /** Every row this page holds, before any control narrows it (the facets below derive from it). */
  const allRows: Row[] = useMemo(() => {
    const trackedView: Row[] = scopedTrackedRows.map((artifact) => {
      const src = sources.find((s) => s.id === artifact.sourceId || (artifact.listedOn && artifact.listedOn.includes(s.id)));
      const channel = artifact.sourceId?.startsWith('mp-') ? artifact.sourceId.slice(3) : (artifact.sourceId ?? 'direct');
      const hosts = [...new Set(artifact.copies.map((c) => c.host))];
      const runtime = runtimeFor(artifact.name);
      return {
        key: artifact.id,
        name: artifact.name,
        canonicalKey: artifact.canonicalKey,
        repo: repoOfKey(artifact.canonicalKey),
        description: artifact.description,
        copies: artifact.copies,
        hosts,
        tracked: true,
        sourceId: artifact.sourceId ?? null,
        listedOn: artifact.listedOn ?? (artifact.sourceId ? [artifact.sourceId] : []),
        catalog: src?.catalog ?? 'default',
        channel,
        state: artifact.rollup,
        ...(runtime ? { runtime } : {}),
        artifact,
      };
    });
    const localView: Row[] = scopedDiscovered.map((item) => {
      const runtime = runtimeFor(item.name);
      return {
        key: `local:${item.kind}:${item.harness ?? ''}:${item.name}`,
        name: item.name,
        canonicalKey: item.canonicalKey ?? null,
        repo: repoOfKey(item.canonicalKey),
        description: item.description,
        copies: item.copies,
        hosts: item.hosts,
        tracked: false,
        sourceId: null,
        listedOn: [],
        state: 'local',
        ...(item.origin ? { origin: item.origin } : {}),
        ...(item.version ? { version: item.version } : {}),
        ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
        ...(item.removal ? { removal: item.removal } : {}),
        ...(runtime ? { runtime } : {}),
      };
    });
    const all = [...trackedView, ...localView];
    return all.sort((a, b) => Number(b.tracked) - Number(a.tracked) || a.name.localeCompare(b.name));
  }, [scopedTrackedRows, scopedDiscovered, runtimeIndex, harness]);

  /** Is there anything to hide — and anything left to show? Both are PAGE-level facts, never
   *  query-dependent, so the control cannot vanish mid-typing and a runtime whose skills ALL live in
   *  the shared tree keeps its list instead of opening on an empty page. */
  const hasSharedRows = useMemo(() => allRows.some((row) => row.hosts.includes(SHARED_HOST)), [allRows]);
  const hasPrivateRows = useMemo(() => allRows.some((row) => !row.hosts.includes(SHARED_HOST)), [allRows]);
  const canToggleShared = canHideShared && hasSharedRows && hasPrivateRows;

  /** ON by default: the shared set is identical under every rail entry, so a pinned page that leads
   *  with it answers a question nobody asked. The gate guards the EFFECT too, not just the control —
   *  a default must never empty a page. */
  const sharedHidden = canToggleShared && hideShared;

  /** Every narrowing EXCEPT the shared exclusion and the source chip. The chips count from this list,
   *  so a number answers exactly what clicking it would show (a facet), never a total the table cannot
   *  produce. */
  const narrowedRows: Row[] = useMemo(() => {
    const list = filter === 'issues' ? allRows.filter(needsAttention) : allRows;
    const needle = q.trim().toLowerCase();
    if (!needle && !hostFilter) return list;
    return list.filter((row) => {
      // Host narrows to the harnesses that actually hold a copy here.
      if (hostFilter && !row.hosts.includes(hostFilter)) return false;
      if (!needle) return true;
      // Text is FUZZY RECALL; the chips above are EXACT narrowing — source has its own chip row, the
      // host has its own picker. So neither the source prefix of `canonicalKey` nor the hosts belong
      // in the haystack. What remains is what no control can express: the display name, the repo or
      // package identity behind it, and where it sits on disk (a directory is not always named like
      // the artifact). Host names still match through the paths, which is the honest place for them.
      const identity = row.canonicalKey
        ? row.canonicalKey.slice(row.canonicalKey.indexOf(':') + 1)
        : '';
      const hay = [row.name, identity, ...row.copies.map((c) => c.path)].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [allRows, filter, q, hostFilter]);

  /** The last facet before the source chip: the shared set, hidden or not. */
  const facetedRows: Row[] = useMemo(
    () => (sharedHidden ? narrowedRows.filter((row) => !row.hosts.includes(SHARED_HOST)) : narrowedRows),
    [narrowedRows, sharedHidden]
  );

  /** How many rows the switch hides RIGHT NOW (under the current query and health filter): the number
   *  is what keeps a default-hidden list from reading as "my skills disappeared". */
  const hiddenSharedCount = canToggleShared
    ? narrowedRows.filter((row) => row.hosts.includes(SHARED_HOST)).length
    : 0;

  const rowCatalog = useCallback((row: Row): string => {
    if (row.catalog) return row.catalog;
    if (row.sourceId) {
      const s = sources.find((src) => src.id === row.sourceId || row.listedOn.includes(src.id));
      if (s?.catalog) return s.catalog;
    }
    return 'default';
  }, [sources]);

  /** The table's rows: the catalog chip is the LAST narrowing, and the only one that carries counts. */
  const rows: Row[] = useMemo(
    () => facetedRows.filter((row) => (activeCatalog === 'all' || rowCatalog(row) === activeCatalog)),
    [facetedRows, activeCatalog, rowCatalog]
  );

  // Only harnesses that actually hold something here: a filter listing empty hosts is noise.
  const hostOptions = useMemo(() => {
    const present = new Set<string>();
    for (const artifact of scopedTrackedRows) for (const copy of artifact.copies) present.add(copy.host);
    for (const item of scopedDiscovered) for (const host of item.hosts) present.add(host);
    return hosts.filter((h) => present.has(h.id)).map(hostOption);
  }, [hosts, scopedTrackedRows, scopedDiscovered]);

  /** Kind of the install the open dialog would run. The marketplace ROW names its writer (an npm
   *  package reached from the skills page is an plugin package), so the target list follows the
   *  row, not the page. */
  const installKind: Kind = installTarget?.installKind ?? kind;
  const installMeta = KIND_META[installKind];

  /**
   * Hosts the dialog may write to — and the caliber differs per kind, which is why this used to be
   * wrong for MCP: skills are LOCATIONS, not readers (fifteen hosts read the same project
   * `.agents/skills`), so a host with no skills root, or one that is an alias of another host's
   * directory, is not a target. MCP and plugins need their OWN verified landing — a shared skills
   * directory says nothing about having a server config to merge into or a package manager to run.
   * Both axes share the presence rule: an undetected host is not offered anywhere (the rail hides it
   * too) — `universal` is always detected, so bootstrapping a fresh machine still has a target.
   */
  const installHostOffers = useMemo(
    () =>
      hosts
        .filter((h) => h.detected)
        .filter((h) =>
          installMeta.installAxis === 'skills-owner'
            ? h.hasSkills && h.owner && h.owner.global === h.id
            : installMeta.landing
              ? h[installMeta.landing]
              : false
        )
        .map(hostOption),
    [hosts, installMeta]
  );

  /**
   * Installed copies indexed by `canonicalKey`, from BOTH truth sources: the manifest (what this
   * gateway installed) and the discovery scan (what a runtime installed for itself). A plugin the
   * runtime owns IS installed — reporting it as "not installed" in the market while the global tab
   * lists it would describe one artifact two ways.
   */
  const installIndex = useMemo(() => {
    const index = new Map<string, { host: string; scope: string; state: string; path: string; profile?: string; projectRoot?: string }[]>();
    const put = (key: string | null | undefined, copy: { host: string; scope: string; state: string; path: string; profile?: string; projectRoot?: string }) => {
      if (!key) return;
      const list = index.get(key) ?? [];
      list.push(copy);
      index.set(key, list);
    };
    for (const artifact of inventory?.artifacts ?? []) {
      for (const copy of artifact.copies) put(artifact.canonicalKey, copy);
    }
    for (const item of inventory?.discovered ?? []) {
      for (const copy of item.copies) put(item.canonicalKey, copy);
    }
    return index;
  }, [inventory]);

  /**
   * Copies a market row is already installed as.
   *
   * A plugin row's key IS its canonicalKey (`npm:<name>`), and so is an MCP row's (the writer keys
   * the server inside a host's own `mcp` container by that identity), so both joins are exact. A skill's canonicalKey carries the directory inside the
   * repo (`gh:<owner>/<repo>#<dir>`), which a market row cannot know before the tarball is resolved —
   * so the repo prefix is the honest match there and the exact per-target answer waits for the
   * install sheet.
   */
  const installsFor = (item: HarnessMarketItem): { host: string; scope: string; state: string; path: string; profile?: string; projectRoot?: string }[] => {
    if (item.installKind !== 'skill') return installIndex.get(item.key) ?? [];
    const prefix = `${item.key.replace(/^github:/, 'gh:')}#`;
    const out: { host: string; scope: string; state: string; path: string; profile?: string; projectRoot?: string }[] = [];
    for (const [key, copies] of installIndex) if (key.startsWith(prefix)) out.push(...copies);
    return out;
  };

  /** Profile names a DSH host can receive a copy into (empty for other hosts). */
  const profilesForHost = (host: string): string[] =>
    host === 'dsh' ? (hosts.find((h) => h.id === 'dsh')?.profiles?.map((p) => p.name) ?? []) : [];

  /** A clean copy blocks only the same host, destination and (for DSH) profile. */
  const takenOn = (
    item: HarnessMarketItem,
    host: string,
    scope = installScope,
    projectId = installProjectId,
    profileName = installProfileValue || 'web',
  ): boolean => {
    const project = scope === 'project' ? projects.find((p) => p.id === projectId) : null;
    const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    return installsFor(item).some((copy) =>
      copy.host === host &&
      copy.scope === scope &&
      copy.state !== 'missing' &&
      (host !== 'dsh' || (copy.profile ?? 'web') === profileName) &&
      (scope === 'global' ||
        (!!project &&
          (copy.projectRoot
            ? norm(copy.projectRoot) === norm(project.path)
            : norm(copy.path).startsWith(`${norm(project.path)}/`)))),
    );
  };

  /** Free means ANY destination for the host; DSH must leave at least one profile open. */
  const hostFree = (
    item: HarnessMarketItem,
    host: string,
    scope = installScope,
    projectId = installProjectId,
  ): boolean => {
    if (host !== 'dsh') return !takenOn(item, host, scope, projectId);
    const names = profilesForHost(host);
    return (names.length ? names : ['web']).some((name) => !takenOn(item, host, scope, projectId, name));
  };

  /** Candidate hosts for an install kind: a single-target kind (an plugin is code against ONE
   *  runtime's plugin API) reads the page's harness; a multi-target kind takes `ticked` when given
   *  (the confirm dialog's chips), otherwise the full offer list — one skill directory, or one MCP
   *  server written into several clients' configs. Single source for the expression:
   *  freeTargets, installTargetHosts and startInstall all read it. */
  const hostsForKind = (kind: HarnessMarketItem['installKind'], ticked?: string[]): string[] =>
    KIND_META[kind].installMode === 'single' ? (harness ? [harness] : []) : (ticked ?? installHostOffers.map((o) => o.value));

  /** Targets this market row could still be installed to, right now (current page + scope). */
  const freeTargets = (item: HarnessMarketItem): number => {
    const hostIds = hostsForKind(item.installKind);
    return hostIds.filter((host) => hostFree(item, host)).length;
  };

  /** The market stays actionable when the item has a free target in another project scope —
   *  counting only hosts that DECLARE a project landing for the kind (ADR-0015 §D2): a host the
   *  writer would refuse is not a free target. */
  const canInstallFromMarket = (item: HarnessMarketItem): boolean =>
    freeTargets(item) > 0 ||
    projects.some((project) =>
      hostsForKind(item.installKind)
        .filter((host) => kindScopesFor(host, item.installKind).includes('project'))
        .some((host) => hostFree(item, host, 'project', project.id))
    );

  /** Open the detail dialog for one row: paint the row immediately, then fill in the README and the
   *  package facts. The row is what the operator clicked, so a slow/hostile upstream never leaves
   *  them looking at an empty modal. */
  /** Open the detail dialog for one subject: paint it immediately, then fill in the README and the
   *  package facts. The subject is what the operator clicked, so a slow/hostile upstream never
   *  leaves them looking at an empty modal. */
  const openDetail = (subject: DetailSubject) => {
    setDetailSubject(subject);
    setDetail(null);
    setDetailFailure(null);
    setDetailFull(false);
    setDetailTr(null);
    setDetailTrBusy(false);
    setDetailProgress(null);
    setDetailShowSrc(false);
    const req = ++detailReqRef.current;
    setDetailLoading(true);
    void api
      .harnessDetail({
        // The two portable identities the backend can build an upstream from: an npm package name,
        // or the ClawHub owner/slug pair. A row with neither (`manual:`, a curated slug) sends nothing
        // and the dialog opens on the row it already holds.
        ...(subject.packageKey?.startsWith('npm:') || subject.packageKey?.startsWith('clawhub:')
          ? { key: subject.packageKey }
          : {}),
        ...(subject.repo ? { repo: subject.repo } : {}),
        // The console language lets the backend serve the README's own localized edition (its
        // `English | Chinese` switcher) and report `readmeLang`, so no translation is spent on a
        // document that already exists in this language.
        lang,
      })
      .then((res) => {
        if (detailReqRef.current === req) setDetail(res.detail);
      })
      .catch((e) => {
        if (detailReqRef.current === req) setDetailFailure(marketFailure(e));
      })
      .finally(() => {
        if (detailReqRef.current === req) setDetailLoading(false);
      });
  };

  /** Translate the README into the console language. Long-form: the backend translates every prose
   *  segment in chunks, keeps fenced code verbatim, and rejoins the document in order. A README is
   *  tens of seconds of model output, so the stream reports chunk progress for the button. `refresh`
   *  re-translates a document that already has a cached rendering — the button says so once one
   *  exists. */
  const translateDetail = async (refresh = false) => {
    const body = detail?.readme;
    if (!body || detailTrBusy) return;
    const req = detailReqRef.current;
    setDetailTrBusy(true);
    setDetailProgress(null);
    try {
      const res = await api.harnessTranslateStream({ text: body, lang, refresh }, (done, total) => {
        // A late event from a dialog that moved on must not repaint the new row's button.
        if (detailReqRef.current === req) setDetailProgress({ done, total });
      });
      if (detailReqRef.current !== req) return;
      setDetailTr({ src: body, text: res.text, model: res.model });
      setDetailShowSrc(false);
    } catch (e) {
      // A run for a dialog that moved on must not toast over the new row.
      if (detailReqRef.current === req) {
        toast.error(`${t('harness.translateFailed')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      // The new dialog owns its own busy flag: only the run that still owns the dialog clears it.
      if (detailReqRef.current === req) {
        setDetailProgress(null);
        setDetailTrBusy(false);
      }
    }
  };

  // Elapsed seconds while a translation runs. Chunk progress only moves when a request RETURNS, and a
  // slow or throttled chunk can hold every worker for tens of seconds — a ticking clock is the honest
  // signal that the run is still alive instead of frozen.
  useEffect(() => {
    if (!detailTrBusy) return;
    const started = Date.now();
    setDetailElapsed(0);
    const id = setInterval(() => setDetailElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [detailTrBusy]);


  // Re-open = re-use: a README translated on a previous visit comes back from the CACHE with no
  // model call and no extra click — the read is cache-only, exactly like the description pre-seed
  // the tables run on mount. A miss is silent; the dialog simply keeps the source text.
  useEffect(() => {
    const body = detail?.readme;
    if (!body || detailTr || detailReadmeLocalized) return;
    const req = detailReqRef.current;
    let cancelled = false;
    void api
      .harnessTranslations({ lang, texts: [body], format: 'markdown' })
      .then(({ translations }) => {
        const hit = translations[body];
        if (cancelled || !hit || detailReqRef.current !== req) return;
        setDetailTr({ src: body, text: hit.text, model: hit.model });
      })
      .catch(() => {
        /* a cache miss is not an error the operator needs to see */
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.readme, detailTr, detailReadmeLocalized, lang]);

  /** Install action for one market row: starts at once when a single free target leaves the sheet
   *  nothing to ask (see `startInstall`); disabled when every reachable target is taken. */
  const marketInstallButton = (item: HarnessMarketItem) => {
    const free = freeTargets(item);
    const count = installsFor(item).length;
    const canInstall = canInstallFromMarket(item);
    return (
      <button
        className="btn btn-sm"
        disabled={!canInstall || installBusy}
        title={!canInstall ? t('harness.targetInstalled') : undefined}
        onClick={() => startInstall(item)}
        style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
      >
        <Download size={12} aria-hidden />
        <span>{!canInstall ? t('harness.installDone') : t('harness.install')}</span>
        {/* A plugin row targets exactly ONE runtime: its button already says install/installed, and a
            cross-host count on a single-host page reads as "partially installed" — a state that
            cannot exist there. The count stays only on multi-target kinds (skills, MCP). */}
        {count > 0 && free > 0 && KIND_META[item.installKind].installMode !== 'single' && (
          <span className="badge" style={{ fontSize: 'var(--text-2xs)', padding: '0 4px', lineHeight: 'var(--leading-14)' }}>
            {t('harness.installedBadge').replace('{n}', String(count))}
          </span>
        )}
      </button>
    );
  };

  /** The one harness a single-target install writes to. Absent when this page pins none — a skills
   *  page has no runtime axis, so there is nowhere to write an plugin package. */
  const singleTarget = installHostOffers.find((o) => o.value === harness);
  /** Per-profile plugin target for the open sheet (DSH): its adapter offers the profiles. */
  const profileChoices = singleTarget?.value === 'dsh' ? (hosts.find((h) => h.id === 'dsh')?.profiles ?? []) : [];
  const profileSelection =
    installProfile === CUSTOM_PROFILE
      ? CUSTOM_PROFILE
      : profileChoices.some((p) => p.name === installProfile)
        ? installProfile
        : (profileChoices[0]?.name ?? '');
  const customProfileName = customProfile.trim();
  const customProfileValid = DSH_PROFILE_NAME_RE.test(customProfileName);
  const installProfileValue =
    profileSelection === CUSTOM_PROFILE ? customProfileName : profileSelection;
  const profileSelectionValid =
    profileSelection !== CUSTOM_PROFILE || customProfileValid;
  /** Shown in place of the target chips when nothing here can take the install. Null for skills: a
   *  skill's landing list is its owned locations, which the chips already enumerate honestly. */
  const missingLanding = installMeta.rail ? (
    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>{t(installMeta.rail.emptyKey)}</span>
  ) : null;

  // Scope or dialog changes swap which locations exist; a selection that is no longer offered must
  // not stay checked and silently do nothing.
  useEffect(() => {
    const offered = new Set(installHostOffers.map((o) => o.value));
    setInstallHosts((prev) => {
      const kept = prev.filter((v) => offered.has(v));
      if (kept.length > 0) return kept;
      const fallback = installHostOffers[0]?.value;
      return fallback ? [fallback] : [];
    });
  }, [installHostOffers]);

  /**
   * Sources the page may offer: the kind must match, and a source that declares `hosts` serves ONLY
   * those harnesses (an plugin source is bound to the runtime whose plugin API its packages
   * target). A source without `hosts` is offered everywhere and the harness is named at install —
   * which is why the MCP registries stay a cross-harness discovery surface.
   */
  const sourcesForHarness = (k: Kind, harnessId: string): HarnessSourceView[] =>
    sources.filter((s) => s.kinds.includes(k) && (!s.hosts || !harnessId || s.hosts.includes(harnessId)));

  const pageSources = useMemo(() => sourcesForHarness(kind, harness), [sources, kind, harness]);


  const formatCatalog = (cat: string) => {
    if (cat === 'default') return t('harness.srcMgmt.defaultCatalog');
    if (cat === 'pi.dev') return t('harness.sourceNames.piDev');
    if (cat === 'ClawHub') return t('harness.sourceNames.clawhub');
    return cat;
  };

  /** Unique catalogs across all installed rows. */
  const installedCatalogs = useMemo(() => {
    const set = new Set<string>();
    for (const row of allRows) {
      set.add(rowCatalog(row));
    }
    return Array.from(set).sort();
  }, [allRows, rowCatalog]);

  /** Chip counts per catalog for the global tab. */
  const catalogCounts = useMemo(() => {
    const counts: Record<string, number> = { all: facetedRows.length };
    for (const cat of installedCatalogs) {
      counts[cat] = facetedRows.filter((row) => rowCatalog(row) === cat).length;
    }
    return counts;
  }, [facetedRows, installedCatalogs, rowCatalog]);

  /**
   * Catalogs available on the market tab.
   *
   * `default` is a SYSTEM catalog, not a source-derived one: operator/local sources (an `mp-*` entry
   * that names no catalog) live there, so it is always shown and sits FIRST — it is the axis'
   * default bucket, and named built-ins (ClawHub / pi.dev) follow in registry order.
   */
  const marketCatalogs = useMemo(() => {
    const named: string[] = [];
    for (const s of pageSources) {
      if (!s.enabled || !s.browsable) continue;
      const cat = s.catalog || 'default';
      if (cat !== 'default' && !named.includes(cat)) named.push(cat);
    }
    return ['default', ...named];
  }, [pageSources]);

  /** All active browsable sources contributing to the selected market catalog (federation). */
  const activeCatalogSources = useMemo(() => {
    return pageSources.filter(
      (s) => (s.catalog || 'default') === marketCatalog && s.enabled && s.browsable
    );
  }, [pageSources, marketCatalog]);

  const canBrowse = activeCatalogSources.length > 0;

  const activeSorts = useMemo(() => {
    const set = new Set<string>();
    for (const s of activeCatalogSources) {
      for (const sort of s.sorts ?? []) set.add(sort);
    }
    return Array.from(set);
  }, [activeCatalogSources]);

  /** The catalogs row is ordered by the system bucket first; the LANDING is the first catalog that
   *  actually has a browsable source, so an empty `default` never opens the market onto nothing. */
  const landingMarketCatalog = useMemo(
    () =>
      marketCatalogs.find((cat) =>
        pageSources.some((s) => s.enabled && s.browsable && (s.catalog || 'default') === cat),
      ) ?? 'default',
    [marketCatalogs, pageSources],
  );

  useEffect(() => {
    if (!marketCatalogs.includes(marketCatalog)) {
      setMarketCatalog(landingMarketCatalog);
    }
  }, [marketCatalogs, marketCatalog, landingMarketCatalog]);

  // A different catalog is a different set of orders: keeping `stars` while switching to a catalog
  // that never declared it would send a key the source cannot serve (the backend silently drops
  // it), so the pick falls back to the first order the active catalog actually declares.
  useEffect(() => {
    if (marketSort && activeSorts.includes(marketSort)) return;
    setMarketSort(activeSorts[0] ?? '');
  }, [activeSorts, marketSort]);

  /**
   * Counts load ASYNCHRONOUSLY for every catalog on the tab — one cheap page-1 probe per source,
   * reading only its authoritative `total`. The active catalog is skipped because `loadMarket`
   * already reads it (and would race the same upstream); a cursor source with no total stays
   * unnumbered. The probe runs once per (axis, harness, catalog): a silent miss never becomes a
   * retry loop, and the browse cache absorbs a later click.
   */
  const countProbeRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tab !== 'market') return;
    for (const cat of marketCatalogs) {
      const key = `${kind}|${harness ?? ''}|${cat}`;
      if (countProbeRef.current.has(key)) continue;
      countProbeRef.current.add(key);
      const sources = pageSources.filter(
        (s) => s.enabled && s.browsable && (s.catalog || 'default') === cat,
      );
      if (sources.length === 0) {
        setMarketCatalogCounts((prev) => (prev[cat] === 0 ? prev : { ...prev, [cat]: 0 }));
        continue;
      }
      void Promise.all(
        sources.map(async (source) => {
          try {
            const res = await api.harnessBrowse({
              source: source.id,
              kind,
              limit: MARKET_PAGE_SIZE,
              page: 1,
              ...(marketSort ? { sort: marketSort } : {}),
              ...(harness ? { harness } : {}),
            });
            return typeof res.total === 'number' && res.totalScope !== 'window' ? res.total : null;
          } catch {
            return null;
          }
        }),
      ).then((totals) => {
        if (totals.length > 0 && totals.every((n): n is number => typeof n === 'number')) {
          const sum = totals.reduce((a, b) => a + b, 0);
          setMarketCatalogCounts((prev) => (prev[cat] === sum ? prev : { ...prev, [cat]: sum }));
        }
      });
    }
  }, [tab, kind, harness, marketCatalogs, pageSources, marketSort]);

  // A harness switch invalidates every downstream pick: the install target list belongs to the
  // previous runtime's picker, page 4 of the old list is meaningless, and the market source may not
  // serve the new runtime at all. Driven by the resolved param — never by the click — so a Back or
  // Forward across two harnesses replays exactly the same reset as picking one in the rail.
  //
  // The TAB is deliberately absent: switching runtimes keeps the operator on the view they were
  // reading (the pick carries `?tab=market` across, and the market list reloads for the new runtime
  // through `marketQueryAxis`). Forcing the global tab here would answer a runtime pick with a list
  // the operator may not have asked for.
  useEffect(() => {
    if (!landing) return;
    setPage(1);
    setMarketCatalog(landingMarketCatalog);
    // The page's harness is the default landing: an MCP server goes into THIS client's config and the
    // multi-select fans out from there. A single-target kind reads the harness directly (the dialog
    // renders it as one fixed chip), so it has no list to seed.
    setInstallHosts(installMode === 'multi' && harness ? [harness] : []);
  }, [landing, installMode, kind, harness, landingMarketCatalog]);

  // A source that no longer has a chip here — narrowed away by the new harness, or emptied by an
  // uninstall — must not keep filtering the list invisibly.
  useEffect(() => {
    if (activeCatalog === 'all') return;
    if (installedCatalogs.includes(activeCatalog)) return;
    setActiveCatalog('all');
  }, [installedCatalogs, activeCatalog]);

  // The host axis exists only where the page spans several hosts (skills): a page pinned to one
  // harness has nothing to narrow.
  useEffect(() => {
    if (landing) setHostFilter('');
  }, [landing]);

  // The translation target IS the console language — translating into the language you already read
  // is the only target a picker ever offered. Switching the UI language drops derived text and
  // re-seeds from the cache for the new language.
  useEffect(() => {
    setTr({});
    setShowOriginal({});
  }, [lang]);

  // Any narrowing resets to page 1: staying on page 4 of a 1-page result reads as an empty table.
  useEffect(() => {
    setPage(1);
  }, [q, filter, activeCatalog, hostFilter, hideShared, kind, harness, pageSize]);

  // Re-seed what previous visits already translated (cache-only lookup — no model call, no spend).
  useEffect(() => {
    const texts = [...new Set(rows.map((r) => r.description).filter((d): d is string => !!d))];
    if (texts.length === 0) return;
    let cancelled = false;
    void api
      .harnessTranslations({ lang, texts })
      .then(({ translations }) => {
        if (cancelled) return;
        setTr((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            const hit = row.description ? translations[row.description] : undefined;
            const stale = next[row.key]?.src !== (row.description ?? '');
            if (hit && stale) next[row.key] = { src: row.description ?? '', text: hit.text, model: hit.model };
          }
          return next;
        });
      })
      .catch(() => {
        /* a cache miss is not an error the operator needs to see */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, inventory, filter, kind]);

  // Same cache-first pass for the marketplace: anything translated on a previous visit (or on the
  // global tab, before the skill was uninstalled) shows in the target language straight away.
  useEffect(() => {
    const texts = [...new Set(marketItems.map((i) => i.description).filter((d): d is string => !!d))];
    if (texts.length === 0) return;
    let cancelled = false;
    void api
      .harnessTranslations({ lang, texts })
      .then(({ translations }) => {
        if (cancelled) return;
        setTr((prev) => {
          const next = { ...prev };
          for (const item of marketItems) {
            const hit = item.description ? translations[item.description] : undefined;
            const stale = next[item.id]?.src !== (item.description ?? '');
            if (hit && stale) next[item.id] = { src: item.description ?? '', text: hit.text, model: hit.model };
          }
          return next;
        });
      })
      .catch(() => {
        /* a cache miss is not an error the operator needs to see */
      });
    return () => {
      cancelled = true;
    };
  }, [lang, marketItems]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  /** Total the shared pager wants. A source that reports none (unknown reachable end) is posed as the
   *  last reachable page instead of a fabricated row count: with a successor the figure is
   *  `page × size + 1` (a lower bound), and on the last page it is the exact count
   *  (`(page − 1) × size + rows`). The pager labels the first case "of at least N". */
  const marketPagerTotal =
    marketTotal ??
    (marketHasMore
      ? marketPage * MARKET_PAGE_SIZE + 1
      : (marketPage - 1) * MARKET_PAGE_SIZE + marketItems.length);

  const loadMarket = async (query: string, page: number = marketPage, refresh = false) => {
    if (!canBrowse) {
      marketReqRef.current += 1;
      setMarketItems([]);
      setMarketNote(null);
      setMarketError(null);
      setMarketHasMore(false);
      setMarketTotal(null);
      setMarketLoading(false);
      // No source in this catalog: an exact 0, not an unknown size.
      if (!query) setMarketCatalogCounts((prev) => ({ ...prev, [marketCatalog]: 0 }));
      return;
    }
    const seq = ++marketReqRef.current;
    setMarketLoading(true);
    setMarketError(null);
    try {
      // Federated fetch across all contributing sources of the active catalog. Each source is asked
      // for THIS page at the console's page size — paging is the source's own cursor, never a slice
      // of a first-page window (a 100-row window made a 5 401-row catalog look like 50).
      const responses = await Promise.all(
        activeCatalogSources.map(async (source) => {
          try {
            const res = await api.harnessBrowse({
              source: source.id,
              q: query,
              kind,
              limit: MARKET_PAGE_SIZE,
              ...(harness ? { harness } : {}),
              page,
              ...(marketSort ? { sort: marketSort } : {}),
              ...(refresh ? { refresh: true } : {}),
            });
            const channel = source.id.startsWith('mp-') ? source.id.slice(3) : source.id;
            return {
              total: res.total,
              totalScope: res.totalScope,
              hasMore: res.hasMore,
              note: res.note,
              noteCode: res.noteCode,
              noteParams: res.noteParams,
              items: res.items.map((item) => ({
                ...item,
                channel: item.channel ?? channel,
                catalog: item.catalog ?? (source.catalog || 'default'),
              })),
            };
          } catch {
            return { items: [], total: undefined, totalScope: undefined, hasMore: false, note: undefined, noteCode: undefined, noteParams: undefined };
          }
        }),
      );
      if (seq !== marketReqRef.current) return;

      const mergedMap = new Map<string, HarnessMarketItem>();
      for (const { items } of responses) {
        for (const item of items) {
          const key = item.key ?? item.id ?? item.name;
          if (!mergedMap.has(key)) {
            mergedMap.set(key, item);
          }
        }
      }
      const merged = Array.from(mergedMap.values());
      // The catalog's own total when every contributor states one; a window cap is not a catalog
      // size (the pager hides the summary), and a source with no total at all (ClawHub's cursor
      // walk) leaves the total unknown instead of presenting the page's row count as a figure.
      const totals = responses.map((r) => r.total);
      const known = totals.length > 0 && totals.every((n): n is number => typeof n === 'number');
      const catalogTotal = known ? totals.reduce((a, b) => a + b, 0) : null;
      setMarketItems(merged);
      setMarketHasMore(responses.some((r) => r.hasMore));
      const windowed = responses.some((r) => r.totalScope === 'window');
      setMarketTotal(catalogTotal);
      setMarketTotalScope(windowed ? 'window' : 'catalog');
      // The context line explains THIS answer. A federated catalog may join several sources, but
      // only a source whose adapter attached a note has something to say — the first one wins.
      const noted = responses.find((r) => r.noteCode !== undefined || r.note !== undefined);
      setMarketNote(
        noted
          ? {
              ...(noted.note !== undefined ? { text: noted.note } : {}),
              ...(noted.noteCode !== undefined ? { code: noted.noteCode } : {}),
              ...(noted.noteParams !== undefined ? { params: noted.noteParams } : {}),
            }
          : null,
      );
      // A chip count is shown ONLY for an authoritative total: a cursor source has none, and a
      // windowed search cap is not the catalog's size.
      if (!query && page === 1 && known && !windowed) {
        setMarketCatalogCounts((prev) => ({ ...prev, [marketCatalog]: catalogTotal ?? 0 }));
      }
    } catch (e) {
      if (seq !== marketReqRef.current) return;
      setMarketItems([]);
      setMarketHasMore(false);
      setMarketTotal(null);
      setMarketNote(null);
      setMarketError(marketFailure(e));
    } finally {
      if (seq === marketReqRef.current) setMarketLoading(false);
    }
  };

  /**
   * Repositories on the shown page whose stars are still unknown — the addresses one click resolves.
   *
   * Only rows that NAME a repo qualify: a row identified by a package name alone has no star count to
   * ask GitHub for. The list is deduped because two rows can point at one repository (a monorepo of
   * skills), and popping the same repo twice would spend the query budget for nothing.
   */
  const starTargets = useMemo(() => {
    const out: string[] = [];
    for (const item of marketItems) {
      if (!item.repo) continue;
      const repo = item.repo.toLowerCase();
      if ((starMap[repo] ?? item.stars) !== null) continue;
      if (!out.includes(repo)) out.push(repo);
    }
    return out;
  }, [marketItems, starMap]);

  /**
   * Resolve stars for the given repositories — one row's, or the whole shown page.
   *
   * Explicit by design: the market read itself never spends GitHub quota, so enrichment happens only
   * when the operator asks for it. Batch and single requests travel the same endpoint (the backend
   * chunks by query length, so one repo is one search), a resolved count is cached there for a day,
   * and `starMap` keeps it for the session — asking twice costs nothing.
   */
  const resolveStars = async (targets: readonly string[]) => {
    // A repository already in flight is skipped: two clicks on one cell must not spend two searches.
    const wanted = targets.filter((repo) => !starPending.includes(repo));
    if (wanted.length === 0) return;
    setStarPending((prev) => [...prev, ...wanted]);
    try {
      const res = await api.harnessMarketStars([...wanted]);
      setStarMap((prev) => ({ ...prev, ...res.stars }));
      // A repo GitHub does not index (deleted, renamed, private) keeps no count — and saying WHICH
      // one turns a silent no-op into a fact. A click that resolved everything says nothing: the
      // numbers appearing IS the answer.
      if (res.missing.length > 0) {
        toast.info(t('harness.starsMissing', { n: String(res.missing.length) }));
      }
    } catch (e) {
      const failure = marketFailure(e);
      toast.error(
        failure.reason && BROWSE_ERROR_KEY[failure.reason]
          ? t(BROWSE_ERROR_KEY[failure.reason]!, failure.reasonParams)
          : `${t('harness.starsFailed')}: ${failure.message}`
      );
    } finally {
      setStarPending((prev) => prev.filter((repo) => !wanted.includes(repo)));
    }
  };

  /**
   * The per-row resolve button: one repository, one GitHub search.
   *
   * The cell IS the affordance — pressing it resolves exactly the row the operator is looking at,
   * never the whole page. `starPending` swallows a double click on the same cell; `disabled` covers
   * the moment a different lookup is already in flight.
   *
   * The box is the shared icon-button contract (`.btn-icon`): a local inline height lost to
   * `.btn-sm`'s min-height and rendered a narrow 22×30 pill instead of a square.
   */
  const starFetchButton = (repo: string) => {
    const busy = starPending.includes(repo);
    const hint = t('harness.starsFetchHint', { n: '1' });
    return (
      <button
        type="button"
        className="btn btn-sm btn-icon"
        disabled={starsBusy}
        title={hint}
        aria-label={hint}
        onClick={() => void resolveStars([repo])}
      >
        <Star size={11} aria-hidden style={busy ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
      </button>
    );
  };

  /**
   * A MARKET row's star cell — three states, three renderings, and NO placeholder for "no answer".
   *
   * A count (published by the source, or resolved on demand) prints compactly (1.2K, not 1234 — the
   * column is narrow and sorting happens upstream), with the exact value on hover. A row that names a
   * repository but has no count yet prints the star button instead of an em dash. A row with no
   * repository has nothing to ask GitHub about and stays empty — an em dash there reads as a value
   * ("zero"), which is the one thing this column must never claim.
   */
  const starControl = (item: HarnessMarketItem, variant: 'list' | 'card') => {
    // A source with a popularity system of its OWN (ClawHub): its count is shown, but labelled as its
    // own rather than passed off as a GitHub star count — `stars` stays null for these rows.
    const registry = item.registryStats?.stars ?? null;
    if (registry !== null) {
      const hint = t('harness.starsRegistryHint');
      return variant === 'card' ? (
        <span className="badge" title={hint}>{formatStars(registry)}★</span>
      ) : (
        <span title={hint}>{formatStars(registry)}</span>
      );
    }
    const n = starOf(item, starMap);
    if (n !== null) {
      return variant === 'card' ? (
        <span className="badge" title={n.toLocaleString()}>{formatStars(n)}★</span>
      ) : (
        <span title={n.toLocaleString()}>{formatStars(n)}</span>
      );
    }
    return item.repo ? starFetchButton(item.repo.toLowerCase()) : null;
  };

  /**
   * An INSTALLED row's star cell. The inventory publishes no count at all, so the number can only
   * come from an explicit lookup: the cell is the resolved count, or the button that resolves it.
   * Rows whose key names no repository (`npm:`, `manual:`) render nothing — and the column itself
   * only exists when the page holds at least one resolvable row (`showStarColumn`).
   */
  const installedStar = (row: Row) => {
    if (!row.repo) return null;
    const repo = row.repo.toLowerCase();
    const n = starMap[repo];
    return n === undefined ? starFetchButton(repo) : <span title={n.toLocaleString()}>{formatStars(n)}</span>;
  };

  /**
   * Repositories visible right now that this session holds no count for — the addresses a render may
   * ask the CACHE about. Both views feed the same list: "what does the gateway already know about
   * these?" is one question. Only rows that name a repository qualify.
   */
  const starPeekTargets = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (repo: string | null | undefined) => {
      if (!repo) return;
      const key = repo.toLowerCase();
      if (seen.has(key) || starMap[key] !== undefined) return;
      seen.add(key);
      out.push(key);
    };
    if (tab === 'market') for (const item of marketItems) push(item.repo);
    else for (const row of pageRows) push(row.repo);
    return out;
  }, [tab, marketItems, pageRows, starMap]);

  /** Repositories already asked about in this session: a second ask would answer the same nothing.
   *  The peek is cache-only (the backend never calls GitHub for it), so it costs no quota — it only
   *  saves a click on a count this gateway resolved minutes ago, e.g. before a page reload. */
  const starPeekedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = starPeekTargets.filter((repo) => !starPeekedRef.current.has(repo));
    if (fresh.length === 0) return;
    for (const repo of fresh) starPeekedRef.current.add(repo);
    void api
      .harnessMarketStars(fresh, { cachedOnly: true })
      .then((res) => {
        if (Object.keys(res.stars).length > 0) setStarMap((prev) => ({ ...prev, ...res.stars }));
      })
      .catch(() => {
        // Cache-only convenience: a failed peek leaves the row's button in place, nothing else.
      });
  }, [starPeekTargets]);
  // A committed query, a different source or a new page is a new list: page 4 of a new query is a
  // leftover, not a place. The reset is folded into the load effect (early return) so one commit
  // never spends two requests on a page turn. `marketQ` is deliberately absent: typed text is not
  // a request — only `marketSubmittedQ` is.
  const marketQueryAxis = `${marketCatalog}|${marketSubmittedQ}|${harness}|${kind}|${marketSort}`;
  const marketQueryAxisRef = useRef('');

  // A new page is a new list: keeping the previous scroll offset lands the operator mid-page.
  useEffect(() => {
    marketScrollRef.current?.scrollTo({ top: 0 });
  }, [marketPage]);

  // No debounce and no timer: the market is a third-party catalog billing per call (anonymous
  // GitHub: 10 req/min) and its cache is keyed by the EXACT query string, so every distinct prefix
  // — every pinyin candidate — would be a real upstream call. The list therefore answers committed
  // queries only; the input never reaches the network on its own.
  useEffect(() => {
    if (tab !== 'market') return;
    if (marketQueryAxisRef.current !== marketQueryAxis) {
      marketQueryAxisRef.current = marketQueryAxis;
      if (marketPage !== 1) {
        setMarketPage(1);
        return;
      }
    }
    void loadMarket(marketSubmittedQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, marketQueryAxis, marketPage, canBrowse]);

  // A drawer mutation reloads the SOURCE LIST first (new `mp-` chip); this tick then refetches the
  // market with the fresh federation — bypassing the browse cache, since a rescan may have
  // rewritten a source's rows under the same query.
  useEffect(() => {
    if (marketRefreshTick > 0 && tab === 'market') void loadMarket(marketSubmittedQ, marketPage, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketRefreshTick]);

  /** Commit a query: it becomes the axis, and the effect above owns the single request for it.
   *  Committing the text already submitted is not a new axis — a repeated Enter costs nothing. */
  const commitMarket = (query: string) => {
    setMarketSubmittedQ(query.trim());
  };

  /** Hosts this install writes to. A taken target is not offered: the writer would only answer
   *  `exists` after a full confirm. */
  const installTargetHosts = (): string[] => {
    if (!installTarget) return [];
    const raw = hostsForKind(installTarget.installKind, installHosts);
    const scope = coercedScope(raw, installTarget.installKind);
    // A taken target is not offered: the writer would only answer `exists` after a full confirm.
    return raw.filter((host) => !takenOn(installTarget, host, scope));
  };

  // The scope the open sheets may offer and submit (ADR-0015 §D2): `installScope` is the raw
  // picker state; these coerce it against the targets' declared capabilities. `sheetProjectOk`
  // gates the chip itself; `sheetScope` drives the hint, the picker and the footer guard.
  const sheetProjectOk = installTarget ? projectScopeAllowed(installTargetHosts(), installTarget.installKind) : false;
  const sheetScope: 'global' | 'project' = installScope === 'project' && sheetProjectOk ? 'project' : 'global';
  const mcpSheetProjectOk = harness !== '' ? projectScopeAllowed([harness], 'mcp') : false;
  const mcpSheetScope: 'global' | 'project' = installScope === 'project' && mcpSheetProjectOk ? 'project' : 'global';

  /** Close the install sheet and drop per-attempt state, so the next open never shows old output. */
  const closeInstall = () => {
    setInstallTarget(null);
    setInstallSuccess(null);
    setInstallLog('');
    setCustomProfile('');
  };

  /**
   * Install ONE market row into ONE explicit host set. The core of every install path — the
   * confirm-dialog button, the single-target fast path and the gate acknowledgement all funnel
   * here, so the wire contract (`confirm`, `#dir` pinning, `listedOn`) is declared once.
   */
  const runInstall = async (target: HarnessMarketItem, hosts: string[], skillDir?: string, confirmed = false) => {
    setInstallBusy(true);
    const installLogId = confirmed && target.installKind === 'plugin' ? newInstallLogId() : undefined;
    let poller: number | undefined;
    if (installLogId) {
      setInstallLog(t('harness.installLogWaiting'));
      poller = window.setInterval(() => {
        void api
          .harnessInstallLog(installLogId)
          .then((log) => setInstallLog(log.lines.join('\n') || t('harness.installLogWaiting')))
          .catch(() => {});
      }, 800);
    } else {
      setInstallLog('');
    }
    try {
      // A picker re-send must REPLACE the row's stale `#dir` pin, not append to it — the key arrives
      // as `github:<owner/repo>#<stale-dir>` and the chosen directory becomes the only pin.
      const baseKey = target.key.includes('#') ? target.key.slice(0, target.key.indexOf('#')) : target.key;
      // The picker state is a wish; the target set's declared capability decides (ADR-0015 §D2).
      const scope = coercedScope(hosts, target.installKind);
      const targetProject = scope === 'project' ? projects.find((p) => p.id === installProjectId) : null;
      const res = await api.harnessInstall({
        // The key is the portable install handle (`github:<owner/repo>` / `npm:<name>`); `kind` picks
        // the writer. A skill directory pins the ambiguous case as `<key>#<dir>`.
        key: skillDir ? `${baseKey}#${skillDir}` : target.key,
        kind: target.installKind,
        hosts,
        scope,
        ...(scope === 'project' && targetProject ? { projectRoot: targetProject.path, projectId: targetProject.id } : {}),
        // The market row's own source is a discovery facet, not the writer: a Pi-catalog package
        // carries an `npm:` key, so without this the record would claim npm was the only place the
        // operator saw it.
        listedOn: [target.sourceId],
        // The row's own line is what an installed row shows when the install resolves no registry
        // document and the copy has no readable manifest (a native-marketplace plugin).
        ...(target.description ? { description: target.description } : {}),
        // A GIT-BACKED plugin row installs through the runtime's OWN marketplace chain: the row's
        // repository and manifest-declared marketplace name are the identity the CLI needs. An npm
        // row can still show a repository (Pi's catalog links every package to its GitHub page) —
        // its key names the package, and sending `marketplace` for it would ask the runtime for a
        // chain it does not have (pi: `install npm:<spec>` only).
        ...(target.installKind === 'plugin' && target.repo && !target.key.startsWith('npm:')
          ? {
              marketplace: {
                repo: target.repo,
                plugin: target.name,
                name: target.marketplace ?? target.repo.split('/').pop() ?? target.name,
              },
            }
          : {}),
        // A per-profile runtime (DSH) needs the chosen target; every other host has one implicit
        // landing, and the field is omitted there.
        ...(target.installKind === 'plugin' && profileChoices.length > 0 && installProfileValue
          ? { profile: installProfileValue }
          : {}),
        ...(installLogId ? { installLogId } : {}),
        ...(confirmed ? { confirm: true } : {}),
      });
      toast.success(`${t('harness.installDone')}: ${res.name} → ${res.copies.map((c) => c.host).join(', ')}`);
      // A partial install is a success plus a refusal. Swallowing the refusal would let the operator
      // believe every selected host received the skill.
      if (res.skipped.length > 0) {
        toast.error(`${t('harness.installPartial')}: ${res.skipped.map((s) => `${s.host} (${s.code})`).join(', ')}`);
      }
      setInstallSuccess(res.name);
      setInstallGate(null);
      setSkillPick(null);
      // Land on the view that now holds the copy: a project install must not jump to global.
      setTab(scope === 'project' ? 'project' : 'global');
      await load();
    } catch (e) {
      const err = e as Error & { code?: string; candidates?: string[]; plan?: HarnessInstallTarget[] };
      // Gate 3 (plugin) / gate 2 (mcp): nothing was written and the backend handed back the exact
      // plan. The operator reads it and re-sends with `confirm` — that is the whole gate.
      if (err.code === 'confirm_required' && Array.isArray(err.plan) && err.plan.length > 0) {
        setInstallGate({ targets: err.plan, ...(skillDir ? { skillDir } : {}) });
        return;
      }
      // The picker answers two backend refusals: `ambiguous` (several SKILL.md dirs, no pin) and a
      // STALE pin — a market row's `#dir` from registry metadata that no longer matches the repo
      // layout (the adapter answers `no_artifact` with the dirs that DO hold a SKILL.md). Both are
      // the same decision — a human picks the directory — so both open the picker.
      if (
        (err.code === 'ambiguous' || err.code === 'no_artifact') &&
        Array.isArray(err.candidates) &&
        err.candidates.length > 0
      ) {
        setSkillPick({
          repo: target.repo ?? target.key,
          candidates: err.candidates,
          value: err.candidates[0] ?? '',
        });
        return;
      }
      toast.error(t('harness.installFailed') + ': ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      if (poller !== undefined) window.clearInterval(poller);
      if (installLogId) {
        const final = await api.harnessInstallLog(installLogId).catch(() => null);
        if (final) setInstallLog(final.lines.join('\n') || final.error || '');
      }
      setInstallBusy(false);
    }
  };

  /** The confirm-dialog entry: hosts come from the ticked chips (or the pinned single landing). */
  const doInstall = (skillDir?: string, confirmed = false) => {
    const hosts = installTargetHosts();
    if (!installTarget || hosts.length === 0) return;
    return runInstall(installTarget, hosts, skillDir, confirmed);
  };

  /**
   * Install entry for a market row (card button AND detail-dialog button). An MCP row opens the
   *  SAME Add/Edit sheet the manual and edit paths use, prefilled from the resolver's pinned launch
   *  (ADR-0015 §D11 amendment): the operator adjusts the full launch, then installs to the page's
   *  pinned landing only. A skill/plugin row keeps the target-choice dialog: with exactly ONE free
   *  target the dialog has nothing to ask — a lone skills owner or a pinned landing is not a
   *  choice — so the install starts at once (a skill lands directly, an plugin first request comes
   *  back `confirm_required` and the plan opens); with several free targets the sheet asks which
   *  hosts to write, because a payload fanned to N owners IS a choice.
   */
  const startInstall = (item: HarnessMarketItem) => {
    // One install at a time: the fast path below bypasses the confirm dialog's
    // disabled-confirm guard, so the row button is the only gate — two quick
    // clicks on different rows would run concurrent installs whose completion
    // handlers yank shared state (setInstallTarget/setTab) out from under
    // each other.
    if (installBusy) return;
    if (item.installKind === 'mcp') {
      // The sheet's name is READ-ONLY, so it must be the key the resolver will write, not the
      // package identity the row is browsed by (the backend answers that derived key as
      // `serverName`; see `mcpServerNameFromPackage`).
      const draft = mcpDraftFromMarketKey(item.serverName ?? item.name, item.key);
      if (draft) {
        setMcpMarket({ item, defaultLaunch: mcpLaunchFromDraft(draft) });
        setMcpDraft(draft);
        // The detect box starts on the package the launch names, so registry-driven params are one
        // click away — the same affordance the edit sheet seeds (see openMcpEdit).
        setMcpDetectQ(mcpPackageHint(mcpLaunchFromDraft(draft)));
        setMcpCandidates([]);
        setMcpPick('');
        return;
      }
      // A package-less MCP key has no form prefill: fall through to the resolver install path.
    }
    const free = hostsForKind(item.installKind).filter((host) => hostFree(item, host));
    // Default to ONE host — the page's pinned landing harness when it can take the install, else
    // the shared Universal tree — never a pre-ticked fan-out across every free host.
    const preferred = free.includes(harness) ? harness : free.includes(SHARED_HOST) ? SHARED_HOST : free[0];
    setInstallHosts(preferred ? [preferred] : []);
    setInstallTarget(item);
    setInstallSuccess(null);
    setInstallLog('');
    const dshProfiles = hosts.find((host) => host.id === 'dsh')?.profiles ?? [];
    const freeProfile = dshProfiles.find(
      (profile) => !takenOn(item, 'dsh', installScope, installProjectId, profile.name)
    );
    setInstallProfile(freeProfile?.name ?? dshProfiles[0]?.name ?? '');
    // A name typed for the previous row must not pre-fill the next sheet's "Custom…" field.
    setCustomProfile('');
  };

  /** Gate acknowledgement: re-send the SAME request with `confirm: true`. */
  const confirmInstallGate = async () => {
    if (!installGate) return;
    const { skillDir } = installGate;
    setInstallGate(null);
    await doInstall(skillDir, true);
  };

  /**
   * Manual MCP install. It takes the `manualPayload` branch instead of a key, so it cannot ride
   * `runInstall` (which speaks `<sourceId>:<ref>`). The gate contract is identical: the first call
   * writes nothing and answers the merge plan, the second re-sends with `confirm`.
   */
  const submitManualMcp = async (
    payload: { name: string; launch: HarnessMcpLaunch },
    confirm = false
  ) => {
    if (!harness) return;
    setInstallBusy(true);
    try {
      const scope = coercedScope([harness], 'mcp');
      const targetProject = scope === 'project' ? projects.find((p) => p.id === installProjectId) : null;
      const res = await api.harnessInstall({
        kind: 'mcp',
        manualPayload: payload,
        hosts: [harness],
        scope,
        ...(scope === 'project' && targetProject ? { projectRoot: targetProject.path, projectId: targetProject.id } : {}),
        ...(confirm ? { confirm: true } : {}),
      });
      toast.success(`${t('harness.installDone')}: ${res.name} → ${res.copies.map((c) => c.host).join(', ')}`);
      if (res.skipped.length > 0) {
        toast.error(`${t('harness.installPartial')}: ${res.skipped.map((s) => `${s.host} (${s.code})`).join(', ')}`);
      }
      setMcpDraft(null);
      setMcpGate(null);
      setTab(scope === 'project' ? 'project' : 'global');
      await load();
    } catch (e) {
      const err = e as Error & { code?: string; plan?: HarnessInstallTarget[] };
      if (err.code === 'confirm_required' && Array.isArray(err.plan) && err.plan.length > 0) {
        setMcpGate({ targets: err.plan, payload });
        return;
      }
      toast.error(t('harness.installFailed') + ': ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setInstallBusy(false);
    }
  };

  const confirmMcpGate = async () => {
    if (!mcpGate) return;
    const { payload } = mcpGate;
    setMcpGate(null);
    await submitManualMcp(payload, true);
  };

  /**
   * Market MCP install through the shared sheet. Unlike `submitManualMcp` (the `manualPayload`
   * escape hatch), this rides the resolver's KEY path so the manifest keeps the row's `sourceId` /
   * `listedOn` / `trust` / `canonicalKey` provenance. The launch override reaches the backend ONLY
   * when the operator edited something — an untouched form installs the resolver's own pinned
   * command unchanged (ADR-0015 §D9). One landing: the page's pinned harness. Gate 2 is identical
   * to the manual/edit paths — the first call writes nothing and returns the merge plan.
   */
  const submitMarketMcp = async (
    draft: McpDraft,
    item: HarnessMarketItem,
    defaultLaunch: HarnessMcpLaunch,
    confirm = false
  ) => {
    if (!harness) return;
    setInstallBusy(true);
    try {
      const launch = mcpLaunchFromDraft(draft);
      const touched = JSON.stringify(launch) !== JSON.stringify(defaultLaunch);
      const scope = coercedScope([harness], 'mcp');
      const targetProject = scope === 'project' ? projects.find((p) => p.id === installProjectId) : null;
      const res = await api.harnessInstall({
        key: item.key,
        kind: 'mcp',
        hosts: [harness],
        scope,
        ...(scope === 'project' && targetProject ? { projectRoot: targetProject.path, projectId: targetProject.id } : {}),
        listedOn: [item.sourceId],
        ...(touched ? { launch } : {}),
        ...(confirm ? { confirm: true } : {}),
      });
      toast.success(`${t('harness.installDone')}: ${res.name} → ${res.copies.map((c) => c.host).join(', ')}`);
      if (res.skipped.length > 0) {
        toast.error(`${t('harness.installPartial')}: ${res.skipped.map((s) => `${s.host} (${s.code})`).join(', ')}`);
      }
      setMcpMarket(null);
      setMcpDraft(null);
      setMcpMarketGate(null);
      setTab(scope === 'project' ? 'project' : 'global');
      await load();
    } catch (e) {
      const err = e as Error & { code?: string; plan?: HarnessInstallTarget[] };
      if (err.code === 'confirm_required' && Array.isArray(err.plan) && err.plan.length > 0) {
        setMcpMarketGate({ targets: err.plan, draft, item, defaultLaunch });
        return;
      }
      toast.error(t('harness.installFailed') + ': ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setInstallBusy(false);
    }
  };

  const confirmMcpMarketGate = async () => {
    if (!mcpMarketGate) return;
    const { draft, item, defaultLaunch } = mcpMarketGate;
    setMcpMarketGate(null);
    await submitMarketMcp(draft, item, defaultLaunch, true);
  };

  /**
   * Open the edit sheet for one EXISTING server: read the launch first, then pre-fill the form.
   *
   * The name is not editable (it is the entry's key — renaming is delete + add), and the read is
   * key-names-only: env/header VALUES stay in the runtime's file and are preserved on write.
   */
  const openMcpEdit = async (row: Row) => {
    if (!harness || mcpEditLoading) return;
    // A project landing resolves under the picked root; without one there is no file to read.
    if (tab === 'project' && !selectedProjectId) {
      toast.error(t('harness.noProjectsAvailable'));
      return;
    }
    setMcpEditLoading(true);
    try {
      // Edit the copy the CURRENT view shows: on the project tab the entry lives in the selected
      // project's landing, not the global one.
      const editScope = tab === 'project' ? ('project' as const) : ('global' as const);
      const editProjectId = editScope === 'project' ? (selectedProjectId ?? undefined) : undefined;
      const entry = await api.harnessMcpEntry({
        host: harness,
        name: row.name,
        scope: editScope,
        ...(editProjectId ? { projectId: editProjectId } : {}),
      });
      setMcpGate(null);
      setMcpEditGate(null);
      setMcpMarket(null);
      setMcpMarketGate(null);
      setMcpEdit({
        name: row.name,
        ...(row.artifact ? { artifactId: row.artifact.id } : {}),
        scope: editScope,
        ...(editProjectId ? { projectId: editProjectId } : {}),
      });
      setMcpDraft(mcpDraftFromLaunch(row.name, entry.launch, entry.setKeys));
      // The search box starts on the package the launch names, so "Detect" is one click away.
      setMcpDetectQ(mcpPackageHint(entry.launch));
      setMcpCandidates([]);
      setMcpPick('');
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'not_found') {
        // The clicked row is gone from the runtime's own config — the runtime rewrote its file
        // (claude's `~/.claude.json` is its own state) or the listing was stale. Refresh so the
        // page stops offering a dead row, instead of reporting a generic read failure.
        void load();
        toast.error(t('harness.mcpEditGone'));
      } else {
        toast.error(`${t('harness.mcpEditLoadFailed')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setMcpEditLoading(false);
    }
  };

  /**
   * Apply one registry candidate: build an EMPTY launch, merge its declared argv rows, and return
   * the npm spec the CLI probe should read (null when the candidate has no launchable npm package).
   */
  const applyMcpCandidate = (
    candidate: HarnessMcpRegistryCandidate,
  ): { spec: string; registry: 'npm' | 'pypi' } | null => {
    const pkg =
      candidate.packages.find((item) => item.registryType === 'npm' && item.transport === 'stdio') ??
      candidate.packages.find((item) => item.registryType === 'pypi' && item.transport === 'stdio') ??
      candidate.packages[0];
    if (!pkg) return null;
    const fields = mcpDraftFromPackage(pkg);
    if (!fields) {
      toast.error(t('harness.mcpDetectUnsupported'));
      return null;
    }
    setMcpDraft((draft) => {
      if (!draft) return draft;
      // An edit (or a hand-typed command) keeps its own launch; only an empty one is built here.
      if (mcpDraftLaunchReady(draft)) return draft;
      // The chosen editing shape survives: custom gets the composed command line instead of the
      // runner/package pair, so a candidate never flips the operator into advanced mode.
      if (draft.mode === 'custom' && fields.mode === 'advanced') {
        const argv = [...MCP_RUNNER_FLAGS[fields.runner], fields.pkg, ...parseArgLine(fields.argsText)];
        return { ...draft, command: draft.command.trim() || fields.runner, argsText: formatArgLine(argv) };
      }
      return { ...draft, ...fields };
    });
    // The open table gains whatever the registry declares; a value already typed wins.
    const parsed = argRowsWithIds(parseArgLine(fields.argsText));
    const declared = parsed.map((row) => {
      const seed =
        fields.args.find((item) => item.name !== '' && item.name === row.name) ??
        fields.args.find((item) => item.name === '' && row.name === '' && item.value === row.value);
      return seed ? { ...seed, id: row.id, name: row.name, value: row.value } : row;
    });
    for (const seed of fields.args) {
      const covered = seed.name
        ? declared.some((row) => row.name === seed.name)
        : declared.some((row) => row.name === '' && row.value === seed.value);
      if (!covered) declared.push(seed);
    }
    // Required declarations come first; everything else keeps registry order.
    declared.sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
    setMcpArgsEditor((rows) => (rows ? mergeMcpParamRows(rows, declared) : rows));
    if (pkg.registryType === 'npm' && pkg.transport === 'stdio') {
      return { spec: `${pkg.identifier}@${pkg.version ?? 'latest'}`, registry: 'npm' as const };
    }
    if (pkg.registryType === 'pypi' && pkg.transport === 'stdio') {
      return { spec: pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier, registry: 'pypi' as const };
    }
    return null;
  };

  /** The package source the editor implies; undefined = try npm first, then PyPI. */
  const mcpProbeRegistry = (): 'npm' | 'pypi' | undefined => {
    if (!mcpDraft || mcpDraft.transport !== 'stdio') return undefined;
    const runner = mcpDraft.mode === 'advanced' ? mcpDraft.runner : mcpDraft.command.trim().toLowerCase();
    if (runner === 'uvx') return 'pypi';
    if (runner === 'npx' || runner === 'bunx') return 'npm';
    return undefined;
  };

  /**
   * Download one package and merge the flags its own parser reads into the open table.
   * The package is scanned, never executed, so no confirmation gate is needed. With no runner
   * chosen yet, an npm miss is retried on PyPI — that is how a bare `uvx` name still resolves.
   */
  const probeMcpPackage = async (spec: string, registry?: 'npm' | 'pypi') => {
    try {
      let probe: Awaited<ReturnType<typeof api.harnessMcpCli>>;
      try {
        probe = await api.harnessMcpCli(spec, registry ?? 'npm');
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (registry || code !== 'not_found') throw error;
        probe = await api.harnessMcpCli(spec, 'pypi');
      }
      if (probe.options.length === 0) {
        toast.error(t('harness.mcpProbeEmpty'));
        return;
      }
      const rows: McpParamRow[] = probe.options.map((option) => ({
        id: nextArgRowId(),
        name: mcpFlagToken(option.name),
        value: '',
        // A discovered flag is a suggestion: only a required one is written without a pick.
        selected: option.required === true,
        ...(option.valueHint ? { placeholder: option.valueHint } : {}),
        ...(option.choices ? { choices: option.choices } : {}),
        ...(option.format ? { format: option.format } : {}),
        ...(option.secret ? { secret: true } : {}),
        ...(option.env ? { description: t('harness.mcpProbeEnvHint', { name: option.env }) } : {}),
        ...(option.required ? { required: true } : {}),
      }));
      setMcpArgsEditor((existing) => (existing ? mergeMcpParamRows(existing, rows) : rows));
    } catch (e) {
      toast.error(`${t('harness.mcpProbeFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Switching candidates replaces the package under the table, so it is probed as well. */
  const probeMcpCandidate = (candidate: HarnessMcpRegistryCandidate) => {
    const target = applyMcpCandidate(candidate);
    if (!target) return;
    setMcpDetecting(true);
    void probeMcpPackage(target.spec, target.registry).finally(() => setMcpDetecting(false));
  };

  /** Registry declarations plus the package's own CLI flags — only when clicked. */
  const detectMcpParams = async () => {
    const query = mcpDetectQ.trim();
    if (!query || mcpDetecting) return;
    setMcpDetecting(true);
    try {
      let candidates: HarnessMcpRegistryCandidate[] = [];
      let registryError = '';
      try {
        candidates = (await api.harnessMcpRegistry(query)).candidates ?? [];
      } catch (e) {
        registryError = e instanceof Error ? e.message : String(e);
      }
      setMcpCandidates(candidates);
      // The preferred match is applied at once — the picker only switches to another candidate.
      const preferred =
        candidates.length === 0
          ? null
          : candidates.length === 1
            ? candidates[0]!
            : candidates.find((item) =>
                item.packages.some((pkg) => pkg.registryType === 'npm' && pkg.transport === 'stdio')
              ) ?? candidates[0]!;
      setMcpPick(preferred?.name ?? '');
      const target = preferred ? applyMcpCandidate(preferred) : null;
      if (target) {
        await probeMcpPackage(target.spec, target.registry);
        return;
      }
      // A package spec typed directly still gets probed even when the registry has no record.
      const bare = query.split('==')[0]!.trim();
      if (!MCP_PKG_RE.test(bare)) {
        toast.error(
          registryError ? `${t('harness.mcpDetectFailed')}: ${registryError}` : t('harness.mcpDetectEmpty')
        );
        return;
      }
      await probeMcpPackage(query, mcpProbeRegistry());
    } finally {
      setMcpDetecting(false);
    }
  };

  /** Commit one edit — same gate as install: the plan is read before anything is written. */
  const submitMcpEdit = async (draft: McpDraft, confirm = false) => {
    if (!harness || !mcpEdit) return;
    setInstallBusy(true);
    try {
      const res = await api.harnessMcpEdit({
        host: harness,
        name: mcpEdit.name,
        launch: mcpLaunchFromDraft(draft),
        ...(mcpEdit.artifactId ? { artifactId: mcpEdit.artifactId } : {}),
        scope: mcpEdit.scope,
        ...(mcpEdit.projectId ? { projectId: mcpEdit.projectId } : {}),
        ...(confirm ? { confirm: true } : {}),
      });
      toast.success(res.changed ? t('harness.mcpEditDone') : t('harness.mcpEditNoChange'));
      setMcpEdit(null);
      setMcpEditGate(null);
      setMcpDraft(null);
      await load();
    } catch (e) {
      const err = e as Error & { code?: string; plan?: HarnessInstallTarget[] };
      if (err.code === 'confirm_required' && Array.isArray(err.plan) && err.plan.length > 0) {
        setMcpEditGate({ targets: err.plan, draft });
        return;
      }
      toast.error(`${t('harness.mcpEditFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstallBusy(false);
    }
  };

  const confirmMcpEditGate = async () => {
    if (!mcpEditGate) return;
    const { draft } = mcpEditGate;
    setMcpEditGate(null);
    await submitMcpEdit(draft, true);
  };

  /** Switch the stdio form between a raw command line and the runner+package helper, carrying argv. */
  const setMcpStdioMode = (mode: McpStdioMode) => {
    setMcpDraft((draft) => {
      if (!draft || draft.mode === mode) return draft;
      if (mode === 'custom') {
        const argv = mcpStdioArgv(draft);
        return { ...draft, mode, command: mcpStdioCommand(draft), argsText: formatArgLine(argv) };
      }
      const runner = MCP_RUNNERS.find((item) => item === draft.command.trim().toLowerCase()) ?? 'npx';
      const argv = parseArgLine(draft.argsText);
      const pkgIndex = argv.findIndex((arg) => mcpPkgToken(runner, arg) && !MCP_RUNNER_FLAGS[runner].includes(arg));
      return {
        ...draft,
        mode: 'advanced',
        runner,
        pkg: pkgIndex >= 0 ? argv[pkgIndex]! : '',
        argsText: formatArgLine(argv.filter((arg, i) => i !== pkgIndex && !MCP_RUNNER_FLAGS[runner].includes(arg))),
      };
    });
  };

  /** Remote request headers: a name plus an optional literal value (blank = runtime reference). */
  const updateMcpHeaderRow = (id: string, patch: Partial<McpParamRow>) =>
    setMcpDraft((draft) =>
      draft ? { ...draft, headerRows: draft.headerRows.map((row) => (row.id === id ? { ...row, ...patch } : row)) } : draft
    );

  const addMcpHeaderRow = () =>
    setMcpDraft((draft) =>
      draft ? { ...draft, headerRows: [...draft.headerRows, { id: nextArgRowId(), name: '', value: '' }] } : draft
    );

  const removeMcpHeaderRow = (id: string) =>
    setMcpDraft((draft) =>
      draft ? { ...draft, headerRows: draft.headerRows.filter((row) => row.id !== id) } : draft
    );

  /** Close whichever MCP sheet is open (add form, install gate or edit gate) — never while applying. */
  const closeMcpSheet = () => {
    if (installBusy) return;
    setMcpGate(null);
    setMcpEditGate(null);
    setMcpEdit(null);
    setMcpMarket(null);
    setMcpMarketGate(null);
    setMcpDraft(null);
    setMcpDetectQ('');
    setMcpCandidates([]);
    setMcpPick('');
    setMcpArgsEditor(null);
    setMcpValueEditor(null);
  };

  /** Open the visual editor: reverse-render the argv line, then attach registry metadata. */
  const openMcpArgsEditor = () => {
    if (!mcpDraft) return;
    // The source IS the package the launch names — never a stale query from an earlier sheet.
    setMcpDetectQ(mcpPackageHint(mcpLaunchFromDraft(mcpDraft)));
    const parsed = argRowsWithIds(parseArgLine(mcpDraft.argsText));
    const seeds = mcpDraft.args;
    const rows = parsed.map((row) => {
      const seed =
        seeds.find((item) => item.name !== '' && item.name === row.name) ??
        seeds.find((item) => item.name === '' && row.name === '' && item.value === row.value);
      return seed ? { ...seed, id: row.id, name: row.name, value: row.value } : row;
    });
    for (const seed of seeds) {
      const covered = seed.name
        ? rows.some((row) => row.name === seed.name)
        : rows.some((row) => row.name === '' && row.value === seed.value);
      if (!covered) rows.push(seed);
    }
    setMcpAlternatesOpen(true);
    setMcpArgsEditor(rows);
  };

  const updateMcpArgRow = (id: string, patch: Partial<McpParamRow>) =>
    setMcpArgsEditor((rows) => rows?.map((row) => (row.id === id ? { ...row, ...patch } : row)) ?? rows);

  const addMcpArgRow = () =>
    setMcpArgsEditor((rows) => [...(rows ?? []), { id: nextArgRowId(), name: '', value: '', selected: true }]);

  const removeMcpArgRow = (id: string) =>
    setMcpArgsEditor((rows) => rows?.filter((row) => row.id !== id) ?? rows);

  const applyMcpArgsEditor = () => {
    if (!mcpArgsEditor) return;
    const tokens = mcpArgsEditor.filter((row) => row.selected === true).flatMap(mcpParamTokens);
    setMcpDraft((draft) => (draft ? { ...draft, argsText: formatArgLine(tokens), args: mcpArgsEditor } : draft));
    setMcpArgsEditor(null);
    setMcpValueEditor(null);
  };

  /** Discard the snapshot — the dialog's X and Cancel share it with Apply. While the enlarged
   *  value editor sits on top, its Escape listener and this one both fire for a single keypress;
   *  this handler then dismisses only the TOP layer, so Escape never throws away the whole sheet. */
  const closeMcpArgsEditor = () => {
    if (mcpValueEditor) {
      setMcpValueEditor(null);
      return;
    }
    setMcpArgsEditor(null);
  };

  /** Write the enlarged editor's text back into its row. Nothing is committed until Apply. */
  const applyMcpValueEditor = () => {
    if (!mcpValueEditor) return;
    updateMcpArgRow(mcpValueEditor.id, { value: mcpValueEditor.value });
    setMcpValueEditor(null);
  };

  /** Write the DSN builder's serialized connection string back into its row. */
  const applyMcpDsnBuilder = (value: string) => {
    if (!mcpDsnBuilder) return;
    updateMcpArgRow(mcpDsnBuilder.id, { value });
    setMcpDsnBuilder(null);
  };

  /** The argv tail, edited inline; the table editor is one click away. */
  const renderMcpArgsField = () => {
    if (!mcpDraft) return null;
    return (
      <Field
        label={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('harness.mcpArgs')}
            <InfoTip text={t('harness.mcpArgsHint')} />
          </span>
        }
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ ...MONO, flex: '1 1 auto', minWidth: 0 }}
            value={mcpDraft.argsText}
            onChange={(e) => setMcpDraft((d) => (d ? { ...d, argsText: e.target.value } : d))}
          />
          <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={openMcpArgsEditor}>
            <Settings2 size={12} aria-hidden />
            <span>{t('harness.mcpArgsEdit')}</span>
          </button>
        </div>
      </Field>
    );
  };

  /** The composed launch line, read-only, directly under the launch-parameters field — the argv that will be written. */
  const renderMcpCommandPreview = () => {
    if (!mcpDraft || mcpDraft.transport !== 'stdio') return null;
    const line = [mcpStdioCommand(mcpDraft), ...mcpStdioArgv(mcpDraft)].join(' ').trim();
    if (!line) return null;
    return (
      <div
        style={{
          ...MONO,
          fontSize: 'var(--text-xs)',
          color: 'var(--text-dim)',
          padding: '6px 8px',
          background: 'var(--chip-bg)',
          borderRadius: 4,
          overflowWrap: 'anywhere',
        }}
      >
        {`$ ${line}`}
      </div>
    );
  };

  /** The launch-argument table — the one place a detected or hand-added row lives. */
  const renderMcpParamTable = (
    rows: McpParamRow[],
    nameLabel: string,
    namePlaceholder: string,
    update: (id: string, patch: Partial<McpParamRow>) => void,
    remove: (id: string) => void
  ) => {
    // Selection decides the launch: a checked row is written, whether or not it has a value yet
    // (an empty checked row is a bare switch); an unchecked row folds under the candidate group and
    // is not written. Required rows never hide — an empty required declaration stays visible.
    const ordered = [...rows].sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
    const filled = ordered.filter((row) => row.selected === true);
    const candidates = ordered.filter((row) => row.selected !== true);
    const renderRow = (row: McpParamRow) => (
      <tr key={row.id}>
        <td style={{ ...MCP_TABLE_CELL, textAlign: 'center' }}>
          <input
            type="checkbox"
            checked={row.selected === true}
            style={{ margin: 0 }}
            title={t('harness.mcpParamUseHint')}
            aria-label={t('harness.mcpParamUse')}
            onChange={() => update(row.id, { selected: row.selected !== true })}
          />
        </td>
        <td style={MCP_TABLE_CELL}>
          <input
            className="input"
            style={{ ...MONO, width: '100%', minWidth: 0 }}
            placeholder={namePlaceholder}
            value={mcpRowNameText(row)}
            onChange={(e) => update(row.id, mcpRowNamePatch(row, e.target.value))}
          />
        </td>
        <td style={MCP_TABLE_CELL}>
          {row.format === 'dsn' || isDsnFlag(row.name) ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                className="input"
                style={{ ...MONO, width: '100%', minWidth: 0 }}
                readOnly
                value={maskDsn(row.value)}
                placeholder={row.placeholder ?? ''}
              />
              {/* A `dsn`-format flag opens a structured connection-string builder instead of the
                  free-text expand; the cell shows a masked summary so the credential is not legible
                  at a glance (the builder edits the password as plain text). */}
              <button
                type="button"
                className="btn btn-sm"
                style={{ flex: '0 0 auto', padding: '4px 6px' }}
                title={t('harness.mcpDsnExpand')}
                aria-label={t('harness.mcpDsnExpand')}
                onClick={() => setMcpDsnBuilder({ id: row.id, name: row.name, value: row.value })}
              >
                <Database size={12} aria-hidden />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {/* Probe literals are hints, not an enum: suggestions come from what the scan saw,
                  while any value is accepted (DBHub handles every non-`http` value as stdio). */}
              <SuggestInput
                value={row.value}
                onChange={(v) => update(row.id, { value: v })}
                suggestions={row.choices ?? []}
                placeholder={row.placeholder ?? ''}
                title={row.value || undefined}
                inputMode={row.format === 'number' ? 'numeric' : undefined}
                style={{ width: '100%', minWidth: 0 }}
              />
              {/* A long token or URL is unreadable in a ~40-character box; this opens the same value
                  in a full-size editor instead of making the column wider for every row. */}
              <button
                type="button"
                className="btn btn-sm"
                style={{ flex: '0 0 auto', padding: '4px 6px' }}
                title={t('harness.mcpValueExpand')}
                aria-label={t('harness.mcpValueExpand')}
                onClick={() => setMcpValueEditor({ id: row.id, name: row.name, value: row.value })}
              >
                <Maximize2 size={12} aria-hidden />
              </button>
            </div>
          )}
        </td>
        <td style={{ ...MCP_TABLE_CELL, fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-tight)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className={row.required ? 'badge badge-info' : 'badge'}
              style={{
                flex: '0 0 auto',
                fontFamily: 'inherit',
                background: 'transparent',
                cursor: 'pointer',
                ...(row.required ? {} : { border: '1px solid var(--divider)', color: 'var(--text-dim)' }),
              }}
              title={t('harness.mcpParamRequiredHint')}
              aria-pressed={Boolean(row.required)}
              onClick={() => update(row.id, { required: !row.required })}
            >
              {row.required ? t('harness.mcpParamRequired') : t('harness.mcpParamOptionalTag')}
            </button>
            <span style={{ color: 'var(--text-dim)', minWidth: 0, overflowWrap: 'anywhere' }}>
              {row.description ?? ''}
            </span>
          </div>
        </td>
        <td style={{ ...MCP_TABLE_CELL, textAlign: 'right', paddingRight: 14 }}>
          <button className="btn btn-sm" title={t('common.delete')} onClick={() => remove(row.id)}>
            <Trash2 size={12} aria-hidden />
          </button>
        </td>
      </tr>
    );
    const columns: ScrollTableColumn[] = [
      {
        key: 'use',
        label: (
          <span
            role="img"
            aria-label={t('harness.mcpParamUse')}
            title={t('harness.mcpParamUseHint')}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <SquareCheck size={13} aria-hidden />
          </span>
        ),
        width: 44,
        align: 'center',
      },
      // The name column holds a flag (`--dsn`) or a short env key — 22% is already generous. Every
      // point it takes beyond that is a point the value column loses, and values are the long side.
      { key: 'name', label: nameLabel, width: '22%' },
      { key: 'value', label: t('harness.mcpParamValue') },
      { key: 'description', label: t('harness.description'), width: '28%' },
      {
        key: 'actions',
        label: t('common.delete'),
        width: 72,
        align: 'right',
        headStyle: { paddingRight: 14 },
      },
    ];
    return (
      <ScrollTable columns={columns} maxHeight={280}>
        {filled.map(renderRow)}
        {/* A group head only makes sense when a committed row exists to keep the table open;
            with everything still a candidate, collapsing would hide the whole sheet. */}
        {filled.length > 0 && candidates.length > 0 && (
          <tr>
            <td
              colSpan={5}
              style={{
                padding: '2px 8px',
                background: 'var(--chip-bg)',
                borderTop: '1px solid var(--divider)',
              }}
            >
              <button className="btn btn-sm" onClick={() => setMcpAlternatesOpen((open) => !open)}>
                <ChevronDown
                  size={12}
                  aria-hidden
                  style={{ transform: mcpAlternatesOpen ? undefined : 'rotate(-90deg)', transition: 'transform 120ms' }}
                />
                <span>{t('harness.mcpParamCandidate', { n: candidates.length })}</span>
              </button>
            </td>
          </tr>
        )}
        {filled.length === 0 || mcpAlternatesOpen ? candidates.map(renderRow) : null}
      </ScrollTable>
    );
  };

  /** Visual launch-argument editor — one table, opened from the launch-parameters field. */
  const renderMcpArgsEditor = () => {
    if (!mcpArgsEditor) return null;
    // The probe reads the package the launch already names; the box is read-only in that case.
    const source = mcpDraft ? mcpPackageHint(mcpLaunchFromDraft(mcpDraft)) : '';
    return (
      <Dialog
        title={t('harness.mcpArgsEditorTitle')}
        subtitle={t('harness.mcpArgsEditorHint')}
        onClose={closeMcpArgsEditor}
        closeLabel={t('combobox.close')}
        width={880}
        footerRight={
          <>
            <button className="btn btn-sm" onClick={closeMcpArgsEditor}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-sm" onClick={applyMcpArgsEditor}>
              {t('harness.mcpArgsEditorApply')}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field
            label={t('harness.mcpDetect')}
            hint={source ? t('harness.mcpDetectDerivedHint') : t('harness.mcpDetectHint')}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ ...MONO, flex: '1 1 auto', minWidth: 0, ...(source ? { color: 'var(--text-dim)' } : {}) }}
                value={source || mcpDetectQ}
                readOnly={Boolean(source)}
                title={source ? t('harness.mcpDetectDerivedHint') : undefined}
                placeholder={t('harness.mcpDetectPlaceholder')}
                onChange={(e) => {
                  if (!source) setMcpDetectQ(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void detectMcpParams();
                  }
                }}
              />
              <button
                className="btn btn-sm"
                onClick={() => void detectMcpParams()}
                disabled={mcpDetecting || installBusy || !mcpDetectQ.trim()}
              >
                <Search size={12} aria-hidden />
                <span>{mcpDetecting ? t('harness.mcpDetecting') : t('harness.mcpDetectAction')}</span>
              </button>
            </div>
            {mcpCandidates.length > 1 && (
              <Combobox
                value={mcpPick}
                onChange={(v) => {
                  setMcpPick(v);
                  const picked = mcpCandidates.find((item) => item.name === v);
                  if (picked) probeMcpCandidate(picked);
                }}
                options={mcpCandidates.map((item) => ({
                  value: item.name,
                  label: `${item.title ?? item.name}${item.version ? ` · v${item.version}` : ''}`,
                  meta: item.name,
                }))}
                placeholder={t('harness.mcpDetectPick')}
                forceFilter
              />
            )}
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {t('harness.mcpArgs')}
              <InfoTip text={t('harness.mcpParamUseHint')} />
            </div>
            {renderMcpParamTable(mcpArgsEditor, t('harness.mcpArgFlag'), 'transport', updateMcpArgRow, removeMcpArgRow)}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={addMcpArgRow}>
                <Plus size={12} aria-hidden />
                <span>{t('harness.mcpArgAdd')}</span>
              </button>
              {/* Drops only the unchecked candidates: a selected or required row survives. */}
              {mcpArgsEditor.some((row) => row.selected !== true && !row.required) && (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setMcpArgsEditor((rows) => rows?.filter((row) => row.selected === true || row.required) ?? rows)
                  }
                >
                  {t('harness.mcpClearCandidates')}
                </button>
              )}
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.mcpParamRequiredHint')}</span>
            </div>
          </div>
        </div>
      </Dialog>
    );
  };

  /** Enlarged editor for one parameter value — stacked over the launch-argument editor. */
  const renderMcpValueEditor = () => {
    if (!mcpValueEditor) return null;
    const row = mcpArgsEditor?.find((item) => item.id === mcpValueEditor.id);
    return (
      <Dialog
        title={t('harness.mcpValueEditorTitle')}
        subtitle={<span style={MONO}>{row?.name || t('harness.mcpParamValue')}</span>}
        width={640}
        onClose={() => setMcpValueEditor(null)}
        closeLabel={t('combobox.close')}
        footerRight={
          <>
            <button className="btn btn-sm" onClick={() => setMcpValueEditor(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-sm" onClick={applyMcpValueEditor}>
              {t('harness.mcpValueEditorSave')}
            </button>
          </>
        }
      >
        <textarea
          className="input"
          rows={8}
          autoFocus
          spellCheck={false}
          style={{ ...MONO, resize: 'vertical', lineHeight: 'var(--leading-snug)', minHeight: 140 }}
          value={mcpValueEditor.value}
          onChange={(e) => setMcpValueEditor((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
        />
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.mcpValueEditorHint')}</div>
      </Dialog>
    );
  };

  /** Structured DSN builder for a `dsn`-format row; falls back to a raw textarea inside the dialog. */
  const renderMcpDsnBuilder = () => {
    if (!mcpDsnBuilder) return null;
    return (
      <DsnBuilder
        name={mcpDsnBuilder.name}
        value={mcpDsnBuilder.value}
        onClose={() => setMcpDsnBuilder(null)}
        onSave={applyMcpDsnBuilder}
      />
    );
  };

  const renderMarket = () => (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
        <div className="card-title">
          <span>{t(meta.marketKey)}</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginLeft: '8px' }}>
            {marketLoading ? t('harness.scanning') : marketItems.length}
          </span>
        </div>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '200px', maxWidth: '520px' }}>
          <Search
            size={13}
            style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }}
          />
          <input
            className="input"
            style={{ ...TOOLBAR_CONTROL, width: '100%', paddingLeft: '26px', paddingRight: '26px' }}
            placeholder={t('harness.marketSearch')}
            aria-label={t('harness.marketSearch')}
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
            // Typing changes only the field. Enter commits it — the one moment a request is spent —
            // and Escape clears field and list together, like the chip does. An Enter that commits an
            // IME candidate is the input method's key, not ours: searching there would spend a call on
            // half a pinyin syllable.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                commitMarket(marketQ);
              } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                setMarketQ('');
                commitMarket('');
              }
            }}
          />
          {/* Chip only exists while there is something to clear; `.input-clear` owns the look. */}
          {marketQ && (
            <button
              type="button"
              aria-label={t('common.clear')}
              title={t('common.clear')}
              onClick={() => {
                setMarketQ('');
                commitMarket('');
              }}
              className="input-clear"
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          )}
        </div>
        <SegGroup
          value={layout}
          onChange={(v) => setLayout(v as 'list' | 'card')}
          size="sm"
          height={HEADER_CONTROL_HEIGHT}
          options={[
            { value: 'list', icon: <List size={13} aria-hidden />, title: t('harness.list') },
            { value: 'card', icon: <LayoutGrid size={13} aria-hidden />, title: t('harness.card') },
          ]}
        />
      </div>
      {/* One sub-tab per source: the market answers "what can I get from WHERE", so the source is a
          view switch, not a filter. EVERY source that serves this axis is rendered — one that cannot
          serve stays visible with its reason, because a missing chip reads as "no such source". */}
      <div className="chip-row" style={{ alignItems: 'center', padding: '0 14px 10px 14px' }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.detailCatalog')}</span>
        {marketCatalogs.map((cat) => {
          const label = formatCatalog(cat);
          // Exact 0 when no source belongs to the catalog; unvisited catalogs with sources stay
          // silent (their size is not known until a browse answers).
          const hasSources = pageSources.some(
            (s) => s.enabled && s.browsable && (s.catalog || 'default') === cat,
          );
          const count = marketCatalogCounts[cat] ?? (hasSources ? undefined : 0);
          return (
            <button
              key={cat}
              className="chip"
              aria-pressed={marketCatalog === cat}
              aria-label={
                count === undefined ? label : t('harness.sourceCountAria', { name: label, count })
              }
              onClick={() => {
                setMarketCatalog(cat);
                commitMarket(marketQ);
              }}
            >
              {label}
              {count !== undefined && (
                <span className="chip-count" aria-hidden>
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {/* Order, star-fetch and refresh form one right-aligned group, because all three act on the
            shown page of the source picked to their left. The orderings are the SOURCE's own
            (declared in its `sorts`), so keeping the picker on this row makes the dependency visible —
            and it keeps the controls that decide "which page, in what order, enriched how" on the same
            baseline instead of one per row. A source with a single order gets a plain label: a dead
            dropdown reads as "broken", not as "one option". */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {activeSorts.length >= 2 ? (
            <Combobox
              variant="ghost"
              value={marketSort || activeSorts[0]!}
              onChange={(v) => setMarketSort(v)}
              options={activeSorts.map((k) => ({
                value: k,
                label: MARKET_SORT_KEY[k] ? t(MARKET_SORT_KEY[k]!) : k,
              }))}
              // Width is the label's, not a constant: a ghost trigger has no chrome to justify a fixed
              // box, and 168px around a two-character order read as an unfilled input. `width: auto`
              // also has to be said out loud — `.input` is `width: 100%`, which in this flex row would
              // stretch the trigger across the group and push refresh out of view. The panel keeps its
              // own 200px floor (Combobox PANEL_MIN_WIDTH_DEFAULT), so a narrow trigger still opens a
              // legible menu; growth happens leftward against the row edge, so refresh never moves.
              style={{
                fontSize: 'var(--text-sm)',
                width: 'auto',
                height: CHIP_ROW_CONTROL_HEIGHT,
                paddingTop: 0,
                paddingBottom: 0,
              }}
            />
          ) : (
            <span
              title={t('harness.marketSortLabel')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-dim)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('harness.marketSortLabel')}：
              {activeSorts[0] && MARKET_SORT_KEY[activeSorts[0]]
                ? t(MARKET_SORT_KEY[activeSorts[0]]!)
                : t('harness.marketSortCatalog')}
            </span>
          )}
          {/* Enrichment is an explicit act: most catalogs publish no star count, so the column would be
              empty for every row. One click here resolves the shown page's repositories in a single
              batched GitHub search; the button disappears entirely when nothing on the page can be
              resolved (no repo, or every count already known). A single row is resolved from its own
              cell — the same endpoint, one repository. Lives beside refresh, its page-action twin:
              both spend a call on the shown page, and neither changes the page's axes. */}
          {starTargets.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => void resolveStars(starTargets)}
              disabled={starsBusy}
              title={t('harness.starsFetchHint', { n: String(starTargets.length) })}
              // The chip row's own band, like refresh: no header-band height override here, or the
              // row would grow around one tall control and the chips beside it would lose the baseline.
            >
              <Star
                size={12}
                style={starsBusy ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
              />
              <span style={{ marginLeft: 6 }}>{starsBusy ? t('harness.scanning') : t('harness.starsFetch')}</span>
            </button>
          )}
          {/* The browse answer is cached for 60 s (the anonymous GitHub quota is 10 requests/minute), so
              the shown rows can be older than the source. Refresh re-reads THIS page under the current
              source/query/order — a control that spends a call on purpose, which is why it is a button
              and not a timer. Landing on the same page is what makes it a refresh rather than a
              re-search: nothing about the axis changes, only its age. */}
          <button
            className="btn btn-sm"
            onClick={() => void loadMarket(marketSubmittedQ, marketPage, true)}
            disabled={!canBrowse || marketLoading}
            title={t('harness.marketRefreshHint')}
            // The chip row's own band, not the header toolbar: this button is the same height as the
            // source chips it sits beside, so the row does not grow a taller control than its neighbours.
          >
            <RefreshCw
              size={12}
              style={marketLoading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
              aria-hidden
            />
            <span style={{ marginLeft: 6 }}>{t('harness.marketRefresh')}</span>
          </button>
        </div>
      </div>
      {/* Why this list looks the way it does — a default filter or an anonymous quota. It sits under
          the source chips that chose it and right beside the search it explains, instead of as a
          footnote below the table, where it read as a caption for the rows. */}
      {marketNote && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 14px 10px',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-dim)',
          }}
        >
          <Info size={11} aria-hidden />
          <span>
            {marketNote.code && NOTE_KEY[marketNote.code]
              ? t(NOTE_KEY[marketNote.code]!, marketNote.params)
              : marketNote.text}
          </span>
        </div>
      )}
      {sources.length > 0 && !canBrowse ? (
        /* No browsable source on this axis. Saying so is the honest answer; an empty result list
           would claim "nothing exists". */
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            color: 'var(--text-dim)',
            fontSize: 'var(--text-md)',
            padding: '28px',
            textAlign: 'center',
          }}
        >
          <ShieldAlert size={20} />
          <span>{t('harness.noBrowsableSource')}</span>
        </div>
      ) : marketError ? (
        <div style={{ padding: '16px', color: 'var(--accent-rose)', fontSize: 'var(--text-md)' }}>
          {marketError.reason && BROWSE_ERROR_KEY[marketError.reason]
            ? t(BROWSE_ERROR_KEY[marketError.reason]!, marketError.reasonParams)
            : marketError.message}
        </div>
      ) : marketItems.length === 0 && !marketLoading ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            color: 'var(--text-dim)',
            fontSize: 'var(--text-md)',
            padding: '28px',
          }}
        >
          <Inbox size={20} />
          <span>{t('harness.noMatch')}</span>
        </div>
      ) : (
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
          {/* The list/card switch governs both tabs: a toggle that only affects one of them is a lie
              about what it controls. */}
          {/* Loading is a LAYER, not a replacement: the previous page stays readable (dimmed) while
              the next one is on its way, so a commit does not blank the market. */}
          {marketLoading && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 14px',
                  borderRadius: 999,
                  background: 'var(--card-bg)',
                  border: '1px solid var(--card-border)',
                  boxShadow: 'var(--card-shadow)',
                  color: 'var(--text-dim)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <RefreshCw size={14} style={{ animation: 'ocr-spin 0.8s linear infinite' }} aria-hidden />
                {t('harness.scanning')}
              </span>
            </div>
          )}
          <div
            ref={marketScrollRef}
            style={{
              overflow: 'auto',
              flex: '1 1 auto',
              minHeight: 0,
              padding: '0 14px 12px 14px',
              opacity: marketLoading ? 0.45 : 1,
              transition: 'opacity 0.15s',
            }}
          >
          {layout === 'list' ? (
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 'var(--text-md)' }}>
              <colgroup>
                <col style={{ width: '26%' }} />
                <col />
                <col style={{ width: '26%' }} />
                <col style={{ width: '76px' }} />
                <col style={{ width: '92px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={TH}>{t('harness.name')}</th>
                  <th style={TH}>{t('harness.description')}</th>
                  <th style={TH}>{t('harness.repository')}</th>
                  <th style={TH_CENTER} title={t('harness.starsHint')}>{t('harness.stars')}</th>
                  <th style={TH_CENTER} />
                </tr>
              </thead>
              <tbody>
                {marketItems.map((item) => (
                  <tr key={item.id}>
                    <td style={{ ...TD, fontWeight: 'var(--font-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="harness-detail-link"
                        title={t('harness.detailOpen')}
                        onClick={() => openDetail(subjectFromMarket(item))}
                      >
                        {item.name}
                      </button>
                    </td>
                    <td style={TD}>{descCell({ key: item.id, description: item.description })}</td>
                    <td style={{ ...TD, ...MONO, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.repo ?? item.key}
                    </td>
                    <td style={TD_CENTER}>{starControl(item, 'list')}</td>
                    <td style={TD_CENTER}>{marketInstallButton(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '12px',
              paddingTop: '4px',
            }}
          >
            {marketItems.map((item) => (
              <div
                key={item.id}
                style={{
                  border: '1px solid var(--divider)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  background: 'var(--chip-bg)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: 'var(--text-md)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {/* The card's ONLY detail opener: the title, as a button (keyboard focus stop).
                      No card-level onClick — every control inside would need stopPropagation
                      against it, and one miss pops the dialog (exactly what the translate button
                      did before this rule). The installed tab's cards already work this way. */}
                  <button
                    type="button"
                    className="harness-detail-link"
                    title={t('harness.detailOpen')}
                    onClick={() => openDetail(subjectFromMarket(item))}
                  >
                    {item.name}
                  </button>
                  <span style={{ flex: 1 }} />
                  {starControl(item, 'card')}
                </div>
                {descCell({ key: item.id, description: item.description }, true)}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, marginTop: 'auto' }}>
                  <span
                    title={item.repo ?? item.key}
                    style={{
                      ...MONO,
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-dim)',
                      flex: '1 1 auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>{t('harness.detailChannel')}:</span>{' '}
                    {item.channel ?? (item.sourceId?.startsWith('mp-') ? item.sourceId.slice(3) : item.sourceId)}
                  </span>
                  <span style={{ flex: '0 0 auto' }}>{marketInstallButton(item)}</span>
                </div>
              </div>
            ))}
          </div>
          )}
          </div>
        </div>
      )}
      {/* The shared pager, with the SOURCE's own count: the market reports a real total when the
          catalog states one (`1-50 / 5338` upstream), so the page strip and its summary are honest.
          A source that states none (the MCP registry answers only a cursor) keeps the
          last-reachable-page pose and says "at least N" — the rows the list can prove, never a
          fabricated exact count. */}
      {canBrowse && marketItems.length > 0 && (
        <div style={{ padding: '0 14px 6px', borderTop: '1px solid var(--divider)' }}>
          <Pagination
            page={marketPage}
            pageSize={MARKET_PAGE_SIZE}
            total={marketPagerTotal}
            onChange={(next) => setMarketPage(next)}
            disabled={marketLoading}
            // A `window` total is NOT the catalog's size: a windowed search caps every answer,
            // so printing "1-24 / 569" invited "the catalog has 569". The number stays for the page
            // buttons, the summary hides, and the note states the source's own figures instead.
            showSummary={marketTotalScope !== 'window'}
            // A source without a total still knows ONE exact number on its last page (no successor =
            // the end), so "at least" is only honest while a successor exists.
            totalAtLeast={marketTotal === null && marketHasMore}
            // No catalog total (ClawHub's cursor walk): page numbers would be invented. The bar
            // keeps prev / current / next and lets the source's own `hasMore` own "next".
            cursor={marketTotal === null}
            hasNext={marketHasMore}
          />
        </div>
      )}
    </div>
  );

  /** Rows the page holds: tracked everywhere + the local discovery scan where the kind has one. */
  const total = scopedTrackedRows.length + (discovery ? scopedDiscovered.length : 0);

  /** Breadcrumb: a landing page names its harness because the harness IS the scope there. */
  const breadcrumb = (): string => {
    const scope = harness ? `${harness}/` : '';
    if (tab === 'global') return `harness://${scope}inventory`;
    if (tab === 'project') {
      const proj = projects.find((p) => p.id === selectedProjectId);
      return `harness://${scope}inventory:project${proj ? `/${proj.name}` : ''}`;
    }
    const market = marketCatalog ? `catalog/${marketCatalog}:search` : 'search';
    return scope ? `harness://${scope}${market}` : market;
  };

  /**
   * Does a copy belong to THIS page?
   *
   * `copyServes` is the same predicate the rail counts with, so the removal dialog can never disagree
   * with the list that opened it: on a skills page it answers by READERSHIP (the shared
   * `.agents/skills` tree is one copy owned by `universal` and read by fifteen runtimes, so it belongs to
   * every rail entry that reads it), on MCP/plugin pages by the copy's own host. No harness on the
   * page (before the catalog resolves) means no scope to narrow by — every copy is in scope.
   */
  const servesPage = (copy: HarnessCopyView): boolean => (harness ? copyServes(harness)(copy) : true);

  /**
   * Row copies as the removal dialog lists them: this page's copies first, the rest after (stable, so
   * the row's own order survives inside each group).
   *
   * EVERY copy is listed and every one of them stays TICKABLE — the row's host chips already name them
   * ("Universal · Claude Code"), so a hidden row would contradict the card, and a disabled one would
   * take away an ability the plan layer still supports (one plan may remove several copies). What the
   * page's scope decides is only the DEFAULT: the copies this runtime serves are the ones preselected.
   */
  const pickerCopies = (row: Row): HarnessCopyView[] =>
    row.copies.slice().sort((a, b) => Number(servesPage(b)) - Number(servesPage(a)));

  /**
   * Open the removal dialog with this page's copies preselected.
   *
   * A page pinned to one harness asks one runtime's question, so its copies are ticked and another
   * runtime's copy — an MCP server that also sits in Claude's config, or a `claude/skills` directory —
   * is not. It stays one tick away: "remove everywhere" is still the same list, deliberately chosen.
   */
  const openPicker = (row: Row) => {
    const picked = row.copies.filter((c) => c.state !== 'foreign' && servesPage(c));
    setPicker({ row, picked: new Set(picked.map((c) => c.path)) });
  };

  const translateText = async (key: string, description: string | null) => {
    if (!description) return;
    setTr((prev) => ({ ...prev, [key]: { src: description, text: '…', model: '' } }));
    try {
      const res = await api.harnessTranslate({ text: description, lang });
      setTr((prev) => ({ ...prev, [key]: { src: description, text: res.text, model: res.model } }));
    } catch (e) {
      setTr((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.error(`${t('harness.translateFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Translate every row still showing its original text, in chunks of 8.
   *
   * Chunked rather than one big request: a slow tier can't stall a single call for a minute, and the
   * backend cache makes an interrupted run resumable — pressing the button again picks up the rest.
   */
  const translateAll = async () => {
    // Only rows whose CURRENT description has no translation yet — a stale entry is not a hit.
    const pending = rows.filter((row) => row.description && tr[row.key]?.src !== row.description);
    if (pending.length === 0) return;
    const ok = await confirmDialog({
      title: t('harness.translateAll'),
      description: `${t('harness.translateAllConfirm')} (${pending.length})`,
    });
    if (!ok) return;

    // One description can back several rows; translate it once and fill them all.
    const keysByText = new Map<string, string[]>();
    for (const row of pending) {
      const text = row.description as string;
      const list = keysByText.get(text) ?? [];
      list.push(row.key);
      keysByText.set(text, list);
    }
    const texts = [...keysByText.keys()];
    const CHUNK = 8;
    let done = 0;
    let failed = 0;
    let aborted = false;
    setBatch({ done: 0, total: texts.length, failed: 0 });

    try {
      for (let i = 0; i < texts.length; i += CHUNK) {
        const chunk = texts.slice(i, i + CHUNK);
        try {
          const res = await api.harnessTranslateBatch({ lang, texts: chunk });
          setTr((prev) => {
            const next = { ...prev };
            for (const [text, translated] of Object.entries(res.results)) {
              for (const key of keysByText.get(text) ?? []) {
                next[key] = { src: text, text: translated.text, model: translated.model };
              }
            }
            return next;
          });
          failed += res.errors.length;
        } catch (e) {
          failed += chunk.length;
          const err = e as Error & { code?: string };
          toast.error(`${t('harness.translateFailed')}: ${err.message}`);
          // A missing key fails every remaining chunk identically — stop instead of spamming.
          if (err.code === 'no_api_key') {
            aborted = true;
            break;
          }
        }
        done += chunk.length;
        setBatch({ done: Math.min(done, texts.length), total: texts.length, failed });
      }
    } finally {
      setBatch(null);
      if (!aborted) {
        if (failed > 0) toast.error(`${t('harness.translateAllPartial')}: ${failed}/${texts.length}`);
        else toast.success(t('harness.translateAllDone'));
      }
    }
  };

  /** Execute the picked locations: one plan for this row, one transaction. */
  const removePicked = async () => {
    if (!picker) return;
    const picked = picker.row.copies.filter((c) => picker.picked.has(c.path));
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const { plan } = await api.harnessPlan({
        action: 'remove',
        // Project-scope copies resolve against the picked project's roots, exactly like the
        // inventory that listed them — never against the gateway cwd.
        ...(inventoryProjectId ? { projectId: inventoryProjectId } : {}),
        items: [
          {
            artifactId: picker.row.artifact?.id ?? null,
            copies: picked.map((c) => ({
              scope: c.scope,
              host: c.host,
              path: c.path,
              ...(c.profile ? { profile: c.profile } : {}),
            })),
            // A discovered row's record is the target: the scan already resolved which file and
            // container hold it, so the plan does not have to re-guess the runtime's layout.
            ...(picker.row.removal ? { removal: picker.row.removal } : {}),
          },
        ],
      });
      if (plan.blocked.length > 0) {
        toast.error(`${t('harness.removeFailed')}: ${plan.blocked.map((b) => b.message).join('; ')}`);
        return;
      }
      let discardLocalEdits = false;
      if (plan.warnings.length > 0) {
        discardLocalEdits = await confirmDialog({
          title: t('harness.removeDirtyTitle'),
          description: `${t('harness.removeDirtyDesc')}\n\n${plan.warnings.map((w) => w.path).join('\n')}`,
          danger: true,
          confirmLabel: t('harness.remove'),
        });
        if (!discardLocalEdits) return;
      }
      const result = await api.harnessApply({ planId: plan.planId, discardLocalEdits });
      // A `prune-record` apply removes a manifest row while the package itself stays in the
      // runtime's own store — "removed N copies" would be a false report, so the backend's own
      // explanation wins when it sends one.
      toast.success(result.message ?? t('harness.removeDone').replace('{n}', String(result.removed.length)));
      setPicker(null);
      await load();
    } catch (e) {
      toast.error(`${t('harness.removeFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Description cell: cached machine translation first, original on request.
   *  Takes any keyed description (inventory row or marketplace item) — the cache is keyed by text,
   *  so one implementation serves both tabs. `block` wraps to two lines instead of truncating. */
  const descCell = (row: { key: string; description: string | null }, block = false) => {
    // A translation is valid only for the exact source it was made from (`tr.src`); otherwise a
    // rescan that reworded the description would keep showing the previous wording forever.
    const entry = tr[row.key];
    const translated = entry && entry.src === (row.description ?? '') ? entry : undefined;
    const showingTranslation = !!translated && !showOriginal[row.key];
    const text = showingTranslation ? translated.text : (row.description ?? '');
    // Nothing to show is shown as nothing — an em dash in an otherwise empty cell is punctuation
    // pretending to be data.
    if (!text) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%' }}>
        <span
          title={text}
          style={
            block
              ? {
                  flex: '1 1 auto',
                  minWidth: 0,
                  color: 'var(--text-dim)',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  // Fixed height, not min-height: line-clamp only clips inside a box that cannot
                  // grow, otherwise a long description spills over the row beneath it.
                  height: '2.9em',
                  lineHeight: 'var(--leading-tight)',
                }
              : {
                  flex: '0 1 auto',
                  minWidth: 0,
                  color: 'var(--text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }
          }
        >
          {text}
        </span>
        {translated && (
          /* A titled button in every row shouted louder than the content it annotates. A micro
             badge carries the same state, and the tooltip still spells it out. */
          <button
            className="badge"
            onClick={() => setShowOriginal((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
            title={showingTranslation ? t('harness.showOriginal') : t('harness.translated')}
            aria-pressed={showingTranslation}
            style={{
              flex: '0 0 auto',
              fontSize: 'var(--text-2xs)',
              padding: '0 5px',
              letterSpacing: 'var(--tracking-normal)',
              lineHeight: 'var(--leading-15)',
              cursor: 'pointer',
              border: '1px solid var(--divider)',
              background: 'transparent',
              color: showingTranslation ? 'var(--text-dim)' : 'var(--accent-emerald)',
            }}
          >
            {showingTranslation ? t('harness.mtBadge') : t('harness.origBadge')}
          </button>
        )}
        {row.description && !translated && (
          <button
            className="btn btn-sm"
            onClick={() => void translateText(row.key, row.description)}
            title={t('harness.translate')}
            aria-label={t('harness.translate')}
            style={{ flex: '0 0 auto' }}
          >
            <Globe size={12} aria-hidden />
          </button>
        )}
      </div>
    );
  };

  /** Where a row came from, as copy: a registry label for a tracked row, the runtime record for a
   *  discovered plugin (it has no source — the runtime's own store is not a marketplace), the
   *  plain "local" for a skill directory. Raw ids never reach the UI: a cell is copy, not a slug.
   *
   *  A tracked row answers "where did I INSTALL this from" — the BROWSE surface, not the writer that
   *  served the bytes. A Pi-catalog package carries `sourceId:'npm'` + `listedOn:['npm','pi-dev']`;
   *  the operator picked it on pi.dev, so the cell says pi.dev. The writer is not lost: it stays in
   *  the record and in `canonicalKey` (`npm:<pkg>`, the cell's tooltip), and the chips still narrow
   *  by both — only this column's question is answered literally (ADR-0015 §D8.6). */
  const channelLabel = (row: Row): string => {
    if (!row.tracked) {
      if (row.origin === 'runtime-store') return t('harness.originRuntimeStore');
      if (row.origin === 'config-array') return t('harness.originConfigEntry');
      if (row.origin === 'local-file') return t('harness.originLocalFile');
      return t('harness.local');
    }
    if (row.channel) return row.channel;
    for (const surface of [...row.listedOn].reverse()) {
      if (surface === 'pi-dev') return 'pi-dev';
      if (surface.startsWith('mp-')) return surface.slice(3);
      if (surface) return surface;
    }
    if (row.sourceId?.startsWith('mp-')) return row.sourceId.slice(3);
    return row.sourceId ?? 'direct';
  };


  /** The catalog's word for a host (`Universal`, `OpenCode`); the raw id is only the fallback. The
   *  rail and this chip name the same host, so they must not spell it two ways. */
  const hostName = (id: string): string => {
    const found = hosts.find((candidate) => candidate.id === id);
    return found ? found.label.replace(/\s*\([^)]*\)\s*$/, '') : id;
  };
  /**
   * One badge per row — THE PINNED HARNESS's verdict only.
   *
   * Two independent claims can make a row unhealthy: the on-disk claim (`needsAttention`'s copy
   * state — a member that is gone or claimed by another environment) and the runtime's live answer
   * (the server failed to connect or needs a login, even while its config member is intact). The
   * runtime verdict wins the badge text because that is the state the operator must act on. A
   * page is pinned to one harness, so its badge answers "does this server work THERE" — another
   * harness's failure can never repaint this row.
   *
   * A healthy live answer is also printed instead of silence: `connected` / `disabled` is the
   * real state of the server, and a blank cell would claim nothing. Absent runtime data (no
   * status surface, unreachable CLI) is not a verdict and prints nothing.
   *
   * `dirty` is never one of these answers: a config file rewritten by its own runtime, or shared
   * with another tool, is ordinary drift, not a defect. The CAUSE of a real issue is the badge's
   * tooltip; drift is named per copy in the removal picker, the only place it changes an outcome.
   */
  const stateBadge = (row: Row) => {
    const runtime = row.runtime;
    const badge = runtime ? RUNTIME_BADGE[runtime.status] : null;
    if (runtime && badge && (runtimeNeedsAttention(runtime) || !needsAttention(row))) {
      const title = runtime.error
        ? `${hostName(runtime.host)}: ${runtime.error}`
        : `${hostName(runtime.host)}: ${t(badge.key)}`;
      return (
        <span className={badge.className} title={title}>{t(badge.key)}</span>
      );
    }
    if (!needsAttention(row)) return null;
    // Copy-level evidence outranks the rollup: a row whose rollup is `dirty` can still hold a copy
    // that is gone, and the tooltip must name that instead of the drift that outranked it.
    const reason = row.copies.some((c) => c.state === 'missing')
      ? 'harness.stateMissing'
      : row.copies.some((c) => c.state === 'foreign')
        ? 'harness.stateForeign'
        : row.state === 'partial'
          ? 'harness.stateForeign'
          : `harness.state${row.state[0].toUpperCase()}${row.state.slice(1)}`;
    return (
      <span className="badge badge-warning" title={t(reason)}>{t('harness.stateIssue')}</span>
    );
  };

  /** The list view drops the whole state column when no row on this page has anything to report:
   *  an empty column is the same noise as a column of greens. */
  const showStateColumn = pageRows.some((row) => stateBadge(row) !== null);

  /** Same rule for stars: the column exists only when the page holds a row that names a repository.
   *  An npm-only page has nothing to resolve, so it gets no column — never a column of blanks. */
  const showStarColumn = pageRows.some((row) => row.repo !== null);

  /**
   * WHICH harness a row is installed FOR — rendered on the row itself, in BOTH layouts.
   *
   * Readership is what makes this mandatory rather than decorative. A skills page is pinned to one
   * runtime but shows every row that runtime can LOAD, and two such rows can live in different
   * places: one in the shared `.agents/skills` tree (`Universal` — fifteen runtimes load it, so removing
   * it touches all fifteen) and one in that runtime's own directory (`OpenCode` — private to it). With
   * no tag, a pinned page reads as if every row were scoped to the pinned harness, which is exactly
   * the claim it must not make. The chip's tooltip is the copy's real path, so "which directory am I
   * about to remove" never needs a second click.
   *
   * MCP is the exception: the page is pinned to one harness and every claim on the card (state,
   * edit, remove) is THAT harness's, so other hosts' chips would only imply a shared fate the
   * actions do not have. Where sharing actually matters — removal touches every host the artifact
   * landed on — the picker names each copy (ADR-0015 §D8.6). */
  const hostChips = (row: Row, limit: number = HOSTS_PREVIEW) => {
    const shown = kind === 'mcp' ? row.hosts.filter((host) => host === harness) : row.hosts;
    return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {shown.slice(0, limit).map((host) => {
        const paths = row.copies
          .filter((copy) => copy.host === host)
          .map((copy) => (copy.profile ? `${copy.profile}: ${copy.path}` : copy.path));
        return (
          <span
            key={host}
            className="chip"
            title={paths.join('\n') || undefined}
            style={{ fontSize: 'var(--text-xs)', padding: '1px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <HostIcon host={host} size={12} />
            {hostName(host)}
          </span>
        );
      })}
      {shown.length > limit && (
        <span className="chip" style={{ fontSize: 'var(--text-xs)', padding: '1px 7px' }}>+{shown.length - limit}</span>
      )}
    </div>
    );
  };

  /** DSH plugin profile pills. The host chip names the runtime; these name the profiles it landed in.
   *  Legacy unprofiled copies meant `web`, so they still read correctly. */
  const profileChips = (row: Row) => {
    if (kind !== 'plugin') return null;
    const profiles = new Set<string>();
    for (const copy of row.copies) {
      if (copy.host === 'dsh') profiles.add(copy.profile ?? 'web');
    }
    if (profiles.size === 0) return null;
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {[...profiles].sort().map((profile) => (
          <span
            key={profile}
            className="chip"
            title={`${t('harness.installProfile')}: ${profile}`}
            style={{ fontSize: 'var(--text-xs)', padding: '1px 7px' }}
          >
            {profile}
          </span>
        ))}
      </div>
    );
  };
  /**
   * Edit one EXISTING server's launch. Offered only where the page is pinned to an MCP-capable
   * runtime that holds this row: the dialog reads that runtime's config entry, so a hand-broken or
   * unreadable file answers a toast instead of opening a form over it. A row entirely claimed by
   * another environment is refused up front — the write would only fail after the gate.
   */
  const editMcpButton = (row: Row) => {
    if (kind !== 'mcp' || !harness || !row.hosts.includes(harness)) return null;
    if (!hosts.some((host) => host.id === harness && host.hasMcp)) return null;
    const allForeign = row.copies.length > 0 && row.copies.every((c) => c.state === 'foreign');
    return (
      <button
        className="btn btn-sm"
        disabled={allForeign || installBusy || mcpEditLoading}
        title={allForeign ? t('harness.foreignHint') : t('harness.mcpEdit')}
        onClick={() => void openMcpEdit(row)}
        style={{ flex: '0 0 auto' }}
      >
        <Pencil size={11} />
        <span>{t('harness.mcpEdit')}</span>
      </button>
    );
  };

  const removeButton = (row: Row) => {
    const allForeign = row.copies.length > 0 && row.copies.every((c) => c.state === 'foreign');
    // A row whose shape the scan could not describe has nothing to plan against: refuse the click
    // instead of letting it fail after the round-trip. Config-backed kinds only — a skill's removal
    // is planned from its copies, so it needs no descriptor.
    const unknownShape = (kind === 'plugin' || kind === 'mcp') && !row.tracked && !row.removal;
    return (
      <button
        className="btn btn-sm"
        disabled={allForeign || unknownShape}
        title={allForeign ? t('harness.foreignHint') : unknownShape ? t('harness.localHint') : undefined}
        onClick={() => openPicker(row)}
        style={{ flex: '0 0 auto' }}
      >
        <Trash2 size={11} />
        <span>{t('harness.remove')}</span>
      </button>
    );
  };

  /** The count noun follows the artifact kind ("installed skills / installed MCP / installed
   *  plugins"): one shared skills label read as a lie on a landing page, where the list holds
   *  servers or plugins. */
  const installedNoun = t(meta.installedKey);

  /** The compact fact line under a detail dialog's title: only fields that actually answered. */
  const detailFacts: string[] = [];
  if (detail?.latestVersion) detailFacts.push(`v${detail.latestVersion}`);
  if (detail?.license) detailFacts.push(detail.license);
  if (detail?.language) detailFacts.push(detail.language);
  if (detail?.stars) detailFacts.push(`${formatStars(detail.stars)}★`);
  else if (!detail && detailSubject?.market?.stars) detailFacts.push(`${formatStars(detailSubject.market.stars)}★`);
  const detailDate =
    detail?.publishedAt ??
    detail?.updatedAt ??
    detailSubject?.market?.updatedAt ??
    undefined;
  if (detailDate) detailFacts.push(detailDate.slice(0, 10));
  /**
   * The SOURCE'S own counters (ClawHub today) — rendered as a labelled line of their own, never as a
   * `★` on the fact line: `detail.stars` means a GitHub star count, and printing a registry rating
   * under it would relabel one number as another (ADR-0015 §D6).
   */
  const detailRegistry = detail?.registryStats ?? detailSubject?.market?.registryStats ?? null;
  const detailRegistryText = detailRegistry
    ? t('harness.registryCounts', {
        stars: detailRegistry.stars === null ? '—' : detailRegistry.stars.toLocaleString(),
        downloads: detailRegistry.downloads === null ? '—' : detailRegistry.downloads.toLocaleString(),
        installs: detailRegistry.installs === null ? '—' : detailRegistry.installs.toLocaleString(),
      })
    : null;
  /** Why the detail read produced nothing: a thrown request failure, or the reason the backend
   *  reported inside a successful answer (a refused/throttled upstream is a 200, not an error). */
  const detailProblem: MarketFailure | null =
    detailFailure ??
    (detail?.reason
      ? { message: detail.message ?? '', reason: detail.reason, reasonParams: detail.reasonParams }
      : null);
  /** The README actually rendered: the translation while it is valid AND not dismissed. */
  const detailReadme =
    detail?.readme && detailTr && detailTr.src === detail.readme && !detailShowSrc ? detailTr.text : (detail?.readme ?? null);
  /** Where the README's relative links resolve to. The registry's `repository` field wins over the
   *  row's own (an npm row usually names its repo only in the detail answer), and a row with no
   *  source page leaves them unresolved — `ReadmeMarkdown` then drops the click instead of sending
   *  it to a console route that does not exist. */
  const readmeBase = detailSubject
    ? readmeBaseHref({
        repo: detail?.repo ?? detailSubject.repo,
        path: detail?.readmePath,
        packageKey: detailSubject.packageKey,
        url: detailSubject.url,
      })
    : undefined;
  /** A rendering for THIS source already exists (translated now or seeded from the cache): the
   *  header button re-translates instead of asking the cache the same question again. */
  const detailTranslated = !!detail?.readme && detailTr?.src === detail.readme;
  /** Busy label: chunk progress while a run reports it, the generic wording otherwise. */
  const detailTranslateLabel = detailTrBusy
    ? detailProgress
      ? t('harness.detailTranslatingProgress', { ...detailProgress, secs: detailElapsed })
      : t('harness.detailTranslating')
    : detailTranslated
      ? t('harness.detailRetranslate')
      : t('harness.detailTranslate');

  /** One-line description, translated when the shared cache already has it (same rule as `descCell`). */
  const detailDescEntry = detailSubject ? tr[detailSubject.key] : undefined;
  const detailDesc = detailSubject?.description
    ? detailDescEntry && detailDescEntry.src === detailSubject.description && !showOriginal[detailSubject.key]
      ? detailDescEntry.text
      : detailSubject.description
    : null;

  /** Everything inside the frame is identical for every kind — the rail only changes the frame
   *  around it, so skills/MCP cannot drift from the plugin page. */
  const content = (
    <>
      {/* Page-level tabs: the two views share one artifact set, so they are two views of one page
          rather than two screens. Sits outside the cards so no card scroll takes it away. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, flexWrap: 'wrap' }}>
        {/* The switch never shrinks: its own `overflow: hidden` makes it a zero-min-width flex item,
            so a squeezed row clipped the trailing tab to a sliver instead of letting the breadcrumb
            truncate. */}
        <div style={{ flex: '0 0 auto' }}>
          <SegGroup
            value={tab}
            onChange={(v) => setTab(v as 'global' | 'project' | 'market')}
            size="lg"
            // Every kind forks the installed view into global/project tabs, aligned with the market
            // tab in the same group.
            options={[
              { value: 'global', label: t('harness.viewGlobal', { kind: t(meta.scopeKindKey) }) },
              ...(projectTabOk
                ? [{ value: 'project', label: t('harness.viewProject', { kind: t(meta.scopeKindKey) }) }]
                : []),
              { value: 'market', label: t(meta.marketKey) },
            ]}
          />
        </div>
        <span
          title={breadcrumb()}
          style={{
            flex: '1 1 160px',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-dim)',
            fontFamily: FONT_MONO,
          }}
        >
          {breadcrumb()}
        </span>
        {tab === 'market' && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => setSourcesOpen(true)}
          >
            <Settings2 size={12} />
            {t('harness.srcMgmt.manage')}
          </button>
        )}
      </div>

      {/* ── One list: tracked + local ────────────────────────────────────── */}
      {(tab === 'global' || tab === 'project') && (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
        {/* Wrap instead of squeezing: on a narrow window the action group drops to its own line
            rather than crushing the title. */}
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
          {/* ONE title line for the scope and its count. This card used to sit under a header card
              that repeated both — title, count and a rescan button — for a whole extra card's
              padding. The scope name lives here, the count is its dim suffix, and when a filter
              narrows the list the suffix says how much of the whole is on screen. */}
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <Boxes size={18} color="var(--accent)" />
            <span>{tab === 'project' ? t('harness.viewProject', { kind: t(meta.scopeKindKey) }) : t(meta.titleKey)}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {inventory ? (
                <>
                  {installedNoun} {rows.length}
                  {rows.length !== total ? ` / ${total}` : ''}
                </>
              ) : (
                t('harness.subtitle')
              )}
            </span>
            {tab === 'project' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: '8px' }}>
                {projects.length > 0 ? (
                  <div style={{ minWidth: 160, maxWidth: 240 }}>
                    <Combobox
                      value={selectedProjectId ?? ''}
                      onChange={(v) => setSelectedProjectId(v)}
                      options={projects.map((p) => ({ value: p.id, label: p.name, meta: p.path }))}
                      placeholder={t('harness.switchProject')}
                      hideMetaInTrigger
                      panelMinWidth={280}
                    />
                  </div>
                ) : (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {t('harness.noProjectsAvailable')}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setProjectsDialogOpen(true)}
                  title={t('harness.manageProjects')}
                  style={{ height: HEADER_CONTROL_HEIGHT, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <FolderCog size={13} />
                  <span style={{ fontSize: 'var(--text-sm)' }}>{t('projects.title')}</span>
                </button>
                {selectedProject && (
                  <span
                    style={{
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-dim)',
                      fontFamily: FONT_MONO,
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={selectedProject.path}
                  >
                    ({selectedProject.path})
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Actions stay on the title line and never shrink: a squeezed flex item wraps its
              label one character per line, which is how this toolbar broke before. */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto' }}>
            {kind === 'mcp' && harness && hosts.some((h) => h.id === harness && h.hasMcp && h.detected) && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  setMcpGate(null);
                  setMcpEditGate(null);
                  setMcpEdit(null);
                  setMcpMarket(null);
                  setMcpMarketGate(null);
                  setMcpDraft({ ...EMPTY_MCP_DRAFT });
                  setMcpDetectQ('');
                  setMcpCandidates([]);
                  setMcpPick('');
                  // Opening Add from the project view presets the install target to that project;
                  // opening it from the global view must not inherit a previous project pick.
                  if (tab === 'project' && selectedProjectId) {
                    setInstallScope('project');
                    setInstallProjectId(selectedProjectId);
                  } else {
                    setInstallScope('global');
                    setInstallProjectId(null);
                  }
                }}
                disabled={installBusy}
                style={{ height: HEADER_CONTROL_HEIGHT, paddingTop: 0, paddingBottom: 0 }}
              >
                <Plus size={12} />
                <span>{t('harness.mcpAdd')}</span>
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => void load()}
              disabled={loading}
              style={{ height: HEADER_CONTROL_HEIGHT, paddingTop: 0, paddingBottom: 0 }}
            >
              <RefreshCw
                size={12}
                style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
              />
              <span>{loading ? t('harness.scanning') : t('harness.scan')}</span>
            </button>
            {kind === 'mcp' && runtimeProbing && (
              <span
                style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                title={t('harness.mcpRuntimeProbing')}
              >
                <RefreshCw size={10} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
                {t('harness.mcpRuntimeProbing')}
              </span>
            )}
            <button
              className="btn btn-sm"
              onClick={() => void translateAll()}
              disabled={batch !== null || rows.every((row) => !row.description || tr[row.key]?.src === row.description)}
              title={t('harness.translateAll')}
              style={{
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
                height: HEADER_CONTROL_HEIGHT,
                paddingTop: 0,
                paddingBottom: 0,
              }}
            >
              <Globe size={12} aria-hidden />
              <span>{batch ? `${batch.done}/${batch.total}` : t('harness.translateAll')}</span>
            </button>
            <SegGroup
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              size="sm"
              height={HEADER_CONTROL_HEIGHT}
              options={[
                { value: 'all', label: t('harness.filterAll') },
                { value: 'issues', label: t('harness.filterIssues') },
              ]}
            />
            <SegGroup
              value={layout}
              onChange={(v) => setLayout(v as 'list' | 'card')}
              size="sm"
              height={HEADER_CONTROL_HEIGHT}
              options={[
                { value: 'list', icon: <List size={13} aria-hidden />, title: t('harness.list') },
                { value: 'card', icon: <LayoutGrid size={13} aria-hidden />, title: t('harness.card') },
              ]}
            />
          </div>
        </div>
        {/* ONE filter row: the source facets, the host picker and the query all narrow the same
            list, so they share a line — three stacked rows cost a table's worth of height on every
            visit. The search field takes whatever width the card can spare. Only sources that landed
            something are rendered: a facet with nothing behind it can only ever empty the table, and
            the market tab is where the full registry (including a source that cannot serve) stays
            visible. */}
        <div className="chip-row" style={{ alignItems: 'center', padding: '0 14px 10px 14px', gap: '8px' }}>
          {installedCatalogs.length > 0 && (
            <>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.detailCatalog')}</span>
              <button
                className="chip"
                aria-pressed={activeCatalog === 'all'}
                aria-label={t('harness.sourceCountAria', { name: t('harness.filterAll'), count: catalogCounts.all ?? 0 })}
                onClick={() => setActiveCatalog('all')}
              >
                {t('harness.filterAll')}
                <span className="chip-count" aria-hidden>
                  {catalogCounts.all ?? 0}
                </span>
              </button>
              {installedCatalogs.map((cat) => (
                <button
                  key={cat}
                  className="chip"
                  aria-pressed={activeCatalog === cat}
                  aria-label={t('harness.sourceCountAria', {
                    name: cat === 'default' ? t('harness.srcMgmt.defaultCatalog') : cat,
                    count: catalogCounts[cat] ?? 0,
                  })}
                  onClick={() => setActiveCatalog(cat)}
                >
                  {formatCatalog(cat)}
                  <span className="chip-count" aria-hidden>
                    {catalogCounts[cat] ?? 0}
                  </span>
                </button>
              ))}
            </>
          )}
          {!landing && (
            <Combobox
              value={hostFilter}
              onChange={(v) => setHostFilter(v)}
              options={hostOptions}
              clearable
              placeholder={t('harness.allHosts')}
              style={{ ...TOOLBAR_CONTROL, width: '150px', flex: '0 0 auto' }}
            />
          )}
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '200px', maxWidth: '520px' }}>
            <Search
              size={13}
              style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }}
            />
            <input
              className="input"
              style={{ ...TOOLBAR_CONTROL, width: '100%', paddingLeft: '26px', paddingRight: '26px' }}
              placeholder={t('harness.searchPlaceholder')}
              aria-label={t('harness.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {/* Same chip, same rule: only while `q` holds text. `q` is part of the page-1-reset
                effect, so clearing also returns the table to its first page. A real <button>: the
                clear control is reachable and operable from the keyboard, not just the mouse. */}
            {q && (
              <button
                type="button"
                aria-label={t('common.clear')}
                title={t('common.clear')}
                onClick={() => setQ('')}
                className="input-clear"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
          {/* The one exclusion worth having: the shared `.agents` tree is the same set under every
              rail entry, so hiding it is the only way this page says "mine" — and it is therefore ON
              by default. Absent where it would mean nothing: not on MCP/plugin pages (no shared
              landing there), not on the shared entry itself, and not on a page with nothing private
              left to show. The count is the receipt for a hidden set: it says how many rows this
              switch is holding back right now, under the current query. */}
          {canToggleShared && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flex: '0 0 auto',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <Switch size="sm" checked={sharedHidden} onChange={setHideShared} ariaLabel={t('harness.hideShared')} />
              <span>{t('harness.hideShared')}</span>
              {hiddenSharedCount > 0 && (
                <span className="chip-count" aria-hidden>
                  {hiddenSharedCount}
                </span>
              )}
            </label>
          )}
        </div>
        {error ? (
          <div style={{ padding: '16px', color: 'var(--accent-rose)', fontSize: 'var(--text-md)' }}>{error}</div>
        ) : rows.length === 0 && !loading && inventory ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              color: 'var(--text-dim)',
              fontSize: 'var(--text-md)',
              padding: '28px',
            }}
          >
            <Inbox size={20} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '560px' }}>
              <span>{total === 0 ? t('harness.empty') : t('harness.noMatch')}</span>
              {/* The one place that must say what "0" means for a kind with no discovery scan: an
                  empty list is "this gateway installed nothing", never "this machine has none". */}
              {total === 0 && emptyNoteKey && (
                <span style={{ fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-snug)' }}>{t(emptyNoteKey)}</span>
              )}
            </span>
          </div>
        ) : (
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
            {/* The rescan's own progress: the toolbar button spins too, but a scan that re-reads the
                disk can outlast the click, and the table must not look frozen while it runs. The
                FIRST scan counts too (`inventory` is null): "0 rows" before the answer arrives is a
                claim the page has not earned yet. */}
            {(loading || !inventory) && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                  zIndex: 2,
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 14px',
                    borderRadius: 999,
                    background: 'var(--card-bg)',
                    border: '1px solid var(--card-border)',
                    boxShadow: 'var(--card-shadow)',
                    color: 'var(--text-dim)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <RefreshCw size={14} style={{ animation: 'ocr-spin 0.8s linear infinite' }} aria-hidden />
                  {t('harness.scanning')}
                </span>
              </div>
            )}
            <div
              style={{
                overflow: 'auto',
                flex: '1 1 auto',
                minHeight: 0,
                padding: '0 14px 12px 14px',
                opacity: loading ? 0.45 : 1,
                transition: 'opacity 0.15s',
              }}
            >
            {layout === 'list' ? (
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 'var(--text-md)' }}>
                <colgroup>
                  <col style={{ width: '18%' }} />
                  <col />
                  <col style={{ width: '86px' }} />
                  {/* The host column is NOT dropped on a pinned page: "this runtime can load it"
                      and "this runtime owns it" are different facts (see `hostChips`). */}
                  <col style={{ width: '205px' }} />
                  {showStarColumn && <col style={{ width: '76px' }} />}
                  {showStateColumn && <col style={{ width: '76px' }} />}
                  <col style={{ width: '92px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={TH}>{t('harness.name')}</th>
                    <th style={TH}>{t('harness.description')}</th>
                    <th style={TH_CENTER}>{t('harness.source')}</th>
                    <th style={TH}>{t('harness.host')}</th>
                    {showStarColumn && <th style={TH_CENTER} title={t('harness.starsHint')}>{t('harness.stars')}</th>}
                    {showStateColumn && <th style={TH_CENTER}>{t('harness.state')}</th>}
                    <th style={TH_CENTER} />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.key}>
                      <td style={{ ...TD, fontWeight: 'var(--font-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <NameCell row={row} onOpen={(r) => openDetail(subjectFromRow(r))} disabledLabel={t('harness.pluginDisabled')} />
                      </td>
                      <td style={TD}>{descCell(row)}</td>
                      <td
                        style={{ ...TD_CENTER, color: 'var(--text-dim)' }}
                        title={row.canonicalKey ?? (row.tracked ? undefined : t('harness.localHint'))}
                      >
                        {channelLabel(row)}
                      </td>
                      <td style={TD}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {hostChips(row)}
                          {profileChips(row)}
                        </div>
                      </td>
                      {showStarColumn && <td style={TD_CENTER}>{installedStar(row)}</td>}
                      {showStateColumn && <td style={TD_CENTER}>{stateBadge(row)}</td>}
                      <td style={TD_CENTER}>
                        <div style={{ display: 'inline-flex', gap: '6px' }}>
                          {editMcpButton(row)}
                          {removeButton(row)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '12px',
                  paddingTop: '4px',
                }}
              >
                {pageRows.map((row) => (
                  <div
                    key={row.key}
                    style={{
                      border: '1px solid var(--divider)',
                      borderRadius: '8px',
                      padding: '10px 12px',
                      background: 'var(--chip-bg)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      fontSize: 'var(--text-md)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <NameCell row={row} onOpen={(r) => openDetail(subjectFromRow(r))} disabledLabel={t('harness.pluginDisabled')} />
                      <span style={{ flex: 1 }} />
                      {installedStar(row)}
                      {stateBadge(row)}
                    </div>
                    {descCell(row, true)}
                    {hostChips(row, row.hosts.length)}
                    {profileChips(row)}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, marginTop: 'auto' }}>
                      <span
                        style={{
                          fontSize: 'var(--text-sm)',
                          color: 'var(--text-dim)',
                          flex: '1 1 auto',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={row.sourceId ? row.canonicalKey ?? undefined : t('harness.localHint')}
                      >
                        <span style={{ color: 'var(--text-muted)' }}>{t('harness.detailChannel')}:</span> {channelLabel(row)}
                      </span>
                      {editMcpButton(row)}
                      {removeButton(row)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        )}
        {/* The shared pager, not a local one: summary + size selector left, page buttons right —
            the same control every other list page renders. */}
        {rows.length > 0 && (
          <div style={{ padding: '0 14px 6px', borderTop: '1px solid var(--divider)' }}>
            <Pagination
              page={safePage}
              pageSize={pageSize}
              total={rows.length}
              onChange={setPage}
              showSummary
              pageSizeOptions={[25, 50, 100]}
              onPageSizeChange={(size) => setPageSize(size)}
            />
          </div>
        )}
      </div>
      )}

      {tab === 'market' && renderMarket()}

      {tab === 'market' && (
        <HarnessSourcesDrawer
          harness={harness}
          kind={kind}
          open={sourcesOpen}
          runtimeForEntry={sourceRuntimeFor}
          onChanged={() => {
            sourcesDirtyRef.current = true;
          }}
          onClose={() => {
            setSourcesOpen(false);
            if (sourcesDirtyRef.current) {
              sourcesDirtyRef.current = false;
              // The federation list (`sources` state) must reload FIRST — a new `mp-` chip has to
              // exist before any market refetch can ask it for rows. The tick fires loadMarket
              // after that reload's re-render, with refresh=true to bypass the browse cache.
              void load().then(() => setMarketRefreshTick((t) => t + 1));
            }
          }}
        />
      )}

      {/* ── Location picker ──────────────────────────────────────────────── */}
      {picker && (
        <Dialog
          title={t('harness.removeTitle').replace('{name}', picker.row.name)}
          subtitle={t('harness.removeDesc')}
          onClose={() => setPicker(null)}
          closeLabel={t('combobox.close')}
          width={560}
          footerLeft={
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {t('harness.selectedCount').replace('{n}', String(picker.picked.size))}
            </span>
          }
          footerRight={
            <>
              <button className="btn btn-sm" onClick={() => setPicker(null)} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void removePicked()}
                disabled={busy || picker.picked.size === 0}
              >
                <Trash2 size={12} />
                <span>{t('harness.removeSelected')}</span>
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pickerCopies(picker.row).map((copy) => {
              // Only a `foreign` copy is untouchable here (another environment owns the path and the
              // plan refuses it). An out-of-scope copy is merely NOT PRESELECTED — still tickable, so
              // "remove everywhere" stays one plan.
              const disabled = copy.state === 'foreign';
              const hostLabel = copy.host === 'dsh' ? 'DSH' : hostName(copy.host);
              return (
                <label
                  key={copy.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 9px',
                    border: '1px solid var(--divider)',
                    borderRadius: 8,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={picker.picked.has(copy.path)}
                    disabled={disabled}
                    onChange={() =>
                      setPicker((prev) => {
                        if (!prev) return prev;
                        const next = new Set(prev.picked);
                        if (next.has(copy.path)) next.delete(copy.path);
                        else next.add(copy.path);
                        return { ...prev, picked: next };
                      })
                    }
                  />
                  <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-medium)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <HostIcon host={copy.host} size={14} />
                    {hostLabel}
                  </span>
                  <span style={{ ...MONO, color: 'var(--text-dim)' }}>
                    {copy.scope === 'global' ? t('harness.scopeGlobal') : t('harness.scopeProject')}
                  </span>
                  {copy.profile && (
                    <span style={{ ...MONO, color: 'var(--text-dim)' }}>{copy.profile}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {copy.state === 'dirty' && (
                    /* The ONLY place drift is spoken: removing this copy would take the edits with
                       it, so the sentence belongs beside the checkbox that decides that. */
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.stateDirty')}</span>
                  )}
                  {copy.external ? (
                    /* `path` is an identity token for a package-manager-owned copy, not a directory
                       to reveal — showing a folder icon would promise a path that does not exist. */
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                      {t('harness.extManaged').replace('{host}', hostLabel)}
                    </span>
                  ) : (
                    <span
                      data-tip={copy.path}
                      role="note"
                      aria-label={copy.path}
                      tabIndex={0}
                      style={{
                        flex: '0 0 auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: 'var(--text-dim)',
                        cursor: 'help',
                        outline: 'none',
                      }}
                    >
                      <FolderTree size={13} aria-hidden />
                    </span>
                  )}
                </label>
              );
            })}
            {/* What the removal will physically do, when the shape is known up front (a discovered
                row carries it). One line only: a runtime-store declaration adds the half the sentence
                would otherwise omit (the package survives), riding on the same line instead of a
                second paragraph of the same shape. */}
            {picker.row.removal && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                {picker.row.removal.op === 'trash-path'
                  ? t('harness.removeNoteTrash')
                  : picker.row.removal.op === 'cli-remove'
                    ? t('harness.removeNoteCli')
                    : picker.row.removal.op === 'plugin-remove'
                      ? t('harness.removeNotePluginCli')
                      : t('harness.removeNoteConfig').replace('{file}', picker.row.removal.file)}
                {picker.row.removal.op === 'drop-entry' && picker.row.origin === 'runtime-store'
                  ? ` ${t('harness.removeNoteDecl')}`
                  : null}
              </span>
            )}
          </div>
        </Dialog>
      )}

      {installTarget && (
        <Dialog
          title={
            installGate
              ? t('harness.installGateTitle')
              : t('harness.installTitle').replace('{name}', installTarget.name)
          }
          subtitle={installTarget.repo ?? installTarget.key}
          onClose={() => {
            closeInstall();
          }}
          closeLabel={t('combobox.close')}
          width={installGate ? 560 : 460}
          backdropClose={!installBusy}
          closeDisabled={installBusy}
          footerRight={
            installGate ? (
              <>
                <button className="btn btn-sm" onClick={() => setInstallGate(null)} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                {/* The only click that actually runs the echoed command. */}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void confirmInstallGate()}
                  disabled={installBusy}
                >
                  <ShieldAlert size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            ) : installSuccess ? (
              <button
                className="btn btn-sm btn-primary"
                disabled={installBusy}
                onClick={closeInstall}
              >
                {t('common.close')}
              </button>
            ) : (
              <>
                <button className="btn btn-sm" onClick={closeInstall} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void doInstall()}
                  disabled={installBusy || installTargetHosts().length === 0 || (sheetScope === 'project' && !installProjectId) || !profileSelectionValid}
                >
                  <Download size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            )
          }
        >
          {installGate ? (
            /* Gate 2/3: nothing has been written yet. The plan is shown verbatim — the exact
               third-party command (or the exact config file / container a merge would touch) — so the
               operator's "install" is an informed one. */
            <InstallGatePlan
              targets={installGate.targets}
              descKey={'harness.installGateDesc'}
            />
          ) : (
          <div className="install-sheet">
            {/* Fast-path installs run with this sheet already open (see startInstall): without a
                visible state the only busy signal would be the disabled footer button. */}
            {installBusy && (
              <div className="form-hint" role="status">
                {t('harness.installing')}
              </div>
            )}
            {installTarget?.installKind === 'plugin' &&
              singleTarget?.value === 'dsh' &&
              profileChoices.length > 0 && (
                <FormSection title={t('harness.installProfile')}>
                  {/* Every card carries its state as a second line, so the row keeps one uniform
                      height and the sheet never repeats the selection underneath it. */}
                  <div className="install-profile">
                    {profileChoices.length <= PROFILE_RADIO_MAX ? (
                      <RadioGroup
                        value={profileSelection}
                        onChange={setInstallProfile}
                        ariaLabel={t('harness.installProfile')}
                        options={[
                          ...profileChoices.map((profile): RadioGroupOption => {
                            const installed = installTarget
                              ? takenOn(installTarget, 'dsh', installScope, installProjectId, profile.name)
                              : false;
                            return {
                              value: profile.name,
                              label: profile.name,
                              ...(installed
                                ? { description: t('harness.profileInstalled') }
                                : profile.exists
                                  ? {}
                                  : { description: t('harness.profileWillInitialize') }),
                            };
                          }),
                          // The sentinel lives in BOTH branches: the radio path is the one a small DSH
                          // install gets (<= 5 profiles), and it is exactly the first-install case
                          // where an operator names a new profile instead of picking an existing one.
                          { value: CUSTOM_PROFILE, label: t('harness.profileCustom') },
                        ]}
                      />
                    ) : (
                      <Combobox
                        value={profileSelection}
                        onChange={setInstallProfile}
                        options={[
                          ...profileChoices.map((profile) => {
                            const installed = installTarget
                              ? takenOn(installTarget, 'dsh', installScope, installProjectId, profile.name)
                              : false;
                            return {
                              value: profile.name,
                              label: profile.name,
                              ...(installed
                                ? { meta: t('harness.profileInstalled') }
                                : profile.exists
                                  ? {}
                                  : { meta: t('harness.profileWillInitialize') }),
                            };
                          }),
                          {
                            value: CUSTOM_PROFILE,
                            label: t('harness.profileCustom'),
                          },
                        ]}
                      />
                    )}
                  </div>
                  {profileSelection === CUSTOM_PROFILE && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <input
                        className="input"
                        value={customProfile}
                        onChange={(e) => setCustomProfile(e.target.value)}
                        placeholder={t('harness.profileCustomPlaceholder')}
                        aria-label={t('harness.installProfile')}
                        maxLength={64}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {customProfileName && !customProfileValid && (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>
                          {t('harness.profileCustomInvalid')}
                        </span>
                      )}
                    </div>
                  )}
                </FormSection>
              )}
            {/* Install Scope selector: Global vs Project */}
            <FormSection title={t('harness.installScope')}>
              <div className="chip-row">
                <button
                  type="button"
                  className="chip"
                  aria-pressed={sheetScope === 'global'}
                  onClick={() => setInstallScope('global')}
                >
                  <Globe size={12} aria-hidden />
                  <span>{t('harness.scopeGlobal')}</span>
                </button>
                {/* Project is offered only when every target host declares a project landing for
                    this kind (ADR-0015 §D2) — a hidden chip cannot aim an install at a landing
                    the runtime has no write grammar for. */}
                {sheetProjectOk && (
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={sheetScope === 'project'}
                    onClick={() => setInstallScope('project')}
                  >
                    <FolderGit2 size={12} aria-hidden />
                    <span>{t('harness.scopeProject')}</span>
                  </button>
                )}
              </div>
              <div className="form-hint">
                {sheetScope === 'global' ? t('harness.scopeGlobalHint') : t('harness.scopeProjectHint')}
              </div>

              {sheetScope === 'project' && (
                <Field label={t('harness.targetProject')}>
                  {projects.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>{t('harness.noProjectsAvailable')}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setProjectsDialogOpen(true)}
                      >
                        {t('projects.add')}
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <div style={{ flex: 1 }}>
                        <Combobox
                          value={installProjectId ?? ''}
                          onChange={(v) => setInstallProjectId(v)}
                          options={projects.map((p) => ({ value: p.id, label: p.name, meta: p.path }))}
                          placeholder={t('harness.selectProjectPlaceholder')}
                          hideMetaInTrigger
                          panelMinWidth={280}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setProjectsDialogOpen(true)}
                        title={t('harness.manageProjects')}
                      >
                        <FolderCog size={13} />
                      </button>
                    </div>
                  )}
                </Field>
              )}
            </FormSection>

            <FormSection title={t('harness.installHost')}>
              {installMeta.installMode === 'single' ? (
                singleTarget ? (
                  <>
                    {/* One runtime is the whole target set (a plugin is code against ONE plugin
                        API), so the landing is a fixed card: a chip here would read as a toggle the
                        operator forgot to press. */}
                    <div className="install-target">
                      {singleTarget.icon}
                      <span>{singleTarget.label}</span>
                    </div>
                    {installMeta.singleHintKey && (
                      <div className="form-hint">
                        {t(installMeta.singleHintKey, { name: singleTarget.label })}
                      </div>
                    )}
                  </>
                ) : (
                  /* No harness on THIS page can take it (a skills page has no runtime axis, so there
                     is no harness to write into). Say so instead of rendering an empty chip row
                     beside a live-looking Install button. */
                  missingLanding
                )
              ) : installHostOffers.length === 0 ? (
                /* Same honesty for the multi case: nothing here has a landing of its own. */
                missingLanding
              ) : (
                /* Chips, not a combobox: the payload is written once, so a second host costs a copy
                   rather than another download (and one MCP server in several clients is the point). */
                <div className="chip-row">
                  {installHostOffers.map((o) => {
                    const on = installHosts.includes(o.value);
                    // The backend refuses a target that already holds a clean copy (`exists`); showing
                    // that here turns a failed confirm into a visible state.
                    const taken = takenOn(installTarget, o.value);
                    return (
                      <button
                        key={o.value}
                        className="chip"
                        aria-pressed={on && !taken}
                        disabled={taken}
                        title={taken ? t('harness.targetInstalled') : undefined}
                        onClick={() =>
                          setInstallHosts((prev) =>
                            prev.includes(o.value) ? prev.filter((v) => v !== o.value) : [...prev, o.value]
                          )
                        }
                      >
                        {o.icon}
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
              {installTarget && installHostOffers.some((o) => takenOn(installTarget, o.value)) && (
                <div className="install-notice" role="note">
                  <Info size={14} aria-hidden />
                  <div>
                    <strong>{t('harness.targetInstalled')}</strong>
                    <span>{t('harness.targetTakenHint')}</span>
                  </div>
                </div>
              )}
            </FormSection>
            {installSuccess && (
              <div className="form-hint" style={{ color: 'var(--accent-emerald)' }}>
                {t('harness.installDone')}: {installSuccess}
              </div>
            )}
            {installLog && (
              <details open style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                  {t('harness.installLog')}
                </summary>
                <pre
                  style={{
                    margin: '6px 0 0',
                    maxHeight: 180,
                    overflow: 'auto',
                    padding: 8,
                    borderRadius: 6,
                    background: 'var(--surface-2)',
                    color: 'var(--text-dim)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {installLog}
                </pre>
              </details>
            )}
          </div>
          )}
        </Dialog>
      )}
      {skillPick && (
        <Dialog
          title={t('harness.multiSkillsTitle')}
          subtitle={skillPick.repo}
          onClose={() => setSkillPick(null)}
          closeLabel={t('combobox.close')}
          width={460}
          footerRight={
            <>
              <button className="btn btn-sm" onClick={() => setSkillPick(null)} disabled={installBusy}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const dir = skillPick.value;
                  setSkillPick(null);
                  void doInstall(dir);
                }}
                disabled={installBusy || !skillPick.value}
              >
                <Download size={12} aria-hidden />
                <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
              {t('harness.multiSkillsHint').replace('{n}', String(skillPick.candidates.length))}
            </span>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.multiSkillsPick')}</label>
            <Combobox
              value={skillPick.value}
              onChange={(v) => setSkillPick((p) => (p ? { ...p, value: v } : p))}
              options={skillPick.candidates.map((c) => ({ value: c, label: c }))}
              placeholder={t('harness.multiSkillsPick')}
            />
          </div>
        </Dialog>
      )}
      {/* Manual MCP server (ADR-0015 §D6 "manual") and the EDIT sheet for an existing server share
          one form and one gate: nothing is written until the exact file + container (and, for an
          edit, the overwritten key) is confirmed. */}
      {mcpDraft && (
        <Dialog
          title={
            mcpGate || mcpEditGate || mcpMarketGate
              ? t('harness.mcpGateTitle')
              : mcpEdit
                ? t('harness.mcpEditTitle')
                : mcpMarket
                  ? t('harness.mcpInstallTitle')
                  : t('harness.mcpAddTitle')
          }
          subtitle={(mcpEdit ? t('harness.mcpEditSubtitle') : t('harness.mcpAddSubtitle')).replace(
            '{name}',
            hosts.find((h) => h.id === harness)?.label ?? harness
          )}
          onClose={closeMcpSheet}
          closeLabel={t('combobox.close')}
          width={mcpGate || mcpEditGate || mcpMarketGate ? 640 : 780}
          footerRight={
            mcpEditGate ? (
              <>
                <button className="btn btn-sm" onClick={() => setMcpEditGate(null)} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void confirmMcpEditGate()}
                  disabled={installBusy}
                >
                  <ShieldAlert size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.mcpEditConfirm')}</span>
                </button>
              </>
            ) : mcpGate ? (
              <>
                <button className="btn btn-sm" onClick={() => setMcpGate(null)} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void confirmMcpGate()}
                  disabled={installBusy}
                >
                  <ShieldAlert size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            ) : mcpMarketGate ? (
              <>
                <button className="btn btn-sm" onClick={() => setMcpMarketGate(null)} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void confirmMcpMarketGate()}
                  disabled={installBusy}
                >
                  <ShieldAlert size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            ) : mcpEdit ? (
              <>
                <button className="btn btn-sm" onClick={closeMcpSheet} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void submitMcpEdit(mcpDraft)}
                  disabled={installBusy || !mcpDraftLaunchReady(mcpDraft)}
                >
                  <Save size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.mcpEditSave')}</span>
                </button>
              </>
            ) : mcpMarket ? (
              <>
                <button className="btn btn-sm" onClick={closeMcpSheet} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void submitMarketMcp(mcpDraft, mcpMarket.item, mcpMarket.defaultLaunch)
                  }
                  disabled={
                    installBusy ||
                    !mcpDraftLaunchReady(mcpDraft) ||
                    (mcpSheetScope === 'project' && !installProjectId)
                  }
                >
                  <Download size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm" onClick={closeMcpSheet} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void submitManualMcp({
                      name: mcpDraft.name.trim(),
                      launch: mcpLaunchFromDraft(mcpDraft),
                    })
                  }
                  disabled={
                    installBusy ||
                    !mcpDraftReady(mcpDraft) ||
                    (mcpSheetScope === 'project' && !installProjectId)
                  }
                >
                  <Plus size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.srcMgmt.add')}</span>
                </button>
              </>
            )
          }
        >
          {mcpEditGate ? (
            <InstallGatePlan targets={mcpEditGate.targets} descKey={'harness.mcpEditGateDesc'} />
          ) : mcpGate ? (
            <InstallGatePlan targets={mcpGate.targets} descKey={'harness.mcpGateDesc'} />
          ) : mcpMarketGate ? (
            <InstallGatePlan targets={mcpMarketGate.targets} descKey={'harness.mcpGateDesc'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {!mcpEdit && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.installScope')}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="chip"
                      aria-pressed={mcpSheetScope === 'global'}
                      onClick={() => setInstallScope('global')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', padding: '4px 10px' }}
                    >
                      <Globe size={12} />
                      <span>{t('harness.scopeGlobal')}</span>
                    </button>
                    {/* Same capability gate as the market sheet: the chip appears only when the
                        pinned landing declares a project MCP landing (ADR-0015 §D2). */}
                    {mcpSheetProjectOk && (
                      <button
                        type="button"
                        className="chip"
                        aria-pressed={mcpSheetScope === 'project'}
                        onClick={() => setInstallScope('project')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', padding: '4px 10px' }}
                      >
                        <FolderGit2 size={12} />
                        <span>{t('harness.scopeProject')}</span>
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {mcpSheetScope === 'global' ? t('harness.scopeGlobalHint') : t('harness.scopeProjectHint')}
                  </span>

                  {mcpSheetScope === 'project' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.targetProject')}</label>
                      {projects.length === 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>{t('harness.noProjectsAvailable')}</span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setProjectsDialogOpen(true)}
                            style={{ fontSize: 'var(--text-xs)', padding: '2px 8px' }}
                          >
                            {t('projects.add')}
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <div style={{ flex: 1 }}>
                            <Combobox
                              value={installProjectId ?? ''}
                              onChange={(v) => setInstallProjectId(v)}
                              options={projects.map((p) => ({ value: p.id, label: p.name, meta: p.path }))}
                              placeholder={t('harness.selectProjectPlaceholder')}
                              hideMetaInTrigger
                              panelMinWidth={280}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setProjectsDialogOpen(true)}
                            title={t('harness.manageProjects')}
                          >
                            <FolderCog size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
<Field
                label={t('harness.mcpName')}
                hint={
                  mcpEdit
                    ? t('harness.mcpNameLocked')
                    : mcpMarket
                      ? undefined
                      : mcpDraft.name.trim() && mcpNameInvalid(mcpDraft.name)
                        ? t('harness.mcpNameInvalid')
                        : undefined
                }
              >
                <input
                  className="input"
                  value={mcpDraft.name}
                  autoFocus={!mcpEdit && !mcpMarket}
                  readOnly={!!mcpEdit || !!mcpMarket}
                  onChange={(e) => {
                    if (mcpEdit || mcpMarket) return;
                    setMcpDraft((d) => (d ? { ...d, name: e.target.value } : d));
                  }}
                />
              </Field>
              <Field label={t('harness.mcpTransport')} inline>
                <SegGroup
                  value={mcpDraft.transport}
                  onChange={(v) => setMcpDraft((d) => (d ? { ...d, transport: v as McpTransport } : d))}
                  size="sm"
                  options={[
                    { value: 'stdio', label: t('harness.mcpTransportStdio') },
                    { value: 'sse', label: t('harness.mcpTransportRemote') },
                  ]}
                />
              </Field>
              {mcpDraft.transport === 'stdio' && (
                <Field label={t('harness.mcpEditMode')} inline>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <SegGroup
                      value={mcpDraft.mode}
                      onChange={(v) => setMcpStdioMode(v as McpStdioMode)}
                      size="sm"
                      options={[
                        { value: 'custom', label: t('harness.mcpModeCustom') },
                        { value: 'advanced', label: t('harness.mcpModeAdvanced') },
                      ]}
                    />
                    <InfoTip text={t('harness.mcpEditModeHint')} />
                  </div>
                </Field>
              )}
              {mcpDraft.transport === 'stdio' ? (
                <>
                  {mcpDraft.mode === 'advanced' ? (
                    <>
                      <Field label={t('harness.mcpRunner')} inline>
                        <SegGroup
                          value={mcpDraft.runner}
                          onChange={(v) => setMcpDraft((d) => (d ? { ...d, runner: v as McpRunner } : d))}
                          size="sm"
                          options={MCP_RUNNERS.map((runner) => ({ value: runner, label: runner }))}
                        />
                      </Field>
                      <Field
                        label={
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {t('harness.mcpPackage')}
                            <InfoTip text={t('harness.mcpPackageHint')} />
                          </span>
                        }
                        hint={
                          mcpDraft.pkg.trim() && !mcpPkgValid(mcpDraft.runner, mcpDraft.pkg)
                            ? t('harness.mcpPackageInvalid')
                            : undefined
                        }
                      >
                        <input
                          className="input"
                          style={MONO}
                          placeholder={mcpDraft.runner === 'uvx' ? 'name==1.2.3' : '@scope/name@1.2.3'}
                          value={mcpDraft.pkg}
                          onChange={(e) => setMcpDraft((d) => (d ? { ...d, pkg: e.target.value } : d))}
                        />
                      </Field>
                      {renderMcpArgsField()}
                      {renderMcpCommandPreview()}
                    </>
                  ) : (
                    <>
                      <Field label={t('harness.mcpCommand')} hint={t('harness.mcpCommandHint')}>
                        <input
                          className="input"
                          style={MONO}
                          placeholder="npx"
                          value={mcpDraft.command}
                          onChange={(e) => setMcpDraft((d) => (d ? { ...d, command: e.target.value } : d))}
                        />
                      </Field>
                      {renderMcpArgsField()}
                      {renderMcpCommandPreview()}
                    </>
                  )}
                </>
              ) : (
                <>
                  <Field
                    label={t('harness.mcpUrl')}
                    hint={
                      mcpDraft.url.trim() && !MCP_URL_RE.test(mcpDraft.url.trim())
                        ? t('harness.mcpUrlInvalid')
                        : undefined
                    }
                  >
                    <input
                      className="input"
                      value={mcpDraft.url}
                      onChange={(e) => setMcpDraft((d) => (d ? { ...d, url: e.target.value } : d))}
                    />
                  </Field>
                  <Field label={t('harness.mcpHeaders')} hint={t('harness.mcpHeadersHint')}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {mcpDraft.headerRows.map((row) => {
                        const alreadySet = row.value === '' && mcpDraft.headerSetKeys.includes(row.name.trim());
                        return (
                          <div key={row.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              className="input"
                              style={{ ...MONO, flex: '0 1 38%', minWidth: 0 }}
                              placeholder={t('harness.mcpHeaderName')}
                              value={row.name}
                              onChange={(e) => updateMcpHeaderRow(row.id, { name: e.target.value })}
                            />
                            <input
                              className="input"
                              style={{ flex: '1 1 auto', minWidth: 0 }}
                              type={row.secret ? 'password' : 'text'}
                              autoComplete="off"
                              placeholder={
                                alreadySet
                                  ? t('harness.mcpHeaderValueSet')
                                  : (row.placeholder ?? t('harness.mcpHeaderValue'))
                              }
                              title={row.description}
                              value={row.value}
                              onChange={(e) => updateMcpHeaderRow(row.id, { value: e.target.value })}
                            />
                            {row.required && (
                              <span className="badge badge-info" style={{ flex: '0 0 auto' }}>
                                {t('harness.mcpParamRequired')}
                              </span>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ flex: '0 0 auto', padding: '4px 6px' }}
                              title={t('common.delete')}
                              aria-label={t('common.delete')}
                              onClick={() => removeMcpHeaderRow(row.id)}
                            >
                              <Trash2 size={12} aria-hidden />
                            </button>
                          </div>
                        );
                      })}
                      {mcpDraft.headerRows.length === 0 && (
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('harness.mcpHeadersEmpty')}</span>
                      )}
                      <div>
                        <button className="btn btn-sm" onClick={addMcpHeaderRow}>
                          <Plus size={12} aria-hidden />
                          <span>{t('harness.mcpHeaderAdd')}</span>
                        </button>
                      </div>
                    </div>
                  </Field>
                </>
              )}
            </div>
          )}
        </Dialog>
      )}
      {renderMcpArgsEditor()}
      {renderMcpValueEditor()}
      {renderMcpDsnBuilder()}
      {/* Artifact detail (ADR-0015 §D6) — market rows AND installed rows. A native dialog, not an
          iframe: github.com answers `X-Frame-Options: deny`, npmjs.com and pi.dev `SAMEORIGIN`, so
          embedding the source page was measured impossible. The subject is the skeleton (it is what
          was clicked); the backend read only adds the README and the package facts, and an artifact
          with nothing published (a manual MCP server) still opens. */}
      {detailSubject && (
        <Dialog
          title={detailSubject.name}
          subtitle={
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={MONO}>{detailSubject.repo ?? detailSubject.packageKey ?? detailSubject.key}</span>
              {detailFacts.length > 0 && <span>· {detailFacts.join(' · ')}</span>}
            </span>
          }
          onClose={() => setDetailSubject(null)}
          closeLabel={t('combobox.close')}
          // A reading card, not a takeover: `full` is the operator's choice (the expand button),
          // never the default — 900px fits a README's code blocks without stretching prose, and the
          // shared body scroll keeps it inside 88vh until they ask for the whole screen.
          full={detailFull}
          width={900}
          headerActions={
            <>
              {!detailReadmeLocalized && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!detail?.readme || detailTrBusy}
                  title={detailTranslateLabel}
                  onClick={() => void translateDetail(detailTranslated)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                >
                  <Globe size={12} aria-hidden />
                  <span>{detailTranslateLabel}</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setDetailFull((v) => !v)}
                title={detailFull ? t('harness.detailCollapse') : t('harness.detailExpand')}
                aria-label={detailFull ? t('harness.detailCollapse') : t('harness.detailExpand')}
                aria-pressed={detailFull}
                style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 6px' }}
              >
                {detailFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            </>
          }
          footerRight={
            <>
              {detailSubject.url && (
                <a
                  className="btn btn-sm"
                  href={detailSubject.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                >
                  <ExternalLink size={12} aria-hidden />
                  <span>{t('harness.detailOpenExternal')}</span>
                </a>
              )}
              {/* Install belongs to the MARKETPLACE view only: an installed row's own action is
                  removal, which the row already offers. Both dialogs share one z-index, so the
                  install sheet must not open BENEATH the detail dialog — the detail closes AFTER the
                  button's handler, on the bubble phase. A capture-phase close unmounts this subtree
                  mid-dispatch (React 18 flushes discrete updates synchronously) and the button's
                  own onClick never runs. */}
              {detailSubject.market && (
                <span onClick={() => setDetailSubject(null)}>
                  {marketInstallButton(detailSubject.market)}
                </span>
              )}
            </>
          }
        >
          {/* `flex: 0 0 auto` — the dialog body is a column flex container, and a `minHeight: 0`
              wrapper would let this content box COLLAPSE below its own height; the README (with
              `max-width: 100%` images whose height follows the width) then feeds back into the
              scroll height and the rail flickers. Keeping the wrapper at content height leaves the
              scrolling to the body, where it belongs. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: '0 0 auto' }}>
            {detailDesc && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)', flex: '1 1 auto' }}>
                  {detailDesc}
                </p>
                {/* The description travels the same translation path as the table cells; the README
                    below has its own long-form pass. */}
                {detailSubject.description && !detailDescEntry && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void translateText(detailSubject.key, detailSubject.description)}
                    title={t('harness.translate')}
                    aria-label={t('harness.translate')}
                    style={{ flex: '0 0 auto', height: 22, padding: '0 6px' }}
                  >
                    <Globe size={11} aria-hidden />
                  </button>
                )}
              </div>
            )}
            {detailRegistryText && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{detailRegistryText}</span>
            )}
            {detailLoading && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                <RefreshCw size={13} style={{ animation: 'ocr-spin 0.8s linear infinite' }} aria-hidden />
                {t('harness.detailLoading')}
              </span>
            )}
            {!detailLoading && detailProblem && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>
                {detailProblem.reason && BROWSE_ERROR_KEY[detailProblem.reason]
                  ? t(BROWSE_ERROR_KEY[detailProblem.reason]!, detailProblem.reasonParams)
                  : detailProblem.message}
              </span>
            )}
            {/* Translation state line: the same MT/SRC toggle the list rows carry, plus the honest
                note when the document outran the translation budget. */}
            {!detailLoading && detailTr && detailTr.src === detail?.readme && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="badge"
                  onClick={() => setDetailShowSrc((v) => !v)}
                  title={detailShowSrc ? t('harness.translated') : t('harness.showOriginal')}
                  aria-pressed={!detailShowSrc}
                  style={{
                    fontSize: 'var(--text-2xs)',
                    padding: '0 5px',
                    letterSpacing: 'var(--tracking-normal)',
                    lineHeight: 'var(--leading-15)',
                    cursor: 'pointer',
                    border: '1px solid var(--divider)',
                    background: 'transparent',
                    color: detailShowSrc ? 'var(--text-dim)' : 'var(--accent-emerald)',
                  }}
                >
                  {detailShowSrc ? t('harness.origBadge') : t('harness.mtBadge')}
                </button>
              </div>
            )}
            {!detailLoading && detailReadme && (
              <div className="md-well" style={{ fontSize: 'var(--text-md)' }}>
                {/* README surface: raw HTML is PARSED and sanitized here (see lib/readme-markdown) —
                    a plugin page written in `<div align="center">` must not render as nothing. */}
                <ReadmeMarkdown source={detailReadme} base={readmeBase} />
              </div>
            )}
            {!detailLoading && !detailReadme && !detailProblem && detailSubject.url && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('harness.detailNoReadme')}</span>
            )}
          </div>
        </Dialog>
      )}
          <ProjectsDialog
        open={projectsDialogOpen}
        onClose={() => setProjectsDialogOpen(false)}
        onProjectsChange={(updatedProjects, updatedActiveId) => {
          setProjects(updatedProjects);
          setActiveProjectId(updatedActiveId);
          if (updatedProjects.length > 0) {
            setFallbackProjectId((prev) =>
              prev && updatedProjects.some((p) => p.id === prev) ? prev : (updatedActiveId ?? updatedProjects[0].id)
            );
            setInstallProjectId((prev) =>
              prev && updatedProjects.some((p) => p.id === prev) ? prev : (updatedActiveId ?? updatedProjects[0].id)
            );
          } else {
            setFallbackProjectId(null);
            setInstallProjectId(null);
          }
          void load();
        }}
      />
    </>
  );

  // A kind without a harness axis keeps the original frame: one full-width column, no rail.
  if (!railCopy) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>{content}</div>;
  }
  // A kind with a landing puts the rail left of that same column. `onSelect` pushes only the URL:
  // the reset chain lives in the effect keyed on the resolved param, so Back/Forward replays it.
  const pickHarness = (id: string): void => {
    // A rail pick is a scope change, not a view change: the `?tab=` query rides along so the
    // operator keeps reading the list (installed or market) they were on. Clicking the row they
    // already stand on is a no-op — there is no view to reset, and a duplicate history entry would
    // only bury the picks Back is meant to replay.
    if (id === harness) return;
    navigate(`/harness/${route}/${id}${location.search}`);
  };
  return (
    <div className="harness-frame">
      <HarnessRail
        hosts={harnessOptions}
        counts={railCounts}
        activeId={harness}
        onSelect={pickHarness}
        hintKey={railCopy.hintKey}
        emptyKey={railCopy.emptyKey}
        loading={!inventory}
        hiddenCount={hiddenHostCount}
        expanded={showAllHosts}
        primaryCount={landingHosts.filter(isPrimaryHost).length}
        onToggle={() => setShowAllHosts((v) => !v)}
      />
      <div className="harness-body">{content}</div>
    </div>
  );
};
