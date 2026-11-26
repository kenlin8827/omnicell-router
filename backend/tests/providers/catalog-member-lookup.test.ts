// Catalog member lookup — `findMemberCatalogRecords` feeds the PUBLIC capability
// surface (`/v1/models`, `/v1/catalog.json`). A prefixed provider registers its
// models as `${provider}/${upstream}` while the catalog record keeps the BARE
// upstream key, so a caller indexing the returned records by `record.id` misses
// every prefixed provider and silently drops attachment/modalities/limit/
// tool_call. `byId` is the lookup-id-keyed view that closes that hole.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogModel, CatalogProviderRecord } from '../../src/opencode/catalog/types.js';
import { findMemberCatalogRecords } from '../../src/providers/virtual-meta.js';

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ id, ...extra }) as CatalogModel;

const provider = (id: string, models: CatalogModel[]): CatalogProviderRecord =>
  ({ id, name: id, models }) as CatalogProviderRecord;

const listOf = (providers: CatalogProviderRecord[]) => async () => providers;

describe('findMemberCatalogRecords', () => {
  it('keys byId by the registered lookup id, not the catalog record id', async () => {
    const cat = model('dmodel', { attachment: true });
    const { records, byId } = await findMemberCatalogRecords(
      ['qoder-cn/dmodel'],
      listOf([provider('qoder-cn', [cat])])
    );
    // `records` keeps the catalog's own bare key (its contract is unchanged)…
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'dmodel');
    // …and `byId` answers for the id the caller actually holds.
    assert.equal(byId.get('qoder-cn/dmodel'), cat);
    assert.equal(byId.get('dmodel'), undefined, 'byId must not invent a bare-key entry for a prefixed id');
  });

  it('resolves a bare (unprefixed) registration by its bare id', async () => {
    const cat = model('glm-4.6', { attachment: true });
    const { byId } = await findMemberCatalogRecords(['glm-4.6'], listOf([provider('zhipu', [cat])]));
    assert.equal(byId.get('glm-4.6'), cat);
  });

  it('prefers the prefixed provider record over a same-named bare one', async () => {
    const own = model('dmodel', { attachment: true, limit: { context: 96_000 } });
    const foreign = model('dmodel', { attachment: false, limit: { context: 1 } });
    const { byId } = await findMemberCatalogRecords(
      ['qoder-cn/dmodel'],
      listOf([provider('other', [foreign]), provider('qoder-cn', [own])])
    );
    assert.equal(byId.get('qoder-cn/dmodel'), own);
  });

  it('omits ids with no catalog record instead of inventing one', async () => {
    const { records, byId } = await findMemberCatalogRecords(['qoder-cn/ghost'], listOf([provider('qoder-cn', [])]));
    assert.deepEqual(records, []);
    assert.equal(byId.size, 0);
  });

  it('survives a catalog read failure with an empty map', async () => {
    const { records, byId, lookup } = await findMemberCatalogRecords(['x/y'], async () => {
      throw new Error('catalog offline');
    });
    assert.deepEqual(records, []);
    assert.equal(byId.size, 0);
    assert.equal(lookup('x/y'), undefined);
  });

  it('keeps one record per id when the input repeats', async () => {
    const cat = model('dmodel', { attachment: true });
    const { records, byId } = await findMemberCatalogRecords(
      ['qoder-cn/dmodel', 'qoder-cn/dmodel'],
      listOf([provider('qoder-cn', [cat])])
    );
    assert.equal(records.length, 2);
    assert.equal(byId.size, 1);
  });
});