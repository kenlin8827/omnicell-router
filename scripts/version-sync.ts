#!/usr/bin/env node
// Single-source version sync. The repo root package.json is the ONLY place a
// human edits the version; this script mirrors it into the copies the npm /
// Tauri / Cargo ecosystems each hard-require. Wired as the npm "version"
// lifecycle hook, so `npm version minor` updates every file in one step.
//
//   bun scripts/version-sync.ts            sync all files to the root version
//   bun scripts/version-sync.ts --check    verify only, exit 1 on drift (CI guard)
//
// Node-compatible on purpose: CI runs it with the same bun setup, but keeping
// it std-node:fs keeps it usable from any runner without dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (typeof rootPkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(rootPkg.version)) {
  console.error(`[version-sync] root package.json has no valid version: ${rootPkg.version}`);
  process.exit(2);
}
const v = rootPkg.version;
const check = process.argv.includes('--check');

// Cargo.lock is positional: only the self-crate's version line may be touched,
// anchored to its name to leave third-party crates (e.g. vswhom 0.1.0) alone.
const targets = [
  { file: 'backend/package.json', from: /"version": "[^"]*"/, to: `"version": "${v}"` },
  { file: 'frontend/package.json', from: /"version": "[^"]*"/, to: `"version": "${v}"` },
  { file: 'desktop/package.json', from: /"version": "[^"]*"/, to: `"version": "${v}"` },
  { file: 'desktop/src-tauri/tauri.conf.json', from: /"version": "[^"]*"/, to: `"version": "${v}"` },
  { file: 'desktop/src-tauri/Cargo.toml', from: /^version = "[^"]*"/m, to: `version = "${v}"` },
  {
    file: 'desktop/src-tauri/Cargo.lock',
    from: /(name = "omnicell-router-desktop"\r?\nversion = ")[^"]*(")/,
    to: `$1${v}$2`,
  },
];

let drift = false;
for (const t of targets) {
  const abs = path.join(root, t.file);
  const before = fs.readFileSync(abs, 'utf8');
  const after = before.replace(t.from, t.to);
  if (after === before) continue; // already in sync
  if (check) {
    console.error(`[version-sync] DRIFT ${t.file}: expected ${v}`);
    drift = true;
  } else {
    fs.writeFileSync(abs, after, 'utf8');
    console.log(`[version-sync] ${t.file} -> ${v}`);
  }
}

if (drift) process.exit(1);
console.log(`[version-sync] ${check ? 'check' : 'sync'} OK (root version ${v})`);
