import { describe, expect, it } from 'vitest';
import { pluginWarningText } from './warnings';

const labels = {
  junie_wmi_hung: {
    'zh-CN': 'WMI 无响应 —— {detail}。',
    'en-US': 'WMI stopped answering — {detail}.',
  },
  plain: 'A plain string label with {path}.',
};

describe('pluginWarningText', () => {
  it('picks the active locale and fills every param slot', () => {
    expect(pluginWarningText(labels, 'junie_wmi_hung', { detail: 'repair WMI' }, 'zh')).toBe(
      'WMI 无响应 —— repair WMI。'
    );
    expect(pluginWarningText(labels, 'junie_wmi_hung', { detail: 'repair WMI' }, 'en')).toBe(
      'WMI stopped answering — repair WMI.'
    );
  });

  it('falls back to en-US for a language the label does not declare', () => {
    expect(pluginWarningText(labels, 'junie_wmi_hung', { detail: 'x' }, 'de')).toBe('WMI stopped answering — x.');
  });

  it('leaves an undeclared code undefined so the console keeps its own copy', () => {
    expect(pluginWarningText(labels, 'ca_not_trusted', {}, 'en')).toBeUndefined();
    expect(pluginWarningText(undefined, 'junie_wmi_hung', {}, 'en')).toBeUndefined();
  });

  it('handles a plain-string label and missing params', () => {
    expect(pluginWarningText(labels, 'plain', { path: '/tmp/x' }, 'zh')).toBe('A plain string label with /tmp/x.');
    expect(pluginWarningText(labels, 'junie_wmi_hung', undefined, 'en')).toBe('WMI stopped answering — {detail}.');
  });
});
