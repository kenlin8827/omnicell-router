import { AsyncLocalStorage } from 'node:async_hooks';
import type http from 'node:http';

/**
 * The OCR API key a forward-proxy credential authenticated (ADR-0017/0008).
 *
 * Carries ONLY the resolved identity — never the secret. The secret is
 * compared once at CONNECT admission and discarded; downstream metering reads
 * the live key config by id so disable/expiry takes effect immediately.
 */
export interface ProxyCaller {
  keyId: string;
  name: string;
}

/** CONNECT-time identity, keyed by the request the inner server handed on. */
const REQUEST_CALLER = new WeakMap<http.IncomingMessage, ProxyCaller>();

/** Async hook the gateway plugin handler runs under (plugin code is unaware). */
const als = new AsyncLocalStorage<ProxyCaller>();

export function markProxyCaller(req: http.IncomingMessage, caller: ProxyCaller | undefined): void {
  if (caller) REQUEST_CALLER.set(req, caller);
}

export function proxyCallerOf(req: http.IncomingMessage): ProxyCaller | undefined {
  return REQUEST_CALLER.get(req);
}

/** Run the intercepted exchange with its authenticated caller in scope. */
export function runWithProxyCaller<T>(caller: ProxyCaller | undefined, fn: () => T): T {
  return caller ? als.run(caller, fn) : fn();
}

/** Caller of the in-process gateway turn currently executing (undefined outside). */
export function getProxyCaller(): ProxyCaller | undefined {
  return als.getStore();
}
