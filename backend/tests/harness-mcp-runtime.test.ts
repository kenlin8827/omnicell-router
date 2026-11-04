import { describe, expect, it } from 'bun:test';
import { probeOpencodeMcpRuntime } from '../src/harness/host/opencode-mcp-runtime.js';
import type { OpencodeV2ServiceConfig } from '../src/opencode/credentials/opencode-v2-store.js';

/**
 * Live MCP status (ADR-0015 §D8.8) — the runtime's own answer, not an inference from the config file.
 *
 * These cases pin the honesty rules: the service vocabulary maps 1:1 (including the failure text),
 * a reachable runtime with a healthy server reports it, and every "cannot ask" path answers
 * `reachable: false` instead of inventing a health verdict.
 */

const CONFIG: OpencodeV2ServiceConfig = {
  baseUrl: 'http://127.0.0.1:4999',
  authHeader: 'Basic b3BlbmNvZGU6c2VjcmV0',
  password: 'secret',
  targetPolicy: 'loopback',
};

function responding(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('probeOpencodeMcpRuntime', () => {
  it('maps the runtime vocabulary and keeps the failure text', async () => {
    const result = await probeOpencodeMcpRuntime({
      config: CONFIG,
      fetchImpl: responding({
        data: [
          { name: 'brave', status: { status: 'connected' } },
          { name: 'postman', status: { status: 'needs_auth', error: 'login required' } },
          { name: 'broken', status: { status: 'failed', error: 'spawn ENOENT' } },
          { name: 'off', status: { status: 'disabled' } },
          { name: 'starting', status: { status: 'pending' } },
          { name: 'malformed', status: { status: 'unknown-state' } },
          { status: { status: 'connected' } },
        ],
      }),
    });
    expect(result.reachable).toBe(true);
    expect(result.servers).toEqual([
      { name: 'brave', status: 'connected' },
      { name: 'postman', status: 'needs_auth', error: 'login required' },
      { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
      { name: 'off', status: 'disabled' },
      { name: 'starting', status: 'pending' },
    ]);
  });

  it('calls the service endpoint with its Basic authorization', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get('Authorization');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeOpencodeMcpRuntime({ config: CONFIG, fetchImpl });
    expect(result).toEqual({ reachable: true, servers: [] });
    expect(seenUrl).toBe('http://127.0.0.1:4999/api/mcp');
    expect(seenAuth).toBe(CONFIG.authHeader);
  });

  it('answers "no live claim" when the service is absent, refuses, or answers a foreign shape', async () => {
    expect(await probeOpencodeMcpRuntime({ config: null })).toEqual({
      reachable: false,
      message: 'opencode v2 service credentials not found',
      servers: [],
    });
    expect(await probeOpencodeMcpRuntime({ config: CONFIG, fetchImpl: responding({}, 503) })).toEqual({
      reachable: false,
      message: 'opencode /api/mcp answered HTTP 503',
      servers: [],
    });
    expect(await probeOpencodeMcpRuntime({ config: CONFIG, fetchImpl: responding({ servers: [] }) })).toEqual({
      reachable: false,
      message: 'opencode /api/mcp returned an unexpected shape',
      servers: [],
    });
  });

  it('turns a transport failure into reachable:false, never a failed server', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeOpencodeMcpRuntime({ config: CONFIG, fetchImpl });
    expect(result.reachable).toBe(false);
    expect(result.servers).toEqual([]);
    expect(result.message).toContain('ECONNREFUSED');
  });
});
