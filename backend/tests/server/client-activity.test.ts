import { describe, it, expect } from 'bun:test';
import {
  noteClientSetup,
  noteClientActivityFromUserAgent,
  clientActivitySnapshot,
  resetClientActivity,
} from '../../src/cli/clients/activity.js';

describe('client activity ledger', () => {
  it('stamps setup and activity independently, merged per client', () => {
    resetClientActivity();
    noteClientSetup('claude', 1000);
    noteClientActivityFromUserAgent('claude-cli/2.1.317 (external, cli)', 2000);
    expect(clientActivitySnapshot()).toEqual({
      claude: { lastSetupAt: 1000, lastActiveAt: 2000 },
    });
  });

  it('fingerprints each known UA to its own client — first match wins', () => {
    resetClientActivity();
    noteClientActivityFromUserAgent('opencode/1.0.0', 10);
    noteClientActivityFromUserAgent('codex_cli_rs/0.20.0', 20);
    noteClientActivityFromUserAgent('Mozilla/5.0 (curl)', 30);
    noteClientActivityFromUserAgent(undefined, 40);
    const snap = clientActivitySnapshot();
    expect(snap.opencode).toEqual({ lastActiveAt: 10 });
    expect(snap.codex).toEqual({ lastActiveAt: 20 });
    // Unrecognized / absent UA: no client is stamped at all.
    expect(snap['curl']).toBeUndefined();
    expect(Object.keys(snap).sort()).toEqual(['codex', 'opencode']);
  });

  it('later activity overwrites the timestamp (last wins)', () => {
    resetClientActivity();
    noteClientActivityFromUserAgent('claude-cli/2', 100);
    noteClientActivityFromUserAgent('claude-cli/2', 200);
    expect(clientActivitySnapshot().claude).toEqual({ lastActiveAt: 200 });
  });
});
