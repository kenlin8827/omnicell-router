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
import { groupVisibleFields, isFieldVisible, pickLocaleText } from './plugin-config';
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
