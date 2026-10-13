/**
 * ADR-0019 P1 — public surface of the credential adapter layer.
 * Console/boot code should import from here, not from the individual files.
 */
export * from './types.js';
export * from './paths.js';
export * from './auth-snapshot.js';
export * from './ocr-store.js';
export * from './opencode-v2-store.js';
export * from './factory.js';
export * from './reconcile.js';
export * from './push.js';
