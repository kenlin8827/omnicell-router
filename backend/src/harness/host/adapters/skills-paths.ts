import os from 'node:os';
import path from 'node:path';

/**
 * Shared path primitives for host adapters (leaf module — imports nothing from `harness/`).
 *
 * These two facts are cross-host: the user's home, the XDG config root, and the cross-agent
 * `.agents/skills` directory that several runtimes read directly. They live here, declared exactly
 * once, because `universal` owns the directory and every `readsUniversal` host REFERENCES it instead
 * of re-declaring the path (a second literal would be the drift twin AGENTS.md forbids).
 */

export const home = (): string => os.homedir();

export const xdgConfig = (): string => process.env.XDG_CONFIG_HOME || path.join(home(), '.config');

/** The cross-agent skills directory — owned by `universal`, read by every `readsUniversal` host. */
export const UNIVERSAL_SKILLS = {
  global: path.join(home(), '.agents', 'skills'),
  project: path.join('.agents', 'skills'),
} as const;
