import { beforeEach, describe, expect, it } from 'bun:test';
import { resetSandbox, runPlaygroundTool } from '../../frontend/src/lib/playground-tools';

describe('playground tool path normalization', () => {
  beforeEach(() => {
    resetSandbox();
  });

  it('accepts trailing slashes emitted by ls() in ls and grep', () => {
    const rootListing = runPlaygroundTool('ls', '{}');
    expect(rootListing).toContain('src/');

    expect(runPlaygroundTool('ls', '{"path":"src/"}')).toBe('index.ts\nutil.ts');
    expect(runPlaygroundTool('grep', '{"pattern":"add","path":"src/"}')).toContain('src/util.ts:1:');
  });

  it('accepts sandbox root spellings "." and "/" in ls and grep', () => {
    const expectedRoot = runPlaygroundTool('ls', '{}');
    expect(runPlaygroundTool('ls', '{"path":"."}')).toBe(expectedRoot);
    expect(runPlaygroundTool('ls', '{"path":"./"}')).toBe(expectedRoot);
    expect(runPlaygroundTool('ls', '{"path":"/"}')).toBe(expectedRoot);
    expect(runPlaygroundTool('ls', '{"path":""}')).toBe(expectedRoot);

    const expectedGrep = runPlaygroundTool('grep', '{"pattern":"Sandbox"}');
    expect(runPlaygroundTool('grep', '{"pattern":"Sandbox","path":"."}')).toBe(expectedGrep);
    expect(runPlaygroundTool('grep', '{"pattern":"Sandbox","path":"/"}')).toBe(expectedGrep);
  });

  it('still rejects parent traversal and root paths on file-only tools', () => {
    expect(runPlaygroundTool('ls', '{"path":".."}')).toBe('error: path must be a relative path inside the sandbox');
    expect(runPlaygroundTool('ls', '{"path":"src/../.."}')).toBe('error: path must be a relative path inside the sandbox');
    expect(runPlaygroundTool('grep', '{"pattern":"a","path":"../etc"}')).toBe(
      'error: path must be a relative path inside the sandbox',
    );
    expect(runPlaygroundTool('read', '{"path":"."}')).toBe('error: path must be a relative path inside the sandbox');
    expect(runPlaygroundTool('read', '{"path":"/"}')).toBe('error: path must be a relative path inside the sandbox');
  });
});
