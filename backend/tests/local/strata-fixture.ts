/**
 * A throwaway Strata layout for tests (ADR-0039 §13).
 *
 * The runtime reads the front-end and the data directory from the gateway
 * home (`<ocrHome>/strata/runtime` and `<ocrHome>/strata/data`), never from a
 * checkout beside the model file. A test that wants a launchable model plants
 * that layout under the sandbox `OCR_HOME`. The files are empty markers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../src/cli/paths.js';

export interface StrataFixture {
  /** `<ocrHome>/strata`. Removing it drops the runtime, the data dir and generated configs. */
  root: string;
  /** `<ocrHome>/strata/runtime` — `serve/` and the interpreter. */
  workspace: string;
  entry: string;
  python: string;
  /** `<ocrHome>/strata/data`. */
  dataRoot: string;
  /** `data/packs/<slug>`. */
  pack: string;
  /** `data/models/<modelDir>/<file>` — the registry path a launch reads. */
  modelPath: string;
  mtp: string;
  mmproj: string;
  expertProfile: string;
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

export function makeStrataWorkspace(options?: { slug?: string; modelDir?: string; fileName?: string; withPack?: boolean }): StrataFixture {
  const slug = options?.slug ?? 'abl-iq2_xs';
  const modelDir = options?.modelDir ?? 'abl-IQ2_XS';
  const fileName = options?.fileName ?? 'Swift-MoE-abliterated-IQ2_XS-00001-of-00002.gguf';
  const root = path.join(getOcrHomeDir(), 'strata');
  const workspace = path.join(root, 'runtime');
  const dataRoot = path.join(root, 'data');
  // One layout per gateway home. A second call in the same process must not
  // inherit the previous pack set.
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  const entry = path.join(workspace, 'serve', 'server.py');
  const python = process.platform === 'win32'
    ? path.join(workspace, '.venv', 'Scripts', 'python.exe')
    : path.join(workspace, '.venv', 'bin', 'python3');
  const pack = path.join(dataRoot, 'packs', slug);
  const modelPath = path.join(dataRoot, 'models', modelDir, fileName);
  const mtp = path.join(dataRoot, 'mtp', 'rt');
  const mmproj = path.join(dataRoot, 'models', 'mmproj-Swift-MoE-BF16.gguf');
  const expertProfile = path.join(workspace, 'data', 'expert-profile.bin');

  touch(entry);
  touch(python);
  touch(expertProfile);
  // The data root is recognised by having BOTH packs/ and models/ on disk
  // (`looksLikeDataRoot`) — a workspace whose only gap is the pack still has
  // the packs/ dir, empty, waiting for the packer (ADR-0039 §9).
  fs.mkdirSync(path.join(dataRoot, 'packs'), { recursive: true });
  if (options?.withPack !== false) {
    touch(path.join(pack, 'dense.bin'));
    // The completion marker the packer publishes LAST — `looksLikePack`
    // requires it, so a fixture pack without one is not a pack at all.
    touch(path.join(pack, 'native_experts.txt'));
    touch(path.join(pack, 'tokenizer', 'tokenizer.json'));
  }
  touch(path.join(workspace, 'tools', 'iq_pack.py'));
  touch(modelPath);
  touch(mmproj);
  touch(path.join(mtp, 'experts.bin'));

  return { root, workspace, entry, python, dataRoot, pack, modelPath, mtp, mmproj, expertProfile };
}
