import { describe, expect, it } from 'bun:test';
import fastify from 'fastify';
import {
  appendInstallLog,
  finishInstallLog,
  readInstallLog,
  startInstallLog,
} from '../src/harness/host/install-log.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

describe('install log ring', () => {
  it('stitches partial chunks and flushes the tail on finish', () => {
    expect(startInstallLog('log-test-partial')).toBe(true);
    appendInstallLog('log-test-partial', 'stdout', 'hel');
    appendInstallLog('log-test-partial', 'stdout', 'lo\nwor');
    appendInstallLog('log-test-partial', 'stdout', 'ld');
    appendInstallLog('log-test-partial', 'stderr', 'warn');
    expect(readInstallLog('log-test-partial')).toEqual({
      lines: ['hello'],
      done: false,
    });
    finishInstallLog('log-test-partial');
    expect(readInstallLog('log-test-partial')).toEqual({
      lines: ['hello', 'world', '! warn'],
      done: true,
    });
  });

  it('strips ANSI colour codes and keeps the final carriage-return frame', () => {
    expect(startInstallLog('log-test-ansi')).toBe(true);
    appendInstallLog(
      'log-test-ansi',
      'stdout',
      '\u001b[32m✓\u001b[39m Lockfile\nProgress: 1\rProgress: 2\rProgress: 3\n'
    );
    expect(readInstallLog('log-test-ansi')?.lines).toEqual(['✓ Lockfile', 'Progress: 3']);
  });

  it('rejects ids the console could not have generated', () => {
    expect(startInstallLog('short')).toBe(false);
    expect(readInstallLog('short')).toBeUndefined();
  });

  it('keeps the terminal error on the snapshot', () => {
    expect(startInstallLog('log-test-error')).toBe(true);
    finishInstallLog('log-test-error', 'timed out after 900000ms');
    expect(readInstallLog('log-test-error')).toEqual({
      lines: [],
      done: true,
      error: 'timed out after 900000ms',
    });
  });
});

describe('install log route', () => {
  it('serves a live log and answers 404 for an id the console could not have or one already expired', async () => {
    expect(startInstallLog('log-route-live')).toBe(true);
    appendInstallLog('log-route-live', 'stdout', 'resolving\n');

    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();

    const live = await app.inject({ method: 'GET', url: '/api/admin/harness/install-log/log-route-live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok', lines: ['resolving'], done: false });

    // Unknown id: the console must get 404 (its poller then stops) rather than an empty log that
    // reads as "the install produced no output".
    const unknown = await app.inject({ method: 'GET', url: '/api/admin/harness/install-log/log-route-absent' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ status: 'error', code: 'not_found' });

    finishInstallLog('log-route-live');
    const done = await app.inject({ method: 'GET', url: '/api/admin/harness/install-log/log-route-live' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'ok', done: true });
    await app.close();
  });
});
