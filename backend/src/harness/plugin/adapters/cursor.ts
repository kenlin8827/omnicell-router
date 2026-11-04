import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Cursor's market (ADR-0015 §D10). Cursor installs plugins from its marketplace (or `/add-plugin`),
 * and a repository's published form is its own `.cursor-plugin/` directory. Cursor does NOT publish
 * a standardized manifest file there the way Claude does, so the probe treats the DIRECTORY as the
 * plugin and never parses vendor JSON. Rules and hooks live in `.cursor/`, which is not a plugin
 * form and is never read as one.
 */
export const CURSOR_PROBE_OPTIONS: ProbeOptions = {
  directoryPlugin: { base: 'repo' },
};

export class CursorPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return CURSOR_PROBE_OPTIONS;
  }
}
