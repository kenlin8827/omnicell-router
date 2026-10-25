import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Content hashing for harness artifacts (ADR-0015 §D4/§5.3).
 *
 * Normalization is part of the contract: LF line endings, BOM stripped, sorted relative paths, file
 * mode ignored. Without it every Windows copy with `autocrlf` would be permanently `dirty`.
 */

const BOM = '\uFEFF';

function normalizeText(bytes: Buffer): Buffer {
  let text = bytes.toString('utf8');
  if (text.startsWith(BOM)) text = text.slice(1);
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

export interface TreeHash {
  hash: string;
  files: number;
  bytes: number;
}

/** Hash a materialized directory tree with the fixed normalization above. */
export function hashTree(root: string): TreeHash {
  const files = walkFiles(root);
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const content = normalizeText(fs.readFileSync(path.join(root, rel)));
    bytes += content.length;
    digest.update(rel.replace(/\\/g, '/'));
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return { hash: digest.digest('hex'), files: files.length, bytes };
}

/** Hash a single file with the same normalization (config-file copies, MCP merges). */
export function hashFile(file: string): string {
  return crypto.createHash('sha256').update(normalizeText(fs.readFileSync(file))).digest('hex');
}
