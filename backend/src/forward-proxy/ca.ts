import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { getOcrHomeDir, getSharedDataRootDir } from '../cli/paths.js';

/**
 * MITM CA + per-host certificate minting for the inbound forward proxy.
 *
 * Generation uses `node:crypto` for the RSA keypairs (native, fast) and
 * node-forge purely for X.509 assembly/signing (Bun has no cert-signing API).
 * On disk under `<caDir>/`: ca.pem + ca-key.pem + leaf-key.pem (all 0600).
 *
 * One shared leaf keypair is reused across every minted cert — the certs are
 * all ours; only the subject/SAN varies per host. Minted certs are cached in
 * memory (persist nothing per-host).
 */

export const CA_CN = 'OmniCellRouter Forward Proxy CA';
const CA_DAYS = 3650;
const LEAF_DAYS = 30;

function generateRsaKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

function createCaCertPem(caKey: forge.pki.rsa.PrivateKey, commonName: string): string {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(caKey.n, caKey.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 24 * 3600 * 1000);
  // A unique OU per CA key. Without it every OCR CA shares one subject DN, and
  // a verifier holding several same-subject roots (the operator's installed
  // CA plus a test/rotated one) can select the wrong certificate and report
  // CERT_SIGNATURE_FAILURE. The CN stays stable for CA detection/CLI display.
  const keyId = crypto
    .createHash('sha256')
    .update(`${caKey.n.toString(16)}:${caKey.e.toString(16)}`)
    .digest('hex')
    .slice(0, 8);
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationalUnitName', value: `CA ${keyId}` },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

export interface CaMaterial {
  caCertPem: string;
  caCert: forge.pki.Certificate;
  caKey: forge.pki.rsa.PrivateKey;
  leafKeyPem: string;
  leafKey: forge.pki.rsa.PrivateKey;
}

/**
 * Load the CA bundle from disk, generating (and persisting) it on first use.
 *
 * `commonName` is overridable for TESTS only. A test CA that reuses `CA_CN` is
 * shadowed by an OCR CA installed in the OS trust store: the TLS verifier can
 * resolve the stored same-subject certificate first and fail the signature
 * check (CERT_SIGNATURE_FAILURE) even though the minted CA is valid.
 *
 * A persisted bundle whose CN differs from an EXPLICITLY requested one is an
 * ERROR, never a silent return: `ensureCa(dir, testCn)` on a dir that already
 * holds the operator CA would hand back the production CA and reintroduce
 * exactly that shadowing with no trace of what happened. The DEFAULT CN stays
 * permissive on purpose — the proxy, the PEM download and the CA card all call
 * `ensureCa(dir)` and must keep working over whatever bundle the dir holds
 * (test sandboxes seed one).
 */
export function ensureCa(caDir: string, commonName: string = CA_CN): CaMaterial {
  fs.mkdirSync(caDir, { recursive: true });
  const caCertPath = path.join(caDir, 'ca.pem');
  const caKeyPath = path.join(caDir, 'ca-key.pem');
  const leafKeyPath = path.join(caDir, 'leaf-key.pem');

  let caCertPem: string;
  let caKeyPem: string;
  let leafKeyPem: string;
  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath) && fs.existsSync(leafKeyPath)) {
    caCertPem = fs.readFileSync(caCertPath, 'utf8');
    caKeyPem = fs.readFileSync(caKeyPath, 'utf8');
    leafKeyPem = fs.readFileSync(leafKeyPath, 'utf8');
    const persistedCn = forge.pki.certificateFromPem(caCertPem).subject.getField('CN').value as string;
    if (commonName !== CA_CN && persistedCn !== commonName) {
      throw new Error(
        `CA at ${caDir} has CN "${persistedCn}", but "${commonName}" was requested — refusing to return a CA under the wrong identity.`
      );
    }
  } else {
    caKeyPem = generateRsaKeyPem();
    leafKeyPem = generateRsaKeyPem();
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);
    caCertPem = createCaCertPem(caKey, commonName);
    fs.writeFileSync(caCertPath, caCertPem, { mode: 0o600 });
    fs.writeFileSync(caKeyPath, caKeyPem, { mode: 0o600 });
    fs.writeFileSync(leafKeyPath, leafKeyPem, { mode: 0o600 });
  }

  return {
    caCertPem,
    caCert: forge.pki.certificateFromPem(caCertPem),
    caKey: forge.pki.privateKeyFromPem(caKeyPem),
    leafKeyPem,
    leafKey: forge.pki.privateKeyFromPem(leafKeyPem),
  };
}

/**
 * The machine-wide CA directory every OCR book-set shares: the per-user data
 * root (the desktop shell's default OCR_HOME) + `forward-proxy`. A trust anchor
 * is MACHINE state — a second install must adopt the root the operator already
 * imported instead of minting a same-CN twin that clients can pick by mistake
 * (`CERT_SIGNATURE_FAILURE`). `forwardProxy.caDir` is the operator override;
 * `OCR_CA_DIR` pins the default for sandboxed test runs.
 */
export function defaultCaDir(): string {
  return path.join(getSharedDataRootDir(), 'forward-proxy');
}

const CA_FILES = ['ca.pem', 'ca-key.pem', 'leaf-key.pem'] as const;

/**
 * Adopt a legacy per-home CA into the shared dir. Upgrades from the old default
 * (`<ocrHome>/forward-proxy`) MUST keep the same identity: regenerating would
 * invalidate the root the operator already imported into the OS trust store.
 * Runs only while the shared dir holds no CA; each file lands through
 * temp+rename so a concurrent boot never reads a half-written key. Best-effort:
 * a failed adoption falls through to minting a fresh CA in the shared dir.
 */
function adoptLegacyCa(targetDir: string): void {
  const legacyDir = path.join(getOcrHomeDir(), 'forward-proxy');
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
  if (CA_FILES.some((name) => fs.existsSync(path.join(targetDir, name)))) return;
  if (!CA_FILES.every((name) => fs.existsSync(path.join(legacyDir, name)))) return;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of CA_FILES) {
      const dest = path.join(targetDir, name);
      if (fs.existsSync(dest)) continue;
      const tmp = `${dest}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(path.join(legacyDir, name), tmp);
        fs.renameSync(tmp, dest);
        fs.chmodSync(dest, 0o600);
      } catch {
        fs.rmSync(tmp, { force: true });
      }
    }
  } catch {
    // Unreadable legacy dir or a read-only data root: fall through to a fresh CA.
  }
}

/**
 * Resolve the MITM CA directory: the operator's `forwardProxy.caDir` override,
 * else the `OCR_CA_DIR` sandbox pin, else the machine-wide default (adopting a
 * legacy per-home CA first). ONE spelling for the proxy, the console CA
 * download and the system-proxy trust hint — a drift twin here points users at
 * a certificate the proxy does not use.
 */
export function resolveCaDir(caDir?: string): string {
  const explicit = caDir?.trim() || process.env.OCR_CA_DIR?.trim();
  if (explicit) return explicit;
  const dir = defaultCaDir();
  adoptLegacyCa(dir);
  return dir;
}

/** Display-safe identity of the persisted CA (console CA card). */
export interface CaMeta {
  /** Absolute path of the PEM clients must trust. */
  path: string;
  fingerprintSha256: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

/** Read/generate the CA and describe it without exposing key material. */
export function describeCa(caDir?: string): CaMeta {
  const dir = resolveCaDir(caDir);
  const x509 = new crypto.X509Certificate(ensureCa(dir).caCertPem);
  return {
    path: path.join(dir, 'ca.pem'),
    fingerprintSha256: x509.fingerprint256,
    subject: x509.subject.split('\n').join(', '),
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: new Date(x509.validTo).toISOString(),
  };
}

interface MintedCert {
  key: string;
  cert: string;
}

/**
 * Cap on cached leaf certs. Full-capture MITM mints one per host and the proxy
 * sees every host a client visits, so an unbounded map is a slow leak; evicting
 * a cert is free (the next CONNECT re-mints it from the same CA).
 */
const MAX_CACHED_CERTS = 512;

export class CertMinter {
  private cache = new Map<string, MintedCert>();

  constructor(private ca: CaMaterial) {}

  /** Cached per-host leaf cert for the per-host `tls.createServer` (server.ts). */
  get(host: string): MintedCert {
    const hit = this.cache.get(host);
    if (hit) {
      // Re-insert to mark most-recently-used (a Map keeps insertion order).
      this.cache.delete(host);
      this.cache.set(host, hit);
      return hit;
    }
    const certPem = this.mintLeaf(host);
    const out: MintedCert = {
      key: this.ca.leafKeyPem,
      cert: certPem,
    };
    this.cache.set(host, out);
    while (this.cache.size > MAX_CACHED_CERTS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return out;
  }

  private mintLeaf(host: string): string {
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(this.ca.leafKey.n, this.ca.leafKey.e);
    cert.serialNumber = '02' + crypto.randomBytes(9).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.ca.caCert.subject.attributes);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const altNames = (isIp ? [{ type: 7, ip: host }] : [{ type: 2, value: host }]) as any;
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ]);
    cert.sign(this.ca.caKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
}