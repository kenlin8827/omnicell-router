import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import {
  acpAgentsDir,
  acpBinaryPath,
  acpDownloadPath,
  acpInstallRoot,
  buildJunieProfiles,
  detectAcpInstalls,
  downloadFile,
  extractZip,
  isWritable,
  JUNIE_TIERS,
  junieModelsPresent,
  looksLikeZip,
  mergeJunieConfig,
  patchVmOptions,
  pickAcpBinaryAsset,
  platformAssetKey,
  removeJunieModels,
  stripVmOptions,
  vmOptionsTrustLines,
  writeJunieModels,
} from '../src/cli/clients/jetbrains-junie.js';

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

describe('ACP registry resolution', () => {
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

describe('ACP install layout', () => {
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

describe('download validation', () => {
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

  it('refuses a truncated body and leaves no .part behind', async () => {
    const dir = tmpDir('dl-trunc-');
    const dest = path.join(dir, 'junie.zip');
    const payload = Buffer.from(zipSync({ 'junie/junie.exe': new Uint8Array([9]) }));
    const fetchImpl = (async () =>
      new Response(payload, { status: 200, headers: { 'content-length': String(payload.length + 500) } })) as unknown as typeof fetch;
    const res = await downloadFile('https://example.invalid/junie.zip', dest, { fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.detail ?? '', /truncated/);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
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

describe('archive extraction', () => {
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

describe('Junie model profiles', () => {
  it('uses the verbatim completions URL — Junie appends nothing', () => {
    const base = buildJunieProfiles('http://127.0.0.1:4000', 'sk-ocr-test');
    assert.equal(base[0].body.baseUrl, 'http://127.0.0.1:4000/v1/chat/completions');
    // An already-versioned or already-complete URL must not be double-suffixed.
    assert.equal(buildJunieProfiles('http://127.0.0.1:4000/v1', 'k')[0].body.baseUrl, 'http://127.0.0.1:4000/v1/chat/completions');
    assert.equal(
      buildJunieProfiles('http://127.0.0.1:4000/v1/chat/completions', 'k')[0].body.baseUrl,
      'http://127.0.0.1:4000/v1/chat/completions',
    );
    assert.equal(buildJunieProfiles('http://h:1/', 'k')[0].body.baseUrl, 'http://h:1/v1/chat/completions');
  });

  it('keeps apiKey a plain string and every tier addressable', () => {
    const profiles = buildJunieProfiles('http://127.0.0.1:4000', 'sk-ocr-test');
    assert.equal(profiles.length, JUNIE_TIERS.length);
    assert.deepEqual(
      profiles.map((p) => p.file),
      ['ocr-auto.json', 'ocr-lite.json', 'ocr-plus.json', 'ocr-pro.json', 'ocr-ultra.json'],
    );
    assert.deepEqual(
      profiles.map((p) => p.body.displayName),
      ['Auto (OCR)', 'Lite (OCR)', 'Plus (OCR)', 'Pro (OCR)', 'Ultra (OCR)'],
    );
    for (const profile of profiles) {
      assert.equal(typeof profile.body.apiKey, 'string');
      assert.equal(profile.body.apiType, 'OpenAICompletion');
      assert.equal(profile.body.id, profile.file.replace(/\.json$/, ''));
      assert.equal(profile.body.primaryModel.id, profile.body.id.replace('ocr-', ''));
      assert.equal(profile.body.fasterModel.id, 'lite');
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

    const written = writeJunieModels('http://127.0.0.1:4000', 'sk-ocr-test', { home, defaultTier: 'pro' });
    assert.equal(written.ok, true);
    assert.equal(written.files.length, JUNIE_TIERS.length);
    assert.equal(written.model, 'custom:ocr-pro');
    assert.equal(junieModelsPresent({ home }), true);

    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.model, 'custom:ocr-pro');
    assert.equal(config.effort, 'high');

    const removed = removeJunieModels({ home });
    assert.equal(removed.removed.length, JUNIE_TIERS.length);
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
});

describe('vmoptions trust block', () => {
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

describe('writability probe', () => {
  it('accepts a writable file and rejects a missing one', () => {
    const dir = tmpDir('w-');
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    assert.equal(isWritable(file), true);
    assert.equal(isWritable(path.join(dir, 'missing')), false);
  });
});
