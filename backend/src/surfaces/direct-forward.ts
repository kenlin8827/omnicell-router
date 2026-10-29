import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import { FORWARD_PROXY_HANG_TIMEOUT_MS } from '../config/defaults.js';
import { filterHeaders, openViaProxy, parseProxy, transitProxyFor } from '../forward-proxy/egress.js';
import {
  emitUpstreamFailureOnce,
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
} from '../observability/upstream-events.js';
import type { UpstreamEventContext } from '../observability/upstream-events.js';
import type { DirectForwardPlan } from '../types/router.js';
import type { TransportContext } from './types.js';

/**
 * The `direct` unresolved-model executor (ADR-0003 §7a) — the pipeline-side
 * verbatim relay. The turn has already run THROUGH the pipeline (normalization,
 * session id, compression, client-leg capture); this helper performs the one
 * thing the pipeline's provider executors cannot: an HTTP round trip to the
 * ORIGINAL destination with the client's own auth headers and the origin wire
 * body, then hands the origin response to the transport's raw relay
 * (`t.relayUpstream`) — JSON or SSE alike, byte-verbatim.
 *
 * Egress follows the same `config.proxy` outbound policy as the forward
 * proxy's own forwarders (transitProxyFor; CONNECT tunnel for https targets).
 * Upstream-leg capture fires here (request once the target is known, response
 * on completion) with the provenance orchestrator attached to the plan.
 */

const DIRECT_RELAY_BODY_CAP = 80_000;

export async function relayDirectForward(t: TransportContext, plan: DirectForwardPlan): Promise<void> {
  let u: URL;
  try {
    u = new URL(plan.url);
  } catch {
    t.sendJson(502, { error: { message: `Direct forward: invalid original destination URL '${plan.url}'` } });
    return;
  }
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const headers: Record<string, string | string[]> = { ...plan.requestHeaders, host: u.host };
  const captureCtx: UpstreamEventContext | undefined = plan.capture?.recorder.isEnabled() ? plan.capture : undefined;
  const spanId = emitUpstreamRequestOnce(captureCtx, {
    url: plan.url,
    method: 'POST',
    requestHeaders: headers as Record<string, string>,
    requestBody: plan.requestBody,
  });

  await new Promise<void>((resolve) => {
    const fail = (status: number, message: string, err?: unknown): void => {
      emitUpstreamFailureOnce(captureCtx, {
        spanId,
        url: plan.url,
        method: 'POST',
        status,
        statusText: 'Bad Gateway',
        error: err instanceof Error ? err.message : String(err ?? message),
      });
      t.sendJson(status, { error: { message } });
      resolve();
    };

    const onOriginResponse = (up: http.IncomingMessage): void => {
      // The egress caller clears the hang-protection timer before calling
      // this (SSE direct turns stream for minutes — never killed mid-flight).
      let body = '';
      const firstByteTs: number | undefined = Date.now();
      up.on('data', (chunk: Buffer) => {
        if (body.length < DIRECT_RELAY_BODY_CAP) body = (body + chunk.toString('utf8')).slice(0, DIRECT_RELAY_BODY_CAP);
      });
      up.on('end', () => {
        emitUpstreamResponseOnce(captureCtx, {
          spanId,
          url: plan.url,
          method: 'POST',
          status: up.statusCode || 502,
          statusText: up.statusMessage || '',
          responseHeaders: nodeHeadersToFetch(up.headers),
          responseBody: body,
          firstByteTs,
        });
        resolve();
      });
      up.on('error', (err) => {
        emitUpstreamFailureOnce(captureCtx, {
          spanId,
          url: plan.url,
          method: 'POST',
          status: up.statusCode || 502,
          statusText: up.statusMessage || '',
          responseHeaders: nodeHeadersToFetch(up.headers),
          responseBody: body,
          error: err?.message || 'upstream response stream error',
        });
        resolve();
      });
      t.relayUpstream({
        statusCode: up.statusCode || 502,
        statusMessage: up.statusMessage,
        headers: filterHeaders(up.headers),
        stream: up as unknown as Readable,
      });
    };

    /** Each egress mode clears its own hang guard once headers arrive. */
    const onHeaders = (upstream: http.ClientRequest) => (up: http.IncomingMessage): void => {
      upstream.setTimeout(0);
      onOriginResponse(up);
    };

    const hangGuard = (upstream: http.ClientRequest): void => {
      // Applies only until response headers arrive (cleared in onHeaders).
      upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
        upstream.destroy(new Error('upstream timeout'));
      });
    };

    const proxyUrl = transitProxyFor(u.hostname, port);
    if (!proxyUrl) {
      const transport = secure ? https : http;
      const upstream = transport.request(
        {
          host: u.hostname,
          port,
          method: 'POST',
          path: `${u.pathname}${u.search}`,
          headers,
          ...(secure ? { servername: u.hostname.replace(/^\[|\]$/g, '') } : {}),
        } as https.RequestOptions,
        (up) => onHeaders(upstream)(up)
      );
      hangGuard(upstream);
      upstream.on('error', (err: Error) => {
        const timedOut = err?.message === 'upstream timeout';
        fail(
          timedOut ? 504 : 502,
          timedOut ? 'Direct forward: upstream timed out (target unreachable from this machine?)' : `Direct forward: upstream connection failed (${err.message})`,
          err
        );
      });
      upstream.end(plan.requestBody);
      return;
    }

    const p = parseProxy(proxyUrl);
    if (!p) {
      fail(502, 'Direct forward: invalid outbound proxy url');
      return;
    }
    if (!secure) {
      // Plain-HTTP target via the outbound proxy (absolute-URI request form).
      const upstream = http.request({
        host: p.host,
        port: p.port,
        method: 'POST',
        path: plan.url,
        headers: { ...headers, ...(p.auth ? { 'proxy-authorization': p.auth } : {}) },
      });
      hangGuard(upstream);
      upstream.on('error', (err: Error) => fail(502, `Direct forward: upstream connection failed via outbound proxy (${err.message})`, err));
      upstream.on('response', (up) => onHeaders(upstream)(up));
      upstream.end(plan.requestBody);
      return;
    }

    // HTTPS target: CONNECT tunnel → one-shot loopback relay → https.request
    // over the relay (TLS end-to-end; the real target cert is validated).
    openViaProxy(proxyUrl, u.hostname, port)
      .then((pipeSock) => {
        const relay = net.createServer((c) => {
          c.pipe(pipeSock);
          pipeSock.pipe(c);
        });
        const cleanup = (): void => {
          try {
            relay.close();
          } catch {}
          try {
            pipeSock.destroy();
          } catch {}
        };
        relay.on('error', cleanup);
        relay.listen(0, '127.0.0.1', () => {
          const relayPort = (relay.address() as net.AddressInfo).port;
          const upstream = https.request({
            host: '127.0.0.1',
            port: relayPort,
            method: 'POST',
            path: `${u.pathname}${u.search}`,
            headers,
            servername: u.hostname.replace(/^\[|\]$/g, ''),
          });
          hangGuard(upstream);
          upstream.on('error', (err: Error) => {
            cleanup();
            fail(502, `Direct forward: upstream connection failed via outbound proxy (${err.message})`, err);
          });
          upstream.on('response', (up) => {
            cleanup();
            onHeaders(upstream)(up);
          });
          upstream.end(plan.requestBody);
        });
      })
      .catch((err: Error) => fail(502, `Direct forward: outbound proxy connection failed (${err.message})`, err));
  });
}

/** Origin IncomingHttpHeaders → fetch Headers (emitUpstreamResponse contract). */
function nodeHeadersToFetch(headers: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, item);
    else out.set(k, v);
  }
  return out;
}
