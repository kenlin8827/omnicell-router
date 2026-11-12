/**
 * Bundled provider logos: downloads the official models.dev glyphs (the exact
 * SVGs the catalog serves at https://models.dev/logos/<id>.svg) into
 * `frontend/public/provider-logos/`, plus the OpenRouter brand glyph, and
 * bakes a colour into each monochrome glyph so the console shows a coloured
 * mark without shipping raster copies.
 *
 * WHY BUNDLE: the console's first-choice logo is the bundled file, so the page
 * renders identically offline / behind an intranet, without depending on the
 * catalog disk cache having warmed up. The catalog URL stays as the fallback
 * (see ProviderLogo), so a bundled miss still shows the official remote art.
 *
 * COLOR: upstream glyphs are single-colour (`fill="currentColor"`). Tint
 * priority: curated BRAND_COLOR table → Simple Icons (each brand's published
 * colour) → a deterministic id-hash hue for the long tail, so every provider
 * is recognisable at a glance. The hash hue is explicitly NOT a brand claim;
 * brand colours too light for the plate are darkened until they separate.
 *
 * Run: `bun run logos:fetch` (network required).
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(import.meta.dir, '..', 'frontend', 'public', 'provider-logos');
const MODELS_DEV_API = 'https://models.dev/api.json';
const LOGO_URL = (id: string) => `https://models.dev/logos/${encodeURIComponent(id)}.svg`;
const OPENROUTER_GLYPH = 'https://openrouter.ai/brand/v2/openrouter-glyph-light.svg';
const UA = 'OmniCellRouter-logo-fetch/1.0';
const SIMPLE_ICONS_URL = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json';
const MANIFEST_FILE = path.resolve(import.meta.dir, '..', 'frontend', 'src', 'lib', 'provider-logos.ts');
/** Provider ids are lowercase slugs (same rule as isValidProviderId). */
/**
 * Per-id overrides for glyphs the catalog mislabels or ships in a form that
 * does not read as the brand:
 *  - `alibaba-token-plan*` is the 百炼 (Bailian / Model Studio) token plan, but
 *    models.dev serves the Qwen four-point spark;
 *  - `volcengine*` is served a flat single-colour wave, while the brand mark is
 *    the three-peak blue/cyan mountain.
 * Source: LobeHub icons (MIT, see NOTICE.txt beside the generated files).
 */
const LOGO_OVERRIDE: Record<string, string> = {
  'alibaba-token-plan':
    'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.102.0/icons/bailian-color.svg',
  'alibaba-token-plan-cn':
    'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.102.0/icons/bailian-color.svg',
  volcengine:
    'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.102.0/icons/volcengine-color.svg',
  'volcengine-coding-plan':
    'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.102.0/icons/volcengine-color.svg',
};
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
/**
 * Human-checked brand colours (provider brand pages). Anything absent here is
 * still resolved from Simple Icons before falling back to no tint at all.
 */
const BRAND_COLOR: Record<string, string> = {
  '302ai': '#8E47F0',
  alibaba: '#FF6A00',
  'alibaba-cn': '#FF6A00',
  'alibaba-coding-plan': '#FF6A00',
  'alibaba-coding-plan-cn': '#FF6A00',
  'alibaba-token-plan': '#FF6A00',
  'alibaba-token-plan-cn': '#FF6A00',
  'amazon-bedrock': '#FF9900',
  anthropic: '#D97757',
  azure: '#0078D4',
  'azure-cognitive-services': '#0078D4',
  bailing: '#2932E1',
  baseten: '#0F766E',
  cerebras: '#F15A29',
  'cloudflare-ai-gateway': '#F38020',
  'cloudflare-workers-ai': '#F38020',
  cohere: '#39594D',
  databricks: '#FF3621',
  deepinfra: '#0B5FFF',
  deepseek: '#4D6BFE',
  'fireworks-ai': '#FF5E1F',
  'github-copilot': '#181717',
  gitlab: '#FC6D26',
  google: '#4285F4',
  'google-vertex': '#4285F4',
  'google-vertex-anthropic': '#4285F4',
  groq: '#F55036',
  huggingface: '#FF9D00',
  'kimi-code-plan-cn': '#16191E',
  'kimi-code-plan-global': '#16191E',
  lmstudio: '#4B5563',
  meta: '#0866FF',
  minimax: '#F23F5D',
  'minimax-cn': '#F23F5D',
  'minimax-cn-coding-plan': '#F23F5D',
  'minimax-coding-plan': '#F23F5D',
  mistral: '#FA520F',
  moonshotai: '#16191E',
  'moonshotai-cn': '#16191E',
  nebius: '#4D5BFF',
  'novita-ai': '#0EA5E9',
  nvidia: '#76B900',
  oci: '#C74634',
  openai: '#10A37F',
  openrouter: '#7624F4',
  ovhcloud: '#123F6D',
  perplexity: '#20808D',
  'perplexity-agent': '#20808D',
  poe: '#5D5CDE',
  sambanova: '#EE7624',
  scaleway: '#4F0599',
  siliconflow: '#6C5CE7',
  'siliconflow-cn': '#6C5CE7',
  'snowflake-cortex': '#0E7490',
  stepfun: '#1E40FF',
  'stepfun-ai': '#1E40FF',
  'stepfun-ai-step-plan': '#1E40FF',
  'stepfun-step-plan': '#1E40FF',
  'tencent-coding-plan': '#0052D9',
  'tencent-token-plan': '#0052D9',
  'tencent-tokenhub': '#0052D9',
  togetherai: '#0F6FFF',
  upstage: '#7666F6',
  vercel: '#000000',
  volcengine: '#006EFF',
  'volcengine-coding-plan': '#006EFF',
  vultr: '#007BFC',
  watsonx: '#0F62FE',
  xai: '#000000',
  xiaomi: '#FF6900',
  'xiaomi-token-plan-ams': '#FF6900',
  'xiaomi-token-plan-cn': '#FF6900',
  'xiaomi-token-plan-sgp': '#FF6900',
  zai: '#000000',
  'zai-coding-plan': '#000000',
  zhipuai: '#000000',
  'zhipuai-coding-plan': '#000000',
};

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Official brand colour per provider: curated table (human-checked against the
 * provider's brand page) on top of the Simple Icons dataset (slug / title
 * match against the models.dev provider id and display name). Ids with no
 * sourced colour are absent — never guessed.
 */
async function officialBrandColors(
  providers: Record<string, { name?: string } | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const raw = await fetchText(SIMPLE_ICONS_URL);
  if (raw) {
    const list = JSON.parse(raw) as { title: string; slug: string; hex?: string }[];
    const bySlug = new Map(list.map((entry) => [entry.slug, entry]));
    const byTitle = new Map(list.map((entry) => [normName(entry.title), entry]));
    for (const [id, provider] of Object.entries(providers)) {
      const entry =
        bySlug.get(id) ??
        bySlug.get(id.replace(/-ai$/, '')) ??
        byTitle.get(normName(provider?.name ?? id)) ??
        byTitle.get(normName(id));
      if (entry?.hex) out.set(id, `#${entry.hex}`);
    }
  }
  for (const [id, hex] of Object.entries(BRAND_COLOR)) out.set(id, hex);
  return out;
}

/** Darken a brand colour that would vanish on the light logo plate. */
function legibleOnLightPlate(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  let r = parseInt(match[1].slice(0, 2), 16);
  let g = parseInt(match[1].slice(2, 4), 16);
  let b = parseInt(match[1].slice(4, 6), 16);
  const luminance = (): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  while (luminance() > 0.55) {
    r = Math.round(r * 0.88);
    g = Math.round(g * 0.88);
    b = Math.round(b * 0.88);
  }
  const toHex = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Stable non-official hue for providers with no sourced brand colour: the id
 * hash picks the hue, fixed S/L keeps it legible on the light plate. It is a
 * recognisability aid, never a claim about the brand.
 */
function fallbackHue(id: string): string {
  let hue = 0;
  for (let i = 0; i < id.length; i += 1) hue = (hue * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hue} 58% 42%)`;
}

/**
 * Marks the catalog ships already painted while the official mark is
 * monochrome (models.dev serves the 智谱/Z.ai Z in blue `#2f5bea`; the brand
 * mark is black). Those ids are force-repainted instead of left untouched.
 */
const MONOCHROME_OFFICIAL: Record<string, true> = {
  zhipuai: true,
  'zhipuai-coding-plan': true,
  zai: true,
  'zai-coding-plan': true,
};

/** Parse `#rgb` / `#rrggbb` / `rgb(r,g,b)` paint values. */
function parseColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

const luminanceOf = ([r, g, b]: [number, number, number]): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** True when the paint is a gray tone (no hue of its own). */
const isNeutral = ([r, g, b]: [number, number, number]): boolean =>
  Math.max(r, g, b) - Math.min(r, g, b) <= 8;

/**
 * Repaint a glyph's solid paint values. `force` overrides genuine colours
 * (only for MONOCHROME_OFFICIAL marks); otherwise only neutral gray artwork is
 * tinted and white/`none` details are preserved (302.AI ships its disc in
 * grays while the brand mark is purple with white rings).
 */
function repaint(svg: string, color: string, force: boolean): string {
  return svg.replace(/\b(fill|stroke)="([^"]+)"/gi, (whole, attr: string, value: string) => {
    const rgb = parseColor(value);
    if (!rgb || luminanceOf(rgb) > 0.85) return whole;
    if (!force && !isNeutral(rgb)) return whole;
    return `${attr}="${color}"`;
  });
}

/** Paint a glyph; genuine multi-colour artwork is never touched. */
function colorize(svg: string, id: string, color: string): string {
  const painted = legibleOnLightPlate(color);
  if (MONOCHROME_OFFICIAL[id]) return repaint(svg, painted, true);
  if (svg.includes('currentColor')) return svg.replaceAll('currentColor', painted);
  return repaint(svg, painted, false);
}

/**
 * Wordmark lockups (wide text-shaped logos) are unreadable at the console's
 * 34–37px icon size — shrinking one produces the "tiny smeared text" card.
 * Above this width/height ratio the console renders a monogram instead.
 */
const WORDMARK_ASPECT = 1.8;

function aspectRatio(svg: string): number | null {
  const viewBox = /viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)"/.exec(svg);
  if (viewBox) return Number(viewBox[3]) / Number(viewBox[4]);
  const width = /\bwidth="(\d+)"/.exec(svg);
  const height = /\bheight="(\d+)"/.exec(svg);
  return width && height ? Number(width[1]) / Number(height[1]) : null;
}
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // `--mono` keeps the upstream single-colour artwork (currentColor) instead
  // of baking colours — one command switches the whole set back and forth.
  const mono = process.argv.includes('--mono');
  const api = await fetchText(MODELS_DEV_API);
  if (!api) throw new Error(`cannot fetch ${MODELS_DEV_API}`);
  const payload = JSON.parse(api) as Record<string, { name?: string } | undefined>;
  const ids = Object.keys(payload)
    .filter((id) => SAFE_ID.test(id))
    .sort();
  const colors = mono ? new Map<string, string>() : await officialBrandColors(payload);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  const missing: string[] = [];

  /** id → wide lockup aspect ratio (width / height). */
  const wordmarks = new Map<string, number>();
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const svg = await fetchText(LOGO_OVERRIDE[id] ?? LOGO_URL(id));
        if (!svg || !svg.toLowerCase().includes('<svg')) {
          missing.push(id);
          continue;
        }
        const ratio = aspectRatio(svg);
        const color = colors.get(id) ?? fallbackHue(id);
        fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), mono ? svg : colorize(svg, id, color));
        if (ratio !== null && ratio >= WORDMARK_ASPECT) wordmarks.set(id, Math.round(ratio * 100) / 100);
        written += 1;
      }
    }),
  );

  const openrouter = await fetchText(OPENROUTER_GLYPH);
  if (openrouter) {
    fs.writeFileSync(path.join(OUT_DIR, 'openrouter.svg'), openrouter);
    written += 1;
  }
  console.log(
    mono
      ? 'mode: monochrome (upstream currentColor)'
      : `mode: full colour (${colors.size}/${ids.length} official brand colours, ${ids.length - colors.size} deterministic fallback hues)`,
  );

  // A stale file for a provider upstream dropped — or for an id that is now
  // classified as a wordmark — would silently outlive its rule. Only `.svg`
  // files are considered: NOTICE.txt and other sidecars must survive a run.
  const known = new Set([...ids, 'openrouter']);
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (!file.endsWith('.svg')) continue;
    const id = file.slice(0, -4);
    if (!known.has(id)) fs.rmSync(path.join(OUT_DIR, file));
  }

  // Manifest = the ids that actually landed on disk. The console reads it to
  // decide whether to try the bundled file at all (no 404 probe per provider).
  const bundled = fs
    .readdirSync(OUT_DIR)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.slice(0, -4))
    .sort();
  fs.writeFileSync(
    MANIFEST_FILE,
    [
      '/**',
      ' * GENERATED by scripts/fetch-provider-logos.ts — do not edit by hand.',
      ' * Provider ids with a bundled official glyph under frontend/public/provider-logos/.',
      ' */',
      `export const BUNDLED_PROVIDER_LOGOS: ReadonlySet<string> = new Set<string>([`,
      ...bundled.map((id) => `  '${id}',`),
      ']);',
      '',
      '/**',
      ' * Wide wordmark lockups and their aspect ratio: the console gives them a',
      ' * proportionally wide plate instead of squeezing them into a square icon.',
      ' */',
      `export const WORDMARK_PROVIDER_LOGOS: Record<string, number> = {`,
      ...[...wordmarks.entries()].sort().map(([id, ratio]) => `  '${id}': ${ratio},`),
      '};',
      '',
    ].join('\n'),
  );

  console.log(
    `provider logos: ${written} written, ${missing.length} missing, ${wordmarks.size} wordmarks, ${bundled.length} in manifest`,
  );
  if (missing.length > 0) console.log(`missing: ${missing.join(' ')}`);
}

void main();
