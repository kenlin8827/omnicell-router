import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';

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

const CA_CN = 'OmniCellRouter Forward Proxy CA';
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

function createCaCertPem(caKey: forge.pki.rsa.PrivateKey): string {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(caKey.n, caKey.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: CA_CN }];
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

/** Load the CA bundle from disk, generating (and persisting) it on first use. */
export function ensureCa(caDir: string): CaMaterial {
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
  } else {
    caKeyPem = generateRsaKeyPem();
    leafKeyPem = generateRsaKeyPem();
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);
    caCertPem = createCaCertPem(caKey);
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

interface MintedCert {
  key: string;
  cert: string;
}

export class CertMinter {
  private cache = new Map<string, MintedCert>();

  constructor(private ca: CaMaterial) {}

  /** Cached per-host leaf cert for the per-host `tls.createServer` (server.ts). */
  get(host: string): MintedCert {
    const hit = this.cache.get(host);
    if (hit) return hit;
    const certPem = this.mintLeaf(host);
    const out: MintedCert = {
      key: this.ca.leafKeyPem,
      cert: certPem,
    };
    this.cache.set(host, out);
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