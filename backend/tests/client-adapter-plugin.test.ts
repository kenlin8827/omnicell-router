import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPluginClientAdapters,
  getPluginClientAdapter,
  listPluginClientAdapters,
  registerPluginClientAdapter,
} from '../src/cli/clients/plugin-adapters.js';
import { isCoreClientId } from '../src/cli/clients/reserved.js';
import type { ClientAdapter } from '../src/cli/clients/base.js';

/**
 * The client-adapter plugin seam (ADR-0027).
 *
 * What is contractual here is not "an adapter can be listed" — it is the two
 * refusals: a package may never shadow a hook this build ships, and two
 * packages may never fight over one client id. Both are silent-override bugs
 * waiting to happen, so they must fail at LOAD with the package's own error.
 */

const fake = (name: string): ClientAdapter =>
  ({
    name,
    displayName: `Fake ${name}`,
    hookKind: 'service-env',
    getConfigPath: () => '/tmp/none',
    getStatus: async () => ({
      name,
      displayName: `Fake ${name}`,
      configPath: '/tmp/none',
      exists: true,
      hooked: false,
      backupExists: false,
      details: '',
      modelSlots: [],
    }),
    setup: async () => ({ success: true, message: 'ok' }),
    teardown: async () => ({ success: true, message: 'ok' }),
  }) as unknown as ClientAdapter;

beforeEach(() => clearPluginClientAdapters());

describe('client-adapter plugin registry (ADR-0027)', () => {
  it('a core hook id can never be claimed by a package', () => {
    // `opencode` is a built-in hook — a package providing it would make the
    // Client Hub row depend on install order.
    assert.equal(isCoreClientId('opencode'), true);
    assert.throws(() => registerPluginClientAdapter('evil', fake('opencode')), /built-in hook/);
    assert.equal(getPluginClientAdapter('opencode'), undefined);
  });

  it('two packages cannot fight over one client id', () => {
    registerPluginClientAdapter('first', fake('acme-cli'));
    assert.throws(() => registerPluginClientAdapter('second', fake('acme-cli')), /already provided by plugin 'first'/);
    // The first registration survives the refusal.
    assert.equal(listPluginClientAdapters().length, 1);
  });

  it('a reload of the SAME package replaces its own row', () => {
    registerPluginClientAdapter('first', fake('acme-cli'));
    const replacement = fake('acme-cli');
    registerPluginClientAdapter('first', replacement);
    assert.equal(getPluginClientAdapter('acme-cli'), replacement);
  });

  it('clearing drops every contributed adapter (rebuild/disable/uninstall)', () => {
    registerPluginClientAdapter('first', fake('acme-cli'));
    registerPluginClientAdapter('second', fake('other-cli'));
    assert.equal(listPluginClientAdapters().length, 2);
    clearPluginClientAdapters();
    assert.equal(listPluginClientAdapters().length, 0);
    assert.equal(getPluginClientAdapter('acme-cli'), undefined);
  });

  it('an adapter without a name is refused instead of becoming an unreachable row', () => {
    assert.throws(() => registerPluginClientAdapter('broken', fake('')), /no adapter name/);
  });
});
