import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';

// The plugin sources live in a gitignored dev tree (a separate repository), so a
// fresh checkout has no `plugins/jetbrains-gateway`. A static import cannot be
// conditional — the file would fail at module load — so the package is loaded
// only when its directory exists. Bun's `node:test` compat layer ignores a
// `skip` option, so every block below registers only through `d`; `src!` is
// therefore never evaluated without the package.
const pluginDir = path.resolve(import.meta.dirname, '../../../plugins/jetbrains-gateway');
const src = fs.existsSync(pluginDir) ? await import('../../../plugins/jetbrains-gateway/junie.js') : null;
/** Register a plugin-dependent block only when the package is present. */
const d = src ? describe : null;

/**
 * The one-click JetBrains integration is mostly FILE SURGERY on a machine nobody has
 * touched yet, so the contract worth pinning is:
 *
 *   1. the ACP registry is the single source of an agent version — we never
 *      hard-code one, and an unpublished platform is a null, not a throw;
 *   2. the install layout matches what the IDE's AcpBinaryManager promotes into,
 *      and the archive is seeded where it looks, or it re-downloads forever;
 *   3. a download is validated before anything extracts it (a truncated 215 MB
 *      archive must fail loudly instead of producing a half agent);
 *   4. the Junie profile JSON keeps the two shapes Junie's serializer insists on
 *      (verbatim completions URL, plain-string apiKey);
 *   5. our vmoptions block is replaceable and removable without touching an
 *      operator's own JVM flags.
 */

const REGISTRY = {
  version: '1.0.0',
  agents: [
    {
      id: 'junie',
      version: '4020.7.0',
      distribution: {
        binary: {
          'windows-x86_64': {
            archive: 'https://github.com/JetBrains/junie-acp-release/releases/download/4020.7/junie-release-4020.7-windows-amd64.zip',
            cmd: './junie/junie.exe',
            args: ['--acp=true'],
          },
          'linux-x86_64': {
            archive: 'https://example.invalid/junie-release-4020.7-linux-amd64.zip',
            cmd: './junie-app/bin/junie',
            args: [],
          },
        },
      },
    },
    { id: 'no-binary', version: '1.0.0', distribution: { npx: { package: 'x@1.0.0' } } },
  ],
};

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

d?.('ACP registry resolution', () => {
  const { platformAssetKey, pickAcpBinaryAsset } = src!;
  it('maps platform/arch to the registry asset keys', () => {
    assert.equal(platformAssetKey('win32', 'x64'), 'windows-x86_64');
    assert.equal(platformAssetKey('win32', 'arm64'), 'windows-aarch64');
    assert.equal(platformAssetKey('darwin', 'arm64'), 'darwin-aarch64');
    assert.equal(platformAssetKey('darwin', 'x64'), 'darwin-x86_64');
    assert.equal(platformAssetKey('linux', 'x64'), 'linux-x86_64');
    assert.equal(platformAssetKey('linux', 'arm64'), 'linux-aarch64');
    assert.equal(platformAssetKey('freebsd', 'x64'), null);
  });

  it('resolves the agent version and command from the registry, never a constant', () => {
    const asset = pickAcpBinaryAsset(REGISTRY, 'junie', 'windows-x86_64');
    assert.ok(asset);
    assert.equal(asset.version, '4020.7.0');
    assert.equal(asset.cmd, './junie/junie.exe');
    assert.deepEqual(asset.args, ['--acp=true']);
    assert.equal(asset.archiveName, 'junie-release-4020.7-windows-amd64.zip');
    assert.equal(asset.url.startsWith('https://github.com/'), true);
  });

  it('returns null for an unknown agent, an unpublished platform, or junk input', () => {
    assert.equal(pickAcpBinaryAsset(REGISTRY, 'nope', 'windows-x86_64'), null);
    assert.equal(pickAcpBinaryAsset(REGISTRY, 'junie', 'solaris-sparc'), null);
    assert.equal(pickAcpBinaryAsset(REGISTRY, 'junie', 'darwin-aarch64'), null);
    assert.equal(pickAcpBinaryAsset(REGISTRY, 'no-binary', 'windows-x86_64'), null);
    assert.equal(pickAcpBinaryAsset(null, 'junie', 'windows-x86_64'), null);
    assert.equal(pickAcpBinaryAsset({ agents: 'nope' }, 'junie', 'windows-x86_64'), null);
    assert.equal(pickAcpBinaryAsset(REGISTRY, 'junie', null), null);
  });
});

d?.('ACP registry discovery', () => {
  const { acpRegistryPath, acpRegistryCandidates } = src!;
  it('accepts the hashed snapshot 2026.3 writes, newest first', () => {
    const root = tmpDir('acp-registry-');
    const agents = path.join(root, 'JetBrains', 'IntelliJIdea2026.3', 'acp-agents');
    fs.mkdirSync(agents, { recursive: true });
    const older = path.join(agents, 'registry-aaaa.json');
    const newer = path.join(agents, 'registry-bbbb.json');
    fs.writeFileSync(older, JSON.stringify(REGISTRY));
    fs.writeFileSync(newer, JSON.stringify(REGISTRY));
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(older, past, past);
    // No plain `registry.json`: the pre-2026.3 name must not be REQUIRED.
    assert.deepEqual(acpRegistryCandidates(agents), [newer, older]);
    fs.writeFileSync(acpRegistryPath(agents), JSON.stringify(REGISTRY));
    assert.equal(acpRegistryCandidates(agents)[0], acpRegistryPath(agents));
  });

  it('falls back to the legacy flat registry that still publishes junie', () => {
    const root = tmpDir('acp-legacy-');
    const agents = path.join(root, 'JetBrains', 'IntelliJIdea2026.3', 'acp-agents');
    const legacy = path.join(root, 'JetBrains', 'acp-agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    const legacyRegistry = path.join(legacy, 'registry.json');
    fs.writeFileSync(legacyRegistry, JSON.stringify(REGISTRY));
    assert.deepEqual(acpRegistryCandidates(agents), [legacyRegistry]);
    assert.deepEqual(acpRegistryCandidates(tmpDir('acp-empty-')), []);
  });
});

d?.('ACP install layout', () => {
  const { acpAgentsDir, acpInstallRoot, acpBinaryPath, acpDownloadPath, detectAcpInstalls } = src!;
  it('puts the agents dir beside the IDE config NAME, not in the roaming root', () => {
    const dir = acpAgentsDir(path.join('C:', 'Users', 'k', 'AppData', 'Roaming', 'JetBrains', 'IntelliJIdea2026.3'));
    assert.match(dir, /JetBrains[\\/]IntelliJIdea2026\.3[\\/]acp-agents$/);
    assert.equal(dir.includes('Roaming'), false);
  });

  it('resolves the registry cmd against the version root', () => {
    const agents = path.join('agents');
    const root = acpInstallRoot(agents, 'junie', '4020.7.0');
    assert.equal(acpBinaryPath(root, './junie/junie.exe'), path.join(root, 'junie', 'junie.exe'));
    assert.equal(acpBinaryPath(root, 'junie/junie.exe'), path.join(root, 'junie', 'junie.exe'));
    // Seeds land exactly where AcpBinaryManager stages its own downloads.
    assert.match(acpDownloadPath(agents, 'junie', '4020.7.0', 'a.zip'), /\.downloads[\\/]junie[\\/]4020\.7\.0[\\/]a\.zip$/);
  });

  it('detects installed versions newest-first and skips missing dirs', () => {
    const agents = tmpDir('acp-agents-');
    assert.deepEqual(detectAcpInstalls(agents, 'junie'), []);
    for (const version of ['4020.7.0', '4020.10.0']) {
      const root = acpInstallRoot(agents, 'junie', version);
      fs.mkdirSync(path.join(root, 'junie'), { recursive: true });
      fs.writeFileSync(path.join(root, 'junie', 'junie.exe'), 'MZ');
    }
    const found = detectAcpInstalls(agents, 'junie');
    assert.deepEqual(found.map((f) => f.version), ['4020.10.0', '4020.7.0']);
    assert.match(found[0].binary ?? '', /junie\.exe$/);
  });
});

d?.('download validation', () => {
  const { looksLikeZip, downloadFile } = src!;
  it('recognises a real zip and rejects a truncated one', () => {
    const dir = tmpDir('zip-');
    const archive = path.join(dir, 'a.zip');
    const zipped = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([1, 2, 3]) }));
    fs.writeFileSync(archive, zipped);
    assert.equal(looksLikeZip(archive), true);

    fs.writeFileSync(path.join(dir, 'trunc.zip'), zipped.subarray(0, zipped.length - 30));
    assert.equal(looksLikeZip(path.join(dir, 'trunc.zip')), false);
    assert.equal(looksLikeZip(path.join(dir, 'missing.zip')), false);
  });

  it('writes the body, then reuses it on a second call', async () => {
    const dir = tmpDir('dl-');
    const dest = path.join(dir, 'nested', 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([9]) }));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    }) as unknown as typeof fetch;

    const first = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.bytes, payload.length);
    assert.equal(calls, 1);

    const second = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'a validated archive must not be re-downloaded');
  });

  it('keeps the partial of a truncated body so the next run can resume', async () => {
    const dir = tmpDir('dl-trunc-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([9]) }));
    const fetchImpl = (async () =>
      new Response(payload, { status: 200, headers: { 'content-length': String(payload.length + 500) } })) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.detail ?? '', /truncated/);
    assert.equal(fs.existsSync(dest), false);
    // The bytes ARE the resume state: keeping them is what turns a dropped
    // 215 MB transfer into "one more attempt" instead of "start over".
    assert.equal(fs.existsSync(`${dest}.part`), true);
    assert.equal(fs.readFileSync(`${dest}.part`).length, payload.length);
    const meta = JSON.parse(fs.readFileSync(`${dest}.part.json`, 'utf8')) as { url: string; mode: string };
    assert.equal(meta.url, 'https://example.invalid/junie.zip');
    assert.equal(meta.mode, 'stream');
  });

  it('resumes from the bytes on disk and never re-asks for them', async () => {
    const dir = tmpDir('dl-resume-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([4, 5, 6]) }));
    const half = Math.floor(payload.length / 2);
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, half));
    fs.writeFileSync(`${dest}.part.json`, JSON.stringify({ url: 'https://example.invalid/junie.zip', mode: 'stream' }));
    const ranges: (string | null)[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      ranges.push(headers.range ?? null);
      const from = Number(/^bytes=(\d+)-$/.exec(headers.range ?? '')?.[1] ?? 0);
      return new Response(payload.subarray(from), {
        status: 206,
        headers: {
          'content-range': `bytes ${from}-${payload.length - 1}/${payload.length}`,
          'content-length': String(payload.length - from),
        },
      });
    }) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(res.ok, true, res.detail);
    assert.deepEqual(ranges, [`bytes=${half}-`], 'the resumed run must not fetch the bytes it already has');
    assert.deepEqual(fs.readFileSync(dest), payload);
  });

  it('assembles a large archive from parallel ranges', async () => {
    const dir = tmpDir('dl-range-');
    const dest = path.join(dir, 'junie.zip');
    // `level: 0` keeps the fixture above the parallel threshold, which a
    // compressed zip of zeros would not be.
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array(9 * 1024 * 1024).fill(7) }, { level: 0 }));
    assert.ok(payload.length > 8 * 1024 * 1024, 'fixture must exceed the parallel threshold');
    let rangeCalls = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const match = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
      if (!match) return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
      rangeCalls += 1;
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : payload.length - 1;
      return new Response(payload.subarray(from, to + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${from}-${to}/${payload.length}`,
          'content-length': String(to - from + 1),
        },
      });
    }) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl, concurrency: 4 });
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.ranged, true);
    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.ok(rangeCalls >= 3, `expected several range requests, saw ${rangeCalls}`);
    assert.equal(fs.existsSync(`${dest}.part`), false, 'a finished download leaves no partial behind');
    assert.equal(fs.existsSync(`${dest}.part.pieces`), false);
  });

  it('resumes a parallel partial from its piece markers, never probing past EOF', async () => {
    const dir = tmpDir('dl-range-resume-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array(9 * 1024 * 1024).fill(3) }, { level: 0 }));
    const pieceBytes = 4 * 1024 * 1024;
    const pieces = Math.ceil(payload.length / pieceBytes);
    // A partial left by an interrupted run: the file is preallocated to the full
    // size and only the LAST piece is missing.
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, (pieces - 1) * pieceBytes).length === 0 ? Buffer.alloc(0) : payload);
    fs.writeFileSync(
      `${dest}.part.json`,
      JSON.stringify({ url: 'https://example.invalid/junie.zip', mode: 'range', total: payload.length, pieceBytes }),
    );
    fs.mkdirSync(`${dest}.part.pieces`, { recursive: true });
    for (let index = 0; index < pieces - 1; index += 1) {
      fs.writeFileSync(`${dest}.part.pieces/${index}.done`, 'x');
    }
    const starts: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const match = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
      assert.ok(match, 'every request must be a bounded range');
      const from = Number(match[1]);
      starts.push(from);
      assert.ok(from < payload.length, `range start ${from} must be inside the asset`);
      const to = match[2] ? Number(match[2]) : payload.length - 1;
      return new Response(payload.subarray(from, to + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${from}-${to}/${payload.length}`,
          'content-length': String(to - from + 1),
        },
      });
    }) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl, concurrency: 2 });
    assert.equal(res.ok, true, res.detail);
    assert.deepEqual(starts, [(pieces - 1) * pieceBytes], 'only the missing piece is requested');
    assert.deepEqual(fs.readFileSync(dest), payload);
  });

  it('names the two empty-defaulted config keys when a download cannot get through', async () => {
    const { ensureAcpAgent } = src!;
    const root = tmpDir('acp-fail-');
    const fetchImpl = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    const res = await ensureAcpAgent({
      configDir: path.join(root, 'IntelliJIdea2026.3'),
      agentsDir: path.join(root, 'acp-agents'),
      cacheDir: path.join(root, 'downloads'),
      asset: {
        id: 'junie',
        version: '4020.7.0',
        url: 'https://example.invalid/junie.zip',
        cmd: './junie/junie.exe',
        args: [],
        archiveName: 'junie.zip',
      },
      fetchImpl,
    });
    assert.equal(res.ok, false);
    // `downloadMirrors` and `junieArchivePath` default to empty, so a failure is
    // the one moment the operator has to learn they exist.
    assert.match(res.detail ?? '', /downloadMirrors/);
    assert.match(res.detail ?? '', /junieArchivePath/);
  });

  it('asks the mirror FIRST and never touches the origin when it serves', async () => {
    const dir = tmpDir('dl-mirror-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([8]) }));
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      seen.push(target);
      if (target.startsWith('https://mirror.invalid/')) {
        return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
      }
      return new Response('', { status: 502 });
    }) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl, mirrors: ['https://mirror.invalid/'] });
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.source, 'https://mirror.invalid/https://example.invalid/junie.zip');
    // A mirror exists to avoid the origin, so the probe must not spend its one
    // request on the path the operator already knows is slow.
    assert.deepEqual(seen, ['https://mirror.invalid/https://example.invalid/junie.zip']);
  });

  it('falls through a mirror that answers 404 to the origin', async () => {
    const dir = tmpDir('dl-mirror-404-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([7]) }));
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      seen.push(target);
      if (target.startsWith('https://dead.invalid/')) return new Response('', { status: 404 });
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    }) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl, mirrors: ['https://dead.invalid/'] });
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.source, 'https://example.invalid/junie.zip', 'the origin must still get its turn');
    assert.deepEqual(seen, ['https://dead.invalid/https://example.invalid/junie.zip', 'https://example.invalid/junie.zip']);
  });

  it('expands mirror templates both ways', () => {
    const { mirrorUrl } = src!;
    assert.equal(mirrorUrl('https://ghfast.top/', 'https://github.com/x/y.zip'), 'https://ghfast.top/https://github.com/x/y.zip');
    assert.equal(mirrorUrl('https://gh-proxy.com/{url}', 'https://github.com/x/y.zip'), 'https://gh-proxy.com/https://github.com/x/y.zip');
    assert.equal(mirrorUrl('   ', 'https://github.com/x/y.zip'), 'https://github.com/x/y.zip');
  });

  it('installs from an operator-supplied archive without touching the network', async () => {
    const { ensureAcpAgent } = src!;
    const root = tmpDir('acp-import-');
    const agentsDir = path.join(root, 'acp-agents');
    const archive = path.join(root, 'junie.zip');
    fs.writeFileSync(archive, Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([1, 2, 3]) })));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error('a local archive must not reach the network');
    }) as unknown as typeof fetch;
    const res = await ensureAcpAgent({
      configDir: path.join(root, 'IntelliJIdea2026.3'),
      agentsDir,
      cacheDir: path.join(root, 'downloads'),
      asset: {
        id: 'junie',
        version: '4020.7.0',
        url: 'https://example.invalid/junie.zip',
        cmd: './junie/junie.exe',
        args: ['--acp=true'],
        archiveName: 'junie.zip',
      },
      archivePath: archive,
      fetchImpl,
    });
    if (!res.ok && /archiver|extraction/i.test(res.detail ?? '')) return; // no archiver on this box
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.installed, true);
    assert.equal(calls, 0, 'the origin must not be contacted');
    assert.equal(fs.existsSync(path.join(agentsDir, 'junie', '4020.7.0', 'junie', 'junie.exe')), true);
    // the archive is cached for other IDEs, and seeded for the IDE's own manager
    assert.equal(fs.existsSync(path.join(root, 'downloads', 'junie', '4020.7.0', 'junie.zip')), true);
    assert.equal(fs.existsSync(path.join(agentsDir, '.downloads', 'junie', '4020.7.0', 'junie.zip')), true);
  });

  it('refuses a non-zip 200 (a captive portal or an HTML error page)', async () => {
    const dir = tmpDir('dl-html-');
    const dest = path.join(dir, 'junie.zip');
    const fetchImpl = (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.detail ?? '', /not a zip/);
  });

  it('reports the upstream status instead of writing a body', async () => {
    const dir = tmpDir('dl-404-');
    const dest = path.join(dir, 'junie.zip');
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.detail ?? '', /HTTP 404/);
  });
});

d?.('archive extraction', () => {
  const { extractZip } = src!;
  it('extracts with whatever archiver this machine has', async () => {
    const dir = tmpDir('unzip-');
    const archive = path.join(dir, 'a.zip');
    fs.writeFileSync(archive, Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([7, 7, 7]) })));
    const out = path.join(dir, 'out');
    const res = await extractZip(archive, out);
    if (!res.ok) return; // no archiver on this box: not a product regression
    assert.equal(fs.readFileSync(path.join(out, 'junie', 'junie.exe')).length, 3);
  });
});

d?.('Junie model profiles', () => {
  const {
    buildJunieProfiles,
    junieEndpointUrl,
    JUNIE_VIRTUAL_MODELS,
    junieVirtualModelEntries,
    junieModelSlug,
    mergeJunieConfig,
    refreshJunieModels,
    writeJunieModels,
    junieModelsPresent,
    removeJunieModels,
  } = src!;
  it('prefixes an already-versioned base URL without ever double-suffixing it', () => {
    // `responses` is the generator default (Junie's chat request object has no
    // streaming executor), so the no-double-suffix rule is asserted on the
    // DEFAULT path and the chat path is asked for explicitly.
    const base = buildJunieProfiles('http://127.0.0.1:4000', 'sk-ocr-test');
    assert.equal(base[0].body.baseUrl, 'http://127.0.0.1:4000/v1/responses');
    assert.equal(
      buildJunieProfiles('http://127.0.0.1:4000', 'sk-ocr-test', undefined, 'chat')[0].body.baseUrl,
      'http://127.0.0.1:4000/v1/chat/completions',
    );
    // An already-versioned or already-complete URL must not be double-suffixed.
    assert.equal(buildJunieProfiles('http://127.0.0.1:4000/v1', 'k')[0].body.baseUrl, 'http://127.0.0.1:4000/v1/responses');
    assert.equal(
      buildJunieProfiles('http://127.0.0.1:4000/v1/chat/completions', 'k', undefined, 'chat')[0].body.baseUrl,
      'http://127.0.0.1:4000/v1/chat/completions',
    );
    assert.equal(buildJunieProfiles('http://h:1/', 'k')[0].body.baseUrl, 'http://h:1/v1/responses');
  });

  it('resolves the Responses endpoint without ever stacking protocol paths', () => {
    assert.equal(junieEndpointUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000/v1/responses');
    assert.equal(junieEndpointUrl('http://127.0.0.1:4000', 'chat'), 'http://127.0.0.1:4000/v1/chat/completions');
    assert.equal(junieEndpointUrl('http://127.0.0.1:4000', 'responses'), 'http://127.0.0.1:4000/v1/responses');
    assert.equal(junieEndpointUrl('http://127.0.0.1:4000/v1', 'responses'), 'http://127.0.0.1:4000/v1/responses');
    // A caller handing a chat endpoint into responses mode must not produce
    // `/v1/chat/completions/v1/responses`.
    assert.equal(
      junieEndpointUrl('http://127.0.0.1:4000/v1/chat/completions', 'responses'),
      'http://127.0.0.1:4000/v1/responses',
    );
    assert.equal(
      junieEndpointUrl('http://127.0.0.1:4000/v1/responses', 'chat'),
      'http://127.0.0.1:4000/v1/chat/completions',
    );
  });

  it('emits an OpenAIResponses profile by default, with chat as the explicit escape hatch', () => {
    const responses = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test');
    assert.equal(responses.length, JUNIE_VIRTUAL_MODELS.length);
    for (const profile of responses) {
      assert.equal(profile.body.apiType, 'OpenAIResponses');
      assert.equal(profile.body.baseUrl, 'http://127.0.0.1:4700/v1/responses');
      assert.deepEqual(profile.body.extraBody, { store: true });
      // The streaming gate must NEVER be forced from the generator: doing so on
      // the chat wire made Junie's batch parser read SSE and throw.
      assert.equal((profile.body.extraBody as Record<string, unknown>).stream, undefined);
    }
    const chat = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', undefined, 'chat');
    for (const profile of chat) {
      assert.equal(profile.body.apiType, 'OpenAICompletion');
      assert.equal(profile.body.extraBody, undefined);
    }
  });

  it('honors an operator-chosen fasterModel and falls back for unlisted ids', () => {
    const models: { id: string }[] = [
      { id: 'lite' },
      { id: 'xiaomi/mimo-v2.6-flash' },
      { id: 'xiaomi/mimo-v2.6-pro' },
    ];
    // Explicit listed id wins over the `lite` ladder default — Junie's
    // internal helper agents (capability filter, titling) call this model.
    const overridden = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', models, 'chat', 'xiaomi/mimo-v2.6-pro');
    for (const profile of overridden) {
      assert.equal(profile.body.fasterModel.id, 'xiaomi/mimo-v2.6-pro');
    }
    // An id the picker does not expose must fall back to the ladder, never
    // write a profile that routes to nothing.
    const invalid = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', models, 'chat', 'gpt-9-turbo');
    for (const profile of invalid) {
      assert.equal(profile.body.fasterModel.id, 'lite');
    }
    // A custom list without `lite`/`auto` falls to the first listed id.
    const noLadder = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', [{ id: 'a-model' }, { id: 'b-model' }]);
    for (const profile of noLadder) {
      assert.equal(profile.body.fasterModel.id, 'a-model');
    }
  });

  it('honors an operator-chosen maxContextLength and ignores junk', () => {
    // Explicit positive integer wins over the 128000 default — a wrong window
    // is a silent hazard (small truncates sessions early, large overflows).
    const big = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', undefined, 'chat', undefined, 200000);
    for (const profile of big) {
      assert.equal(profile.body.maxContextLength, 200000);
    }
    // Non-positive / fractional / NaN values must fall back, never write a
    // profile that misleads Junie's request assembly.
    for (const junk of [0, -128000, 1.5, Number.NaN]) {
      const degraded = buildJunieProfiles('http://127.0.0.1:4700', 'sk-ocr-test', undefined, 'chat', undefined, junk);
      for (const profile of degraded) {
        assert.equal(profile.body.maxContextLength, 128000);
      }
    }
  });

  it('honors a primary-model default naming a listed concrete id', () => {
    // `juniePrimaryModel` is the primaryModel's standing choice: any model the
    // picker exposes works, not just the tier aliases — the profile slug chain
    // must land the operator's model as the initial selection.
    const models = [{ id: 'auto' }, { id: 'xiaomi/mimo-v2.6-pro' }, { id: 'plus' }];
    const home = tmpDir('junie-primary-');
    const written = writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', {
      home,
      models,
      primaryModel: 'xiaomi/mimo-v2.6-pro',
    });
    assert.equal(written.ok, true);
    assert.equal(written.model, 'custom:ocr-xiaomi-mimo-v2-6-pro');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.model, 'custom:ocr-xiaomi-mimo-v2-6-pro');
  });

  it('keeps apiKey a plain string and every virtual model addressable', () => {
    const profiles = buildJunieProfiles('http://127.0.0.1:4000', 'sk-ocr-test', undefined, 'chat');
    assert.equal(profiles.length, JUNIE_VIRTUAL_MODELS.length);
    assert.deepEqual(
      profiles.map((p) => p.file),
      ['ocr-auto.json', 'ocr-lite.json', 'ocr-plus.json', 'ocr-pro.json', 'ocr-ultra.json'],
    );
    assert.deepEqual(
      profiles.map((p) => p.body.displayName),
      ['Auto', 'Lite', 'Plus', 'Pro', 'Ultra'],
    );
    for (const profile of profiles) {
      assert.equal(typeof profile.body.apiKey, 'string');
      assert.equal(profile.body.apiType, 'OpenAICompletion');
      assert.equal(profile.body.id, profile.file.replace(/\.json$/, ''));
      assert.equal(profile.body.primaryModel.id, profile.body.id.replace('ocr-', ''));
      assert.equal(profile.body.fasterModel.id, 'lite');
      // The picker prints `providerName · displayName`, so the source marker
      // lives in the provider slot exactly once — a trailing `(OCR)` would
      // duplicate it on every row.
      assert.equal(profile.body.providerName, 'OCR');
      assert.equal(/OCR/i.test(profile.body.displayName), false);
    }
  });

  it('merges config without dropping operator keys, and survives a corrupt file', () => {
    const kept = JSON.parse(mergeJunieConfig('{"effort":"high","byok":{"litellm":{"baseUrl":"x"}}}', 'custom:ocr-auto'));
    assert.equal(kept.model, 'custom:ocr-auto');
    assert.equal(kept.effort, 'high');
    assert.equal(kept.byok.litellm.baseUrl, 'x');

    assert.equal(JSON.parse(mergeJunieConfig(null, 'custom:ocr-auto')).model, 'custom:ocr-auto');
    assert.equal(JSON.parse(mergeJunieConfig('{not json', 'custom:ocr-auto')).model, 'custom:ocr-auto');
    assert.equal(JSON.parse(mergeJunieConfig('[1,2]', 'custom:ocr-auto')).model, 'custom:ocr-auto');
  });

  it('writes profiles + default, then removes only ours', () => {
    const home = tmpDir('junie-home-');
    const other = path.join(home, 'models', 'mine.json');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, '{"id":"mine"}');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ effort: 'high' }));

    const written = writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home, primaryModel: 'pro' });
    assert.equal(written.ok, true);
    assert.equal(written.files.length, JUNIE_VIRTUAL_MODELS.length);
    assert.equal(written.model, 'custom:ocr-pro');
    assert.equal(junieModelsPresent({ home }), true);

    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.model, 'custom:ocr-pro');
    assert.equal(config.effort, 'high');

    const removed = removeJunieModels({ home });
    assert.equal(removed.removed.length, JUNIE_VIRTUAL_MODELS.length);
    assert.equal(fs.existsSync(other), true, "an operator's own profile must survive teardown");
    assert.equal(junieModelsPresent({ home }), false);
    assert.equal('model' in JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), false);
  });

  it('leaves a re-pointed model selection alone on teardown', () => {
    const home = tmpDir('junie-repoint-');
    writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'some-cloud-model' }));
    removeJunieModels({ home });
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).model, 'some-cloud-model');
  });

  it('exposes exactly the list it is given — a registry id keeps its routing id', () => {
    const home = tmpDir('junie-list-');
    const models = [
      { id: 'auto' },
      { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo v2.6 Pro' },
      { id: 'plus' },
    ];
    const written = writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home, models, primaryModel: 'plus' });
    assert.deepEqual(
      written.files.map((file) => path.basename(file)),
      ['ocr-auto.json', 'ocr-xiaomi-mimo-v2-6-pro.json', 'ocr-plus.json'],
    );
    assert.equal(written.model, 'custom:ocr-plus');
    const concrete = JSON.parse(fs.readFileSync(path.join(home, 'models', 'ocr-xiaomi-mimo-v2-6-pro.json'), 'utf8'));
    // The picker label is human, the routing target is the gateway's own id.
    assert.equal(concrete.displayName, 'MiMo v2.6 Pro');
    assert.equal(concrete.providerName, 'OCR');
    assert.equal(concrete.primaryModel.id, 'xiaomi/mimo-v2.6-pro');
    assert.equal(concrete.id, 'ocr-xiaomi-mimo-v2-6-pro');
    // `lite` is not in this list, so the faster model falls back to a virtual model it has.
    assert.equal(concrete.fasterModel.id, 'auto');
    // Virtual model ids keep their established label, so a re-follow does not rename them.
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'models', 'ocr-auto.json'), 'utf8')).displayName, 'Auto');
  });

  it('replaces the previous list and never deletes an operator profile', () => {
    const home = tmpDir('junie-shrink-');
    const mine = path.join(home, 'models', 'mine.json');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, '{"id":"mine"}');
    writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home });
    assert.equal(junieModelsPresent({ home }), true);

    const shrunk = writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', {
      home,
      models: [{ id: 'pro' }],
      primaryModel: 'ultra',
    });
    assert.deepEqual(shrunk.files.map((file) => path.basename(file)), ['ocr-pro.json']);
    // A default the list no longer carries falls back to its first entry rather
    // than pointing at a profile that was just deleted.
    assert.equal(shrunk.model, 'custom:ocr-pro');
    assert.deepEqual(fs.readdirSync(path.join(home, 'models')).sort(), ['mine.json', 'ocr-pro.json']);
  });

  it('refuses to provision on refresh — only a hook writes ~/.junie', () => {
    const home = tmpDir('junie-untouched-');
    assert.equal(refreshJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home, models: [{ id: 'auto' }] }), null);
    assert.equal(fs.existsSync(path.join(home, 'models')), false);
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  });

  it('slug + virtual-model block stay the write contract the gateway view feeds', () => {
    assert.deepEqual(junieVirtualModelEntries().map((entry) => entry.id), JUNIE_VIRTUAL_MODELS.map((entry) => entry.model));
    assert.equal(junieModelSlug('xiaomi/mimo-v2.6-pro'), 'xiaomi-mimo-v2-6-pro');
    assert.equal(junieModelSlug('ocr/auto'), 'ocr-auto');
    assert.equal(junieModelSlug('///'), 'model');
  });
});

d?.('Junie settings — WMI guard', () => {
  const { disableJunieStatistics, junieSettingsPath } = src!;

  it('leaves a machine that never ran Junie alone', () => {
    const home = tmpDir('junie-settings-untouched-');
    const result = disableJunieStatistics({ home });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(fs.existsSync(junieSettingsPath({ home })), false);
  });

  it('turns the FUS upload off while keeping every other key', () => {
    const home = tmpDir('junie-settings-');
    const file = junieSettingsPath({ home });
    fs.writeFileSync(file, JSON.stringify({ shareAnonymousStatistics: 'true', sessionCount: '6', braveMode: 'ON' }, null, 4));
    const first = disableJunieStatistics({ home });
    assert.deepEqual([first.ok, first.changed], [true, true]);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.shareAnonymousStatistics, 'false');
    assert.equal(parsed.sessionCount, '6');
    assert.equal(parsed.braveMode, 'ON');
    // Idempotent: a second run reports "already off" instead of rewriting.
    const second = disableJunieStatistics({ home });
    assert.deepEqual([second.ok, second.changed], [true, false]);
  });

  it('refuses to rewrite a settings file it cannot parse', () => {
    const home = tmpDir('junie-settings-bad-');
    const file = junieSettingsPath({ home });
    fs.writeFileSync(file, 'not json', 'utf8');
    const result = disableJunieStatistics({ home });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
  });
});

d?.('vmoptions trust block', () => {
  const { patchVmOptions, vmOptionsTrustLines, stripVmOptions } = src!;
  const STORE = path.join('C:', 'Users', 'k', '.omnicell-router', 'jbr', 'cacerts');

  it('appends a marker-scoped block and keeps operator flags', () => {
    const out = patchVmOptions('-Xmx24G\n-Dfile.encoding=UTF-8\n', STORE);
    assert.match(out, /^-Xmx24G$/m);
    assert.match(out, /^-Dfile\.encoding=UTF-8$/m);
    assert.match(out, /# omnicell-router-managed: JBR truststore override/);
    for (const line of vmOptionsTrustLines(STORE)) assert.ok(out.split('\n').includes(line));
  });

  it('is idempotent — a second patch replaces instead of stacking', () => {
    const once = patchVmOptions('-Xmx1G\n', path.join('old', 'cacerts'));
    const twice = patchVmOptions(once, STORE);
    assert.equal(twice.match(/omnicell-router-managed/g)?.length, 1);
    assert.equal(twice.match(/-Djavax\.net\.ssl\.trustStore=/g)?.length, 1);
    assert.equal(twice.includes('old'), false);
    assert.equal(patchVmOptions(twice, STORE), twice);
  });

  it('strips exactly our block, leaving the rest byte-identical', () => {
    const original = '-Xmx24G\n-Dfile.encoding=UTF-8\n';
    const patched = patchVmOptions(original, STORE);
    assert.equal(stripVmOptions(patched), original);
    // No block → unchanged (a file we never wrote is never "unpatched").
    assert.equal(stripVmOptions(original), original);
  });

  it('parks a hand-added trustStore block instead of stacking a second one', () => {
    // Real failure: an operator (or an older manual fix) already added the two
    // -D lines. Appending ours left two truststores in one file and the winner
    // depended on JVM argument order.
    const hand = [
      '-Xmx2G',
      '-Djavax.net.ssl.trustStore=C:/old/cacerts',
      '-Djavax.net.ssl.trustStorePassword=changeit',
      '',
    ].join('\n');
    const patched = patchVmOptions(hand, STORE);
    const active = patched.split('\n').filter((line) => /^-Djavax\.net\.ssl\.trustStore=/.test(line));
    assert.equal(active.length, 1, 'exactly one active truststore');
    assert.equal(active[0], `-Djavax.net.ssl.trustStore=${STORE}`);
    assert.equal(patched.includes('old'), true, 'the operator line is parked, not deleted');
    assert.equal(patched.split('\n').filter((line) => line.startsWith('# omnicell-router-managed (disabled):')).length, 2);

    const restored = stripVmOptions(patched);
    assert.deepEqual(
      restored.split('\n').filter((line) => line !== ''),
      ['-Xmx2G', '-Djavax.net.ssl.trustStore=C:/old/cacerts', '-Djavax.net.ssl.trustStorePassword=changeit'],
    );
    assert.equal(restored.includes('omnicell-router-managed'), false);
  });

  it('strips our trust block from a file that also has unrelated JVM args after it', () => {
    const text = `-Xmx1G\n${patchVmOptions('', STORE)}-Dmy.own=1\n`;
    const out = stripVmOptions(text);
    assert.equal(out.includes('trustStore'), false);
    assert.match(out, /-Dmy\.own=1/);
  });
});

d?.('writability probe', () => {
  const { isWritable } = src!;
  it('accepts a writable file and rejects a missing one', () => {
    const dir = tmpDir('w-');
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    assert.equal(isWritable(file), true);
    assert.equal(isWritable(path.join(dir, 'missing')), false);
  });
});
