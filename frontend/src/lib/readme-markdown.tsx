import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

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
    source: ['srcset', 'src', 'type', 'media', 'sizes'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

/** GFM only (task lists, tables, strikethrough) — raw HTML is parsed in the REHYPE phase, not here. */
export const README_MD_REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm];

/** `rehype-raw` parses the HTML, `rehype-sanitize` immediately narrows it to the allowlist. */
export const README_MD_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, README_SCHEMA],
];

export const README_MD_COMPONENTS: Components = {
  // Never hijack the console's own tab.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _node, src, alt, ...props }) => {
    if (!(typeof src === 'string' && /^https?:\/\//i.test(src))) return null;
    // `max-width` is a CAP, never a stretch: a 64 px logo stays 64 px and an oversized screenshot
    // shrinks to the column. `height: auto` is only added when the author did NOT declare a height —
    // otherwise a badge declared `height="20"` would be blown back up to its intrinsic size.
    const heightCss = props.height === undefined ? { height: 'auto' } : {};
    return (
      <img
        {...props}
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ maxWidth: '100%', ...heightCss }}
      />
    );
  },
};
