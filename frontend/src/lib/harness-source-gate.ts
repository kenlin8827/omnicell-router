/**
 * Which market sources need the detected-host support gate (ADR-0015 §D10/§D11).
 *
 * Support is DETECTED, not declared: the console probes every served harness's published form and
 * refuses a source whose forms do not include the open tab's harness — registering it would list a
 * market the tab can never browse or install from. That rule is about REPOSITORIES, which publish a
 * per-harness form (`.claude-plugin/`, `pi-extension/`, a marketplace catalog, …).
 *
 * A PACKAGE source has no form to detect: the probe reads a registry, so the backend deliberately
 * reports no hosts for it and skips its own support gate (`BasePluginMarketAdapter.registerSource`).
 * Running the gate in the console would refuse every package source with "detected: none".
 */

/** The source types the console's picker offers, per axis. */
export type MarketSourceType = 'github' | 'npm' | 'pypi';

/**
 * Does adding this source require a detected-form check (and, when several harnesses answer, the
 * scope dialog)? `input` is the raw field text: the backend also honors an `npm:` prefix whatever
 * the picked type says (`parseNpmSource`), so the same spelling must answer false here too.
 */
export function needsHostDetection(type: MarketSourceType, input: string): boolean {
  if (type !== 'github') return false;
  return !/^npm:/i.test(input.trim());
}
