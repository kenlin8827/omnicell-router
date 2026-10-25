import fs from 'node:fs';
import { findArtifact, writeManifest, readManifest } from './manifest.js';
import { adapterFor, isExtensionHost } from './adapters/index.js';
import type { ArtifactRecord, CopyPlacement, CopyRecord } from './types.js';

/**
 * Install probe (ADR-0015 §D8) — post-apply verification that a copy is actually loadable-shaped,
 * not just written. Placement upgrades `materialized` → `verified` only when the probe PASSES; a
 * failed probe records `unverified` and never lies about state (the copy-state vocabulary has no
 * "probably fine").
 *
 * Probes are read-only and cheap:
 *  - skill      → `<copy>/SKILL.md` exists (the minimum a runtime needs to load the skill);
 *  - mcp        → the config file parses and contains the server key;
 *  - extension  → `external` copy: the apply-time subprocess exit code IS the proof; config copy:
 *                 the file the writer merged into still lists the spec in that host's container.
 *
 * A probe answers THREE states, never two: `true` (proven present), `false` (proven absent) and
 * `null` (this copy cannot be judged at all — e.g. the host has no extension landing to inspect).
 * An undecidable copy keeps whatever placement it already had; "I cannot tell" is not the same
 * claim as "I checked and it failed", and placement is the vocabulary that must never overstate.
 *
 * The container name comes from the host ADAPTER (`containers`), never from a literal — a new
 * extension host must not require editing the probe, and a renamed key (`plugin` → `plugins`) is a
 * per-host fact, not a probe change.
 */

export interface ProbeResult {
  artifactId: string;
  /** `placement: null` = undecidable; the copy's stored placement is left untouched. */
  copies: { path: string; placement: CopyPlacement | null }[];
  /** True when every copy probed verified. */
  allVerified: boolean;
}

function skillProbe(path: string): boolean {
  return fs.existsSync(path) && fs.existsSync(`${path}/SKILL.md`);
}

function configContains(path: string, key: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;
    // The server entry lives under the container the writer merged into (opencode: `mcp`).
    const container = parsed['mcp'];
    return Boolean(container && typeof container === 'object' && key in (container as Record<string, unknown>));
  } catch {
    return false;
  }
}

function arrayContains(path: string, containers: string[], value: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return containers.some((container) => {
      const arr = parsed[container];
      return Array.isArray(arr) && arr.includes(value);
    });
  } catch {
    return false;
  }
}

/**
 * Extension copy probe. An `external` copy is package-manager-owned: its `path` is an identity token
 * and the subprocess exit code already proved the install, so there is nothing left to inspect.
 *
 * A config copy is verified only against the container the host catalog declares. The compared value
 * is `record.name`, which for an extension record IS the verbatim spec the writer pushed into that
 * container (`writers/extension.ts`: `arr.push(req.spec)` + `name: req.spec`) — never the package
 * name, which would miss every pinned `name@version` entry.
 *
 * `null` is returned whenever the landing cannot be resolved (`ok: false`), the host lands via a
 * package-manager subprocess (no in-file container exists), or the record carries no harness: in all
 * three the probe has no table to read, so the copy's placement must stay as recorded.
 */
function extensionProbe(record: ArtifactRecord, copy: CopyRecord): boolean | null {
  if (copy.external === true) return true;
  if (!record.harness) return null;
  // Only the container list is taken from the adapter: the probe reads the RECORDED path, and the
  // container spelling is host-static. (Project-scope path resolution would need the install's
  // projectRoot.)
  const adapter = adapterFor(record.harness);
  const containers = isExtensionHost(adapter) ? adapter.containers() : [];
  if (containers.length === 0) return null;
  return arrayContains(copy.path, containers, record.name);
}

export function probeArtifact(artifactId: string): ProbeResult | null {
  const record = findArtifact(artifactId);
  if (!record) return null;
  const probed = record.copies.map((copy) => {
    let ok: boolean | null;
    if (record.kind === 'skill') ok = skillProbe(copy.path);
    else if (record.kind === 'mcp') ok = configContains(copy.path, record.name);
    else ok = extensionProbe(record, copy);
    return { path: copy.path, placement: ok === null ? null : ((ok ? 'verified' : 'unverified') as CopyPlacement) };
  });

  // Persist the upgraded placement so the inventory reports what was PROVEN, not what was written.
  // An undecidable copy (`null`) is left exactly as recorded — no rewrite to `unverified`.
  const manifest = readManifest();
  const target = manifest.artifacts.find((a) => a.id === artifactId);
  if (target) {
    target.copies = target.copies.map((copy) => {
      const hit = probed.find((p) => p.path === copy.path);
      return hit && hit.placement !== null ? { ...copy, placement: hit.placement } : copy;
    });
    writeManifest(manifest);
  }

  return { artifactId, copies: probed, allVerified: probed.length > 0 && probed.every((p) => p.placement === 'verified') };
}
