/**
 * Asset matching against the REAL Strata v0.2.22 release shape: the CUDA tail
 * is `<backend>-<variant>` (`cuda-cuda13`), hip/sycl/metal tails equal the
 * target id. Also pins the release-availability probe the console's target
 * chips read.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { getOcrHomeDir } from '../../src/cli/paths.js';
import { engineById, probeEngineAvailability } from '../../src/local/engines.js';

const STRATA = engineById('strata')!;
const LLAMACPP = engineById('llamacpp')!;

// Names verbatim from Niko1221/Strata v0.2.22 (2026-11).
const STRATA_V0222_ASSETS = [
  'strata-engine-0.1.69-linux-aarch64-cuda-cuda13.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-cuda-cuda12.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-cuda-cuda13.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-hip-halo.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-hip-rx6000.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-hip-rx7900.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-hip-rx9070.tar.gz',
  'strata-engine-0.1.69-linux-x86_64-sycl.tar.gz',
  'strata-engine-0.1.69-macos-arm64-metal.tar.gz',
  'strata-engine-0.1.69-windows-x86_64-cuda-cuda12.tar.gz',
  'strata-engine-0.1.69-windows-x86_64-cuda-cuda13.tar.gz',
  'strata-engine-0.1.69-windows-x86_64-hip-rdna2.tar.gz',
  'strata-engine-0.1.69-windows-x86_64-hip-rdna3.tar.gz',
  'strata-engine-0.1.69-windows-x86_64-hip-rx9070.tar.gz',
];

const match = (platform: NodeJS.Platform, arch: string, targetId: string, assets: string[], tag = 'v0.2.22') =>
  STRATA.matchAssets({ platform, arch, targetId, tag, assets });

describe('strata matchAssets (release v0.2.22 shape)', () => {
  test('windows cuda targets map onto the cuda-<variant> tail', () => {
    expect(match('win32', 'x64', 'cuda13', STRATA_V0222_ASSETS)).toEqual({
      assets: ['strata-engine-0.1.69-windows-x86_64-cuda-cuda13.tar.gz'],
      version: '0.1.69',
    });
    expect(match('win32', 'x64', 'cuda12', STRATA_V0222_ASSETS)).toEqual({
      assets: ['strata-engine-0.1.69-windows-x86_64-cuda-cuda12.tar.gz'],
      version: '0.1.69',
    });
  });

  test('hip and metal tails equal the target id', () => {
    expect(match('win32', 'x64', 'hip-rdna3', STRATA_V0222_ASSETS)?.assets[0]).toBe(
      'strata-engine-0.1.69-windows-x86_64-hip-rdna3.tar.gz',
    );
    expect(match('darwin', 'arm64', 'metal', STRATA_V0222_ASSETS)?.version).toBe('0.1.69');
    expect(match('linux', 'x64', 'sycl', STRATA_V0222_ASSETS)?.assets[0]).toBe(
      'strata-engine-0.1.69-linux-x86_64-sycl.tar.gz',
    );
  });

  test('the control bundle installs beside the engine, into the gateway runtime', () => {
    const assets = [
      ...STRATA_V0222_ASSETS,
      'strata-control-0.1.69-windows-x86_64.zip',
      'strata-control-0.1.69-linux-x86_64.tar.gz',
    ];
    expect(match('win32', 'x64', 'cuda13', assets)?.companions).toEqual([
      { asset: 'strata-control-0.1.69-windows-x86_64.zip', dest: path.join(getOcrHomeDir(), 'strata', 'runtime') },
    ]);
    expect(match('linux', 'x64', 'cuda13', assets)?.companions?.[0]?.asset).toBe(
      'strata-control-0.1.69-linux-x86_64.tar.gz',
    );
    // v0.2.22 has no control archive: the engine still matches, with no companion.
    expect(match('win32', 'x64', 'cuda13', STRATA_V0222_ASSETS)?.companions).toBeUndefined();
  });

  test('a target with no asset in the release returns null', () => {
    expect(match('win32', 'x64', 'cuda13', STRATA_V0222_ASSETS.filter((a) => !a.includes('cuda-cuda13')))).toBeNull();
  });
});

describe('probeEngineAvailability', () => {
  const fakeFetch = (assets: string[]) =>
    (async () =>
      new Response(JSON.stringify({ tag_name: 'v0.2.22', assets: assets.map((name) => ({ name })) }), { status: 200 })) as typeof fetch;

  test('every catalog target of this platform is reported, available or not', async () => {
    const row = await probeEngineAvailability(STRATA, fakeFetch(STRATA_V0222_ASSETS));
    expect(row.id).toBe('strata');
    expect(row.tag).toBe('v0.2.22');
    const catalog = STRATA.targets(process.platform, process.arch);
    expect(Object.keys(row.targets ?? {}).sort()).toEqual(catalog.map((t) => t.id).sort());
    for (const target of catalog) {
      // The v0.2.22 asset list above ships every catalogued Windows target.
      if (process.platform === 'win32') expect(row.targets?.[target.id]?.available).toBe(true);
    }
  });

  test('a missing asset marks exactly that target unavailable', async () => {
    const withoutCuda13 = STRATA_V0222_ASSETS.filter((a) => !a.includes('cuda-cuda13'));
    const row = await probeEngineAvailability(STRATA, fakeFetch(withoutCuda13));
    if (row.targets && 'cuda13' in row.targets) {
      expect(row.targets.cuda13).toEqual({ available: false });
    }
  });

  test('a failed release lookup yields an error row, never a throw', async () => {
    const failing = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const row = await probeEngineAvailability(STRATA, failing);
    expect(row.error).toBeTruthy();
    expect(row.targets).toBeUndefined();
  });

  test('llama.cpp targets match by exact asset name against the release tag', async () => {
    const tag = 'b12728';
    const cpuAssets = [`llama-${tag}-bin-win-cpu-x64.zip`];
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ tag_name: tag, assets: cpuAssets.map((name) => ({ name })) }]), { status: 200 })) as typeof fetch;
    const row = await probeEngineAvailability(LLAMACPP, fetchImpl);
    if (process.platform === 'win32') {
      expect(row.targets?.cpu?.available).toBe(true);
      expect(row.targets?.vulkan?.available).toBe(false);
    }
  });

  test('every catalogued target has a measured size (no zero-byte rows)', () => {
    for (const engine of [LLAMACPP, STRATA]) {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        for (const arch of ['x64', 'arm64']) {
          for (const target of engine.targets(platform, arch)) {
            expect(target.approxBytes, `${engine.id} ${platform}/${arch} ${target.id}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('llama.cpp release resolution (pointer-only stable tags)', () => {
  const releaseListFetch = (releases: Array<{ tag: string; assets: string[] }>) =>
    (async () =>
      new Response(
        JSON.stringify(releases.map((r) => ({ tag_name: r.tag, assets: r.assets.map((name) => ({ name })) }))),
        { status: 200 },
      )) as typeof fetch;

  test('resolveRelease skips a pointer-only stable tag and lands on the b* build', async () => {
    // The 2026-11-26 regression: stable v1.1.0 shipped ONLY nightly-tag.txt,
    // sat at the top of the release list, and shadowed every b* binary build —
    // the console read it as "the current release ships no build target".
    const release = await LLAMACPP.resolveRelease(releaseListFetch([
      { tag: 'v1.1.0', assets: ['nightly-tag.txt'] },
      { tag: 'b12774', assets: ['llama-b12774-bin-win-cpu-x64.zip'] },
    ]));
    expect(release.tag).toBe('b12774');
  });

  test('resolveRelease skips a still-uploading release with no assets at all', async () => {
    const release = await LLAMACPP.resolveRelease(releaseListFetch([
      { tag: 'b12775', assets: [] },
      { tag: 'b12774', assets: ['llama-b12774-bin-win-cpu-x64.zip'] },
    ]));
    expect(release.tag).toBe('b12774');
  });

  test('resolveRelease throws when no listed release carries binaries', async () => {
    await expect(
      LLAMACPP.resolveRelease(releaseListFetch([{ tag: 'v1.1.0', assets: ['nightly-tag.txt'] }])),
    ).rejects.toThrow('no binary release');
  });

  test('listTags never offers a binary-less tag', async () => {
    const tags = await LLAMACPP.listTags!(releaseListFetch([
      { tag: 'v1.1.0', assets: ['nightly-tag.txt'] },
      { tag: 'b12774', assets: ['llama-b12774-bin-win-cpu-x64.zip'] },
    ]));
    expect(tags).toEqual(['b12774']);
  });

  test('the availability probe resolves past a pointer-only stable tag', async () => {
    const tag = 'b12774';
    const row = await probeEngineAvailability(LLAMACPP, releaseListFetch([
      { tag: 'v1.1.0', assets: ['nightly-tag.txt'] },
      { tag, assets: [`llama-${tag}-bin-win-cpu-x64.zip`] },
    ]));
    expect(row.tag).toBe(tag);
    if (process.platform === 'win32') {
      expect(row.targets?.cpu?.available).toBe(true);
    }
  });
});
