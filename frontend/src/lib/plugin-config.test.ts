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
  drawerFields,
  formatAliasSpec,
  gatewayCardShape,
  gatewayModeValue,
  gatewayVocabulary,
  groupVisibleFields,
  isFieldVisible,
  matchAliasPattern,
  parseAliasRows,
  parseAliasSpec,
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
 * Regression: the shared card once hardcoded one gateway's unset spelling for
 * every gateway, so saving another card wrote a value its manifest never
 * declared. The host drops unknown keys and falls back on a failed enum — with
 * a warning — so the operator's model-list choice silently reverted in the
 * gateway. Both halves stay manifest-derived: the
 * unset spelling (the synthetic `unset` fixture below proves the card never
 * invents the UI word) and the key field (both gateways now declare
 * `accountKeyId`, but the card still reads whichever field carries
 * `control: apiKey`).
 */
describe('gateway card vocabulary', () => {
  const cursorSchema: PluginConfigFieldInfo[] = [
    { key: 'model', type: 'string', default: 'auto', control: 'model' },
    { key: 'modelListMode', type: 'enum', default: 'default', values: ['default', 'custom', 'follow'], control: 'segmented' },
    { key: 'models', type: 'string[]', default: [], control: 'models' },
    { key: 'accountKeyId', type: 'string', default: '', control: 'apiKey' },
  ];
  const qoderSchema: PluginConfigFieldInfo[] = [
    { key: 'model', type: 'string', default: 'auto', control: 'model' },
    { key: 'modelListMode', type: 'enum', default: 'default', values: ['default', 'custom', 'follow'], control: 'segmented' },
    { key: 'models', type: 'string[]', default: [], control: 'models' },
    { key: 'accountKeyId', type: 'string', default: '', control: 'apiKey' },
  ];
  /** jetbrains-gateway ships the qoder spelling (unset = `none`); its card is
   *  the same generic editor, so the vocabulary must come from ITS manifest. */
  const jetbrainsSchema: PluginConfigFieldInfo[] = [
    { key: 'model', type: 'string', default: 'auto', control: 'model' },
    { key: 'modelListMode', type: 'enum', default: 'default', values: ['default', 'custom', 'follow'] },
    { key: 'models', type: 'string[]', default: [] },
    { key: 'accountKeyId', type: 'string', default: '', control: 'apiKey' },
  ];
  /** A future gateway may name its binding and its unset spelling anything;
   *  `unset` is arbitrary and never a shipped value — the card must echo
   *  whatever the manifest declares, never the console's own word. */
  const renamedSchema: PluginConfigFieldInfo[] = [
    { key: 'modelListMode', type: 'enum', default: 'unset', values: ['unset', 'custom', 'follow'] },
    { key: 'gatewayKeyId', type: 'string', default: '', control: 'apiKey' },
  ];

  it('reads the unset spelling and key field from each manifest', () => {
    expect(gatewayVocabulary(cursorSchema)).toEqual({ unsetMode: 'default', keyField: 'accountKeyId' });
    expect(gatewayVocabulary(qoderSchema)).toEqual({ unsetMode: 'default', keyField: 'accountKeyId' });
    expect(gatewayVocabulary(jetbrainsSchema)).toEqual({ unsetMode: 'default', keyField: 'accountKeyId' });
    expect(gatewayVocabulary(renamedSchema)).toEqual({ unsetMode: 'unset', keyField: 'gatewayKeyId' });
  });

  it('parses the stored binding from the declared field, not a fixed name', () => {
    const cursor = parseGatewayCfg({ modelListMode: 'default', accountKeyId: 'key-a' }, gatewayVocabulary(cursorSchema));
    expect(cursor.modelListMode).toBe('default');
    expect(cursor.boundKeyId).toBe('key-a');

    const qoder = parseGatewayCfg({ accountKeyId: 'key-b' }, gatewayVocabulary(qoderSchema));
    expect(qoder.modelListMode).toBe('default');
    expect(qoder.boundKeyId).toBe('key-b');

    const renamed = parseGatewayCfg({ gatewayKeyId: 'key-c' }, gatewayVocabulary(renamedSchema));
    expect(renamed.boundKeyId).toBe('key-c');
  });

  it('persists an enum value the manifest accepts for the UI "Default" mode', () => {
    for (const schema of [cursorSchema, qoderSchema, renamedSchema]) {
      const vocabulary = gatewayVocabulary(schema);
      const mode = schema.find((field) => field.key === 'modelListMode');
      expect(mode?.values).toContain(gatewayModeValue(vocabulary, 'default'));
      expect(gatewayModeValue(vocabulary, 'custom')).toBe('custom');
      expect(gatewayModeValue(vocabulary, 'follow')).toBe('follow');
    }
  });

  it('defaults the ocr/ namespace toggle OFF until the operator opts in', () => {
    const vocabulary = gatewayVocabulary(cursorSchema);
    expect(parseGatewayCfg({}, vocabulary).catalogPrefix).toBe(false);
    expect(parseGatewayCfg({ catalogPrefix: true }, vocabulary).catalogPrefix).toBe(true);
    expect(parseGatewayCfg({ catalogPrefix: false }, vocabulary).catalogPrefix).toBe(false);
  });

  it('falls back safely when a schema declares neither', () => {
    const parsed = parseGatewayCfg(
      { modelListMode: 'custom', models: ['ocr/pro'] },
      { unsetMode: 'default', keyField: '' }
    );
    expect(parsed.modelListMode).toBe('custom');
    expect(parsed.models).toEqual(['pro']);
    expect(parsed.boundKeyId).toBe('');
  });

  it('reads an older package’s `none` spelling as the Default mode', () => {
    // Core derives the spelling from the manifest, so an installed package that
    // still declares `none` keeps working: any non-custom/follow value is the
    // no-list-set state.
    const legacy = parseGatewayCfg({ modelListMode: 'none' }, { unsetMode: 'none', keyField: '' });
    expect(legacy.modelListMode).toBe('default');
  });
});

describe('gatewayCardShape', () => {
  it('draws the shared model-list block only for a gateway that declares it', () => {
    const cursorLike: PluginConfigFieldInfo[] = [
      { key: 'model', type: 'string' },
      { key: 'forceModel', type: 'boolean' },
      { key: 'modelListMode', type: 'enum', values: ['default', 'custom', 'follow'] },
      { key: 'models', type: 'string[]' },
    ];
    expect(gatewayCardShape(cursorLike)).toEqual({ modelList: true, routingDefault: true });
    // A mapping-table gateway adds no models: neither block may render.
    const aliasOnly: PluginConfigFieldInfo[] = [
      { key: 'accountKeyId', type: 'string' },
      { key: 'modelAliases', type: 'string[]', control: 'aliases' },
    ];
    expect(gatewayCardShape(aliasOnly)).toEqual({ modelList: false, routingDefault: false });
  });
});

describe('alias rows', () => {
  it('parses `clientId=target[@effort][#label]` and drops entries that could never match', () => {
    expect(parseAliasSpec('gemini-4-argon-high=kimi-code-plan-cn/k3#OCR · K3')).toEqual({
      clientId: 'gemini-4-argon-high',
      target: 'kimi-code-plan-cn/k3',
      effort: '',
      label: 'OCR · K3',
    });
    expect(parseAliasSpec('gemini-4-argon-high=workbuddy/default-model')).toEqual({
      clientId: 'gemini-4-argon-high',
      target: 'workbuddy/default-model',
      effort: '',
      label: '',
    });
    // A trailing ladder token pins the level; the label may still follow.
    expect(parseAliasSpec('gemini-4-hydrogen-high=deepseek/deepseek-flash@high#OCR · Flash')).toEqual({
      clientId: 'gemini-4-hydrogen-high',
      target: 'deepseek/deepseek-flash',
      effort: 'high',
      label: 'OCR · Flash',
    });
    // Only a LADDER token is a level — anything else stays part of the id.
    expect(parseAliasSpec('a=vendor/model@2026-11')).toEqual({ clientId: 'a', target: 'vendor/model@2026-11', effort: '', label: '' });
    expect(parseAliasSpec('no-equals')).toBeUndefined();
    expect(parseAliasSpec('=target')).toBeUndefined();
    expect(parseAliasSpec('client=')).toBeUndefined();
    expect(parseAliasRows(['a=b', 'junk', 'c=d#L'])).toEqual([
      { clientId: 'a', target: 'b', effort: '', label: '' },
      { clientId: 'c', target: 'd', effort: '', label: 'L' },
    ]);
  });

  it('formats a row back into the stored spelling, and refuses an incomplete one', () => {
    expect(formatAliasSpec({ clientId: ' a ', target: 'b/c', effort: '', label: '' })).toBe('a=b/c');
    expect(formatAliasSpec({ clientId: 'a', target: 'b/c', effort: '', label: 'OCR · X' })).toBe('a=b/c#OCR · X');
    expect(formatAliasSpec({ clientId: 'a', target: 'b/c', effort: 'xhigh', label: '' })).toBe('a=b/c@xhigh');
    expect(formatAliasSpec({ clientId: 'a', target: 'b/c', effort: 'none', label: 'OCR · X' })).toBe('a=b/c@none#OCR · X');
    expect(formatAliasSpec({ clientId: 'a', target: '  ', effort: '', label: '' })).toBe('');
    expect(formatAliasSpec({ clientId: '', target: 'b', effort: '', label: '' })).toBe('');
  });

  it('round-trips a level-pinned row', () => {
    const spec = 'gemini-4-hydrogen-xhigh=deepseek/deepseek-flash@xhigh#OCR · Flash XL';
    expect(formatAliasSpec(parseAliasSpec(spec)!)).toBe(spec);
  });
});

describe('matchAliasPattern', () => {
  const ids = ['gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-4-neon-high', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'];

  it('expands `*` over the client ids and ignores case', () => {
    expect(matchAliasPattern('gemini-4*', ids)).toEqual(['gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-4-neon-high']);
    expect(matchAliasPattern('*-high', ids)).toEqual(['gemini-4-argon-high', 'gemini-4-neon-high', 'claude-opus-5-5-high']);
    expect(matchAliasPattern('GEMINI-4-ARGON-*', ids)).toEqual(['gemini-4-argon-high', 'gemini-4-argon-low']);
    expect(matchAliasPattern('gpt-oss-120b-medium', ids)).toEqual(['gpt-oss-120b-medium']);
  });

  it('treats everything but `*` literally and matches nothing on an empty pattern', () => {
    expect(matchAliasPattern('gemini.4*', ids)).toEqual([]);
    expect(matchAliasPattern('gemini-4-*-(high|low)', ids)).toEqual([]);
    expect(matchAliasPattern('   ', ids)).toEqual([]);
  });
});
describe('drawerFields', () => {
  const field = (key: string, extra: Record<string, unknown> = {}) =>
    ({ key, type: 'boolean' as const, ...extra });

  it('renders every drawer field when the schema marks no essentials', () => {
    // The gateway manifests declare no `essential`, so the quick subset must not
    // apply — filtering by it emptied the settings drawer (a Save button over an
    // empty body) for every one of them.
    const schema = [field('logFrames'), field('interceptGenerate'), field('errorAsText')];
    expect(drawerFields(schema, 'quick').map((f) => f.key)).toEqual(['logFrames', 'interceptGenerate', 'errorAsText']);
  });

  it('keeps card fields and the apiKey control out of the drawer', () => {
    const schema = [
      field('logFrames'),
      field('modelAliases', { placement: 'card' }),
      field('accountKeyId', { control: 'apiKey' }),
    ];
    expect(drawerFields(schema, 'advanced').map((f) => f.key)).toEqual(['logFrames']);
  });

  it('narrows to essentials only when the schema declares them', () => {
    const schema = [field('a', { essential: true }), field('b'), field('c', { essential: true })];
    expect(drawerFields(schema, 'quick').map((f) => f.key)).toEqual(['a', 'c']);
    expect(drawerFields(schema, 'advanced').map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });
});
