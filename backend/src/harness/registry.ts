import { awesomeAdapter } from './sources/awesome-opencode.js';
import { clawhubAdapter } from './sources/clawhub.js';
import { githubAdapter } from './sources/github.js';
import { mcpOfficialAdapter } from './sources/mcp-official.js';
import { npmAdapter } from './sources/npm.js';
import { opencodeCafeAdapter } from './sources/opencode-cafe.js';
import { smitheryAdapter } from './sources/smithery.js';
import type { SourceAdapter } from './spi.js';

/**
 * Source adapter registry (ADR-0015 §8).
 *
 * Onboarding a marketplace = one adapter file + one entry here — never a route or page edit. Sources
 * declared in the console's SOURCES view but absent here answer install requests with
 * `unsupported_source` instead of pretending.
 */

const ADAPTERS: SourceAdapter[] = [
  awesomeAdapter,
  clawhubAdapter,
  githubAdapter,
  mcpOfficialAdapter,
  npmAdapter,
  opencodeCafeAdapter,
  smitheryAdapter,
];

export function getAdapter(sourceId: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === sourceId);
}
