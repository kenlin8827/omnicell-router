/**
 * `isFieldVisible` — the console half of `visibleWhen` (ADR-0017 §7).
 *
 * The contract worth pinning: a hidden field is a DISPLAY decision only. The
 * predicate reads the draft and decides rendering; it never mutates, never
 * clears, and never re-derives a value — so switching a mode away and back
 * leaves the operator's input intact. The draft's shape is what the plugin
 * drawer actually holds: enum/string as text, booleans as booleans.
 */
import { describe, expect, it } from 'vitest';
import {
  gatewayModeValue,
  gatewayVocabulary,
  groupVisibleFields,
  isFieldVisible,
  parseGatewayCfg,
  pickLocaleText,
} from './plugin-config';
import type { PluginConfigFieldInfo } from './api';

const enumField: PluginConfigFieldInfo = { key: 'mode', type: 'enum', values: ['none', 'custom', 'follow'] };

describe('isFieldVisible', () => {
  it('shows a field without a condition', () => {
    expect(isFieldVisible(enumField, {})).toBe(true);
  });

  it('matches equals on an enum sibling', () => {
    const list: PluginConfigFieldInfo = { key: 'models', type: 'string[]', visibleWhen: { key: 'mode', equals: 'custom' } };
    expect(isFieldVisible(list, { mode: 'custom' })).toBe(true);
    expect(isFieldVisible(list, { mode: 'follow' })).toBe(false);
    expect(isFieldVisible(list, {}), 'an unset sibling never matches').toBe(false);
  });

  it('matches in on a boolean sibling', () => {
    const cap: PluginConfigFieldInfo = { key: 'cap', type: 'number', visibleWhen: { key: 'enabled', in: [true] } };
    expect(isFieldVisible(cap, { enabled: true })).toBe(true);
    expect(isFieldVisible(cap, { enabled: false })).toBe(false);
  });

  it('does not confuse the string "true" with the boolean true', () => {
    const cap: PluginConfigFieldInfo = { key: 'cap', type: 'number', visibleWhen: { key: 'enabled', in: [true] } };
    expect(isFieldVisible(cap, { enabled: 'true' })).toBe(false);
  });

  it('leaves the draft untouched', () => {
    const draft = { mode: 'follow', models: 'a\nb' };
    const list: PluginConfigFieldInfo = { key: 'models', type: 'string[]', visibleWhen: { key: 'mode', equals: 'custom' } };
    expect(isFieldVisible(list, draft)).toBe(false);
    expect(draft).toEqual({ mode: 'follow', models: 'a\nb' });
  });
});

describe('pickLocaleText', () => {
  it('prefers the active UI language, then en-US, then any entry', () => {
    const map = { 'zh-CN': '抓取流量', 'en-US': 'Capture traffic' };
    expect(pickLocaleText(map, 'zh')).toBe('抓取流量');
    expect(pickLocaleText(map, 'ja')).toBe('Capture traffic');
    expect(pickLocaleText({ 'de-DE': 'Nur Deutsch' }, 'ja')).toBe('Nur Deutsch');
    expect(pickLocaleText('plain', 'zh')).toBe('plain');
    expect(pickLocaleText(undefined, 'zh')).toBeUndefined();
  });
});

describe('groupVisibleFields', () => {
  const sections = [
    { id: 'a', title: { 'zh-CN': '甲', 'en-US': 'A' } },
    { id: 'b', title: 'B', advanced: true },
  ];
  const field = (key: string, extra: Partial<PluginConfigFieldInfo> = {}): PluginConfigFieldInfo => ({
    key,
    type: 'string',
    ...extra,
  });

  it('puts ungrouped fields first, then declared sections in order', () => {
    const groups = groupVisibleFields(
      [field('loose'), field('one', { section: 'a' }), field('two', { section: 'b' })],
      sections,
      {}
    );
    expect(groups.map((g) => g.id)).toEqual([null, 'a', 'b']);
    expect(groups.map((g) => g.fields.map((f) => f.key))).toEqual([['loose'], ['one'], ['two']]);
  });

  it('drops a section whose fields are all hidden right now', () => {
    const groups = groupVisibleFields(
      [field('one', { section: 'a' }), field('two', { section: 'b', visibleWhen: { key: 'mode', equals: 'on' } })],
      sections,
      { mode: 'off' }
    );
    expect(groups.map((g) => g.id)).toEqual(['a']);
  });

  it('carries the advanced flag and the raw (untranslated) title', () => {
    const groups = groupVisibleFields([field('two', { section: 'b' })], sections, {});
    expect(groups[0].advanced).toBe(true);
    expect(groups[0].title).toEqual('B');
  });

  it('keeps schema order inside a group even when the array interleaves sections', () => {
    const groups = groupVisibleFields(
      [field('one', { section: 'a' }), field('two', { section: 'b' }), field('three', { section: 'a' })],
      sections,
      {}
    );
    expect(groups[0].fields.map((f) => f.key)).toEqual(['one', 'three']);
  });

  it('falls back to the ungrouped block for an unknown section id', () => {
    const groups = groupVisibleFields([field('x', { section: 'ghost' })], sections, {});
    expect(groups.map((g) => g.id)).toEqual([null]);
  });
});

/**
 * Gateway card vocabulary — Client Hub must persist what the gateway DECLARED.
 *
 * Regression: the shared card once hardcoded qoder-gateway's spelling
 * (`accountKeyId`, `none`) for every gateway, so saving the Cursor card sent
 * `none` to a manifest whose unset value is `all`. The host drops unknown keys
 * and falls back on a failed enum — with a warning — so the operator's
 * model-list choice silently reverted in the gateway. The key field name is
 * not hardcoded either: both gateways now declare `accountKeyId`, but the card
 * still reads whichever field carries `control: apiKey`.
 */
describe('gateway card vocabulary', () => {
  const cursorSchema: PluginConfigFieldInfo[] = [
    { key: 'model', type: 'string', default: 'auto', control: 'model' },
    { key: 'modelListMode', type: 'enum', default: 'all', values: ['all', 'custom', 'follow'], control: 'segmented' },
    { key: 'models', type: 'string[]', default: [], control: 'models' },
    { key: 'accountKeyId', type: 'string', default: '', control: 'apiKey' },
  ];
  const qoderSchema: PluginConfigFieldInfo[] = [
    { key: 'model', type: 'string', default: 'auto', control: 'model' },
    { key: 'modelListMode', type: 'enum', default: 'none', values: ['none', 'custom', 'follow'], control: 'segmented' },
    { key: 'models', type: 'string[]', default: [], control: 'models' },
    { key: 'accountKeyId', type: 'string', default: '', control: 'apiKey' },
  ];
  /** A future gateway may name its binding anything; the card must follow. */
  const renamedSchema: PluginConfigFieldInfo[] = [
    { key: 'modelListMode', type: 'enum', default: 'all', values: ['all', 'custom', 'follow'] },
    { key: 'gatewayKeyId', type: 'string', default: '', control: 'apiKey' },
  ];

  it('reads the unset spelling and key field from each manifest', () => {
    expect(gatewayVocabulary(cursorSchema)).toEqual({ unsetMode: 'all', keyField: 'accountKeyId' });
    expect(gatewayVocabulary(qoderSchema)).toEqual({ unsetMode: 'none', keyField: 'accountKeyId' });
    expect(gatewayVocabulary(renamedSchema)).toEqual({ unsetMode: 'all', keyField: 'gatewayKeyId' });
  });

  it('parses the stored binding from the declared field, not a fixed name', () => {
    const cursor = parseGatewayCfg({ modelListMode: 'all', accountKeyId: 'key-a' }, gatewayVocabulary(cursorSchema));
    expect(cursor.modelListMode).toBe('none');
    expect(cursor.boundKeyId).toBe('key-a');

    const qoder = parseGatewayCfg({ accountKeyId: 'key-b' }, gatewayVocabulary(qoderSchema));
    expect(qoder.modelListMode).toBe('none');
    expect(qoder.boundKeyId).toBe('key-b');

    const renamed = parseGatewayCfg({ gatewayKeyId: 'key-c' }, gatewayVocabulary(renamedSchema));
    expect(renamed.boundKeyId).toBe('key-c');
  });

  it('persists an enum value the manifest accepts for the UI "none" mode', () => {
    for (const schema of [cursorSchema, qoderSchema]) {
      const vocabulary = gatewayVocabulary(schema);
      const mode = schema.find((field) => field.key === 'modelListMode');
      expect(mode?.values).toContain(gatewayModeValue(vocabulary, 'none'));
      expect(gatewayModeValue(vocabulary, 'custom')).toBe('custom');
      expect(gatewayModeValue(vocabulary, 'follow')).toBe('follow');
    }
  });

  it('falls back safely when a schema declares neither', () => {
    const parsed = parseGatewayCfg(
      { modelListMode: 'custom', models: ['ocr/pro'] },
      { unsetMode: 'none', keyField: '' }
    );
    expect(parsed.modelListMode).toBe('custom');
    expect(parsed.models).toEqual(['pro']);
    expect(parsed.boundKeyId).toBe('');
  });
});
