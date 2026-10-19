import fs from 'node:fs';
import path from 'node:path';
import type { CatalogProviderRecord } from './types.js';
import { getEnvPaths } from '../../config/env.js';

/**
 * Static OCR catalog store (<env.catalog>/ocr.json — default env binds to
 * ~/.onecast-router/catalog/ocr.json).
 *
 * This is the LOCAL DATABASE of the catalog: the full aggregated view
 * (catalogRepository.list()) materialized to disk. The repository loads this
 * file at boot when its signature matches, and rewrites it whenever the
 * aggregation is rebuilt (source sync, config/defs-file changes).
 * Writes are atomic (tmp + rename), mirroring cache.ts.
 */

export interface OcrCatalogStore {
  /** v2 = source ids renamed (builtin → opencode) + catalog/ directory layout */
  version: 2;
  /** aggregation signature — jsonc/config.yaml mtimes + source defs + locked ids */
  sig: string;
  /** when this snapshot was aggregated (epoch ms) */
  builtAt: number;
  providers: CatalogProviderRecord[];
}

export function getOcrStorePath(): string {
  const override = process.env.OCR_CATALOG_PATH;
  if (override) return override;
  return path.join(getEnvPaths().catalogDir, 'ocr.json');
}

export function readOcrStore(): OcrCatalogStore | null {
  try {
    const file = getOcrStorePath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as OcrCatalogStore;
    if (parsed?.version !== 2 || typeof parsed.sig !== 'string' || typeof parsed.builtAt !== 'number') return null;
    if (!Array.isArray(parsed.providers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeOcrStore(sig: string, providers: CatalogProviderRecord[]): void {
  try {
    const file = getOcrStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const store: OcrCatalogStore = { version: 2, sig, builtAt: Date.now(), providers };
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best effort — the in-memory copy still serves; next rebuild retries
  }
}
