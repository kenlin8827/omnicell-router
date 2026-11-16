import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SESSION_EXPIRED_EVENT,
  _resetSessionGuardForTests,
  installSessionGuard,
  isConsoleAuthRequired,
} from './sessionGuard';

/**
 * The guard is the console's only global 401 handler: without it every page
 * rendered a dead session as a generic `HTTP 401` and the operator stayed on a
 * console that could not do anything. These tests pin the three parts that can
 * silently rot — which 401 bodies mean "session gone", that a wrong console
 * password is NOT one of them, and that the patched fetch stays transparent.
 */

const authRequiredBody = JSON.stringify({
  error: {
    message: 'Console authentication required.',
    type: 'authentication_error',
    code: 'console_auth_required',
  },
});

describe('isConsoleAuthRequired', () => {
  it('recognizes the webAuth gate envelope', () => {
    expect(isConsoleAuthRequired(authRequiredBody)).toBe(true);
  });

  it('does not treat a wrong console password as an expired session', () => {
    expect(isConsoleAuthRequired(JSON.stringify({ status: 'error', success: false, reasonCode: 'invalid_password', error: 'Invalid password' }))).toBe(false);
    expect(isConsoleAuthRequired(JSON.stringify({ success: false, message: 'Invalid username or password' }))).toBe(false);
  });

  it('does not treat an inference-surface key error as an expired session', () => {
    expect(isConsoleAuthRequired(JSON.stringify({ error: { code: 'missing_api_key' } }))).toBe(false);
    expect(isConsoleAuthRequired(JSON.stringify({ error: { code: 'invalid_api_key' } }))).toBe(false);
  });

  it('never locks on an empty or non-JSON body', () => {
    expect(isConsoleAuthRequired('')).toBe(false);
    expect(isConsoleAuthRequired('<html>401</html>')).toBe(false);
    expect(isConsoleAuthRequired('{"error":')).toBe(false);
  });
});

describe('installSessionGuard', () => {
  const realFetch = globalThis.fetch;
  let dispatch: MockInstance<(e: Event) => boolean>;

  beforeEach(() => {
    dispatch = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    _resetSessionGuardForTests();
    globalThis.fetch = realFetch;
    dispatch.mockRestore();
  });

  const respondWith = (status: number, body = '{}'): void => {
    const stub = vi.fn(async () => new Response(body, { status }));
    globalThis.fetch = stub as unknown as typeof fetch;
    _resetSessionGuardForTests();
    installSessionGuard();
  };

  it('fires the expiry event for the console-auth gate and still returns the response intact', async () => {
    respondWith(401, authRequiredBody);
    const res = await fetch('/api/admin/status');
    expect(res.status).toBe(401);
    // The caller can still read the body: the guard inspected a clone.
    expect((await res.json()).error.code).toBe('console_auth_required');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0] as Event).type).toBe(SESSION_EXPIRED_EVENT);
  });

  it('stays silent for a wrong console password on a credential endpoint', async () => {
    respondWith(401, JSON.stringify({ success: false, reasonCode: 'invalid_password' }));
    const res = await fetch('/api/admin/opencode/providers/x/credentials/y/reveal', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('stays silent for a successful admin response', async () => {
    respondWith(200, '{"ok":true}');
    await fetch('/api/admin/status');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('is idempotent — a second install leaves one wrapper, so one event per response', async () => {
    respondWith(401, authRequiredBody);
    installSessionGuard();
    installSessionGuard();
    await fetch('/api/admin/status');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
