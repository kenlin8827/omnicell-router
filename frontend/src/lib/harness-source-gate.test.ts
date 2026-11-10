import { describe, expect, it } from 'vitest';
import { needsHostDetection } from './harness-source-gate';

describe('needsHostDetection', () => {
  it('gates a repository source on the detected forms', () => {
    expect(needsHostDetection('github', 'owner/repo')).toBe(true);
    expect(needsHostDetection('github', 'https://github.com/owner/repo')).toBe(true);
  });

  it('never gates a package source: a registry has no per-harness form to detect', () => {
    expect(needsHostDetection('npm', 'dsh-plugin-codegraph')).toBe(false);
    expect(needsHostDetection('npm', '@scope/*')).toBe(false);
    expect(needsHostDetection('pypi', 'mcp-server-fetch')).toBe(false);
  });

  it('follows the backend spelling: an `npm:` prefix is a package even under the GitHub tab', () => {
    expect(needsHostDetection('github', 'npm:dsh-plugin-codegraph')).toBe(false);
    expect(needsHostDetection('github', '  npm:@scope/pkg  ')).toBe(false);
  });
});
