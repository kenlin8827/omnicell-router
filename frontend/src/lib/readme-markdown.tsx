import { useMemo, type MouseEvent } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';

/**
 * README rendering for the harness market detail dialog.
 *
 * A DIFFERENT trust model from model output. `SessionTranscript`'s exported `MD_*` map refuses raw
 * HTML outright, because a captured answer is untrusted text. A README is repository prose the
 * operator chose to open, and it is routinely written in HTML — `<div align="center">` headers, badge
 * rows, `<details>` blocks, `<kbd>`, `<picture>`. Refusing it renders half those pages as nothing.
 *
 * So raw HTML IS parsed here (`rehype-raw`) and immediately SANITIZED (`rehype-sanitize`): no
 * scripts, no styles, no iframes, no event handlers, no `javascript:`/`data:` URLs. Only the tags and
 * attributes on the allowlist below survive, and the allowlist is the library's GitHub-derived
 * default plus the few presentational extras READMEs actually use.
 *
 * Remote images ARE loaded on this surface only (a README's logo and badges are the point of the
 * page). `referrerPolicy="no-referrer"` keeps the console's origin out of the request. Model output
 * stays image-free — that rule lives in `SessionTranscript` and is not weakened here.
 */

/** The sanitizer prefixes every `id`/`name` a README declares (the clobber guard: a document must
 *  not shadow the console's own element ids). Slugged headings inherit the prefix, so fragment
 *  lookup applies the same constant the schema below declares. */
const README_ID_PREFIX = 'user-content-';

const README_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: [
    ...new Set([
      ...(defaultSchema.tagNames ?? []),
      'details',
      'summary',
      'picture',
      'source',
      'kbd',
      'ins',
      'del',
      'mark',
    ]),
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Presentational alignment is all GitHub READMEs use `align` for; it cannot execute or hide.
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'align'],
    img: ['src', 'alt', 'title', 'width', 'height', 'align'],
    a: ['href', 'title', 'name'],
    details: ['open'],
    summary: [],
    source: ['srcSet', 'src', 'type', 'media', 'sizes'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
  clobberPrefix: README_ID_PREFIX,
};

/** GFM only (task lists, tables, strikethrough) — raw HTML is parsed in the REHYPE phase, not here. */
const README_MD_REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm];

/** `rehype-raw` parses the HTML, `rehype-slug` gives headings GitHub-shaped ids (so a table of
 *  contents can scroll to them), `rehype-sanitize` immediately narrows the tree to the allowlist. */
const README_MD_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  rehypeSlug,
  [rehypeSanitize, README_SCHEMA],
];

/**
 * Where a README's relative links were authored to point. The dialog is served from the console
 * origin, so an unresolved `docs/guide.md` asks the console for that path — a dead route. README
 * bodies are read from the repository root, hence GitHub's branch-independent `blob/HEAD/` tree as
 * the base. A row that names no repository falls back to its own public page.
 */
export function readmeBaseHref(subject: {
  repo?: string | null;
  /** Repository-relative path of the body; its directory anchors relative links. */
  path?: string | null;
  packageKey?: string | null;
  url?: string | null;
}): string | undefined {
  const repo = subject.repo?.trim();
  // Same `owner/repo` shape the backend accepts for a read; anything else is not a GitHub path.
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
    // A file path's DIRECTORY is the base: `docs/README.zh.md` resolves `../x` inside `docs/`.
    const dir = (subject.path ?? '').split('/').slice(0, -1).join('/');
    return `https://github.com/${repo}/blob/HEAD/${dir ? `${dir}/` : ''}`;
  }
  const pkg = /^npm:(.+)$/.exec(subject.packageKey?.trim() ?? '')?.[1];
  if (pkg) return `https://www.npmjs.com/package/${pkg}/`;
  const url = subject.url?.trim();
  if (!url) return undefined;
  // Directory semantics: `new URL('docs/x', 'https://host/pkg')` would climb out of `pkg` and land
  // on `https://host/docs/x`.
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Absolute hrefs are used as authored; a relative one is joined to the README's source page.
 * `null` = nothing honest to open (a relative link on a row naming no source page, or a scheme the
 * dialog does not hand to the browser).
 */
export function resolveReadmeHref(href: string | undefined, base: string | undefined): string | null {
  if (!href) return null;
  if (/^(?:https?:|mailto:)/i.test(href)) return href;
  // Protocol-relative: the README's own scheme does not apply here, and the console is http(s).
  if (href.startsWith('//')) return `https:${href}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (!base) return null;
  // Root-relative is REPOSITORY-root-relative on GitHub (`new URL('/docs/x', repoBlob)` would answer
  // `https://github.com/docs/x`, a 404), and meaningless on a package page.
  if (href.startsWith('/')) {
    const repo = repoOf(base);
    return repo ? `https://github.com/${repo}/blob/HEAD/${href.replace(/^\/+/, '')}` : null;
  }
  try {
    return clampGithub(new URL(href, base).toString());
  } catch {
    return null;
  }
}

/** A `..` in a README link can climb out of the GitHub branch segment (`/blob/HEAD/` → `/blob/`);
 *  GitHub would then 404, so the branch is re-anchored. Absolute links never reach this. */
function clampGithub(target: string): string {
  const blob = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/)(?!HEAD\/)(.*)$/.exec(target);
  if (blob) return `${blob[1]}HEAD/${blob[2]}`;
  const raw = /^(https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/)(?!HEAD\/)(.*)$/.exec(target);
  return raw ? `${raw[1]}HEAD/${raw[2]}` : target;
}

/** The repository named by a GitHub blob base (`.../blob/HEAD/<dir>/`), when the base is one. */
function repoOf(base: string | undefined): string | undefined {
  return /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/HEAD\//.exec(base ?? '')?.[1];
}

/** Scroll the dialog body to an in-page anchor instead of letting the webview open a second console
 *  tab on a `#fragment` the console itself cannot resolve. */
function jumpToFragment(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault();
  const raw = href.slice(1);
  if (!raw) return;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A malformed escape stays literal; the lookup simply finds nothing.
  }
  const target =
    document.getElementById(README_ID_PREFIX + name) ?? document.getElementsByName(README_ID_PREFIX + name)[0];
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Where README images live when the body came from a repository. GitHub serves the FILE from
 *  `raw.githubusercontent.com`; the `blob/` page would answer HTML for an image URL. */
function imageBaseOf(base: string | undefined): string | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/HEAD\/(.*)$/.exec(base ?? '');
  return match ? `https://raw.githubusercontent.com/${match[1]}/HEAD/${match[2]}` : undefined;
}

/** Absolute image URLs pass through; a relative one joins the repository's raw tree (or, for a
 *  root-relative `src`, the raw ROOT — not the README's directory). `null` means "no honest
 *  source": a docs-relative image on a row with no repository, or a non-web scheme. */
function resolveImageSrc(src: string | undefined, base: string | undefined): string | null {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  const rawBase = imageBaseOf(base);
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !rawBase) return null;
  // Root-relative images live at the repository ROOT, not under the README's own directory.
  if (src.startsWith('/')) {
    const repo = repoOf(base);
    return repo ? `https://raw.githubusercontent.com/${repo}/HEAD/${src.replace(/^\/+/, '')}` : null;
  }
  try {
    return clampGithub(new URL(src, rawBase).toString());
  } catch {
    return null;
  }
}

/** A `<picture>` source list (`dark.svg 1x, wide.svg 2x`) with every URL resolved. `null` when any
 *  candidate has no honest source — a half-resolved list would still pick a broken entry. */
function resolveSrcSet(srcSet: string | undefined, base: string | undefined): string | null {
  if (!srcSet) return null;
  const parts: string[] = [];
  for (const candidate of srcSet.split(',')) {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    const resolved = url ? resolveImageSrc(url, base) : null;
    if (!resolved) return null;
    parts.push([resolved, ...descriptor].join(' '));
  }
  return parts.join(', ');
}

function readmeComponents(base: string | undefined): Components {
  return {
    a: ({ node: _node, href, ...props }) => {
      if (typeof href === 'string' && href.startsWith('#')) {
        return <a {...props} href={href} onClick={(e) => jumpToFragment(e, href)} />;
      }
      const target = resolveReadmeHref(href, base);
      // A relative link with no source page has no honest destination: keep the text, drop the
      // dead click (the browser would otherwise request a console route that does not exist).
      if (!target) return <span {...props} />;
      // Never hijack the console's own tab.
      return <a {...props} href={target} target="_blank" rel="noopener noreferrer" />;
    },
    img: ({ node: _node, src, alt, ...props }) => {
      const resolved = resolveImageSrc(src, base);
      if (!resolved) return null;
      // `max-width` is a CAP, never a stretch: a 64 px logo stays 64 px and an oversized screenshot
      // shrinks to the column. `height: auto` is only added when the author did NOT declare a height —
      // otherwise a badge declared `height="20"` would be blown back up to its intrinsic size.
      const heightCss = props.height === undefined ? { height: 'auto' } : {};
      return (
        <img
          {...props}
          src={resolved}
          alt={alt ?? ''}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ maxWidth: '100%', ...heightCss }}
        />
      );
    },
    source: ({ node: _node, srcSet, src, ...props }) => {
      const resolvedSet = resolveSrcSet(srcSet, base);
      const resolvedSrc = resolveImageSrc(src, base);
      // A half-resolved `<picture>` would still pick a candidate pointing at the console origin;
      // dropping the source lets the `<img>` fallback render instead.
      if (!resolvedSet && !resolvedSrc) return null;
      return (
        <source
          {...props}
          {...(resolvedSet ? { srcSet: resolvedSet } : {})}
          {...(resolvedSrc ? { src: resolvedSrc } : {})}
        />
      );
    },
  };
}

/** One README body, rendered with the console's sanitize policy and its links resolved against the
 *  page the text was published from (`base`, see `readmeBaseHref`). */
export function ReadmeMarkdown({ source, base }: { source: string; base?: string | null }) {
  const components = useMemo(() => readmeComponents(base ?? undefined), [base]);
  return (
    <ReactMarkdown
      remarkPlugins={README_MD_REMARK_PLUGINS}
      rehypePlugins={README_MD_REHYPE_PLUGINS}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
}
