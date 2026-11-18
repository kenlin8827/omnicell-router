import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getOcrHomeDir } from '../src/cli/paths.js';

// The plugin sources live in a gitignored dev tree (a separate repository), so a
// fresh checkout has no `plugins/jetbrains-gateway`. A static import cannot be
// conditional — the file would fail at module load — so the package is loaded
// only when its directory exists. Bun's `node:test` compat layer ignores a
// `skip` option, so every block below registers only through `d`; `src!` is
// therefore never evaluated without the package.
const pluginDir = path.resolve(import.meta.dirname, '../../plugins/jetbrains-gateway');
const src = fs.existsSync(pluginDir) ? await import('../../plugins/jetbrains-gateway/adapter.js') : null;
/** Register a plugin-dependent block only when the package is present. */
const d = src ? describe : null;

// The hook ships as a package: its module-level path helpers resolve the OCR
// home through the host, which `createJetBrainsAdapter` installs. These tests
// drive the pure builders, so the resolver is installed here instead — and only
// when the package is present.
if (src) src.setAdapterHome(() => getOcrHomeDir());

/**
 * The JetBrains hook is a REVERSIBLE file surgery that must behave the same for
 * every product in the table, so the contract worth pinning is:
 *
 *   1. only the manual-proxy keys are overridden — the operator's proxy auth,
 *      scheme flags and every unrelated component survive verbatim;
 *   2. PAC is switched OFF (a PAC URL pointing at a Clash mixed port is exactly
 *      the failure this adapter exists to remove);
 *   3. patching is idempotent, so a re-run cannot accumulate options;
 *   4. a missing component is created rather than crashing on a fresh config;
 *   5. product detection is per product: IDEA's config roots, version pattern
 *      and install layout never answer for GoLand (and vice versa).
 */

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="HttpConfigurable">
    <option name="USE_PROXY_PAC" value="true" />
    <option name="PROXY_HOST" value="" />
    <option name="PROXY_EXCEPTIONS" value="" />
    <option name="USE_PAC_URL" value="true" />
    <option name="PAC_URL" value="http://127.0.0.1:7897" />
    <option name="PROXY_AUTH_PASSWORD" value="keep-me" />
  </component>
  <component name="SomeOtherComponent">
    <option name="untouched" value="yes" />
  </component>
</application>
`;

d?.('jetbrains-proxy proxy.settings.xml surgery', () => {
  const { patchProxySettingsXml, readProxySettings, JETBRAINS_NO_PROXY } = src!;
  it('switches the IDE from a dead PAC to the OCR manual proxy, keeping every other option', () => {
    const patched = patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4555 });
    const state = readProxySettings(patched);

    assert.equal(state.httpProxy, true);
    assert.equal(state.pac, false);
    assert.equal(state.host, '127.0.0.1');
    assert.equal(state.port, 4555);
    assert.equal(state.exceptions, JETBRAINS_NO_PROXY);
    // The PAC URL is cleared, not just flagged off: an enabled-but-unreachable
    // PAC is what `IdeProxySelector - failed to configure proxy by pacUrl` reports.
    assert.match(patched, /<option name="PAC_URL" value="" \/>/);
    // Operator state survives: auth secret and any other component.
    assert.match(patched, /<option name="PROXY_AUTH_PASSWORD" value="keep-me" \/>/);
    assert.match(patched, /<option name="untouched" value="yes" \/>/);
    assert.equal((patched.match(/name="HttpConfigurable"/g) ?? []).length, 1);
  });

  it('is idempotent — a second setup cannot stack duplicate options', () => {
    const once = patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4555 });
    const twice = patchProxySettingsXml(once, { host: '127.0.0.1', port: 4555 });
    assert.equal(twice, once);
    for (const key of ['USE_HTTP_PROXY', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_EXCEPTIONS', 'PAC_URL']) {
      assert.equal((twice.match(new RegExp(`name="${key}"`, 'g')) ?? []).length, 1, `${key} duplicated`);
    }
  });

  it('follows a moved gateway port', () => {
    const first = patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4555 });
    const second = patchProxySettingsXml(first, { host: '127.0.0.1', port: 4600 });
    assert.equal(readProxySettings(second).port, 4600);
  });

  it('creates the component on a config that never had one', () => {
    const created = patchProxySettingsXml('<application>\n</application>\n', { host: '127.0.0.1', port: 4555 });
    const state = readProxySettings(created);
    assert.equal(state.httpProxy, true);
    assert.equal(state.port, 4555);
  });
});

d?.('jetbrains-proxy status honesty', () => {
  const { patchProxySettingsXml, readProxySettings, pointsAtManualProxy, describeProxyTarget } = src!;
  it('reads the FILE, so a stale port is never reported as connected', () => {
    const stale = readProxySettings(patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4555 }));
    assert.equal(pointsAtManualProxy(stale, 'http://127.0.0.1:4557'), false);
    assert.equal(describeProxyTarget(stale), '127.0.0.1:4555');
    const moved = readProxySettings(patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4557 }));
    assert.equal(pointsAtManualProxy(moved, 'http://127.0.0.1:4557'), true);
  });

  it('treats PAC, a missing file and a junk URL as not-pointing-at-us', () => {
    assert.equal(pointsAtManualProxy(readProxySettings(SAMPLE), 'http://127.0.0.1:4557'), false);
    assert.equal(pointsAtManualProxy(null, 'http://127.0.0.1:4557'), false);
    assert.equal(pointsAtManualProxy(readProxySettings(patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4557 })), 'not a url'), false);
    assert.equal(describeProxyTarget(readProxySettings(SAMPLE)), 'a PAC script');
    assert.equal(describeProxyTarget(null), 'no proxy.settings.xml');
  });
});

d?.('jetbrains-proxy teardown without a backup', () => {
  const { patchProxySettingsXml, stripManagedProxyBlock } = src!;
  it('strips the block it wrote when the backup is gone', () => {
    const patched = patchProxySettingsXml(SAMPLE, { host: '127.0.0.1', port: 4555 });
    const stripped = stripManagedProxyBlock(patched);
    assert.ok(stripped);
    // Everything we own is gone, including the PAC keys we forced off.
    for (const key of ['USE_PROXY_PAC', 'USE_HTTP_PROXY', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_EXCEPTIONS']) {
      assert.ok(!stripped.includes(key), `${key} survived`);
    }
    // The operator's own options in that component survive the unpatch.
    assert.match(stripped, /PROXY_AUTH_PASSWORD/);
    assert.match(stripped, /untouched/);
  });

  it('never touches a file this adapter did not write', () => {
    // No marker → the IDE's (or the operator's) own config: unpatched must be
    // null, otherwise teardown would silently disable someone else's proxy.
    assert.equal(stripManagedProxyBlock(SAMPLE), null);
    assert.equal(stripManagedProxyBlock('<application></application>'), null);
  });
});

d?.('jetbrains-proxy config discovery', () => {
  const { staleLauncherPath, productConfigDir, JETBRAINS_PRODUCTS, configVersionOf, detectProduct, JETBRAINS_CA_ALIAS } = src!;
  it('publishes no launch script — the hook is the proxy-settings takeover', () => {
    // The hook is a persistent rewrite of the IDE's own proxy settings, so any
    // desktop/Start-menu shortcut applies it. The only launcher-shaped path
    // left is the orphan cleaner for the earlier launcher release.
    assert.match(staleLauncherPath(), /clients[\\/]idea-launcher\.(cmd|command|sh)$/);
  });

  it('picks the newest config root of the product it is asked about', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jb-appdata-'));
    const previous = process.env.APPDATA;
    process.env.APPDATA = appData;
    try {
      const older = path.join(appData, 'JetBrains', 'IntelliJIdea2025.3');
      const newer = path.join(appData, 'JetBrains', 'IntelliJIdea2026.1');
      const goland = path.join(appData, 'JetBrains', 'GoLand2026.1');
      for (const dir of [older, newer, goland]) fs.mkdirSync(dir, { recursive: true });
      fs.utimesSync(older, new Date(2025, 1, 1), new Date(2025, 1, 1));
      fs.utimesSync(newer, new Date(2026, 1, 1), new Date(2026, 1, 1));
      fs.utimesSync(goland, new Date(2027, 1, 1), new Date(2027, 1, 1));

      // GoLand is the newest directory on disk and must STILL not answer for
      // IDEA — the product table scopes each lookup.
      assert.equal(productConfigDir(JETBRAINS_PRODUCTS[0]), newer);
      assert.equal(productConfigDir(JETBRAINS_PRODUCTS[1]), goland);
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  it('reads the config-root version with the product own pattern', () => {
    const idea = path.join('C:', 'x', 'JetBrains', 'IntelliJIdea2026.3');
    const goland = path.join('C:', 'x', 'JetBrains', 'GoLand2026.1');
    assert.equal(configVersionOf(idea), '2026.3');
    assert.equal(configVersionOf(null), null);
    // IDEA's own pattern must not parse a GoLand root, and vice versa.
    assert.equal(configVersionOf(goland), null);
    assert.equal(configVersionOf(goland, JETBRAINS_PRODUCTS[1]), '2026.1');
    assert.equal(configVersionOf(idea, JETBRAINS_PRODUCTS[1]), null);
  });

  it('pairs an install with the config root its own product-info names', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jb-appdata-'));
    const installHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jb-install-'));
    const previousAppData = process.env.APPDATA;
    const previousHome = process.env.GOLAND_HOME;
    try {
      fs.mkdirSync(path.join(installHome, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(installHome, 'bin', process.platform === 'win32' ? 'goland64.exe' : 'goland.sh'), '');
      fs.writeFileSync(
        path.join(installHome, 'product-info.json'),
        JSON.stringify({ version: '2026.9', dataDirectoryName: 'GoLand2026.9' }),
      );
      const configDir = path.join(appData, 'JetBrains', 'GoLand2026.9');
      fs.mkdirSync(configDir, { recursive: true });
      // A stale root with a newer mtime must not win over the install's own
      // `dataDirectoryName`: that pairing is what decides where the CA and the
      // vmoptions land.
      const decoy = path.join(appData, 'JetBrains', 'GoLand2026.1');
      fs.mkdirSync(decoy, { recursive: true });
      fs.utimesSync(decoy, new Date(2027, 1, 1), new Date(2027, 1, 1));

      process.env.APPDATA = appData;
      process.env.GOLAND_HOME = installHome;
      const detected = detectProduct(JETBRAINS_PRODUCTS[1]);
      assert.equal(detected?.home, installHome);
      assert.equal(detected?.configDir, configDir);
      assert.equal(detected?.version, '2026.9');
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousHome === undefined) delete process.env.GOLAND_HOME;
      else process.env.GOLAND_HOME = previousHome;
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(installHome, { recursive: true, force: true });
    }
  });

  it('names the truststore alias teardown removes', () => {
    assert.equal(JETBRAINS_CA_ALIAS, 'ocr-forward-proxy');
  });
});

/**
 * The family scope rule: JETBRAINS_PRODUCTS covers every IntelliJ-platform
 * product Junie's IDE plugin loads in — a product the agent cannot run in would
 * be a row that hooks the proxy and then silently provides no agent. Order is
 * contract too: default parameters (`JETBRAINS_PRODUCTS[0]`) and the fixtures
 * above read IDEA and GoLand by index, so new rows are appended, never sorted.
 */
d?.('jetbrains-proxy product table scope', () => {
  const { JETBRAINS_PRODUCTS, jetbrainsProduct, productConfigDir, configVersionOf, productConfigPlaceholder } = src!;
  it('covers exactly the Junie-capable family, appended after IDEA and GoLand', () => {
    assert.deepEqual(
      JETBRAINS_PRODUCTS.map((product) => product.id),
      [
        'intellij-idea',
        'goland',
        'pycharm',
        'webstorm',
        'phpstorm',
        'clion',
        'rider',
        'rubymine',
        'rustrover',
        'datagrip',
        'android-studio',
      ],
    );
    assert.equal(jetbrainsProduct('goland')?.id, 'goland');
    assert.equal(jetbrainsProduct(' pycharm ')?.id, 'pycharm');
    assert.equal(jetbrainsProduct('idea'), null);
  });

  it('carries the documented Junie floor only where JetBrains publishes one', () => {
    // Advisory-only field: present for the products with a documented floor,
    // omitted (not zero, not guessed) where none is published.
    for (const id of ['intellij-idea', 'goland', 'pycharm', 'webstorm', 'phpstorm', 'clion', 'rider', 'rubymine', 'rustrover']) {
      assert.ok(jetbrainsProduct(id)?.junieMin, `${id} must declare a Junie floor`);
    }
    assert.equal(jetbrainsProduct('datagrip')?.junieMin, undefined);
    assert.equal(jetbrainsProduct('android-studio')?.junieMin, undefined);
  });

  it('resolves Android Studio config roots under the Google data root', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jb-appdata-'));
    const previous = process.env.APPDATA;
    process.env.APPDATA = appData;
    try {
      const studio = jetbrainsProduct('android-studio')!;
      const configDir = path.join(appData, 'Google', 'AndroidStudio2026.1');
      // A newer GoLand root under the JetBrains tree must not answer for
      // Android Studio — the vendor root is part of the product's scope.
      const decoy = path.join(appData, 'JetBrains', 'GoLand2026.3');
      for (const dir of [configDir, decoy]) fs.mkdirSync(dir, { recursive: true });
      fs.utimesSync(configDir, new Date(2026, 1, 1), new Date(2026, 1, 1));
      fs.utimesSync(decoy, new Date(2027, 1, 1), new Date(2027, 1, 1));

      assert.equal(productConfigDir(studio), configDir);
      assert.equal(configVersionOf(configDir, studio), '2026.1');
      assert.match(productConfigPlaceholder(studio), /[\\/]Google[\\/]AndroidStudio\*[\\/]options[\\/]proxy\.settings\.xml$/);
      assert.doesNotMatch(productConfigPlaceholder(studio), /JetBrains/);
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  it("parses the CE edition name with PyCharm's own pattern, never IDEA's", () => {
    const pycharm = jetbrainsProduct('pycharm')!;
    const community = path.join('C:', 'x', 'JetBrains', 'PyCharmCE2025.1');
    const professional = path.join('C:', 'x', 'JetBrains', 'PyCharm2024.3.2');
    assert.equal(configVersionOf(community, pycharm), '2025.1');
    assert.equal(configVersionOf(professional, pycharm), '2024.3.2');
    // IDEA's pattern never answers for a PyCharm root, and vice versa.
    assert.equal(configVersionOf(community), null);
  });
});

/**
 * Install selection is a correctness issue, not cosmetics: an in-place upgrade
 * leaves `Programs\IntelliJ IDEA 2026.1` holding a 2026.3 build while a fresh
 * 2026.3 install also exists under `C:\Program Files\JetBrains`. Picking by
 * folder order imported the CA into the copy nothing reads — and reported
 * success. These pin the rule: the build the config root names wins.
 */
d?.('jetbrains install selection', () => {
  const { pickInstall, readProductVersion, JETBRAINS_PRODUCTS } = src!;
  const candidate = (home: string, version: string | null) => ({
    home,
    binary: path.join(home, 'bin', 'idea64.exe'),
    configDir: null,
    version,
  });

  it('prefers the build the newest config root belongs to', () => {
    const picked = pickInstall(
      [candidate('/Programs/IntelliJ IDEA 2026.1', '2026.3'), candidate('/Program Files/JetBrains/IntelliJ IDEA 2026.3', '2026.3')],
      '2026.3',
    );
    assert.ok(picked);
    assert.equal(picked.version, '2026.3');
  });

  it('falls back to the newest build when the config version matches nothing', () => {
    const picked = pickInstall([candidate('/a/IntelliJ IDEA 2026.1', '2026.1'), candidate('/b/IntelliJ IDEA 2026.3', '2026.3')], '2025.3');
    assert.equal(picked?.home, '/b/IntelliJ IDEA 2026.3');
    // Unknown versions lose to known ones instead of winning by being first.
    const unknown = pickInstall([candidate('/x/whatever', null), candidate('/b/IntelliJ IDEA 2026.3', '2026.3')], null);
    assert.equal(unknown?.home, '/b/IntelliJ IDEA 2026.3');
  });

  it('never fabricates an install out of nothing', () => {
    assert.equal(pickInstall([], '2026.3'), null);
  });

  it('reads the build from product-info.json before the folder name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-ver-'));
    assert.equal(readProductVersion(home), null, 'no product-info and no version in the name');
    fs.writeFileSync(path.join(home, 'product-info.json'), JSON.stringify({ version: '2026.3' }));
    assert.equal(readProductVersion(home), '2026.3');
    fs.writeFileSync(path.join(home, 'product-info.json'), '{not json');
    // A corrupt file falls back to the folder name, never throws.
    assert.equal(readProductVersion(home), null);
    fs.rmSync(home, { recursive: true, force: true });

    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'IntelliJ IDEA 2026.2-'));
    assert.equal(readProductVersion(named), '2026.2');
    fs.rmSync(named, { recursive: true, force: true });

    // The folder-name fallback is product-scoped: IDEA's pattern never parses a
    // GoLand folder, and GoLand's own pattern does.
    const goland = fs.mkdtempSync(path.join(os.tmpdir(), 'GoLand 2026.2-'));
    assert.equal(readProductVersion(goland), null);
    assert.equal(readProductVersion(goland, JETBRAINS_PRODUCTS[1]), '2026.2');
    fs.rmSync(goland, { recursive: true, force: true });
  });
});

d?.('jetbrains-proxy AI activation reset', () => {
  const { resetAiPlatformLogout } = src!;
  const OTHER = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="AipLicense">
    <option name="forciblyLoggedOut" value="true" />
  </component>
  <component name="SomethingElse">
    <option name="keep" value="yes" />
  </component>
</application>
`;
  const store = (): { dir: string; file: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-prefs-'));
    const file = path.join(dir, 'options', 'other.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { dir, file };
  };

  it('clears the forced-logout marker and keeps every other option intact', () => {
    const { dir, file } = store();
    fs.writeFileSync(file, OTHER, 'utf8');
    assert.deepEqual(resetAiPlatformLogout(file), { ok: true, changed: true });
    const patched = fs.readFileSync(file, 'utf8');
    assert.match(patched, /<option name="forciblyLoggedOut" value="false" \/>/);
    assert.match(patched, /<option name="keep" value="yes" \/>/);
    // The pre-takeover bytes stay recoverable.
    assert.equal(fs.readFileSync(`${file}.ocr-backup`, 'utf8'), OTHER);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent and leaves an already-clear state alone', () => {
    const { dir, file } = store();
    fs.writeFileSync(file, OTHER, 'utf8');
    assert.equal(resetAiPlatformLogout(file).changed, true);
    const once = fs.readFileSync(file, 'utf8');
    assert.equal(resetAiPlatformLogout(file).changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never creates a file or a backup where there is no such state', () => {
    const { dir, file } = store();
    assert.deepEqual(resetAiPlatformLogout(file), { ok: true, changed: false });
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.ocr-backup`), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
