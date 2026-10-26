import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Download, ExternalLink, FolderTree, Globe, Inbox, Info, LayoutGrid, List, Maximize2, Minimize2, RefreshCw, Search, ShieldAlert, Star, Terminal, Trash2, X } from 'lucide-react';
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
  type HarnessSourceView,
} from '../lib/api';
import { SegGroup } from '../components/SegGroup';
import { Switch } from '../components/Switch';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Dialog } from '../components/Dialog';
import { README_MD_REMARK_PLUGINS, README_MD_REHYPE_PLUGINS, README_MD_COMPONENTS } from '../lib/readme-markdown';
import ReactMarkdown from 'react-markdown';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useI18n } from '../i18n/I18nContext';
import { BrandIcon } from '../components/BrandIcons';
import { FONT_MONO } from '../lib/fonts';
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
 *   · skills     — the harness is a READER. One `.agents/skills` tree is loaded by up to nine
 *                  runtimes, so the rail selects "which runtime can use this" (`CopyView.readers`)
 *                  while WRITES stay owner-only (`KIND_META.skill.installAxis`): materializing the
 *                  same directory once per reader would be nine writes of one tree.
 *   · mcp        — an MCP server is one payload written into ONE OR MORE clients' config files, so
 *                  the page is pinned to one landing harness and the install may fan out from there.
 *   · extensions — code against ONE runtime's plugin API, so the runtime is part of the artifact's
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

type Kind = 'skill' | 'mcp' | 'extension';
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
   * `skills-owner` — the OWNER of a skills directory decides, never its readers: nine runtimes read
   * one `.agents/skills` tree, so offering every reader as a target would write the same directory
   * nine times. The rail still lists readers (that is a question about USE, not about writing).
   */
  installAxis: 'landing' | 'skills-owner';
  /** URL segment carrying the harness id: `/harness/<route>/<harness>`. */
  route: string;
  /** Console title / "installed" count noun. */
  titleKey: string;
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
    // A skill lands in a DIRECTORY, and one directory is read by up to nine runtimes. The rail asks
    // "which runtime can use this", never "who owns it" — writes stay owner-only (`installAxis`), or
    // the same tree would be materialized once per reader.
    landing: 'hasSkills',
    installAxis: 'skills-owner',
    route: 'skills',
    titleKey: 'nav.skills',
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
    installedKey: 'harness.installedMcp',
    marketKey: 'harness.marketMcp',
    installMode: 'multi',
    // The MCP landing is a config OBJECT (`mcp` inside the host's own file), and reading it is the
    // same observation the extension page does over `plugin[]`: a server the operator added by hand
    // is installed, shows up here, and is removable by dropping that member from its own file.
    discovery: true,
    rail: {
      hintKey: 'harness.mcpOnly',
      emptyKey: 'harness.mcpNoHarness',
    },
  },
  extension: {
    landing: 'hasExt',
    installAxis: 'landing',
    route: 'extensions',
    titleKey: 'nav.extensions',
    installedKey: 'harness.installedExtensions',
    marketKey: 'harness.marketExtensions',
    installMode: 'single',
    singleHintKey: 'harness.extOnly',
    // Extensions DO get a discovery scan: the runtime's own store is readable (pi's
    // `settings.json` `packages[]`, opencode's `plugin[]`). Those rows are observation of an install
    // we did not make — and they are removable all the same, because the scan hands the console the
    // inverse of the record it read (ADR-0015 §D8.10).
    discovery: true,
    emptyNoteKey: 'harness.extScopeNote',
    rail: {
      hintKey: 'harness.extOnly',
      emptyKey: 'harness.extNoHarness',
    },
  },
};

/**
 * Marketplace source copy, keyed by the backend source id.
 *
 * The registry (`GET /sources`) decides WHICH sources a page offers, what each one serves and whether
 * it is browsable — the console never re-declares a source. Only the WORDS live here: a chip, its
 * tooltip and the provenance cell must read in the console language, while the backend's own `label`
 * is English prose (`OpenCode ecosystem (curated)`). An id with no entry — a source onboarded without
 * a console string — falls back to that label instead of rendering a blank chip.
 */
const SOURCE_NAME_KEY: Record<string, string> = {
  github: 'harness.sourceNames.github',
  'skills-sh': 'harness.sourceNames.skillsSh',
  'mcp-official': 'harness.sourceNames.mcpOfficial',
  smithery: 'harness.sourceNames.smithery',
  npm: 'harness.sourceNames.npm',
  'static-opencode': 'harness.sourceNames.curated',
  'awesome-opencode': 'harness.sourceNames.awesome',
  'opencode-cafe': 'harness.sourceNames.cafe',
  'pi-dev': 'harness.sourceNames.piDev',
  clawhub: 'harness.sourceNames.clawhub',
};

/**
 * Market orderings, keyed by the sort key a source DECLARES (`sorts` on `/sources`).
 *
 * The keys are the upstream's own vocabulary (GitHub: `stars` / `forks` / `updated` / `best-match`;
 * the Pi catalog: `downloads`), so this table only supplies the words. A key with no entry renders
 * verbatim — an upstream that gains an ordering must not print an i18n key.
 */
const MARKET_SORT_KEY: Record<string, string> = {
  catalog: 'harness.marketSortCatalog',
  name: 'harness.marketSortName',
  stars: 'harness.marketSortStars',
  'best-match': 'harness.marketSortBestMatch',
  forks: 'harness.marketSortForks',
  updated: 'harness.marketSortUpdated',
  downloads: 'harness.marketSortDownloads',
  relevance: 'harness.marketSortRelevance',
  recent: 'harness.marketSortRecent',
  'help-wanted-issues': 'harness.marketSortHelpWanted',
  'all-time': 'harness.marketSortAllTime',
  trending: 'harness.marketSortTrending',
  hot: 'harness.marketSortHot',
};

/** Market context line (under the source chips), keyed by the browse adapter's `noteCode` (the
 *  backend's `note` is the fallback). `{keyword}` carries the bare npm tag an empty query defaulted
 *  to — never the `keywords:` search expression itself; `{query}` carries the plain phrase used
 *  where the runtime publishes no npm tag at all. */
const NOTE_KEY: Record<string, string> = {
  'github-anonymous': 'harness.marketNote.githubAnonymous',
  'npm-keyword': 'harness.marketNote.npmKeyword',
  'npm-default': 'harness.marketNote.npmDefault',
  curated: 'harness.marketNote.curated',
  awesome: 'harness.marketNote.awesome',
  'cafe-filtered': 'harness.marketNote.cafeFiltered',
  'pi-dev': 'harness.marketNote.piDev',
  'window-sorted': 'harness.marketNote.windowSorted',
  'mcp-registry': 'harness.marketNote.mcpRegistry',
  'skills-sh-board': 'harness.marketNote.skillsShBoard',
  'skills-sh-search': 'harness.marketNote.skillsShSearch',
  'smithery-window': 'harness.marketNote.smitheryWindow',
  'clawhub-catalog': 'harness.marketNote.clawhubCatalog',
  'clawhub-search': 'harness.marketNote.clawhubSearch',
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
 * `manual:<name>`), so its subject is derived from that — the backend then reads the same registry
 * document or repository it reads for a market row.
 */
interface DetailSubject {
  /** Stable identity: the translation cache key and the request guard. */
  key: string;
  name: string;
  description: string | null;
  /** Where "open in browser" goes, when the subject has a public page. */
  url?: string;
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
  url: item.url,
  ...(item.repo ? { repo: item.repo } : {}),
  packageKey: item.key,
  market: item,
});

/**
 * The GitHub repository a canonical key names (`github:owner/repo#dir`; the `gh:` spelling is the
 * same shape), as written in the key, or null.
 *
 * Single source for its two consumers: the detail subject (README/licence/stars) and the installed
 * row's star cell (an on-demand count). Callers lowercase when they key on it — GitHub slugs are
 * case-insensitive, the star cache is keyed lowercase.
 */
function repoOfKey(canonicalKey: string | null | undefined): string | null {
  if (!canonicalKey) return null;
  const match = /^(?:gh|github):([\w.-]+\/[\w.-]+)/.exec(canonicalKey);
  return match ? match[1]! : null;
}

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
  /** GitHub repository this row names (`github:owner/repo#dir`), as written in the key, or null.
   *  Derived from `canonicalKey` — never a second identity — and the ONLY rows whose star count can
   *  be resolved: an npm package has no repository to ask GitHub about. */
  repo: string | null;
  copies: HarnessCopyView[] | HarnessDiscoveredArtifact['copies'];
  hosts: string[];
  tracked: boolean;
  sourceId: string | null;
  /** Surfaces this row was listed on at install time, writer source first. Empty for a discovered
   *  row: the runtime's own store is not a marketplace, so it was listed on nothing. */
  listedOn: string[];
  state: string;
  /** Discovered extension rows carry the runtime record they were read from (`runtime-store` …). */
  origin?: HarnessDiscoveredArtifact['origin'];
  /** Version the runtime's own store records — rendered as `@x.y.z` beside the name. */
  version?: string;
  /** How to undo the runtime's own install record; present for a discovered extension row. */
  removal?: HarnessDiscoveredArtifact['removal'];
  artifact?: HarnessArtifactView;
}

const MONO: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: '11.5px' };

/**
 * Whether a source chip keeps a row.
 *
 * The facet is "where this came from", not "what wrote it": a Pi-catalog package installs through
 * npm, so its record carries `sourceId: 'npm'` with `listedOn: ['npm','pi-dev']` — both chips must
 * find it. The row's own source cell names the BROWSE surface — the install source this column
 * exists to answer — while the writer stays in `canonicalKey` (ADR-0015 §D8.6): the chip is a
 * discovery facet, never a claim about the artifact's identity.
 */
const sourceMatches = (row: Row, id: string): boolean =>
  id === 'all' || row.sourceId === id || row.listedOn.includes(id);

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
const NameCell: React.FC<{ row: Row; onOpen?: (row: Row) => void }> = ({ row, onOpen }) => (
  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, maxWidth: '100%', fontWeight: 600 }}>
    {onOpen ? (
      <button type="button" className="harness-detail-link" onClick={() => onOpen(row)}>
        {row.name}
      </button>
    ) : (
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
    )}
    {row.version && (
      <span style={{ ...MONO, fontWeight: 400, color: 'var(--text-dim)', flex: '0 0 auto' }}>@{row.version}</span>
    )}
  </span>
);

const TH: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontSize: '11px',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
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
  fontSize: '13px',
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
  'github-copilot': 'github-copilot',
  amp: 'amp',
  cursor: 'cursor',
  windsurf: 'windsurf',
  cline: 'cline',
  zed: 'zed',
  'gemini-cli': 'gemini-cli',
};

/** Brand mark when one is vendored, otherwise a neutral glyph at the same size. */
const HostIcon: React.FC<{ host: string; size?: number }> = ({ host, size = 11 }) => {
  const brand = HOST_BRAND[host];
  if (brand) return <BrandIcon name={brand} size={size} />;
  return <Terminal size={size} aria-hidden style={{ flexShrink: 0 }} />;
};

/** One host as a picker option. The vendor note in parentheses is dropped: the brand mark already
 *  carries the identity, and the rail/filter/install list all read better without it. */
const hostOption = (host: HarnessHostView): ComboboxOption => ({
  value: host.id,
  label: host.label.replace(/\s*\([^)]*\)\s*$/, ''),
  icon: <HostIcon host={host.id} size={12} />,
});

/**
 * Does one COPY belong to the page's harness?
 *
 * Two answers, one predicate: ownership (`copy.host`) is who the copy is recorded under — the
 * landing that was written; readership (`copy.readers`, skills only) is every runtime that loads
 * that directory. A skill materialized once in `.agents/skills` is read by nine runtimes, so asking
 * only about `host` would show it under one rail entry and hide it under the other eight.
 */
const copyServes =
  (harnessId: string) =>
  (copy: { host: string; readers?: string[] }): boolean =>
    copy.host === harnessId || (copy.readers ?? []).includes(harnessId);

/**
 * Does an artifact belong to the page's harness?
 *   · an extension is written against ONE runtime's plugin API, so the runtime is part of its
 *     IDENTITY (`artifact.harness`) — a copy list alone would miss a package that is recorded but
 *     not yet materialized;
 *   · an MCP artifact is one server that may sit in several clients' configs at once, and a skill is
 *     one directory several runtimes read, so the COPY is the landing there and `artifact.harness` is
 *     unset — reading it would hide every artifact that has copies on this page.
 */
const scopedTo = (kind: Kind, harnessId: string) => (artifact: HarnessArtifactView): boolean =>
  (kind === 'extension' && artifact.harness === harnessId) || artifact.copies.some(copyServes(harnessId));

/** The same question for a discovered row: its copies carry readership, and an extension row also
 *  names its runtime at the row level (the store it was read from). */
const rowServes = (harnessId: string) => (item: HarnessDiscoveredArtifact): boolean =>
  item.harness === harnessId || item.copies.some(copyServes(harnessId));

/**
 * The shared cross-agent skills location (`~/.agents/skills`, ADR-0015 D3 R2).
 *
 * `universal` is a HOST id, not a runtime: it owns that directory (first adapter in registry order)
 * and every `readsUniversal` runtime loads it. So on a skills page pinned to one runtime, a row whose
 * copies carry this host is NOT private to that runtime — the same row sits under all nine rail
 * entries, which is exactly why the pinned page cannot answer "what is actually mine" on its own.
 */
const SHARED_HOST = 'universal';

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
 * copies (there is no rollup to consult — the runtime's own store is the only record).
 *
 * This is the one filter worth having. Provenance is a column (the `source` cell already answers it),
 * not a browsing mode: splitting the list into "tracked" and "local" made the SAME artifact look like
 * two different kinds of thing and hid the fact that both are removable.
 */
const needsAttention = (row: Row): boolean =>
  row.tracked && row.artifact
    ? artifactNeedsAttention(row.artifact)
    : row.copies.some((c) => c.state === 'missing' || c.state === 'foreign');

/**
 * The harness rail: the page's first axis, as a vertical picker left of the content column.
 * Kind-agnostic on purpose — which hosts have an axis, what a click does and what the pick MEANS are
 * the caller's decisions (`KIND_META`), so all three kinds share one implementation.
 *
 *    ┌ HARNESS ────────┐   ← `harness.railTitle`, the same word on every page (CSS uppercases it)
 *    │ [filter…      ] │   ← only when the catalog is long enough for the input to earn its row
 *    │ ▪ opencode   3  │   ← HostIcon + label + landed count (+ health dot when not clean)
 *    │ ▪ pi         0  │   ← a zero is a reachable install entry, never hidden
 *    └ only opencode's ────┘   ← hintKey names the pick, "only {name}'s …" (emptyKey instead when nothing has one)
 */
const HarnessRail: React.FC<{
  hosts: ComboboxOption[];
  counts: Record<string, { count: number; warn: boolean }>;
  activeId: string;
  onSelect: (id: string) => void;
  hintKey: string;
  emptyKey: string;
}> = ({ hosts, counts, activeId, onSelect, hintKey, emptyKey }) => {
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
          <span className="harness-rail-hint">{t(emptyKey)}</span>
        ) : visible.length === 0 ? (
          // Filtered to nothing: say so, and keep the field usable — an empty rail with no explanation
          // reads as "this machine has no runtimes".
          <span className="harness-rail-empty">{t('harness.railNoMatch')}</span>
        ) : (
          visible.map((option) => {
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
          })
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

  /** The console-language name of a marketplace source; its backend `label` is the fallback. */
  const sourceName = (source: HarnessSourceView): string => {
    const key = SOURCE_NAME_KEY[source.id];
    return key ? t(key) : source.label;
  };
  const [inventory, setInventory] = useState<HarnessInventoryResponse | null>(null);
  const [sources, setSources] = useState<HarnessSourceView[]>([]);
  const [activeSource, setActiveSource] = useState('all');
  /**
   * Page tab, held in the URL (`?tab=market`).
   *
   * A reload must land on the view the operator was reading, and the market re-opens its own list
   * from the same address (its load effect keys on `tab`). `local` is the default and stays implicit,
   * so the ordinary address remains clean. The write REPLACES: switching a view is not a navigation
   * step, and spending a history entry here would bury the rail picks that Back is meant to replay.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'local' | 'market' = searchParams.get('tab') === 'market' ? 'market' : 'local';
  const setTab = useCallback(
    (next: 'local' | 'market'): void => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'market') params.set('tab', 'market');
          else params.delete('tab');
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  /** Landing pages are bound to ONE harness (no "all"): the target runtime is part of the landing,
   *  so the pick lives in the URL and is resolved against the host catalog below. */
  const [marketSource, setMarketSource] = useState('github');
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
  /** What `marketTotal` counts: `window` = reachable rows only, so the pager keeps the number for its
   *  page buttons but must not print it as the catalog's size (skills.sh: 600 rows of a 9 911 board). */
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
  const [detailTr, setDetailTr] = useState<{ src: string; text: string; model: string; truncated: boolean } | null>(null);
  const [detailTrBusy, setDetailTrBusy] = useState(false);
  /** Per-dialog view toggle: the translation is shown until the operator asks for the source text. */
  const [detailShowSrc, setDetailShowSrc] = useState(false);
  const [installHosts, setInstallHosts] = useState<string[]>([]);
  const [installBusy, setInstallBusy] = useState(false);
  /** Gate 3: the plan the backend refuses to execute until a human reads it. Kept separately from
   *  `installTarget` so the confirmation dialog can show the exact commands on its own surface. */
  const [installGate, setInstallGate] = useState<{ targets: HarnessInstallTarget[]; skillDir?: string } | null>(null);
  // Open when an install fails with `ambiguous`: the repo holds several SKILL.md directories and the
  // backend refuses to guess (ADR-0015 §8). Keeps the install dialog underneath (hosts/scope live
  // there); confirming re-invokes the same install with a `#dir`-pinned key.
  const [skillPick, setSkillPick] = useState<{ repo: string; candidates: string[]; value: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [picker, setPicker] = useState<{ row: Row; picked: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Translated text, keyed by row/item id. `src` pins the exact original it was produced from —
   *  re-downloading a skill whose description changed must not resurface the previous translation. */
  const [tr, setTr] = useState<Record<string, { src: string; text: string; model: string }>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [hosts, setHosts] = useState<HarnessHostView[]>([]);
  const [hostFilter, setHostFilter] = useState('');
  /** Hide the rows that live in the shared `.agents` tree — ON by default. The shared set is the SAME
   *  under every rail entry (nine runtimes read it), so leading a pinned page with it hides the one
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [inv, src, hostList] = await Promise.all([
        api.harnessInventory(),
        api.harnessSources(),
        api.harnessHosts(),
      ]);
      setInventory(inv);
      setHosts(hostList.hosts);
      setSources(src.sources.filter((s) => s.kinds.includes(kind)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    localStorage.setItem(`harness.view.${kind}`, layout);
  }, [layout, kind]);

  const trackedRows = useMemo(
    () => (inventory?.artifacts ?? []).filter((a) => a.kind === kind),
    [inventory, kind]
  );

  /** Every host the kind has an axis for — the only valid values of the page's first axis. For
   *  skills that is every runtime with a skills directory (a reader, not a landing). */
  const harnessOptions = useMemo(
    () => (landing ? hosts.filter((h) => h[landing]).map(hostOption) : []),
    [hosts, landing]
  );

  /** The harness segment the URL asks for. A kind with no axis reads as ''. */
  const requestedHarness = landing ? (params.harness ?? '') : '';
  /** Validated against the catalog: an unknown or missing id is not a harness, it is a broken URL. */
  const harness = useMemo(
    () => (harnessOptions.some((o) => o.value === requestedHarness) ? requestedHarness : ''),
    [harnessOptions, requestedHarness]
  );

  /** The exclusion earns its place only where readership creates a shared set (skills) and the page
   *  is pinned to a runtime other than that shared location itself. */
  const canHideShared = kind === 'skill' && harness !== '' && harness !== SHARED_HOST;

  // The URL is the single source of truth for a landing page's harness. Once the catalog arrives, a
  // missing or unknown segment is REPLACED (never pushed) with the first harness that HAS a landing:
  // a stale bookmark lands somewhere valid, and Back never bounces between two dead URLs. A rescan
  // re-runs this effect and leaves a valid pick untouched. The query rides along — a hand-typed
  // `?tab=market` without a segment must keep the view it names.
  useEffect(() => {
    if (!landing || harness) return;
    const first = harnessOptions[0];
    if (!first) return;
    navigate(`/harness/${route}/${first.value}${location.search}`, { replace: true });
  }, [landing, harness, harnessOptions, route, navigate, location.search]);

  // A harness CHANGE forfeits the market tab: the rail's badges count INSTALLED copies, so answering
  // a rail pick with the source catalog would hide the number the operator just clicked. A fresh
  // mount does NOT forfeit it — that is exactly what lets a reload of `?tab=market` stay on the
  // market. Keyed to the URL segment, never the RESOLVED harness: the resolved one is '' until the
  // host catalog arrives, so it would fake a change (and drop the tab) on every load. An EMPTY
  // previous segment is the URL being completed (a bookmark without a harness), not a switch.
  const harnessAxisRef = useRef(requestedHarness);
  useEffect(() => {
    if (!landing) return;
    const prev = harnessAxisRef.current;
    if (prev === requestedHarness) return;
    harnessAxisRef.current = requestedHarness;
    if (prev === '' || !searchParams.has('tab')) return;
    setTab('local');
  }, [landing, requestedHarness, searchParams, setTab]);

  /** Rail counts: artifacts landed at each harness. The count reuses `scopedTo`, so the rail can
   *  never disagree with the table it selects. A zero stays visible — a harness with nothing
   *  installed must remain a reachable install entry. */
  const scopedTrackedRows = useMemo(
    () => (harness ? trackedRows.filter(scopedTo(kind, harness)) : trackedRows),
    [trackedRows, kind, harness]
  );

  /** Discovery rows for THIS page: the scan is one channel for every kind, so both axes are
   *  filtered here — `kind` always, the harness only where the page is pinned to one. */
  const scopedDiscovered = useMemo(
    () =>
      discovery
        ? (inventory?.discovered ?? []).filter(
            (item) => item.kind === kind && (!landing || rowServes(harness)(item))
          )
        : [],
    [inventory, kind, discovery, landing, harness]
  );

  /** Rail counts: artifacts landed at each harness. The count reuses `scopedTo` for tracked rows
   *  and the same kind/harness filter for discovery, so the rail can never disagree with the table
   *  it selects. A zero stays visible — a harness with nothing installed must remain a reachable
   *  install entry. */
  const railCounts = useMemo(() => {
    const counts: Record<string, { count: number; warn: boolean }> = {};
    for (const option of harnessOptions) {
      const hits = trackedRows.filter(scopedTo(kind, option.value));
      const found = discovery
        ? (inventory?.discovered ?? []).filter(
            (item) => item.kind === kind && rowServes(option.value)(item)
          ).length
        : 0;
      // `artifactNeedsAttention` is the only health signal this page reports, so the rail's dot and
      // the row's badge can never disagree. Rose, not amber: the runtime's own tree is compromised,
      // which is a different sentence from "a file drifted".
      counts[option.value] = { count: hits.length + found, warn: hits.some(artifactNeedsAttention) };
    }
    return counts;
  }, [harnessOptions, trackedRows, kind, discovery, inventory]);

  /** Every row this page holds, before any control narrows it (the facets below derive from it). */
  const allRows: Row[] = useMemo(() => {
    const trackedView: Row[] = scopedTrackedRows.map((artifact) => ({
      key: artifact.id,
      name: artifact.name,
      canonicalKey: artifact.canonicalKey,
      repo: repoOfKey(artifact.canonicalKey),
      description: artifact.description,
      copies: artifact.copies,
      hosts: [...new Set(artifact.copies.map((c) => c.host))],
      tracked: true,
      sourceId: artifact.sourceId ?? null,
      listedOn: artifact.listedOn ?? (artifact.sourceId ? [artifact.sourceId] : []),
      state: artifact.rollup,
      artifact,
    }));
    const localView: Row[] = scopedDiscovered.map((item) => ({
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
      ...(item.removal ? { removal: item.removal } : {}),
    }));
    const all = [...trackedView, ...localView];
    return all.sort((a, b) => Number(b.tracked) - Number(a.tracked) || a.name.localeCompare(b.name));
  }, [scopedTrackedRows, scopedDiscovered]);

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

  /** The table's rows: the source chip is the LAST narrowing, and the only one that carries counts. */
  const rows: Row[] = useMemo(
    () => facetedRows.filter((row) => sourceMatches(row, activeSource)),
    [facetedRows, activeSource]
  );

  // Only harnesses that actually hold something here: a filter listing empty hosts is noise.
  const hostOptions = useMemo(() => {
    const present = new Set<string>();
    for (const artifact of scopedTrackedRows) for (const copy of artifact.copies) present.add(copy.host);
    for (const item of scopedDiscovered) for (const host of item.hosts) present.add(host);
    return hosts.filter((h) => present.has(h.id)).map(hostOption);
  }, [hosts, scopedTrackedRows, scopedDiscovered]);

  /** Kind of the install the open dialog would run. The marketplace ROW names its writer (an npm
   *  package reached from the skills page is an extension package), so the target list follows the
   *  row, not the page. */
  const installKind: Kind = installTarget?.installKind ?? kind;
  const installMeta = KIND_META[installKind];

  /**
   * Hosts the dialog may write to — and the caliber differs per kind, which is why this used to be
   * wrong for MCP: skills are LOCATIONS, not readers (nine hosts read the same project
   * `.agents/skills`), so a host with no skills root, or one that is an alias of another host's
   * directory, is not a target. MCP and extensions need their OWN verified landing — a shared skills
   * directory says nothing about having a server config to merge into or a package manager to run.
   */
  const installHostOffers = useMemo(
    () =>
      hosts
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
   * runtime owns IS installed — reporting it as "not installed" in the market while the local tab
   * lists it would describe one artifact two ways.
   */
  const installIndex = useMemo(() => {
    const index = new Map<string, { host: string; scope: string; state: string }[]>();
    const put = (key: string | null | undefined, copy: { host: string; scope: string; state: string }) => {
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
   * An extension row's key IS its canonicalKey (`npm:<name>`), and so is an MCP row's
   * (`mcp-official:<server name>` — the writer keys the server inside a host's own `mcp` container by
   * that identity), so both joins are exact. A skill's canonicalKey carries the directory inside the
   * repo (`gh:<owner>/<repo>#<dir>`), which a market row cannot know before the tarball is resolved —
   * so the repo prefix is the honest match there and the exact per-target answer waits for the
   * install sheet.
   */
  const installsFor = (item: HarnessMarketItem): { host: string; scope: string; state: string }[] => {
    if (item.installKind !== 'skill') return installIndex.get(item.key) ?? [];
    const prefix = `${item.key.replace(/^github:/, 'gh:')}#`;
    const out: { host: string; scope: string; state: string }[] = [];
    for (const [key, copies] of installIndex) if (key.startsWith(prefix)) out.push(...copies);
    return out;
  };

  /**
   * Already present at this host in the GLOBAL scope? A `missing` copy does not count — reinstalling
   * repairs it. Project copies are not considered: this build installs to global roots only
   * (ADR-0015 §D2 "Scope"), so a row that only exists inside a repo is still installable here.
   */
  const takenOn = (item: HarnessMarketItem, host: string): boolean =>
    installsFor(item).some((c) => c.host === host && c.scope === 'global' && c.state !== 'missing');

  /** Targets this market row could still be installed to, right now (current page + scope). */
  const freeTargets = (item: HarnessMarketItem): number => {
    const hosts =
      KIND_META[item.installKind].installMode === 'single'
        ? harness
          ? [harness]
          : []
        : installHostOffers.map((o) => o.value);
    return hosts.filter((host) => !takenOn(item, host)).length;
  };

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

  /** Translate the README into the console language. Long-form: the backend translates prose in
   *  chunks, keeps fenced code verbatim, and reports `truncated` when the document outran the budget
   *  (the tail then stays in the source language instead of vanishing). */
  const translateDetail = async () => {
    const body = detail?.readme;
    if (!body || detailTrBusy) return;
    const req = detailReqRef.current;
    setDetailTrBusy(true);
    try {
      const res = await api.harnessTranslate({ text: body, lang, format: 'markdown' });
      if (detailReqRef.current !== req) return; // the dialog moved on to another row
      setDetailTr({ src: body, text: res.text, model: res.model, truncated: res.truncated === true });
      setDetailShowSrc(false);
    } catch (e) {
      toast.error(`${t('harness.translateFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDetailTrBusy(false);
    }
  };

  // Re-open = re-use: a README translated on a previous visit comes back from the CACHE with no
  // model call and no extra click — the read is cache-only, exactly like the description pre-seed
  // the tables run on mount. A miss is silent; the dialog simply keeps the source text.
  useEffect(() => {
    const body = detail?.readme;
    if (!body || detailTr) return;
    const req = detailReqRef.current;
    let cancelled = false;
    void api
      .harnessTranslations({ lang, texts: [body], format: 'markdown' })
      .then(({ translations }) => {
        const hit = translations[body];
        if (cancelled || !hit || detailReqRef.current !== req) return;
        setDetailTr({ src: body, text: hit.text, model: hit.model, truncated: hit.truncated === true });
      })
      .catch(() => {
        /* a cache miss is not an error the operator needs to see */
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.readme, detailTr, lang]);

  /** Install action for one market row: stateful, disabled only when every reachable target is taken. */
  const marketInstallButton = (item: HarnessMarketItem) => {
    // A curated row whose package name could not be verified has no install handle of its own
    // (`key` stays `static-opencode:<name>`, and no adapter serves that source). Pressing install
    // could only produce `unsupported_source`, so send the operator to the source that serves it.
    if (item.installKind === 'extension' && item.sourceId === 'static-opencode' && !item.key.startsWith('npm:')) {
      return (
        <button
          className="btn btn-sm"
          title={t('harness.browseOnNpmHint')}
          onClick={() => {
            setMarketSource('npm');
            setMarketQ(item.name);
            // Jumping to npm IS the search: commit the package name so the list answers it at once.
            commitMarket(item.name);
          }}
          style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <Search size={12} aria-hidden />
          <span>{t('harness.browseOnNpm')}</span>
        </button>
      );
    }
    const free = freeTargets(item);
    const count = installsFor(item).length;
    return (
      <button
        className="btn btn-sm"
        disabled={free === 0}
        title={free === 0 ? t('harness.targetInstalled') : undefined}
        onClick={() => setInstallTarget(item)}
        style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
      >
        <Download size={12} aria-hidden />
        <span>{free === 0 ? t('harness.installDone') : t('harness.install')}</span>
        {count > 0 && free > 0 && (
          <span className="badge" style={{ fontSize: '10px', padding: '0 4px', lineHeight: '14px' }}>
            {t('harness.installedBadge').replace('{n}', String(count))}
          </span>
        )}
      </button>
    );
  };

  /** The one harness a single-target install writes to. Absent when this page pins none — a skills
   *  page has no runtime axis, so there is nowhere to write an extension package. */
  const singleTarget = installHostOffers.find((o) => o.value === harness);
  /** Shown in place of the target chips when nothing here can take the install. Null for skills: a
   *  skill's landing list is its owned locations, which the chips already enumerate honestly. */
  const missingLanding = installMeta.rail ? (
    <span style={{ fontSize: '11.5px', color: 'var(--accent-rose)' }}>{t(installMeta.rail.emptyKey)}</span>
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
   * those harnesses (an extension source is bound to the runtime whose plugin API its packages
   * target). A source without `hosts` is offered everywhere and the harness is named at install —
   * which is why the MCP registries stay a cross-harness discovery surface.
   */
  const sourcesForHarness = (k: Kind, harnessId: string): HarnessSourceView[] =>
    sources.filter((s) => s.kinds.includes(k) && (!s.hosts || !harnessId || s.hosts.includes(harnessId)));

  const pageSources = useMemo(() => sourcesForHarness(kind, harness), [sources, kind, harness]);

  /**
   * Which sources the local tab offers: only the ones with something installed on THIS page.
   *
   * The predicate is deliberately UNFACETTED (`allRows`, i.e. kind + harness scope only): a chip for a
   * source that never produced a record here can only ever show an empty list, but a chip whose count
   * the current search happens to have narrowed to 0 must stay — hiding it there would make the whole
   * row vanish while the operator types, and take the `all` reset with it.
   */
  const sourceInstalled = useMemo(() => {
    const seen = new Set<string>();
    for (const row of allRows) {
      if (row.sourceId) seen.add(row.sourceId);
      for (const id of row.listedOn) seen.add(id);
    }
    return seen;
  }, [allRows]);

  /** Page sources that actually landed something here — the chips the local tab renders. */
  const installedSources = useMemo(
    () => pageSources.filter((source) => sourceInstalled.has(source.id)),
    [pageSources, sourceInstalled]
  );

  /**
   * Chip counts for the local tab.
   *
   * Each count is the size of the list that chip would show, derived from `facetedRows` — the rows
   * the OTHER controls keep — so a number can never disagree with the table it selects. `all` counts
   * that same list, so the row of numbers adds up in the only sense that matters: no chip is above
   * the total. (A row listed on two sources is deliberately counted in both: each chip answers its
   * own question, and one installed package genuinely came from two places.)
   */
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { all: facetedRows.length };
    for (const source of installedSources) {
      counts[source.id] = facetedRows.filter((row) => sourceMatches(row, source.id)).length;
    }
    return counts;
  }, [facetedRows, installedSources]);

  /** The source the market would actually browse: offered for this axis, enabled AND browsable. */
  const marketSourceView = pageSources.find((s) => s.id === marketSource);
  const canBrowse = !!marketSourceView && marketSourceView.enabled && marketSourceView.browsable === true;
  /** The official orderings the active source declares (empty = it has only its own order). */
  const activeSorts = marketSourceView?.sorts ?? [];

  // A different source is a different set of orders: keeping `stars` while switching to a catalog that
  // has none would send a key the source never declared (and the backend would silently drop it), so
  // the pick resets to that source's own default.
  const marketSortSourceRef = useRef<string | null>(null);
  useEffect(() => {
    if (marketSortSourceRef.current === marketSource) return;
    marketSortSourceRef.current = marketSource;
    setMarketSort(activeSorts[0] ?? '');
    // `activeSorts` is derived from the same source, so the source id is the only trigger needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketSource]);

  // The market opens on the first source that can actually browse THIS axis. Re-pick only when the
  // axis changes: a rescan re-reads the registry and must not overwrite the operator's chosen source.
  /** One expression for "the source this axis would open on", shared by the harness-switch reset and
   *  the late-registry pick so the two can never disagree. */
  const defaultMarketSource = (harnessId: string): string =>
    sourcesForHarness(kind, harnessId).find((s) => s.enabled && s.browsable)?.id ?? '';
  const marketAxis = `${kind}|${harness}`;
  const marketAxisRef = useRef<string | null>(null);
  useEffect(() => {
    if (marketAxisRef.current === marketAxis) return;
    // Registry + host catalog arrive asynchronously; pinning a default before them would lock the
    // market to "no source" for the rest of the visit.
    if (sources.length === 0) return;
    if (landing && !harness) return;
    marketAxisRef.current = marketAxis;
    setMarketSource(defaultMarketSource(harness));
  }, [marketAxis, pageSources, sources.length, landing, harness]);

  // A harness switch invalidates every downstream pick: the install target list belongs to the
  // previous runtime's picker, page 4 of the old list is meaningless, and the market source may not
  // serve the new runtime at all. Driven by the resolved param — never by the click — so a Back or
  // Forward across two harnesses replays exactly the same reset as picking one in the rail.
  //
  // The TAB is not reset here: it lives in the URL, so a true harness change drops it by arriving
  // without `?tab=` (rail pick) or through the axis effect above (Back/Forward), while a plain
  // reload keeps it. Resetting here would re-run on the mount that resolves the segment.
  useEffect(() => {
    if (!landing) return;
    setPage(1);
    setMarketSource(defaultMarketSource(harness));
    // The page's harness is the default landing: an MCP server goes into THIS client's config and the
    // multi-select fans out from there. A single-target kind reads the harness directly (the dialog
    // renders it as one fixed chip), so it has no list to seed.
    setInstallHosts(installMode === 'multi' && harness ? [harness] : []);
  }, [landing, installMode, kind, harness]);

  // A source that no longer has a chip here — narrowed away by the new harness, or emptied by an
  // uninstall — must not keep filtering the list invisibly.
  useEffect(() => {
    if (activeSource === 'all') return;
    if (installedSources.some((s) => s.id === activeSource)) return;
    setActiveSource('all');
  }, [installedSources, activeSource]);

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
  }, [q, filter, activeSource, hostFilter, hideShared, kind, harness, pageSize]);

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
  // local tab, before the skill was uninstalled) shows in the target language straight away.
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
    // No browsable source on this axis: sending nothing is the honest answer. An empty list would
    // read as "nothing exists", which is a different (and false) claim — the view states the reason.
    // The id bump retires any in-flight response: the empty state must not be painted over by rows
    // that belong to a question the operator can no longer ask.
    if (!canBrowse) {
      marketReqRef.current += 1;
      setMarketItems([]);
      setMarketNote(null);
      setMarketError(null);
      setMarketHasMore(false);
      setMarketTotal(null);
      setMarketLoading(false);
      return;
    }
    // A response is rendered only while it still owns the table: the next commit fires a newer
    // request, and a slow earlier one must neither paint its rows under the new query nor clear the
    // newer spinner.
    const seq = ++marketReqRef.current;
    setMarketLoading(true);
    setMarketError(null);
    try {
      const res = await api.harnessBrowse({
        source: marketSource,
        q: query,
        // The axis this page renders: a source serving several axes (npm) picks its default query
        // and stamps row install kinds from it.
        kind,
        // One page is one screenful. A catalog no longer needs its own bigger cap: the page it does
        // not fit on is reachable with "next" instead of being hidden.
        limit: MARKET_PAGE_SIZE,
        ...(harness ? { harness } : {}),
        page,
        // Only a key the source declared travels: `''` lets the source answer in its own order.
        ...(marketSort ? { sort: marketSort } : {}),
        // A refresh means "ask again": the backend drops this source's 60 s window first, so the
        // rows that come back were read now instead of minutes ago.
        ...(refresh ? { refresh: true } : {}),
      });
      if (seq !== marketReqRef.current) return;
      // A page past the end (a stale next, or a query that narrowed the list) steps back one page
      // instead of rendering an empty table that pretends the market has nothing.
      if (page > 1 && res.items.length === 0) {
        setMarketPage(page - 1);
        return;
      }
      setMarketItems(res.items);
      setMarketHasMore(res.hasMore);
      setMarketTotal(res.total ?? null);
      setMarketTotalScope(res.totalScope ?? 'catalog');
      setMarketNote(
        res.note || res.noteCode
          ? {
              ...(res.note ? { text: res.note } : {}),
              ...(res.noteCode ? { code: res.noteCode } : {}),
              ...(res.noteParams ? { params: res.noteParams } : {}),
            }
          : null
      );
    } catch (e) {
      if (seq !== marketReqRef.current) return;
      setMarketItems([]);
      setMarketHasMore(false);
      setMarketTotal(null);
      // The note describes a list that is no longer on screen — keeping the previous source's
      // sentence over an error panel would explain the wrong thing.
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
        style={{ height: 22, minWidth: 22, padding: 0 }}
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
  const marketQueryAxis = `${marketSource}|${marketSubmittedQ}|${harness}|${kind}|${marketSort}`;
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

  /** Commit a query: it becomes the axis, and the effect above owns the single request for it.
   *  Committing the text already submitted is not a new axis — a repeated Enter costs nothing. */
  const commitMarket = (query: string) => {
    setMarketSubmittedQ(query.trim());
  };

  /** Hosts this install writes to. A single-target kind (an extension is code against ONE runtime's
   *  plugin API) reads the page's harness; a multi-target kind takes the ticked list — one skill
   *  directory, or one MCP server written into several clients' configs. */
  const installTargetHosts = (): string[] => {
    if (!installTarget) return [];
    const raw = KIND_META[installTarget.installKind].installMode === 'single' ? (harness ? [harness] : []) : installHosts;
    // A taken target is not offered: the writer would only answer `exists` after a full confirm.
    return raw.filter((host) => !takenOn(installTarget, host));
  };

  /**
   * Install the picked market row. `confirmed` is the gate acknowledgement: without it the backend
   * plans and refuses, and the caller surfaces that plan.
   */
  const doInstall = async (skillDir?: string, confirmed = false) => {
    const hosts = installTargetHosts();
    if (!installTarget || hosts.length === 0) return;
    setInstallBusy(true);
    try {
      const res = await api.harnessInstall({
        // The key is the portable install handle (`github:<owner/repo>` / `npm:<name>`); `kind` picks
        // the writer. A skill directory pins the ambiguous case as `<key>#<dir>`.
        key: skillDir ? `${installTarget.key}#${skillDir}` : installTarget.key,
        kind: installTarget.installKind,
        hosts,
        // Global only: project-level install is deferred, and the backend refuses anything else
        // (ADR-0015 §D2 "Scope").
        scope: 'global',
        // The market row's own source is a discovery facet, not the writer: a Pi-catalog package
        // carries an `npm:` key, so without this the record would claim npm was the only place the
        // operator saw it.
        listedOn: [installTarget.sourceId],
        ...(confirmed ? { confirm: true } : {}),
      });
      toast.success(`${t('harness.installDone')}: ${res.name} → ${res.copies.map((c) => c.host).join(', ')}`);
      // A partial install is a success plus a refusal. Swallowing the refusal would let the operator
      // believe every selected host received the skill.
      if (res.skipped.length > 0) {
        toast.error(`${t('harness.installPartial')}: ${res.skipped.map((s) => `${s.host} (${s.code})`).join(', ')}`);
      }
      setInstallTarget(null);
      setInstallGate(null);
      setSkillPick(null);
      setTab('local');
      await load();
    } catch (e) {
      const err = e as Error & { code?: string; candidates?: string[]; plan?: HarnessInstallTarget[] };
      // Gate 3 (extension) / gate 2 (mcp): nothing was written and the backend handed back the exact
      // plan. The operator reads it and re-sends with `confirm` — that is the whole gate.
      if (err.code === 'confirm_required' && Array.isArray(err.plan) && err.plan.length > 0) {
        setInstallGate({ targets: err.plan, ...(skillDir ? { skillDir } : {}) });
        return;
      }
      if (err.code === 'ambiguous' && Array.isArray(err.candidates) && err.candidates.length > 0) {
        setSkillPick({
          repo: installTarget.repo ?? installTarget.key,
          candidates: err.candidates,
          value: err.candidates[0] ?? '',
        });
        return;
      }
      toast.error(t('harness.installFailed') + ': ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setInstallBusy(false);
    }
  };

  /** Gate acknowledgement: re-send the SAME request with `confirm: true`. */
  const confirmInstallGate = async () => {
    if (!installGate) return;
    const { skillDir } = installGate;
    setInstallGate(null);
    await doInstall(skillDir, true);
  };

  const renderMarket = () => (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
        <div className="card-title">
          <span>{t(meta.marketKey)}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
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
        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.sources')}</span>
        {pageSources.map((source) => {
          const selectable = source.enabled && source.browsable === true;
          return (
            <button
              key={source.id}
              className="chip"
              aria-pressed={marketSource === source.id}
              onClick={() => {
                setMarketSource(source.id);
                // The chip is a view switch that re-asks the field's question in another catalog:
                // committing the field keeps the shown list and the visible text in agreement.
                commitMarket(marketQ);
              }}
              disabled={!selectable}
              title={source.unavailableReason ?? (source.browsable ? sourceName(source) : t('harness.sourceUnbrowsable'))}
              style={selectable ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
            >
              {sourceName(source)}
              {!selectable && <ShieldAlert size={10} style={{ marginLeft: 4, verticalAlign: 'middle' }} />}
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
                fontSize: 12,
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
                fontSize: 11,
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
            fontSize: '11px',
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
            fontSize: '13px',
            padding: '28px',
            textAlign: 'center',
          }}
        >
          <ShieldAlert size={20} />
          <span>{t('harness.noBrowsableSource')}</span>
        </div>
      ) : marketError ? (
        <div style={{ padding: '16px', color: 'var(--accent-rose)', fontSize: '13px' }}>
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
            fontSize: '13px',
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
                  fontSize: 12,
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
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '13px' }}>
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
                    <td style={{ ...TD, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                  fontSize: '13px',
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
                      fontSize: '11px',
                      color: 'var(--text-dim)',
                      flex: '1 1 auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.repo ?? item.key}
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
            // A `window` total is NOT the catalog's size: skills.sh ranks 9 911 skills but ships 600,
            // so printing "1-24 / 569" invited "the catalog has 569". The number stays for the page
            // buttons, the summary hides, and the note states the source's own figures instead.
            showSummary={marketTotalScope !== 'window'}
            // A source without a total still knows ONE exact number on its last page (no successor =
            // the end), so "at least" is only honest while a successor exists.
            totalAtLeast={marketTotal === null && marketHasMore}
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
    if (tab === 'local') return `harness://${scope}inventory`;
    const market = marketSource ? `${marketSource}:search` : 'search';
    return scope ? `harness://${scope}${market}` : market;
  };

  /**
   * Does a copy belong to THIS page?
   *
   * `copyServes` is the same predicate the rail counts with, so the removal dialog can never disagree
   * with the list that opened it: on a skills page it answers by READERSHIP (the shared
   * `.agents/skills` tree is one copy owned by `universal` and read by nine runtimes, so it belongs to
   * every rail entry that reads it), on MCP/extension pages by the copy's own host. No harness on the
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
        items: [
          {
            artifactId: picker.row.artifact?.id ?? null,
            copies: picked.map((c) => ({ scope: c.scope, host: c.host, path: c.path })),
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
                  lineHeight: 1.45,
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
              fontSize: '9.5px',
              padding: '0 5px',
              letterSpacing: 0,
              lineHeight: '15px',
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
   *  discovered extension (it has no source — the runtime's own store is not a marketplace), the
   *  plain "local" for a skill directory. Raw ids never reach the UI: a cell is copy, not a slug.
   *
   *  A tracked row answers "where did I INSTALL this from" — the BROWSE surface, not the writer that
   *  served the bytes. A Pi-catalog package carries `sourceId:'npm'` + `listedOn:['npm','pi-dev']`;
   *  the operator picked it on pi.dev, so the cell says pi.dev. The writer is not lost: it stays in
   *  the record and in `canonicalKey` (`npm:<pkg>`, the cell's tooltip), and the chips still narrow
   *  by both — only this column's question is answered literally (ADR-0015 §D8.6). */
  const sourceLabel = (row: Row): string => {
    if (!row.tracked) {
      if (row.origin === 'runtime-store') return t('harness.originRuntimeStore');
      if (row.origin === 'config-array') return t('harness.originConfigEntry');
      if (row.origin === 'local-file') return t('harness.originLocalFile');
      return t('harness.local');
    }
    if (!row.sourceId) return t('harness.local');
    const label = (id: string): string | undefined => {
      const found = sources.find((candidate) => candidate.id === id);
      return found ? sourceName(found) : undefined;
    };
    // Browse surface first: `listedOn` is writer-first, deduped and route-validated, so the first
    // OTHER id is where the row was installed from. An id the registry cannot label is skipped,
    // never printed raw, and the writer answers when no browse surface was recorded.
    const browsed = row.listedOn.find((id) => id !== row.sourceId);
    const fromBrowse = browsed ? label(browsed) : undefined;
    return fromBrowse ?? label(row.sourceId) ?? t('harness.sourceOther');
  };

  /**
   * One word per row, not five.
   *
   * The column answers a yes/no question ("does this row need a look?"), and the answer comes from
   * `needsAttention` — the same predicate the rail's health dot uses. `clean` renders nothing
   * (silence is the normal state), and every answer that is not "no" prints the same word.
   *
   * `dirty` is NOT one of those answers: a config file rewritten by its own runtime, or shared with
   * another tool, is ordinary drift, not a defect. The CAUSE of a real issue (absent / another
   * environment's claim / shadowed) is the badge's tooltip; drift is named per copy in the removal
   * picker, which is the only place it changes what happens.
   */
  const stateBadge = (row: Row) => {
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

  /** The catalog's word for a host (`Universal`, `OpenCode`); the raw id is only the fallback. The
   *  rail and this chip name the same host, so they must not spell it two ways. */
  const hostName = (id: string): string => {
    const found = hosts.find((candidate) => candidate.id === id);
    return found ? found.label.replace(/\s*\([^)]*\)\s*$/, '') : id;
  };

  /**
   * WHICH harness a row is installed FOR — rendered on the row itself, in BOTH layouts.
   *
   * Readership is what makes this mandatory rather than decorative. A skills page is pinned to one
   * runtime but shows every row that runtime can LOAD, and two such rows can live in different
   * places: one in the shared `.agents/skills` tree (`Universal` — nine runtimes load it, so removing
   * it touches all nine) and one in that runtime's own directory (`OpenCode` — private to it). With
   * no tag, a pinned page reads as if every row were scoped to the pinned harness, which is exactly
   * the claim it must not make. The chip's tooltip is the copy's real path, so "which directory am I
   * about to remove" never needs a second click.
   */
  const hostChips = (row: Row, limit: number = HOSTS_PREVIEW) => (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {row.hosts.slice(0, limit).map((host) => {
        const paths = row.copies.filter((copy) => copy.host === host).map((copy) => copy.path);
        return (
          <span
            key={host}
            className="chip"
            title={paths.join('\n') || undefined}
            style={{ fontSize: '10.5px', padding: '1px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <HostIcon host={host} />
            {hostName(host)}
          </span>
        );
      })}
      {row.hosts.length > limit && (
        <span className="chip" style={{ fontSize: '10.5px', padding: '1px 7px' }}>+{row.hosts.length - limit}</span>
      )}
    </div>
  );

  const removeButton = (row: Row) => {
    const allForeign = row.copies.length > 0 && row.copies.every((c) => c.state === 'foreign');
    // A row whose shape the scan could not describe has nothing to plan against: refuse the click
    // instead of letting it fail after the round-trip. Config-backed kinds only — a skill's removal
    // is planned from its copies, so it needs no descriptor.
    const unknownShape = (kind === 'extension' || kind === 'mcp') && !row.tracked && !row.removal;
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
   *  extensions"): one shared skills label read as a lie on a landing page, where the list holds
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
  /** One-line description, translated when the shared cache already has it (same rule as `descCell`). */
  const detailDescEntry = detailSubject ? tr[detailSubject.key] : undefined;
  const detailDesc = detailSubject?.description
    ? detailDescEntry && detailDescEntry.src === detailSubject.description && !showOriginal[detailSubject.key]
      ? detailDescEntry.text
      : detailSubject.description
    : null;

  /** Everything inside the frame is identical for every kind — the rail only changes the frame
   *  around it, so skills/MCP cannot drift from the extension page. */
  const content = (
    <>
      {/* Page-level tabs: the two views share one artifact set, so they are two views of one page
          rather than two screens. Sits outside the cards so no card scroll takes it away. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
        <SegGroup
          value={tab}
          onChange={(v) => setTab(v as 'local' | 'market')}
          size="lg"
          options={[
            // Tab pairs with the market label per kind: "本机技能 | 技能市场". Reuses the
            // installed noun so the local/本机 wording stays single-sourced.
            { value: 'local', label: t(meta.installedKey) },
            { value: 'market', label: t(meta.marketKey) },
          ]}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>{breadcrumb()}</span>
      </div>

      {/* ── Header: scope totals + rescan (local inventory only) ─────────── */}
      {tab === 'local' && (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto' }}>
        <div className="card-header">
          <div className="card-title">
            <Boxes size={18} color="var(--accent)" />
            <span>{t(meta.titleKey)}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {inventory ? `${installedNoun} ${total}` : t('harness.subtitle')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
          </div>
        </div>
      </div>
      )}

      {/* ── One list: tracked + local ────────────────────────────────────── */}
      {tab === 'local' && (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
        {/* Wrap instead of squeezing: on a narrow window the action group drops to its own line
            rather than crushing the title. */}
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
          <div className="card-title">
            <span>{installedNoun}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>{rows.length}</span>
          </div>
          {/* Actions stay on the title line and never shrink: a squeezed flex item wraps its
              label one character per line, which is how this toolbar broke before. */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: '0 0 auto' }}>
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
        {/* Source sub-tabs — the same helper the market tab uses, so switching between the two views
            never changes which sources EXIST. Here only the sources that landed something are
            rendered: a facet with nothing behind it can only ever empty the table, and the market tab
            is where the full registry (including a source that cannot serve) stays visible. */}
        {installedSources.length > 0 && (
          <div className="chip-row" style={{ alignItems: 'center', padding: '0 14px 10px 14px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.sources')}</span>
            {/* Each chip carries the number of rows it would show right now, computed with the other
                controls applied — the label and the table can never disagree. */}
            <button
              className="chip"
              aria-pressed={activeSource === 'all'}
              aria-label={t('harness.sourceCountAria', { name: t('harness.filterAll'), count: sourceCounts.all ?? 0 })}
              onClick={() => setActiveSource('all')}
            >
              {t('harness.filterAll')}
              <span className="chip-count" aria-hidden>
                {sourceCounts.all ?? 0}
              </span>
            </button>
            {installedSources.map((source) => (
              <button
                key={source.id}
                className="chip"
                aria-pressed={activeSource === source.id}
                aria-label={t('harness.sourceCountAria', {
                  name: sourceName(source),
                  count: sourceCounts[source.id] ?? 0,
                })}
                onClick={() => setActiveSource(source.id)}
                disabled={!source.enabled}
                title={source.unavailableReason ?? sourceName(source)}
                style={source.enabled ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
              >
                {sourceName(source)}
                <span className="chip-count" aria-hidden>
                  {sourceCounts[source.id] ?? 0}
                </span>
                {!source.enabled && <ShieldAlert size={10} style={{ marginLeft: 4, verticalAlign: 'middle' }} />}
              </button>
            ))}
          </div>
        )}
        {/* Filters get their own row: host and query both narrow the same list, so they share a line
            and the search field takes all the width the card can spare. The host picker is absent on a
            landing page — one harness there, nothing to narrow. */}
        <div className="chip-row" style={{ alignItems: 'center', padding: '0 14px 10px 14px', gap: '8px' }}>
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
              by default. Absent where it would mean nothing: not on MCP/extension pages (no shared
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
                fontSize: '12px',
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
          <div style={{ padding: '16px', color: 'var(--accent-rose)', fontSize: '13px' }}>{error}</div>
        ) : rows.length === 0 && !loading && inventory ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              color: 'var(--text-dim)',
              fontSize: '13px',
              padding: '28px',
            }}
          >
            <Inbox size={20} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '560px' }}>
              <span>{total === 0 ? t('harness.empty') : t('harness.noMatch')}</span>
              {/* The one place that must say what "0" means for a kind with no discovery scan: an
                  empty list is "this gateway installed nothing", never "this machine has none". */}
              {total === 0 && emptyNoteKey && (
                <span style={{ fontSize: '11px', lineHeight: 1.5 }}>{t(emptyNoteKey)}</span>
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
                    fontSize: 12,
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
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '13px' }}>
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
                      <td style={{ ...TD, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <NameCell row={row} onOpen={(r) => openDetail(subjectFromRow(r))} />
                      </td>
                      <td style={TD}>{descCell(row)}</td>
                      <td
                        style={{ ...TD_CENTER, color: 'var(--text-dim)' }}
                        title={row.canonicalKey ?? (row.tracked ? undefined : t('harness.localHint'))}
                      >
                        {sourceLabel(row)}
                      </td>
                      <td style={TD}>{hostChips(row)}</td>
                      {showStarColumn && <td style={TD_CENTER}>{installedStar(row)}</td>}
                      {showStateColumn && <td style={TD_CENTER}>{stateBadge(row)}</td>}
                      <td style={TD_CENTER}>{removeButton(row)}</td>
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
                      fontSize: '13px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <NameCell row={row} onOpen={(r) => openDetail(subjectFromRow(r))} />
                      <span style={{ flex: 1 }} />
                      {installedStar(row)}
                      {stateBadge(row)}
                    </div>
                    {descCell(row, true)}
                    {hostChips(row, row.hosts.length)}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, marginTop: 'auto' }}>
                      <span
                        style={{
                          fontSize: '11.5px',
                          color: 'var(--text-dim)',
                          flex: '1 1 auto',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={row.sourceId ? row.canonicalKey ?? undefined : t('harness.localHint')}
                      >
                        {sourceLabel(row)}
                      </span>
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

      {/* ── Location picker ──────────────────────────────────────────────── */}
      {picker && (
        <Dialog
          title={t('harness.removeTitle').replace('{name}', picker.row.name)}
          subtitle={t('harness.removeDesc')}
          onClose={() => setPicker(null)}
          closeLabel={t('combobox.close')}
          width={560}
          footerLeft={
            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
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
                  <span style={{ fontSize: '12.5px', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <HostIcon host={copy.host} size={12} />
                    {copy.host}
                  </span>
                  <span style={{ ...MONO, color: 'var(--text-dim)' }}>{copy.scope}</span>
                  <span style={{ flex: 1 }} />
                  {copy.state === 'dirty' && (
                    /* The ONLY place drift is spoken: removing this copy would take the edits with
                       it, so the sentence belongs beside the checkbox that decides that. */
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.stateDirty')}</span>
                  )}
                  {copy.external ? (
                    /* `path` is an identity token for a package-manager-owned copy, not a directory
                       to reveal — showing a folder icon would promise a path that does not exist. */
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.extManaged')}</span>
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
                row carries it). Everything else is spelled out by the dialog subtitle: a path goes to
                the trash, a config member leaves its own file. */}
            {picker.row.removal && (
              <span style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                {picker.row.removal.op === 'trash-path'
                  ? t('harness.removeNoteTrash')
                  : t('harness.removeNoteConfig').replace('{file}', picker.row.removal.file)}
              </span>
            )}
            {picker.row.removal?.op === 'drop-entry' && picker.row.origin === 'runtime-store' && (
              <span style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                {t('harness.removeNoteDecl').replace('{file}', picker.row.removal.file)}
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
            setInstallTarget(null);
            setInstallGate(null);
          }}
          closeLabel={t('combobox.close')}
          width={installGate ? 560 : 460}
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
            ) : (
              <>
                <button className="btn btn-sm" onClick={() => setInstallTarget(null)} disabled={installBusy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void doInstall()}
                  disabled={installBusy || installTargetHosts().length === 0}
                >
                  <Download size={12} aria-hidden />
                  <span>{installBusy ? t('harness.installing') : t('harness.install')}</span>
                </button>
              </>
            )
          }
        >
          {installGate ? (
            /* Gate 3: nothing has been written yet. The plan is shown verbatim — the exact
               third-party command (or the exact config file / container a merge would touch) — so the
               operator's "install" is an informed one. */
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
                <span style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  {t('harness.installGateDesc')}
                </span>
              </div>
              {installGate.targets.map((target, index) => (
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '12.5px', fontWeight: 600 }}>
                    <HostIcon host={target.host} size={12} />
                    {target.host}
                  </span>
                  {target.refused ? (
                    <span style={{ fontSize: '11.5px', color: 'var(--accent-rose)' }}>{target.refused}</span>
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
                </div>
              ))}
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.installHost')}</label>
            {installMeta.installMode === 'single' ? (
              /* One runtime is the whole target set (an extension is code against ONE plugin API), so
                 the harness is rendered as a fixed chip rather than a choice the backend refuses. */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {singleTarget ? (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <span
                        className="chip"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '11.5px', padding: '3px 9px' }}
                      >
                        {singleTarget.icon}
                        {singleTarget.label}
                      </span>
                    </div>
                    {installMeta.singleHintKey && (
                      <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                        {t(installMeta.singleHintKey, { name: singleTarget.label })}
                      </span>
                    )}
                    {installTarget && takenOn(installTarget, singleTarget.value) && (
                      <span style={{ fontSize: '11px', color: 'var(--accent-rose)' }}>{t('harness.targetInstalled')}</span>
                    )}
                  </>
                ) : (
                  /* No harness on THIS page can take it (a skills page has no runtime axis, so there
                     is no harness to write into). Say so instead of rendering an empty chip row
                     beside a live-looking Install button. */
                  missingLanding
                )}
              </div>
            ) : installHostOffers.length === 0 ? (
              /* Same honesty for the multi case: nothing here has a landing of its own. */
              missingLanding
            ) : (
              /* Chips, not a combobox: the payload is written once, so a second host costs a copy
                 rather than another download (and one MCP server in several clients is the point). */
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: '11.5px',
                        padding: '3px 9px',
                        ...(taken ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                      }}
                    >
                      {o.icon}
                      {o.label}
                    </button>
                  );
                })}
              </div>
            )}
            {installTarget &&
              installHostOffers.some((o) => takenOn(installTarget, o.value)) && (
                <span style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  {t('harness.targetTakenHint')}
                </span>
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
            <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
              {t('harness.multiSkillsHint').replace('{n}', String(skillPick.candidates.length))}
            </span>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('harness.multiSkillsPick')}</label>
            <Combobox
              value={skillPick.value}
              onChange={(v) => setSkillPick((p) => (p ? { ...p, value: v } : p))}
              options={skillPick.candidates.map((c) => ({ value: c, label: c }))}
              placeholder={t('harness.multiSkillsPick')}
            />
          </div>
        </Dialog>
      )}
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
              <button
                type="button"
                className="btn btn-sm"
                disabled={!detail?.readme || detailTrBusy}
                title={detailTrBusy ? t('harness.detailTranslating') : t('harness.detailTranslate')}
                onClick={() => void translateDetail()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <Globe size={12} aria-hidden />
                <span>{detailTrBusy ? t('harness.detailTranslating') : t('harness.detailTranslate')}</span>
              </button>
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
                  install sheet must not open BENEATH the detail dialog — close it first, then let
                  the button's own handler run (a disabled button dispatches no click at all). */}
              {detailSubject.market && (
                <span onClickCapture={() => setDetailSubject(null)}>
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
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6, flex: '1 1 auto' }}>
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
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{detailRegistryText}</span>
            )}
            {detailLoading && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)' }}>
                <RefreshCw size={13} style={{ animation: 'ocr-spin 0.8s linear infinite' }} aria-hidden />
                {t('harness.detailLoading')}
              </span>
            )}
            {!detailLoading && detailProblem && (
              <span style={{ fontSize: 12, color: 'var(--accent-rose)' }}>
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
                    fontSize: '9.5px',
                    padding: '0 5px',
                    letterSpacing: 0,
                    lineHeight: '15px',
                    cursor: 'pointer',
                    border: '1px solid var(--divider)',
                    background: 'transparent',
                    color: detailShowSrc ? 'var(--text-dim)' : 'var(--accent-emerald)',
                  }}
                >
                  {detailShowSrc ? t('harness.origBadge') : t('harness.mtBadge')}
                </button>
                {detailTr.truncated && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('harness.detailTruncated')}</span>
                )}
              </div>
            )}
            {!detailLoading && detailReadme && (
              <div className="md-well" style={{ fontSize: '13px' }}>
                {/* README surface: raw HTML is PARSED and sanitized here (see lib/readme-markdown) —
                    a plugin page written in `<div align="center">` must not render as nothing. */}
                <ReactMarkdown
                  remarkPlugins={README_MD_REMARK_PLUGINS}
                  rehypePlugins={README_MD_REHYPE_PLUGINS}
                  components={README_MD_COMPONENTS}
                >
                  {detailReadme}
                </ReactMarkdown>
              </div>
            )}
            {!detailLoading && !detailReadme && !detailProblem && detailSubject.url && (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('harness.detailNoReadme')}</span>
            )}
          </div>
        </Dialog>
      )}
    </>
  );

  // A kind without a harness axis keeps the original frame: one full-width column, no rail.
  if (!railCopy) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>{content}</div>;
  }
  // A kind with a landing puts the rail left of that same column. `onSelect` pushes only the URL:
  // the reset chain lives in the effect keyed on the resolved param, so Back/Forward replays it.
  const pickHarness = (id: string): void => {
    // A rail pick always answers "what is installed HERE" — the badge is a count of local copies.
    // Navigating to a segment WITHOUT `?tab=` is that reset, and it also covers clicking the row you
    // already stand on, where only the query changes.
    navigate(`/harness/${route}/${id}`);
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
      />
      <div className="harness-body">{content}</div>
    </div>
  );
};
