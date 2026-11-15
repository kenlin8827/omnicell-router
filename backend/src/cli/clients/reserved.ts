import type { SupportedClient } from '../types.js';

/**
 * Client-id vocabulary a plugin cannot claim — the RESERVED half of the Client
 * Hub registry (ADR-0027 / ADR-0029).
 *
 * Deliberately a LEAF module: it imports nothing but a type, so the plugin
 * registry (`plugin-adapters.ts`) can ask "is this id reserved?" without
 * pulling the adapter classes themselves. Those classes import the config
 * loader, user-config and the credential store, and the plugin host sits under
 * `providers/dispatch.ts` — registering a package must not drag the whole
 * Client Hub into every caller that merely resolves a provider.
 *
 * The keys are the SINGLE source: `CORE_ADAPTERS` is typed
 * `Record<CoreClientId, ClientAdapter>`, so a missing or extra map entry is a
 * compile error rather than a runtime mismatch between "ids a plugin may not
 * claim" and "hooks this build ships".
 */

/** Every hook this build ships. */
export const CORE_ADAPTER_IDS = {
  opencode: true,
  claude: true,
  codex: true,
  pi: true,
  dsh: true,
  omp: true,
  grok: true,
  kimi: true,
  openclaw: true,
  workbuddy: true,
} as const satisfies Record<string, true>;

/** The ids of the hooks that ship IN CORE (as opposed to package hooks). */
export type CoreClientId = keyof typeof CORE_ADAPTER_IDS;

/** Ids a plugin may never claim. */
export function isCoreClientId(name: string): name is CoreClientId {
  return Object.hasOwn(CORE_ADAPTER_IDS, name);
}

/**
 * Client ids that LEFT this build and now live in a package under a new id.
 *
 * A retired id is not "unknown": an operator whose machine still has the old
 * package installed would otherwise get a second Client Hub row that writes the
 * same client's settings as its replacement — two hooks, one sidecar each, and
 * whichever ran last wins. Refusing the id with the replacement's name turns
 * that silent conflict into a console error the operator can act on.
 */
export const RETIRED_CLIENT_IDS: Readonly<Record<string, string>> = {
  // ADR-0028: the ingress half merged into its gateway package.
  'opencode-proxy': 'opencode-gateway',
};

/** Human-readable hint for a retired id, or undefined when the id is not one. */
export function retiredClientHint(name: string): string | undefined {
  const replacement = Object.hasOwn(RETIRED_CLIENT_IDS, name) ? RETIRED_CLIENT_IDS[name] : undefined;
  if (!replacement) return undefined;
  return `client '${name}' was renamed to '${replacement}' — uninstall the old package (its row is superseded) and use '${replacement}'`;
}

/** Compile-time guard: a reserved id must stay part of the union the console
 *  and CLI can ADDRESS, or the roster would hold an id nothing can type. */
type AssertTrue<T extends true> = T;
export type CoreClientIdsAreAddressable = AssertTrue<CoreClientId extends SupportedClient ? true : false>;
