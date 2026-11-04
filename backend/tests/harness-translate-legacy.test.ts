import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { harnessEnvDir } from '../src/harness/host/manifest.js';
import { getCachedTranslation, translateMarkdown } from '../src/harness/translation.js';

/**
 * The derived translation store used to be ONE `i18n/descriptions.json` blob. It is now one file per
 * entry (`i18n/descriptions/<hash>.<lang>.json`, `i18n/readme/<hash>.<lang>.json`), and the blob is
 * migrated lazily on first read — the cache is derived, but the model calls behind it were paid for,
 * so an upgrade must not throw them away.
 *
 * Both promotions live in ONE test on purpose: the blob is read once per process, so a second test
 * writing a second blob would be reading a stale memo rather than the file it just wrote.
 */
describe('legacy descriptions.json migration', () => {
  it('promotes an old description AND an old README entry into their own files on first read', async () => {
    const description = 'a description written before the split';
    const readme = '# Old page\n\nbody written before the split';
    const descriptionHash = crypto.createHash('sha256').update(description).digest('hex');
    const readmeHash = crypto.createHash('sha256').update(readme).digest('hex');

    const blobPath = path.join(harnessEnvDir(), 'i18n', 'descriptions.json');
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(
      blobPath,
      JSON.stringify({
        version: 1,
        entries: {
          [`${descriptionHash}:zh`]: { text: '迁移过来的描述译文', model: 'old/model', at: '2026-01-01T00:00:00Z' },
          [`md:${readmeHash}:zh`]: { text: '# 旧页面\n\n迁移过来的正文', model: 'old/model', at: '2026-01-01T00:00:00Z' },
        },
      }),
      'utf8'
    );

    expect(getCachedTranslation(description, 'zh')?.text).toBe('迁移过来的描述译文');
    expect(
      fs.existsSync(path.join(harnessEnvDir(), 'i18n', 'descriptions', `${descriptionHash}.zh.json`))
    ).toBe(true);

    const result = await translateMarkdown(readme, 'zh');
    if ('code' in result) throw new Error(`expected the migrated README, got ${result.code}`);
    expect(result.text).toBe('# 旧页面\n\n迁移过来的正文');
    expect(result.cached).toBe(true);
    expect(fs.existsSync(path.join(harnessEnvDir(), 'i18n', 'readme', `${readmeHash}.zh.json`))).toBe(true);
  });
});
