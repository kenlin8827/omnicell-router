/**
 * Offline recovery for password-protected environment archives (.orc_env.zip
 * whose entries are AES-encrypted in WinZip AE-2 format).
 *
 * Decrypts and either unpacks straight to a directory or re-emits a PLAIN zip
 * — WITHOUT any running OCR gateway. The password is the ONLY requirement:
 * AE-2 keys derive from it alone; no OCR install, state, or config is ever
 * consulted. This script is the escape hatch if OCR itself is gone (though
 * 360 Zip / 7-Zip / WinRAR can open the encrypted archive directly too).
 *
 * Usage:
 *   bun scripts/decrypt-archive.ts <archive.orc_env.zip> <password> [outDir]
 *
 * With [outDir]: unpacks manifest.json / config.yaml / payload files into it.
 * Without: writes <name>.plain.zip next to the input file.
 *
 * Note: passing the password as an argv lands it in the shell history — for
 * paranoid use, run from an ephemeral shell or clear the history afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js';
import { safeResolveWithin } from '../backend/src/config/env-archive.js';

configure({ useWebWorkers: false });

const [input, password, outDir] = process.argv.slice(2);
if (!input || !password) {
  console.error('Usage: bun scripts/decrypt-archive.ts <archive.orc_env.zip> <password> [outDir]');
  console.error('The password is the one chosen at export time (it is never stored anywhere).');
  process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(input));
if (!(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
  console.error(`Not a zip archive: ${input}`);
  process.exit(1);
}

const reader = new ZipReader(new BlobReader(new Blob([bytes])), { password });
let entries;
try {
  entries = await reader.getEntries();
} catch (err: any) {
  console.error(`Not a readable zip archive: ${err?.message ?? err}`);
  process.exit(1);
}

try {
  if (!outDir) {
    // Re-emit the same entries as a PLAIN (unencrypted) zip.
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const entry of entries) {
      if (entry.directory) continue;
      await writer.add(entry.filename, new TextReader(await entry.getData(new TextWriter())));
    }
    const blob = await writer.close();
    const out = input.replace(/\.orc_env\.zip$/i, '') + '.plain.zip';
    fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    console.log(`Decrypted → ${out} (open it with any unzip tool)`);
  } else {
    // Unpack mode: the archive may come from someone else, so entry paths
    // still get the same traversal guard the import route uses (cp-boundary).
    const root = path.resolve(outDir);
    fs.mkdirSync(root, { recursive: true });
    let written = 0;
    for (const entry of entries) {
      if (entry.directory) continue;
      const target = safeResolveWithin(root, entry.filename);
      if (!target) {
        console.error(`Skipped unsafe entry: ${entry.filename}`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.getData(new TextWriter()), 'utf8');
      written++;
    }
    console.log(`Decrypted + unpacked ${written} entries → ${root}`);
  }
} catch (err: any) {
  console.error(`Decryption failed — wrong password or corrupted archive (${err?.message ?? err})`);
  process.exit(1);
} finally {
  await reader.close().catch(() => {});
}
