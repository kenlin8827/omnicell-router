import { describe, expect, it } from 'bun:test';
import { searchMcpRegistry } from '../src/harness/host/mcp-registry.js';

/**
 * MCP Registry parameter schema reader (ADR-0015 §D8 amendment).
 *
 * The reader feeds a VISUAL form, so its job is narrow and defensive: normalize the registry's own
 * `server.json` declarations into a capped shape, keep secret/required/format/choices intact, drop
 * anything malformed, and never let a broad search or a hostile upstream grow the dialog.
 */

interface Call {
  url: string;
}

function stub(payload: unknown, init: { status?: number; text?: string } = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push({ url: String(input) });
    const body = init.text ?? JSON.stringify(payload);
    return new Response(body, { status: init.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** URL-routed stub: the first matching route answers; anything else is a 404. */
function routed(
  routes: { when: (url: string) => boolean; payload?: unknown; status?: number; text?: string }[]
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url });
    const route = routes.find((item) => item.when(url));
    if (!route) return new Response('{}', { status: 404 });
    return new Response(route.text ?? JSON.stringify(route.payload ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const dbhub = {
  servers: [
    {
      server: {
        name: 'io.github.bytebase/dbhub',
        title: 'DBHub',
        description: 'Minimal Database MCP Server',
        version: '1.5.0',
        repository: { url: 'https://github.com/bytebase/dbhub', source: 'github' },
        packages: [
          {
            registryType: 'npm',
            identifier: '@bytebase/dbhub',
            version: '1.5.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'DSN', description: 'Connection string', format: 'string', isSecret: true },
              { name: 'DB_PORT', description: 'Port', format: 'number' },
              { name: 'DB_TYPE', description: 'Type', format: 'string', default: 'postgres' },
            ],
          },
        ],
      },
    },
  ],
};

describe('searchMcpRegistry', () => {
  it('normalizes a stdio npm package and its declared inputs', async () => {
    const { fetchImpl, calls } = stub(dbhub);
    const result = await searchMcpRegistry('dbhub', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(calls[0]?.url).toContain('search=dbhub');
    expect(calls[0]?.url).toContain('version=latest');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate).toMatchObject({
      name: 'io.github.bytebase/dbhub',
      title: 'DBHub',
      version: '1.5.0',
      repository: 'https://github.com/bytebase/dbhub',
    });
    expect(candidate.packages[0]).toMatchObject({
      registryType: 'npm',
      identifier: '@bytebase/dbhub',
      version: '1.5.0',
      transport: 'stdio',
    });
    expect(candidate.packages[0]!.env.map((item) => item.name)).toEqual(['DSN', 'DB_PORT', 'DB_TYPE']);
    expect(candidate.packages[0]!.env[0]).toMatchObject({ secret: true, required: false, format: 'string' });
    expect(candidate.packages[0]!.env[1]!.format).toBe('number');
    expect(candidate.packages[0]!.env[2]!.default).toBe('postgres');
  });

  it('normalizes fixed and operator-supplied arguments in registry order', async () => {
    const { fetchImpl } = stub({
      servers: [
        {
          server: {
            name: 'acme/cli',
            version: '2.0.0',
            packages: [
              {
                registryType: 'npm',
                identifier: 'acme-cli',
                version: '2.0.0',
                transport: { type: 'stdio' },
                runtimeArguments: [{ type: 'positional', value: '-y' }],
                packageArguments: [
                  { type: 'named', name: '--port', valueHint: 'port', format: 'number', isRequired: true },
                  { type: 'named', name: '--mode', value: 'fast', isSecret: false },
                ],
              },
            ],
          },
        },
      ],
    });
    const result = await searchMcpRegistry('acme', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.candidates[0]!.packages[0]!.args;
    expect(args.map((arg) => [arg.type, arg.name, arg.value, arg.required])).toEqual([
      ['positional', '-y', '-y', false],
      ['named', '--port', undefined, true],
      ['named', '--mode', 'fast', false],
    ]);
    expect(args[1]!.valueHint).toBe('port');
  });

  it('shapes a remote-only entry as a URL package with header inputs', async () => {
    const { fetchImpl } = stub({
      servers: [
        {
          server: {
            name: 'acme/remote',
            version: '1.0.0',
            remotes: [
              {
                transport: {
                  type: 'streamable-http',
                  url: 'https://mcp.example.test/mcp',
                  headers: [{ name: 'Authorization', isSecret: true }],
                },
              },
            ],
          },
        },
      ],
    });
    const result = await searchMcpRegistry('acme', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]!.packages[0]).toMatchObject({
      registryType: 'remote',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
    });
    expect(result.candidates[0]!.packages[0]!.headers[0]).toMatchObject({ name: 'Authorization', secret: true });
  });

  it('drops malformed entries, keeps the first version of a name, and caps the list', async () => {
    const servers = [
      null,
      { server: { name: 'a/one', version: '1', packages: [{ registryType: 'npm', identifier: 'one' }] } },
      { server: { name: 'a/one', version: '2', packages: [{ registryType: 'npm', identifier: 'one' }] } },
      { server: { name: 'a/empty' } },
      ...Array.from({ length: 30 }, (_, i) => ({
        server: { name: `a/p${i}`, packages: [{ registryType: 'npm', identifier: `p${i}` }] },
      })),
    ];
    const { fetchImpl } = stub({ servers });
    const result = await searchMcpRegistry('aa', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBeLessThanOrEqual(20);
    expect(result.candidates.filter((item) => item.name === 'a/one')).toHaveLength(1);
    expect(result.candidates.find((item) => item.name === 'a/empty')).toBeUndefined();
  });

  it('caps a declared input list', async () => {
    const env = Array.from({ length: 100 }, (_, i) => ({ name: `VAR_${i}` }));
    const { fetchImpl } = stub({
      servers: [
        {
          server: {
            name: 'a/many',
            packages: [{ registryType: 'npm', identifier: 'many', environmentVariables: env }],
          },
        },
      ],
    });
    const result = await searchMcpRegistry('many', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]!.packages[0]!.env).toHaveLength(64);
  });

  it('answers bad_request for an unusable query without touching the network', async () => {
    const { fetchImpl, calls } = stub(dbhub);
    expect(await searchMcpRegistry(' ', { fetchImpl })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await searchMcpRegistry('a\u0000b', { fetchImpl })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await searchMcpRegistry('x'.repeat(201), { fetchImpl })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('maps upstream failures to one code and never throws', async () => {
    expect(await searchMcpRegistry('dbhub', { fetchImpl: stub({}, { status: 503 }).fetchImpl })).toMatchObject({
      ok: false,
      code: 'upstream',
    });
    expect(await searchMcpRegistry('dbhub', { fetchImpl: stub({}, { text: 'not json' }).fetchImpl })).toMatchObject({
      ok: false,
      code: 'upstream',
    });
    expect(
      await searchMcpRegistry('dbhub', { fetchImpl: stub({}, { text: 'x'.repeat(2_000_001) }).fetchImpl })
    ).toMatchObject({ ok: false, code: 'upstream' });

    const failing = (async () => {
      const error = new Error('boom');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    const timeout = await searchMcpRegistry('dbhub', { fetchImpl: failing });
    expect(timeout).toMatchObject({ ok: false, code: 'upstream' });
    if (!timeout.ok) expect(timeout.message).toContain('timed out');
  });

  it('answers an empty candidate list for a match-less answer', async () => {
    const { fetchImpl } = stub({ servers: [] });
    expect(await searchMcpRegistry('nothing', { fetchImpl })).toEqual({ ok: true, candidates: [] });
  });

  it('retries a scoped package spec without its leading @', async () => {
    const { fetchImpl, calls } = routed([
      { when: (url) => url.includes('search=%40bytebase%2Fdbhub'), payload: { servers: [] } },
      { when: (url) => url.includes('search=bytebase%2Fdbhub'), payload: dbhub },
    ]);
    const result = await searchMcpRegistry('@bytebase/dbhub', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]!.name).toBe('io.github.bytebase/dbhub');
    expect(calls).toHaveLength(2);
  });

  it('falls back to the package’s npm mcpName when the spec carries a version', async () => {
    const { fetchImpl, calls } = routed([
      {
        when: (url) => url.includes('search=io.acme%2Fcli'),
        payload: {
          servers: [
            {
              server: {
                name: 'io.acme/cli',
                version: '2.0.0',
                packages: [{ registryType: 'npm', identifier: '@acme/cli', version: '2.0.0' }],
              },
            },
          ],
        },
      },
      { when: (url) => url.includes('search='), payload: { servers: [] } },
      {
        when: (url) => url.includes('registry.npmjs.org/@acme%2Fcli/latest'),
        payload: { name: '@acme/cli', version: '2.0.0', mcpName: 'io.acme/cli' },
      },
    ]);
    const result = await searchMcpRegistry('@acme/cli@2.0.0', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]!.name).toBe('io.acme/cli');
    // registry search (@acme/cli@2.0.0) → registry search (acme/cli@2.0.0) → npm lookup → registry
    expect(calls).toHaveLength(4);
  });

  it('answers the empty list when npm has no mcpName either', async () => {
    const { fetchImpl } = routed([
      { when: (url) => url.includes('search='), payload: { servers: [] } },
      { when: (url) => url.includes('registry.npmjs.org/'), status: 404 },
    ]);
    expect(await searchMcpRegistry('@acme/missing@1.0.0', { fetchImpl })).toEqual({ ok: true, candidates: [] });
  });
});
