import type { ClientAdapter } from './base.js';
import type { CoreClientId } from './reserved.js';
import { OpenCodeClientAdapter } from './opencode.js';
import { ClaudeClientAdapter } from './claude.js';
import { CodexClientAdapter } from './codex.js';
import { PiClientAdapter } from './pi.js';
import { DshClientAdapter } from './dsh.js';
import { GrokClientAdapter } from './grok.js';
import { OmpClientAdapter } from './omp.js';
import { KimiClientAdapter } from './kimi.js';
import { OpenClawClientAdapter } from './openclaw.js';
import { WorkBuddyClientAdapter } from './workbuddy.js';

/**
 * The hooks this BUILD ships — one instance per client id.
 *
 * The whole forward-proxy family (Cursor, Qoder, JetBrains) is NOT here: those
 * hooks ship INSIDE their gateway packages (`cursor-gateway`, `qoder-gateway`,
 * `jetbrains-gateway`) as a `client-adapter` part, next to the gateway that
 * answers the hosts they point at. Nothing in this file decides that a client
 * exists — the roster is core hooks plus every installed package
 * (`clients/index.ts`), which is why a new client needs no core release and no
 * edit here.
 *
 * In its own module so the client registry (`index.ts`) can merge it with
 * plugin-contributed adapters without a cycle. The reserved ids live in
 * `reserved.ts` — a LEAF module — so the plugin registry can refuse a
 * shadowing id without importing this map's adapter classes.
 *
 * Typed `Record<CoreClientId, …>`, not `Record<string, …>`: the key list in
 * `reserved.ts` is the single source, so a hook added or removed here without
 * the id list (or the other way round) is a compile error. Package hooks are
 * NOT typed here: they register any string id at runtime (ADR-0027), and core
 * code must never string-reference one. */
export const CORE_ADAPTERS: Record<CoreClientId, ClientAdapter> = {
  opencode: new OpenCodeClientAdapter(),
  claude: new ClaudeClientAdapter(),
  codex: new CodexClientAdapter(),
  pi: new PiClientAdapter(),
  dsh: new DshClientAdapter(),
  omp: new OmpClientAdapter(),
  grok: new GrokClientAdapter(),
  kimi: new KimiClientAdapter(),
  openclaw: new OpenClawClientAdapter(),
  workbuddy: new WorkBuddyClientAdapter(),
};
