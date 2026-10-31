import { describe, it, expect } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import fastify from 'fastify';
import { probeMcpCli } from '../src/harness/host/mcp-cli.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/** One ustar entry — the probe reads name/size only, but the checksum is written honestly. */
function tarEntry(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8);
  header.write('0', 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarball(entries: Array<{ name: string; body: string }>): Buffer {
  return gzipSync(
    Buffer.concat([...entries.map((entry) => tarEntry(entry.name, Buffer.from(entry.body))), Buffer.alloc(1024)])
  );
}

function stubFetch(files: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const handler = files[url];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const metadata = (name: string, version: string, tarballUrl: string, bin?: string): Response =>
  new Response(
    JSON.stringify({
      version,
      ...(bin ? { bin: { cli: bin } } : {}),
      dist: { tarball: tarballUrl },
    }),
    { headers: { 'content-type': 'application/json' } }
  );

describe('probeMcpCli', () => {
  it('refuses a non-package spec without touching the network', async () => {
    const { fetchImpl, calls } = stubFetch({});
    const result = await probeMcpCli('not a package', { fetchImpl });
    expect(result).toEqual({ ok: false, code: 'bad_request', message: 'not a valid npm package spec' });
    expect(calls).toEqual([]);
  });

  it('lists the flags the package parser reads, with hints, choices, number and env fallback', async () => {
    const name = 'probe-fixture-cli';
    const version = '1.0.0';
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    const source = [
      'const args = parseFlags(process.argv.slice(2));',
      'const transport = args.transport;',
      'if (args.transport === "http") { console.log("http"); }',
      'const mode = args.transport === "http" ? "http" : "stdio";',
      'const port = parseInt(args.port, 10) || 8080;',
      'const dsn = requireFlagValue("dsn", args, "postgres://localhost/db");',
      'const host = args.host ?? process.env.PROBE_FIXTURE_HOST;',
      'const help = args.help;',
    ].join('\n');
    const { fetchImpl, calls } = stubFetch({
      [`https://registry.npmjs.org/${name}/${version}`]: () => metadata(name, version, tarballUrl, 'dist/cli.js'),
      [tarballUrl]: () =>
        new Response(tarball([{ name: 'package/dist/cli.js', body: source }]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });

    const result = await probeMcpCli(`${name}@${version}`, { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([`https://registry.npmjs.org/${name}/${version}`, tarballUrl]);
    expect(result.version).toBe(version);
    expect(result.bin).toBe('dist/cli.js');
    expect(result.options.map((option) => option.name)).toEqual(['transport', 'port', 'host', 'dsn']);
    // `stdio` is only ever the ternary fallback, which the `===` scan alone would miss.
    expect(result.options[0]).toMatchObject({ name: 'transport', choices: ['http', 'stdio'] });
    expect(result.options[1]).toMatchObject({ name: 'port', format: 'number' });
    expect(result.options[2]).toMatchObject({ name: 'host', env: 'PROBE_FIXTURE_HOST' });
    expect(result.options[3]).toMatchObject({
      name: 'dsn',
      valueHint: 'postgres://localhost/db',
      secret: true,
    });
  });

  it('reports a missing package as not_found', async () => {
    const { fetchImpl } = stubFetch({});
    const result = await probeMcpCli('probe-fixture-missing@9.9.9', { fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a tarball that is not hosted by the registry', async () => {
    const name = 'probe-fixture-offsite';
    const { fetchImpl } = stubFetch({
      [`https://registry.npmjs.org/${name}/latest`]: () =>
        metadata(name, '1.0.0', 'https://example.com/evil.tgz'),
    });
    const result = await probeMcpCli(name, { fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'upstream' });
  });

  it('scans a PyPI sdist for the flags uvx will pass', async () => {
    const name = 'probe-fixture-pypi';
    const version = '1.2.3';
    const archiveUrl = `https://files.pythonhosted.org/packages/aa/bb/${name}-${version}.tar.gz`;
    const source = [
      'import argparse, os',
      'parser = argparse.ArgumentParser()',
      'parser.add_argument("--name", required=True, help="server name")',
      'parser.add_argument("--count", type=int, default=3)',
      'parser.add_argument("--mode", choices=["fast", "slow"], default="fast")',
      'parser.add_argument("--token", required=True, help="api token")',
      'parser.add_argument("--host", default="127.0.0.1")',
      'host = os.environ.get("PROBE_PYPI_HOST") or host',
    ].join('\n');
    const { fetchImpl, calls } = stubFetch({
      [`https://pypi.org/pypi/${name}/json`]: () =>
        new Response(
          JSON.stringify({
            info: { version },
            urls: [{ filename: `${name}-${version}.tar.gz`, packagetype: 'sdist', url: archiveUrl }],
          })
        ),
      [archiveUrl]: () =>
        new Response(tarball([{ name: `${name}-${version}/pkg/cli.py`, body: source }]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });

    const result = await probeMcpCli(name, { fetchImpl, registry: 'pypi' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([`https://pypi.org/pypi/${name}/json`, archiveUrl]);
    expect(result.version).toBe(version);
    expect(result.options).toEqual([
      { name: 'name', required: true },
      { name: 'count', valueHint: '3', format: 'number' },
      { name: 'mode', valueHint: 'fast', choices: ['fast', 'slow'] },
      { name: 'token', secret: true, required: true },
      { name: 'host', valueHint: '127.0.0.1', env: 'PROBE_PYPI_HOST' },
    ]);
  });

  it('falls back to a wheel when the PyPI release has no sdist', async () => {
    const name = 'probe-fixture-wheel';
    const version = '0.1.0';
    const archiveUrl = `https://files.pythonhosted.org/packages/cc/dd/${name}-${version}-py3-none-any.whl`;
    const { fetchImpl } = stubFetch({
      [`https://pypi.org/pypi/${name}/${version}/json`]: () =>
        new Response(
          JSON.stringify({
            info: { version },
            urls: [{ filename: `${name}-${version}-py3-none-any.whl`, packagetype: 'bdist_wheel', url: archiveUrl }],
          })
        ),
      [archiveUrl]: () =>
        new Response(
          zipSync({
            [`${name}/__init__.py`]: strToU8(
              'import click\n@click.option("--verbose", is_flag=True)\ndef main(verbose): ...'
            ),
          })
        ),
    });

    const result = await probeMcpCli(`${name}==${version}`, { fetchImpl, registry: 'pypi' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual([{ name: 'verbose' }]);
  });
});

describe('GET /api/admin/harness/mcp/cli', () => {
  /** Warm the probe cache so the route test never depends on the network. */
  async function warmCache(): Promise<{ name: string; version: string }> {
    const name = 'probe-fixture-route';
    const version = '2.0.0';
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    const { fetchImpl } = stubFetch({
      [`https://registry.npmjs.org/${name}/${version}`]: () => metadata(name, version, tarballUrl, 'index.js'),
      [tarballUrl]: () =>
        new Response(
          tarball([
            {
              name: 'package/index.js',
              body: 'const args = parseFlags(process.argv.slice(2));\nconst port = parseInt(args.port, 10);',
            },
          ])
        ),
    });
    const warm = await probeMcpCli(`${name}@${version}`, { fetchImpl });
    expect(warm.ok).toBe(true);
    return { name, version };
  }

  it('requires pkg', async () => {
    const app = fastify();
    registerHarnessRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/api/admin/harness/mcp/cli' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 'error', code: 'bad_request' });
    await app.close();
  });

  it('answers the probed flags for a package', async () => {
    const { name, version } = await warmCache();
    const app = fastify();
    registerHarnessRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/harness/mcp/cli?pkg=${encodeURIComponent(`${name}@${version}`)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; options: Array<{ name: string; format?: string }> };
    expect(body.status).toBe('ok');
    expect(body.options).toEqual([{ name: 'port', format: 'number' }]);
    await app.close();
  });
});
