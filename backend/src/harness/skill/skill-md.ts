import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal Agent-Skills frontmatter reader.
 *
 * A `SKILL.md` starts with a YAML frontmatter block holding at least `name` and `description` (the
 * spec's requirement). We read only that block — a skill body may be megabytes — and we parse only
 * the flat `key: value` scalars we display. Nested maps/lists are ignored, not guessed at.
 *
 * Deliberately NOT a YAML dependency: the fields shown in the console are flat strings, and a parser
 * that silently mis-reads a nested structure would be worse than showing nothing.
 */

export interface SkillMeta {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
}

const MAX_HEAD_BYTES = 8192;

function parseScalar(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\s+/g, ' ').trim();
}

/** Read the frontmatter of `<dir>/SKILL.md`; returns `{}` when absent or unreadable. */
export function readSkillMeta(dir: string): SkillMeta {
  const file = path.join(dir, 'SKILL.md');
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_HEAD_BYTES);
      const read = fs.readSync(fd, buffer, 0, MAX_HEAD_BYTES, 0);
      head = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }

  const normalized = head.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const meta: SkillMeta = {};
  let currentKey: string | null = null;
  /** Set when a key opened a block scalar (`description: |` / `>`); following indented lines fold in. */
  let blockKey: string | null = null;

  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      currentKey = match[1];
      blockKey = null;
      const value = parseScalar(match[2]);
      if (/^[|>][-+]?$/.test(value)) {
        blockKey = currentKey;
        continue;
      }
      if (value) {
        if (currentKey === 'name') meta.name = value;
        else if (currentKey === 'description') meta.description = value;
        else if (currentKey === 'license') meta.license = value;
        else if (currentKey === 'compatibility') meta.compatibility = value;
      }
      continue;
    }
    // Folded/continued scalar: only the description is displayed, so only it is collected.
    const continuation = /^\s+(\S.*)$/.exec(line);
    if (continuation && blockKey === 'description') {
      const part = parseScalar(continuation[1]);
      if (part) meta.description = meta.description ? `${meta.description} ${part}` : part;
    }
  }

  return meta;
}
