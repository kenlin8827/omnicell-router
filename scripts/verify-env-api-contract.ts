// Contract guard for the environment admin client (frontend/src/lib/api.ts).
//   bun run scripts/verify-env-api-contract.ts
// Covers the three Phase-3 review fixes at the level that can be checked
// without a browser: (1) mirrored constants/regex stay equal to the backend
// source, (2) the import body-limit mirror, (3) EnvApiError.hasErrorBody tells
// "gateway answered with an error body" (show error, never poll) apart from
// "no response body" (handover race -> poll for readiness).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const backend = {
  archive: read('../backend/src/config/env-archive.ts'),
  env: read('../backend/src/config/env.ts'),
};

const { api, EnvApiError, ENV_IMPORT_BODY_LIMIT_BYTES, ENV_ARCHIVE_VERSION, ENV_ARCHIVE_FORMAT, ENV_ARCHIVE_SUFFIX } =
  await import('../frontend/src/lib/api.ts');

// ── 1. Mirrored constants must not drift from the backend source ───────────
// Numeric mirrors may be written as an arithmetic expression in either file,
// so evaluate both sides instead of comparing source text.
const evalNum = (expr: string, where: string) => {
  const m = expr.match(/^(?:0|[1-9]\d*)(?:(?:\s*[-+*/]\s*(?:0|[1-9]\d*))+)*$/);
  assert.ok(m, `${where}: not a plain numeric expression: ${expr}`);
  return Function(`"use strict"; return (${m[0]});`)() as number;
};
const beNum = (text: string, name: string) => {
  const m = text.match(new RegExp(`export const ${name} = ([^;]+);`));
  assert.ok(m, `backend constant ${name} not found`);
  return m[1].trim();
};
assert.equal(
  evalNum(beNum(backend.archive, 'IMPORT_BODY_LIMIT_BYTES'), 'backend'),
  ENV_IMPORT_BODY_LIMIT_BYTES,
  'import body limit',
);
assert.equal(String(ENV_ARCHIVE_VERSION), beNum(backend.archive, 'ENVELOPE_VERSION'), 'envelope version');
assert.equal(`'${ENV_ARCHIVE_FORMAT}'`, beNum(backend.archive, 'ENVELOPE_FORMAT'), 'envelope format');
assert.equal(`'${ENV_ARCHIVE_SUFFIX}'`, beNum(backend.archive, 'ARCHIVE_SUFFIX'), 'envelope suffix');

const beRe = backend.env.match(/const ENV_NAME_RE = (\/.*\/[a-z]*);/)?.[1];
const feRe = read('../frontend/src/pages/EnvironmentsPage.tsx').match(/const ENV_NAME_RE = (\/.*\/[a-z]*);/)?.[1];
assert.equal(feRe, beRe, 'client name regex mirror');

// ── 2. Error-body discrimination (the switch flow depends on this) ─────────
type Case = { name: string; make: () => Response | Promise<never>; wantErrBody: boolean | 'not-env-error' };

const json409 = new Response(JSON.stringify({ status: 'error', error: 'a switch is already running' }), {
  status: 409,
  headers: { 'content-type': 'application/json' },
});
const html502 = new Response('<html>bad gateway</html>', { status: 502 });
const json404 = new Response(JSON.stringify({ status: 'error', error: 'Environment "nope" does not exist' }), {
  status: 404,
  headers: { 'content-type': 'application/json' },
});
const jsonSuggest = new Response(
  JSON.stringify({ status: 'error', error: 'exists', suggestion: 'staging-imported' }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);

const cases: Case[] = [
  { name: '409 json (backend switch mutex)', make: () => json409, wantErrBody: true },
  { name: '404 json (missing env)', make: () => json404, wantErrBody: true },
  { name: '409 json + suggestion', make: () => jsonSuggest, wantErrBody: true },
  { name: '502 html (proxy noise)', make: () => html502, wantErrBody: false },
  { name: 'network failure (no response)', make: () => Promise.reject(new TypeError('Failed to fetch')), wantErrBody: 'not-env-error' },
];

const realFetch = globalThis.fetch;
for (const c of cases) {
  globalThis.fetch = (async () => c.make()) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await api.switchEnvironment('staging');
    assert.fail(`${c.name}: switchEnvironment should have thrown`);
  } catch (err) {
    caught = err;
  } finally {
    globalThis.fetch = realFetch;
  }

  if (c.wantErrBody === 'not-env-error') {
    assert.ok(!(caught instanceof EnvApiError), `${c.name}: must NOT be EnvApiError (page must poll)`);
    continue;
  }
  assert.ok(caught instanceof EnvApiError, `${c.name}: expected EnvApiError`);
  assert.equal(caught.hasErrorBody, c.wantErrBody, `${c.name}: hasErrorBody`);
  if (c.name.includes('suggestion')) assert.equal(caught.suggestion, 'staging-imported', 'suggestion passthrough');
  if (c.wantErrBody) assert.notEqual(caught.message, `HTTP ${caught.status}`, 'error text from body');
}

// 2xx with status:'failed' stays a RESULT, not an error (pointer rolled back).
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ status: 'failed', env: 'x', error: 'spawn failed' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
const failed = await api.switchEnvironment('x');
globalThis.fetch = realFetch;
assert.equal(failed.status, 'failed', 'failed is a parsed result');

console.log('env api contract guard: all assertions passed');
