// Console i18n + dropdown conventions check (Phase 3 environments work, kept
// as the standing guard for it). Runs outside the app graph:
//   bun run scripts/verify-frontend-i18n.ts
// Exits 1 when a rule is broken: asymmetric dictionary keys across ANY of the
// eight locales, a {placeholder} set that drifted between locales, a t() key
// that resolves in no dictionary, a declared-but-unreferenced key, or a native
// <select> element (AGENTS.md: every dropdown goes through Combobox).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhCN } from '../frontend/src/i18n/locales/zh-CN';
import { enUS } from '../frontend/src/i18n/locales/en-US';
import { esES } from '../frontend/src/i18n/locales/es-ES';
import { frFR } from '../frontend/src/i18n/locales/fr-FR';
import { deDE } from '../frontend/src/i18n/locales/de-DE';
import { jaJP } from '../frontend/src/i18n/locales/ja-JP';
import { koKR } from '../frontend/src/i18n/locales/ko-KR';
import { ptBR } from '../frontend/src/i18n/locales/pt-BR';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : [];
  });

const at = (dict: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in cur) return (cur as Record<string, unknown>)[part];
    return undefined;
  }, dict);

const resolves = (dict: unknown, path: string): boolean => typeof at(dict, path) === 'string';

// 1) Dictionary parity: every locale holds exactly the same key set. Arrays
// are walked too, so a preset the English table grows must be mirrored.
const flatten = (obj: unknown, prefix = ''): string[] =>
  obj && typeof obj === 'object'
    ? Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flatten(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k],
      )
    : [];

/** Leaves of the dictionary, arrays included as one value (their rows are
 *  data the UI edits, not translatable strings). */
const flatLeaves = (obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> => {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatLeaves(v, path, out);
    else out[path] = v;
  }
  return out;
};

const enKeys = new Set(flatten(enUS));
const enLeaves = flatLeaves(enUS);
const LOCALES: Record<string, unknown> = { zh: zhCN, es: esES, fr: frFR, de: deDE, ja: jaJP, ko: koKR, pt: ptBR };
const parity = Object.entries(LOCALES).flatMap(([lang, dict]) => {
  const keys = new Set(flatten(dict));
  return [
    ...[...enKeys].filter((k) => !keys.has(k)).map((k) => `${lang}:missing:${k}`),
    ...[...keys].filter((k) => !enKeys.has(k)).map((k) => `${lang}:extra:${k}`),
  ];
});

// 2) Keys referenced from code. `t('k')` is the primary source; a quoted
// string that resolves to a dictionary leaf counts too, because status ->
// i18n key maps hold keys without calling t() at the literal site.
const used = new Set<string>();
const tLiterals = new Set<string>();
// Dynamic prefixes — `t(`op.${x}`)`, `t('auto.' + k)` — cannot be resolved
// statically; every key below them is treated as referenced.
const dynamicPrefixes = new Set<string>();
const addPrefix = (prefix: string) => dynamicPrefixes.add(prefix);
for (const file of walk(srcRoot)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9_.]*)'/g)) {
    used.add(m[1]);
    tLiterals.add(m[1]);
    if (m[1].endsWith('.')) addPrefix(m[1]);
  }
  for (const m of text.matchAll(/'([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
    if (resolves(enUS, m[1])) used.add(m[1]);
  }
  for (const m of text.matchAll(/\bdict\.([a-z][a-zA-Z0-9_.]*)/g)) used.add(m[1]);
  for (const m of text.matchAll(/`([a-zA-Z][a-zA-Z0-9_.]*)\.?\$\{/g)) addPrefix(m[1]);
  for (const m of text.matchAll(/'([a-zA-Z][a-zA-Z0-9_.]*)\.'\s*\+/g)) addPrefix(m[1]);
}
const dangling = [...tLiterals].filter((k) => !k.endsWith('.') && !resolves(enUS, k));
// A template prefix is only evidence when it actually sits above real keys —
// unrelated `${…}` strings elsewhere must not mask a dead entry.
const dynamic = [...dynamicPrefixes]
  .filter((p) => p.length > 1 && [...enKeys].some((k) => k.startsWith(p)))
  .sort();
const unused = Object.keys(enLeaves).filter((k) => !used.has(k) && !dynamic.some((p) => k.startsWith(p)));

// 3) Environments coverage: no dead key may ship with the feature.
const envDeclared = [...enKeys].filter((k) => k.startsWith('env.') || k === 'nav.environments');
const envUnused = envDeclared.filter((k) => !used.has(k));

// 4) Placeholder parity: `{name}` / `{n}` mean the same value in every locale.
const tokens = (s: unknown) =>
  typeof s === 'string' ? [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : '';
const placeholderDrift = Object.entries(LOCALES).flatMap(([lang, dict]) => {
  const leaves = flatLeaves(dict);
  return Object.keys(leaves)
    .filter((k) => tokens(leaves[k]) !== tokens(enLeaves[k]))
    .map((k) => `${lang}:${k}`);
});

// 5) Same-object duplicate keys: a repeated key in one object literal silently
// drops a value, which the flattened parity above cannot see. Locale files and
// the dict interface are one entry per line, so a brace-depth walk suffices
// (string bodies are stripped first — values contain `{name}` placeholders).
const stripStrings = (line: string) => line.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
const duplicateKeysIn = (file: string, section: string): string[] => {
  const text = readFileSync(join(srcRoot, file), 'utf8');
  const start = text.indexOf('\n  ' + section + ': {');
  if (start < 0) return [];
  const counts = new Map<string, number>();
  const path: string[] = [section]; // path[d-1] = the object name at depth d
  let depth = 1; // inside `section: {`
  // slice(2): [0] is the empty line before the match, [1] is `section: {` itself
  for (const raw of text.slice(start).split('\n').slice(2)) {
    const body = stripStrings(raw);
    const m = raw.trim().match(/^([A-Za-z][A-Za-z0-9_]*)(\??):\s/);
    if (m) {
      const id = `${path.slice(0, depth).join('.')}.${m[1]}`;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (body.includes('{')) {
        path[depth] = m[1];
        depth++;
      }
    }
    depth -= (body.match(/\}/g) || []).length;
    if (depth <= 0) break;
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
};
const dupes = [
  ...duplicateKeysIn('i18n/locales/zh-CN.ts', 'env'),
  ...duplicateKeysIn('i18n/locales/en-US.ts', 'env'),
  ...duplicateKeysIn('i18n/types.ts', 'env'),
];

// 6) Native <select> audit — doc comments mentioning the element must not
// count, so comment-looking lines are skipped.
const selects: string[] = [];
for (const file of walk(srcRoot)) {
  const rel = relative(srcRoot, file).replace(/\\/g, '/');
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (/<select[\s/>]/.test(line)) selects.push(`${rel}:${i + 1}`);
    });
}

console.log(`dictionary keys: en=${enKeys.size}`);
console.log(`locale parity violations=${parity.length} ${JSON.stringify(parity)}`);
console.log(`keys referenced in code=${used.size} dangling=${dangling.length} ${JSON.stringify(dangling)}`);
console.log(`declared-but-unreferenced=${unused.length} ${JSON.stringify(unused)}`);
console.log(`dynamic key prefixes (checked by hand)=${JSON.stringify(dynamic)}`);
console.log(`placeholder drift=${placeholderDrift.length} ${JSON.stringify(placeholderDrift)}`);
console.log(`env keys declared=${envDeclared.length} unreferenced=${envUnused.length} ${JSON.stringify(envUnused)}`);
console.log(`same-object duplicate keys=${dupes.length} ${JSON.stringify(dupes)}`);
console.log(`native <select> occurrences=${selects.length} ${JSON.stringify(selects)}`);

const fail =
  parity.length ||
  dangling.length ||
  unused.length ||
  placeholderDrift.length ||
  selects.length ||
  envUnused.length ||
  dupes.length;
process.exit(fail ? 1 : 0);
