/**
 * WHICH wire ids a model-service plugin serves — the one bridge between the
 * plugin host and every point that has to decide "is this a plugin protocol?".
 *
 * The plugin host owns the answer (`PluginView.wires`, matched by
 * `getModelServicePlugin(wire)`), but the decision points are built where the
 * registry may hold nothing yet: boot ordering, a test process with no plugin
 * tree, a provider def authored before its plugin was installed. So the host
 * PUSHES its claimed wires here after every registry rebuild
 * (`claimPluginWires`) and consumers ASK (`isPluginWire`) instead of
 * enumerating protocol names. A new plugin protocol therefore needs no core
 * edit — naming a vendor in a core branch is exactly the drift this replaces.
 *
 * `NATIVE_WIRES` is a bootstrap IDENTITY floor, never a dispatch table: an
 * OCR-native protocol id IS its own wire, and a def carrying one must resolve
 * to that wire even while the serving plugin is absent. Falling through to a
 * chat wire instead would send the request to the wrong upstream and blame it
 * for the resulting 400 — and the wire is resolved at BOOT, long before the
 * missing executor could raise its own error.
 */

/** OCR-native protocol ids: bare protocol names whose wire is themselves.
 *  Their executors still belong to the plugin, so an absent install fails
 *  honestly at dispatch instead of routing somewhere else. */
const NATIVE_WIRES: readonly string[] = ['qoder', 'workbuddy'];

/** Base-URL fingerprints for those native wires — some defs carry no protocol,
 *  only the vendor's exchange gateway. This is plugin-owned knowledge (the
 *  vendor's own origin), so it sits beside the wire ids rather than inside the
 *  wire resolver. */
const NATIVE_BASE_HINTS: ReadonlyArray<{ wire: string; fragments: string[] }> = [
  { wire: 'qoder', fragments: ['qoder.sh', 'qoder.com.cn'] },
  { wire: 'workbuddy', fragments: ['copilot.tencent.com', 'workbuddy.ai'] },
];

/** Wires claimed by the LOADED model-service plugins (sorted: the console
 *  vocabulary derives its dropdown order from this, so the list must be
 *  deterministic and must never depend on readdir order). */
let claimed: string[] = [];

/** Core wire shapes are never plugin-owned and cannot be claimed by plugins. */
const CORE_WIRES = new Set([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-gemini',
  'systemone',
  'unroutable',
]);

/** True when `wire` is a built-in core wire that plugins may never claim. */
export function isCoreWire(wire: string): boolean {
  return CORE_WIRES.has(wire.trim().toLowerCase());
}

/** Replace the claimed set — the plugin host calls this at the tail of every
 *  registry rebuild, so a disabled/uninstalled plugin drops out with it. */
export function claimPluginWires(wires: Iterable<string>): void {
  const next = new Set<string>();
  for (const w of wires) {
    const id = typeof w === 'string' ? w.trim().toLowerCase() : '';
    if (id && !CORE_WIRES.has(id)) next.add(id);
  }
  claimed = [...next].sort();
}

/** True when `wire` is plugin-owned: an OCR-native id (resolved even with the
 *  plugin absent) or a wire a loaded plugin claims. Core wire shapes are
 *  handled by their own branches and are never reported here. */
export function isPluginWire(wire: string): boolean {
  return NATIVE_WIRES.includes(wire) || claimed.includes(wire);
}

/** Wires an INSTALLED plugin claims today — the console only offers protocols
 *  that have an executor, so uninstalled ones are deliberately absent. */
export function claimedPluginWires(): readonly string[] {
  return claimed;
}

/** Wire a base URL alone identifies (no protocol known) — the native hints. */
export function nativeBaseHintWire(baseHint?: string): string | undefined {
  const a = (baseHint || '').toLowerCase();
  if (!a) return undefined;
  for (const hint of NATIVE_BASE_HINTS) {
    if (hint.fragments.some((f) => a.includes(f))) return hint.wire;
  }
  return undefined;
}
