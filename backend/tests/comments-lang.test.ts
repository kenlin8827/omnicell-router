/**
 * Comment-i18n tests (ADR-0016 companion): the zh-CN and en comment
 * dictionaries must stay in lockstep (key sets), and the disk format carries
 * NO comments (zero-comment contract) — comments are console-rendered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DICTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config');
const ZH_SRC = readFileSync(path.join(DICTS_DIR, 'comments-zh.ts'), 'utf8');
const EN_SRC = readFileSync(path.join(DICTS_DIR, 'comments-en.ts'), 'utf8');
const INDEX_SRC = readFileSync(path.join(DICTS_DIR, 'index.ts'), 'utf8');

const extractKeys = (src: string, mapName: string): string[] => {
  const start = src.indexOf(`${mapName}: Record<string, string> = {`);
  if (start === -1) throw new Error(`${mapName} not found`);
  const body = src.slice(start, src.indexOf('\n};', start));
  const keys: string[] = [];
  for (const m of body.matchAll(/^  '?([a-zA-Z0-9.*]+)'?: '/gm)) {
    keys.push(m[1]);
  }
  return keys;
};

describe('config comment i18n', () => {
  it('zh-CN and en dictionaries expose the same key set', () => {
    const en = extractKeys(EN_SRC, 'YAML_FIELD_COMMENTS_EN');
    assert.ok(en.length > 100, `en dictionary substantial (${en.length} keys)`);
    const zh = extractKeys(ZH_SRC, 'YAML_FIELD_COMMENTS_ZH');
    assert.ok(zh.length > 100, `zh dictionary substantial (${zh.length} keys)`);
    const missingInEn = zh.filter((k) => !en.includes(k));
    assert.deepEqual(missingInEn, [], `en dictionary missing keys: ${missingInEn.slice(0, 10).join(', ')}`);
    const extraInEn = en.filter((k) => !zh.includes(k));
    assert.deepEqual(extraInEn, [], `en dictionary has keys absent from zh: ${extraInEn.slice(0, 10).join(', ')}`);
  });

  it('the write paths emit no comments: zero-comment disk contract holds', () => {
    // The annotation machinery must be GONE — if anyone reintroduces on-disk
    // comments, this fails (ADR-0016 zero-comment rule).
    assert.equal(indexSrcIncludes('annotateYamlComments'), false, 'annotateYamlComments must not exist');
    assert.equal(indexSrcIncludes('parseDocument'), false, 'writers must not re-parse the document for comments');
    assert.equal(indexSrcIncludes('commentBefore'), false, 'no per-key comment attachment on disk');
  });

  const indexSrcIncludes = (needle: string): boolean => INDEX_SRC.includes(needle);
});
