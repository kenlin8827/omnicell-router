import { describe, expect, it } from 'bun:test';
import {
  HOST_ADAPTERS,
  BaseHostAdapter,
} from '../src/harness/host/adapters/index.js';
import { antigravityAdapter, AntigravityAdapter } from '../src/harness/host/adapters/antigravity.js';
import { claudeAdapter, ClaudeAdapter } from '../src/harness/host/adapters/claude.js';
import { codexAdapter, CodexAdapter } from '../src/harness/host/adapters/codex.js';
import { factoryAdapter, FactoryAdapter } from '../src/harness/host/adapters/factory.js';
import { opencodeAdapter, OpencodeAdapter } from '../src/harness/host/adapters/opencode.js';
import { piAdapter, PiAdapter } from '../src/harness/host/adapters/pi.js';
import { dshAdapter, DshAdapter } from '../src/harness/host/adapters/dsh.js';
import { getBuiltinViewsForHarness } from '../src/harness/plugin/builtin.js';
import { syncMarketplaceToAllHosts, removeMarketplaceFromAllHosts } from '../src/harness/host/marketplace-sync.js';
import type { ExecImpl } from '../src/harness/host/writers/plugin.js';

describe('Host Adapter Class Inheritance Hierarchy', () => {
  it('every registered adapter extends BaseHostAdapter', () => {
    for (const adapter of HOST_ADAPTERS) {
      expect(adapter instanceof BaseHostAdapter).toBe(true);
    }
  });

  it('specific adapters are instances of their concrete classes', () => {
    expect(antigravityAdapter instanceof AntigravityAdapter).toBe(true);
    expect(claudeAdapter instanceof ClaudeAdapter).toBe(true);
    expect(codexAdapter instanceof CodexAdapter).toBe(true);
    expect(factoryAdapter instanceof FactoryAdapter).toBe(true);
    expect(opencodeAdapter instanceof OpencodeAdapter).toBe(true);
    expect(piAdapter instanceof PiAdapter).toBe(true);
    expect(dshAdapter instanceof DshAdapter).toBe(true);
  });

  it('every adapter provides installPlugin, installSkill, installMcp methods', () => {
    for (const adapter of HOST_ADAPTERS) {
      const base = adapter as BaseHostAdapter;
      expect(typeof base.installPlugin).toBe('function');
      expect(typeof base.installSkill).toBe('function');
      expect(typeof base.installMcp).toBe('function');
      expect(typeof base.install).toBe('function');
    }
  });
});

describe('Native Plugin Installation & Source Verification (github | npm)', () => {
  it('Pi host natively ONLY supports npm plugin install and executes native pi install command', async () => {
    expect(piAdapter.supportedPluginSources()).toEqual(['npm']);

    // Attempt github install on Pi -> rejected
    const githubResult = await piAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
    });
    expect(githubResult.ok).toBe(false);
    if (!githubResult.ok) {
      expect(githubResult.code).toBe('bad_request');
      expect(githubResult.message).toContain('only supports npm');
    }

    // Plan check without confirm
    const npmPlan = await piAdapter.installPlugin({
      source: 'npm',
      spec: '@postman/postman-plugin',
    });
    expect(npmPlan.ok).toBe(false);
    if (!npmPlan.ok) {
      expect(npmPlan.code).toBe('confirm_required');
      expect(npmPlan.plan?.[0].echo).toContain('pi install npm:@postman/postman-plugin');
    }

    // Execution with confirm & mocked execImpl -> verify exact native argv
    const executed: { command: string; args: string[] }[] = [];
    const result = await piAdapter.installPlugin({
      source: 'npm',
      spec: '@postman/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executed.push({ command, args });
        return { code: 0, stdout: 'installed', stderr: '' };
      },
    });
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe('pi');
    expect(executed[0].args[0]).toBe('install');
    expect(executed[0].args[1]).toMatch(/^npm:@postman\/postman-plugin/);
  });

  it('Antigravity natively ONLY supports github plugin install and executes agy plugin install', async () => {
    expect(antigravityAdapter.supportedPluginSources()).toEqual(['github']);

    // Attempt npm install on Antigravity -> rejected
    const npmResult = await antigravityAdapter.installPlugin({
      source: 'npm',
      spec: '@postman/postman-plugin',
    });
    expect(npmResult.ok).toBe(false);
    if (!npmResult.ok) {
      expect(npmResult.code).toBe('bad_request');
      expect(npmResult.message).toContain('only supports github');
    }

    // Native github install executes: agy plugin install https://github.com/postmanlabs/postman-plugin
    const executed: { command: string; args: string[] }[] = [];
    const result = await antigravityAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executed.push({ command, args });
        return { code: 0, stdout: 'installed', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe('agy');
    expect(executed[0].args).toEqual(['plugin', 'install', 'https://github.com/postmanlabs/postman-plugin']);
  });

  it('Claude Code executes native marketplace commands for github and native install for npm', async () => {
    expect(claudeAdapter.supportedPluginSources()).toEqual(['github', 'npm']);

    // GitHub install executes:
    // 1. claude plugin marketplace add postmanlabs/postman-plugin
    // 2. claude plugin install postman@postman --scope user
    const executedGithub: { command: string; args: string[] }[] = [];
    const githubResult = await claudeAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executedGithub.push({ command, args });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(githubResult.ok).toBe(true);
    expect(executedGithub).toHaveLength(2);
    expect(executedGithub[0].command).toBe('claude');
    expect(executedGithub[0].args).toEqual(['plugin', 'marketplace', 'add', 'postmanlabs/postman-plugin']);
    expect(executedGithub[1].command).toBe('claude');
    expect(executedGithub[1].args).toEqual(['plugin', 'install', 'postman@postman', '--scope', 'user']);

    // npm install executes: claude plugin install @postman/postman-plugin --scope user
    const executedNpm: { command: string; args: string[] }[] = [];
    const npmResult = await claudeAdapter.installPlugin({
      source: 'npm',
      spec: '@postman/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executedNpm.push({ command, args });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(executedNpm).toHaveLength(1);
    expect(executedNpm[0].command).toBe('claude');
    expect(executedNpm[0].args[0]).toBe('plugin');
    expect(executedNpm[0].args[1]).toBe('install');
    expect(executedNpm[0].args[2]).toMatch(/^@postman\/postman-plugin/);
    expect(executedNpm[0].args[3]).toBe('--scope');
    expect(executedNpm[0].args[4]).toBe('user');
  });

  it('Codex executes native 3-command marketplace chain for github install', async () => {
    expect(codexAdapter.supportedPluginSources()).toEqual(['github']);

    const executed: { command: string; args: string[] }[] = [];
    const result = await codexAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executed.push({ command, args });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(3);
    expect(executed[0].command).toBe('codex');
    expect(executed[0].args).toEqual(['plugin', 'marketplace', 'add', 'postmanlabs/postman-plugin', '--ref', 'main']);
    expect(executed[1].command).toBe('codex');
    expect(executed[1].args).toEqual(['plugin', 'marketplace', 'upgrade', 'postman']);
    expect(executed[2].command).toBe('codex');
    expect(executed[2].args).toEqual(['plugin', 'add', 'postman@postman']);
  });

  it('Factory Droid executes native droid plugin marketplace chain', async () => {
    expect(factoryAdapter.supportedPluginSources()).toEqual(['github']);

    const executed: { command: string; args: string[] }[] = [];
    const result = await factoryAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executed.push({ command, args });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(2);
    expect(executed[0].command).toBe('droid');
    expect(executed[0].args).toEqual(['plugin', 'marketplace', 'add', 'https://github.com/postmanlabs/postman-plugin.git']);
    expect(executed[1].command).toBe('droid');
    expect(executed[1].args).toEqual(['plugin', 'install', 'postman@postman', '--scope', 'user']);
  });

  it('OpenCode executes native opencode plugin add command for github install', async () => {
    expect(opencodeAdapter.supportedPluginSources()).toEqual(['github', 'npm']);

    const executed: { command: string; args: string[] }[] = [];
    const result = await opencodeAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
      confirm: true,
      execImpl: async (command, args) => {
        executed.push({ command, args });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe('opencode');
    expect(executed[0].args).toEqual(['plugin', 'add', 'github:postmanlabs/postman-plugin']);
  });

  it('DSH refuses plugin and skills installs since it lacks those landings', async () => {
    expect(dshAdapter.supportedPluginSources()).toEqual([]);

    const pluginResult = await dshAdapter.installPlugin({
      source: 'github',
      spec: 'postmanlabs/postman-plugin',
    });
    expect(pluginResult.ok).toBe(false);

    const skillResult = await dshAdapter.installSkill({
      source: 'github',
      key: 'github:owner/repo#skill',
    });
    expect(skillResult.ok).toBe(false);

    const mcpResult = await dshAdapter.installMcp({
      source: 'github',
      key: 'github:owner/repo',
    });
    expect(mcpResult.ok).toBe(false);
  });
});

describe('Default Marketplace Architecture (No Hardcoded Presets - Real Native or Empty)', () => {
  it('resolves real native market for Pi (pi.dev)', () => {
    const piViews = getBuiltinViewsForHarness('pi');
    expect(piViews).toHaveLength(1);
    expect(piViews[0].id).toBe('pi-dev');
  });

  it('returns empty list for harnesses without native remote registry (no presets, user-managed)', () => {
    // There are no hardcoded presets — if a harness has no remote market, it is empty by default
    expect(getBuiltinViewsForHarness('claude')).toEqual([]);
    expect(getBuiltinViewsForHarness('codex')).toEqual([]);
    expect(getBuiltinViewsForHarness('github-copilot')).toEqual([]);
    expect(getBuiltinViewsForHarness('universal')).toEqual([]);
    expect(getBuiltinViewsForHarness('cursor')).toEqual([]);
    expect(getBuiltinViewsForHarness('cline')).toEqual([]);
  });
});

describe('Bidirectional Marketplace Synchronization', () => {
  it('syncs marketplace to native host agents executing native CLI commands', async () => {
    const executed: { cmd: string; args: string[] }[] = [];
    const mockExec: ExecImpl = async (cmd, args) => {
      executed.push({ cmd, args });
      return { code: 0, stdout: 'ok', stderr: '' };
    };

    const entry = {
      slug: 'team-plugins',
      repo: 'my-team/team-plugins',
      type: 'github' as const,
      enabled: true,
      addedAt: Date.now(),
      rescan: { enabled: false, intervalMs: 86400000 },
    };
    const syncResults = await syncMarketplaceToAllHosts(entry, mockExec);
    expect(syncResults.length).toBeGreaterThan(0);
    expect(syncResults.every((r) => r.ok)).toBe(true);

    const claudeSync = syncResults.find((r) => r.host === 'claude');
    expect(claudeSync?.command).toEqual(['claude', 'plugin', 'marketplace', 'add', 'my-team/team-plugins']);

    const codexSync = syncResults.find((r) => r.host === 'codex');
    expect(codexSync?.command).toEqual(['codex', 'plugin', 'marketplace', 'add', 'my-team/team-plugins', '--ref', 'main']);

    const copilotSync = syncResults.find((r) => r.host === 'github-copilot');
    expect(copilotSync?.command).toEqual(['copilot', 'plugin', 'marketplace', 'add', 'my-team/team-plugins']);

    const factorySync = syncResults.find((r) => r.host === 'factory');
    expect(factorySync?.command).toEqual(['droid', 'plugin', 'marketplace', 'add', 'https://github.com/my-team/team-plugins.git']);
  });

  it('removes marketplace from native host agents executing native remove commands', async () => {
    const executed: { cmd: string; args: string[] }[] = [];
    const mockExec: ExecImpl = async (cmd, args) => {
      executed.push({ cmd, args });
      return { code: 0, stdout: 'removed', stderr: '' };
    };
    const entry = {
      slug: 'team-plugins',
      repo: 'my-team/team-plugins',
      type: 'github' as const,
      enabled: true,
      addedAt: Date.now(),
      rescan: { enabled: false, intervalMs: 86400000 },
    };
    const removeResults = await removeMarketplaceFromAllHosts(entry, mockExec);
    expect(removeResults.length).toBeGreaterThan(0);

    const claudeRemove = removeResults.find((r) => r.host === 'claude');
    expect(claudeRemove?.command).toEqual(['claude', 'plugin', 'marketplace', 'remove', 'my-team/team-plugins']);

    const codexRemove = removeResults.find((r) => r.host === 'codex');
    expect(codexRemove?.command).toEqual(['codex', 'plugin', 'marketplace', 'remove', 'my-team/team-plugins']);

    const copilotRemove = removeResults.find((r) => r.host === 'github-copilot');
    expect(copilotRemove?.command).toEqual(['copilot', 'plugin', 'marketplace', 'remove', 'my-team/team-plugins']);

    const factoryRemove = removeResults.find((r) => r.host === 'factory');
    expect(factoryRemove?.command).toEqual(['droid', 'plugin', 'marketplace', 'remove', 'https://github.com/my-team/team-plugins.git']);
  });
});

