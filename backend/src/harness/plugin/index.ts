/**
 * OmniCellRouter Plugin Market Subsystem.
 * Mirrors the architecture of backend/src/harness/host.
 * Concrete adapters and probing mechanisms live under ./adapters/.
 */

export * from './adapters/index.js';
export * from './catalog.js';
export * from './builtin.js';
export * from './types.js';
