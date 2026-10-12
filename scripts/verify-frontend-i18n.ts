// Console i18n + dropdown conventions check (Phase 3 environments work, kept
// as the standing guard for it). Runs outside the app graph:
//   bun run scripts/verify-frontend-i18n.ts
// Exits 1 when a rule is broken: asymmetric dictionary keys, a t() key that
// resolves in neither dictionary, a declared-but-unreferenced env key, or a
// native <select> element (AGENTS.md: every dropdown goes through Combobox).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhCN } from '../frontend/src/i18n/locales/zh-CN';
import { enUS } from '../frontend/src/i18n/locales/en-US';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : [];
  });

const at = (dict: any, path: string): unknown =>
  path.split('.').reduce<any>((cur, part) => (cur && typeof cur === 'object' && part in cur ? cur[part] : undefined), dict);

const resolves = (dict: any, path: string): boolean => typeof at(dict, path) === 'string';

// 1) Dictionary parity: neither locale may hold a key the other is missing.
const flatten = (obj: any, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k],
  );

const zhKeys = new Set(flatten(zhCN));
const enKeys = new Set(flatten(enUS));
const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));

// 2) Keys referenced from code. `t('k')` is the primary source; a quoted
// string that resolves to a dictionary leaf counts too, because status ->
// i18n key maps hold keys without calling t() at the literal site.
const used = new Set<string>();
for (const file of walk(srcRoot)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9_.]*)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/'([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
    if (resolves(zhCN, m[1]) && resolves(enUS, m[1])) used.add(m[1]);
  }
}
// Dynamic prefixes — `t('auto.' + k)` — cannot be resolved statically; they
// are printed for manual review instead of counted as dangling.
const dynamic = [...used].filter((k) => k.endsWith('.'));
const dangling = [...used].filter((k) => !k.endsWith('.') && (!resolves(zhCN, k) || !resolves(enUS, k)));

// 3) Environments coverage: no dead key may ship with the feature.
const envDeclared = [...zhKeys].filter((k) => k.startsWith('env.') || k === 'nav.environments');
const envUnused = envDeclared.filter((k) => !used.has(k));

// 4) Same-object duplicate keys: a repeated key in one object literal silently
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

// 5) Native <select> audit — doc comments mentioning the element must not
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

console.log(`dictionary keys: zh=${zhKeys.size} en=${enKeys.size}`);
console.log(`only-in-zh=${onlyZh.length} ${JSON.stringify(onlyZh)}`);
console.log(`only-in-en=${onlyEn.length} ${JSON.stringify(onlyEn)}`);
console.log(`keys referenced in code=${used.size} dangling=${dangling.length} ${JSON.stringify(dangling)}`);
console.log(`dynamic t() prefixes (checked by hand)=${JSON.stringify(dynamic)}`);
console.log(`env keys declared=${envDeclared.length} unreferenced=${envUnused.length} ${JSON.stringify(envUnused)}`);
console.log(`same-object duplicate keys=${dupes.length} ${JSON.stringify(dupes)}`);
console.log(`native <select> occurrences=${selects.length} ${JSON.stringify(selects)}`);

const fail = onlyZh.length || onlyEn.length || dangling.length || selects.length || envUnused.length || dupes.length;
process.exit(fail ? 1 : 0);
