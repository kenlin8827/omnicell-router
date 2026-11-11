import crypto from 'node:crypto';
import { ensureCa, type CaMaterial } from '../../src/forward-proxy/ca.js';

/**
 * Test-only CA factory.
 *
 * A test CA MUST NOT reuse the production `CA_CN`: when that CA is installed in
 * the OS trust store (any machine that actually ran the proxy), TLS verifiers
 * can resolve the stored same-subject certificate first and fail the chain with
 * `CERT_SIGNATURE_FAILURE` — the freshly minted CA is valid, it is simply not
 * the one the store selected. One unique CN per test process keeps every
 * test CA distinguishable from the operator's real CA.
 */
const TEST_CA_CN = `OmniCellRouter Test CA ${crypto.randomBytes(6).toString('hex')}`;

export function ensureTestCa(caDir: string): CaMaterial {
  return ensureCa(caDir, TEST_CA_CN);
}
