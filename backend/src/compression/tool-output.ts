import type { CanonicalRequest } from '../ir/types.js';
import { MIN_BLOB_BYTES, MAX_BLOB_BYTES } from './constants.js';
import { detectContentKind, ContentKind } from './detect.js';
import {
  compressGitStatus, compressGitLog, compressGitDiff, compressGrepHits,
  compressPathList, compressDirListing, compressFsTree, compressBuildLog,
  compressNumberedFile, compressGeneric,
} from './compressors.js';

export interface CompressionStats {
  bytesBefore: number;
  bytesAfter: number;
  hits: { kind: ContentKind; saved: number }[];
}

const COMPRESSORS: Record<ContentKind, (text: string) => string> = {
  'git-log': compressGitLog, 'git-diff': compressGitDiff, 'git-status': compressGitStatus,
  'build-log': compressBuildLog, 'grep-hits': compressGrepHits, 'path-list': compressPathList,
  'dir-listing': compressDirListing, 'fs-tree': compressFsTree,
  'numbered-file': compressNumberedFile, generic: compressGeneric,
};

function countLines(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

function compressText(text: string, stats: CompressionStats): string {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;
  if (bytesIn < MIN_BLOB_BYTES || bytesIn > MAX_BLOB_BYTES) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const kind = detectContentKind(text);
  let output: string;
  try {
    output = COMPRESSORS[kind](text);
  } catch (err: any) {
    console.warn(`[compression] ${kind} compressor failed — passthrough: ${err?.message || err}`);
    stats.bytesAfter += bytesIn;
    return text;
  }
  if (!output) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const marked = `[token-saver: ${kind} ${countLines(text)}->${countLines(output)} lines; `
    + `rerun a narrower command or pipe through head/tail for full output]\n${output}`;
  if (marked.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  stats.bytesAfter += marked.length;
  stats.hits.push({ kind, saved: bytesIn - marked.length });
  return marked;
}

export function compressToolOutputs(request: CanonicalRequest, enabled?: boolean): CompressionStats | null {
  if (!enabled || !Array.isArray(request.input)) return null;
  const stats: CompressionStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    let inputChanged = false;
    const nextInput = request.input.map((item) => {
      if (item.type !== 'tool_result') return item;
      let contentChanged = false;
      const nextContent = item.content.map((part) => {
        if (part.type !== 'text') return part;
        const compressed = compressText(part.text, stats);
        if (compressed === part.text) return part;
        contentChanged = true;
        return { ...part, text: compressed };
      });
      if (!contentChanged) return item;
      inputChanged = true;
      return { ...item, content: nextContent };
    });
    if (inputChanged) request.input = nextInput;
  } catch (err: any) {
    console.warn('[compression] compressToolOutputs error:', err?.message || err);
    return null;
  }
  return stats;
}

export function formatCompressionLog(stats: CompressionStats | null): string | null {
  if (!stats || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : '0';
  const kinds = Array.from(new Set(stats.hits.map((hit) => hit.kind))).join(',');
  return `[compression:rtk] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${kinds}] hits=${stats.hits.length}`;
}
