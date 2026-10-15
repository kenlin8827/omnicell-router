import fs from 'node:fs';
import { readJsonc, type OpenCodeAuthEntry } from '../user-config.js';
import { CredentialPaths } from './paths.js';
import { StoreUnreadableError } from './types.js';

/**
 * READ-ONLY view of opencode's legacy `auth.json`.
 *
 * opencode v2 imports this file once during its own db migration and never writes it
 * back, and opencode v1 is not supported — so auth.json is never a credential SINK
 * for OCR. What remains is the migration read: keys that exist only in the snapshot
 * are pushed into the bound store once, then the file is left alone on disk (OCR
 * never deletes upstream files).
 */
export interface AuthSnapshot {
  read: () => Record<string, OpenCodeAuthEntry>;
}

/**
 * Snapshot accessor bound to an injected path. Byte-identical parse semantics to
 * user-config's readAuthEntries, but never falling back to the operator's real home
 * (OCR_HOME alone does not sandbox opencode paths).
 */
export function authSnapshot(paths: CredentialPaths): AuthSnapshot {
  return {
    read: (): Record<string, OpenCodeAuthEntry> => {
      if (!fs.existsSync(paths.authJsonPath)) return {};
      const parsed = readJsonc(paths.authJsonPath);
      if (!parsed || typeof parsed !== 'object') {
        throw new StoreUnreadableError('cannot_open', 'auth.json exists but is not parsable', paths.authJsonPath);
      }
      return parsed as Record<string, OpenCodeAuthEntry>;
    },
  };
}
