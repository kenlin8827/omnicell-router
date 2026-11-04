/**
 * `repoOfKey` — the repository half of an installed artifact's identity.
 *
 * The regression this guards is real and was user-visible: the detail dialog derives its upstream
 * from `canonicalKey`, and it only understood `gh:`/`github:`. A runtime store writes
 * `git:github.com/<owner>/<repo>` (pi's `packages[]`) and an operator git marketplace writes
 * `mp-<slug>:<owner>/<repo>#`, so those installed rows opened an EMPTY dialog while the market row
 * for the same plugin answered a README.
 */
import { describe, expect, it } from 'vitest';
import { repoOfKey } from './harness-keys';

describe('repoOfKey', () => {
  it('reads the market writers’ github shape, with or without a directory', () => {
    expect(repoOfKey('github:owner/repo')).toBe('owner/repo');
    expect(repoOfKey('github:owner/repo#skills/one')).toBe('owner/repo');
    expect(repoOfKey('gh:Owner/Repo')).toBe('Owner/Repo');
  });

  it('reads a runtime store’s git spec', () => {
    expect(repoOfKey('git:github.com/NVlabs/SoL-Pi')).toBe('NVlabs/SoL-Pi');
    expect(repoOfKey('git:https://github.com/owner/repo')).toBe('owner/repo');
    expect(repoOfKey('git:https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(repoOfKey('git:git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(repoOfKey('git:github.com/owner/repo#main')).toBe('owner/repo');
  });

  it('reads an operator git marketplace’s key', () => {
    expect(repoOfKey('mp-postman:postmanlabs/postman-plugin#')).toBe('postmanlabs/postman-plugin');
    expect(repoOfKey('mp-postman-plugin:postmanlabs/postman-plugin#postman')).toBe(
      'postmanlabs/postman-plugin'
    );
  });

  it('answers null for shapes that name no GitHub repository', () => {
    expect(repoOfKey('npm:pi-chrome')).toBeNull();
    expect(repoOfKey('npm:@juicesharp/rpiv-todo')).toBeNull();
    expect(repoOfKey('clawhub:owner/slug')).toBeNull();
    expect(repoOfKey('claude:codex@openai-codex')).toBeNull();
    expect(repoOfKey('manual:dbhub')).toBeNull();
    expect(repoOfKey(null)).toBeNull();
    expect(repoOfKey('')).toBeNull();
  });

  it('never turns a non-GitHub host into a repository', () => {
    expect(repoOfKey('git:gitlab.com/owner/repo')).toBeNull();
    expect(repoOfKey('git:bitbucket.org/team')).toBeNull();
    expect(repoOfKey('git:example.com/repo')).toBeNull();
  });
});
