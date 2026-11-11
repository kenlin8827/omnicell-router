import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand, type CommandResult } from '../utils/run-command.js';

/**
 * Is the MITM CA trusted by the platform?
 *
 * Trust is MACHINE state (ADR-0008): clients that go through the inbound
 * forward proxy verify our minted leaves against their own trust store, and a
 * missing root is the number-one setup failure. Every answer here is a
 * best-effort probe with an honest third state:
 *
 *   true       the store that platform TLS verifiers read holds the EXACT
 *              certificate (fingerprint / PEM body, never just the CN);
 *   false      the store was readable and the certificate is absent;
 *   'unknown'  the probe itself could not run (missing tool, permissions, an
 *              unreadable store) — never flattened into `false`.
 *
 * Scope: the OS/system stores plus the Chromium NSS databases named below.
 * Applications with their own private roots (Linux Firefox profiles, Java
 * keystores, bundled Mozilla roots in Node) are NOT covered — the console
 * hint says so.
 */

/** Trust-anchor directories used by the mainstream Linux distro families. */
const LINUX_CA_DIRS = [
  '/usr/local/share/ca-certificates', // Debian/Ubuntu — update-ca-certificates
  '/etc/pki/ca-trust/source/anchors', // Fedora/RHEL — update-ca-trust
  '/etc/pki/trust/anchors', // SUSE
];

/** NSS databases Chromium/Electron consult on Linux (`certutil -d sql:<db>`).
 *  A distro bundle update does NOT reach these, so they need their own check. */
const LINUX_NSS_DATABASES = [path.join(os.homedir(), '.pki', 'nssdb'), '/etc/pki/nssdb'];

/** Merged bundles `update-ca-certificates` / `update-ca-trust` regenerate. */
const LINUX_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
];

export type CaTrust = boolean | 'unknown';

/** Stores the Linux probe inspects, grouped so the tests can point it at a
 *  fixture tree instead of the host's real trust roots. */
export interface LinuxTrustStores {
  /** Anchor directories the distro CA tools read. */
  dirs: string[];
  /** Merged bundles those tools regenerate. */
  bundles: string[];
  /** NSS databases Chromium/Electron consult. */
  nssDbs: string[];
}

type CommandRunner = (cmd: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;

let commandRunner: CommandRunner = runCommand;

/** Test seam: swap the subprocess runner (the platform decision table is
 *  exercised without touching the host's real trust stores). */
export function setCaTrustCommandRunner(runner: CommandRunner | undefined): void {
  commandRunner = runner ?? runCommand;
}

/** The PEM body of the FIRST certificate in `pem`, whitespace-stripped. */
function pemBody(pem: string): string | null {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  return match?.[1].replace(/\s+/g, '') ?? null;
}

/**
 * True when `bundlePem` (a merged trust bundle such as
 * /etc/ssl/certs/ca-certificates.crt) carries the exact certificate `caPem`.
 * `update-ca-certificates` appends the PEM body verbatim, so a normalized
 * substring match is enough — no OpenSSL dependency, no CN parsing.
 */
export function pemBundleContainsCa(bundlePem: string, caPem: string): boolean {
  const body = pemBody(caPem);
  return body !== null && bundlePem.replace(/\s+/g, '').includes(body);
}

/** Read the CA PEM once; null when absent/unreadable (nothing to identify). */
function readCaPem(caPath?: string): string | null {
  if (!caPath) return null;
  try {
    return fs.readFileSync(caPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Linux trust: an anchor FILE carries the exact certificate, the merged bundle
 * carries the exact body, and Chromium/Electron read the NSS databases that a
 * distro bundle update never reaches. Any exact hit is proof; a store that
 * could not be READ leaves the answer 'unknown' instead of a dishonest false.
 *
 * Anchor files are compared by CONTENT, not filename: a rotated/older anchor
 * can share a name with the current one, and a directory listing is not
 * evidence that the installed root is this root.
 */
async function probeLinuxCaTrusted(
  caPem: string | null,
  stores: LinuxTrustStores = { dirs: LINUX_CA_DIRS, bundles: LINUX_CA_BUNDLES, nssDbs: LINUX_NSS_DATABASES },
): Promise<CaTrust> {
  if (!caPem) return 'unknown';
  let checked = false;
  /** A store that was visible but unreadable: not a hit, and not proof of
   *  absence either — the requested root could be sitting in it. */
  let blind = false;
  for (const dir of stores.dirs) {
    let entries: string[];
    try {
      if (!fs.existsSync(dir)) continue;
      entries = fs.readdirSync(dir);
    } catch {
      blind = true; // unreadable anchor dir = this check did not run
      continue;
    }
    checked = true;
    for (const entry of entries) {
      try {
        const file = path.join(dir, entry);
        if (!fs.statSync(file).isFile()) continue;
        if (pemBundleContainsCa(fs.readFileSync(file, 'utf8'), caPem)) return true;
      } catch {
        blind = true; // unreadable entry: not a hit, and not proof of absence
      }
    }
  }
  for (const bundle of stores.bundles) {
    let bundlePem: string;
    try {
      if (!fs.existsSync(bundle)) continue;
      bundlePem = fs.readFileSync(bundle, 'utf8');
    } catch {
      blind = true; // unreadable bundle = this check did not run
      continue;
    }
    checked = true;
    if (pemBundleContainsCa(bundlePem, caPem)) return true;
  }
  for (const db of stores.nssDbs) {
    if (!fs.existsSync(db)) continue;
    // `-L -a` dumps every certificate in the DB as PEM, so the comparison is
    // the same exact-body check as the bundle — the old CN-name witness
    // reported "trusted" for a stale same-CN root the verifier never used.
    const r = await commandRunner('certutil', ['-d', `sql:${db}`, '-L', '-a']);
    if (/ENOENT|not found/i.test(r.stderr) && !r.stdout) continue; // no certutil → cannot judge
    if (!r.ok) {
      blind = true; // the listing did not run (locked/broken/permission)
      continue;
    }
    checked = true;
    if (pemBundleContainsCa(r.stdout, caPem)) return true;
  }
  return checked && !blind ? false : 'unknown';
}

/** Read the exact thumbprint the Windows store lookup must match. */
function windowsThumbprint(caPath?: string): string | null {
  try {
    if (!caPath) return null;
    return new crypto.X509Certificate(fs.readFileSync(caPath)).fingerprint.replace(/:/g, '');
  } catch {
    return null;
  }
}

/**
 * Windows trust: match the EXACT certificate, not just the CN. Two installs
 * could share `CA_CN` (legacy per-home CAs minted before the key-derived OU),
 * and the CN-only witness reported "trusted" while the TLS verifier kept
 * selecting the other root — the false green that hid Cursor's
 * CERT_SIGNATURE_FAILURE. A missing certificate is a definite false; a tool
 * that could not run stays 'unknown'.
 *
 * Only the CURRENT user's store and the machine store are probed: `-user`
 * resolves against the gateway process account, which is the desktop user in
 * the normal install and a different store under a service account.
 */
async function probeWindowsCaTrusted(thumbprint: string | null): Promise<CaTrust> {
  // No readable certificate = nothing to identify. A CN-only witness is
  // exactly the false green that hid Cursor's CERT_SIGNATURE_FAILURE (two
  // roots can share the CN), so this is 'unknown', never 'trusted'.
  if (!thumbprint) return 'unknown';
  const machine = await commandRunner('certutil', ['-store', 'Root', thumbprint]);
  if (machine.ok) return true;
  const user = await commandRunner('certutil', ['-user', '-store', 'Root', thumbprint]);
  if (user.ok) return true;
  const output = `${machine.stdout}${machine.stderr}${user.stdout}${user.stderr}`;
  return /NTE_NOT_FOUND|0x80090011|not found|找不到/i.test(output) ? false : 'unknown';
}

/**
 * macOS trust: `security verify-cert` evaluates the REAL SSL trust policy
 * for our own cert file, so a non-zero exit is a definite NOT-trusted. A
 * keychain PRESENCE probe (`find-certificate -c <CN>`) would only prove a
 * certificate with that NAME was added — a CA imported with default trust
 * settings sits in the keychain and still fails TLS — so when verify-cert
 * itself cannot run the answer is 'unknown', not a guess.
 */
async function probeDarwinCaTrusted(caPath?: string): Promise<CaTrust> {
  // A missing/unreadable PEM is nothing to identify — same tri-state answer as
  // Windows, never a fabricated "not trusted".
  if (!caPath || !fs.existsSync(caPath)) return 'unknown';
  const v = await commandRunner('security', ['verify-cert', '-c', caPath, '-p', 'ssl']);
  if (v.ok) return true;
  if (!/ENOENT|command not found/i.test(v.stderr)) return false;
  return 'unknown';
}

/**
 * Best-effort platform probe: is the OCR forward-proxy CA trusted?
 * `platform` and `linuxStores` are injectable for the tests only; production
 * always probes the running platform and its real trust roots. `caPath` is the
 * PEM the client must trust.
 */
export async function probeCaTrusted(
  caPath?: string,
  platform: NodeJS.Platform = process.platform,
  linuxStores?: LinuxTrustStores,
): Promise<CaTrust> {
  try {
    if (platform === 'win32') return probeWindowsCaTrusted(windowsThumbprint(caPath));
    if (platform === 'darwin') return probeDarwinCaTrusted(caPath);
    return probeLinuxCaTrusted(readCaPem(caPath), linuxStores);
  } catch {
    return 'unknown';
  }
}

/**
 * CA-trust probe cache: one entry per CA path, 60s TTL — the console polls
 * client status every few seconds and this probe spawns up to three
 * subprocesses per call (`probeClientVersion`'s rule: status polls must not
 * spawn processes). An explicit "check now" passes `force` so the answer
 * after an install is never a stale pre-install verdict.
 */
const caTrustCache = new Map<string, { trusted: CaTrust; at: number }>();
const CA_TRUST_PROBE_TTL_MS = 60 * 1000;

export interface CaTrustProbeOptions {
  /** Bypass the TTL cache (operator-initiated re-check). */
  force?: boolean;
}

/** A verdict plus the epoch ms of the probe that produced it (a cache hit
 *  keeps the ORIGINAL probe time — the console must never imply it re-ran). */
export interface CaTrustReport {
  trusted: CaTrust;
  checkedAt: number;
}

export async function probeCaTrustedCached(
  caPath: string,
  opts: CaTrustProbeOptions = {},
): Promise<CaTrustReport> {
  const hit = caTrustCache.get(caPath);
  if (!opts.force && hit && Date.now() - hit.at < CA_TRUST_PROBE_TTL_MS) {
    return { trusted: hit.trusted, checkedAt: hit.at };
  }
  const trusted = await probeCaTrusted(caPath);
  const checkedAt = Date.now();
  caTrustCache.set(caPath, { trusted, at: checkedAt });
  return { trusted, checkedAt };
}
