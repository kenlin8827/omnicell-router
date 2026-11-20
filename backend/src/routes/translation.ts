import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isSupportedLang,
  probeTranslationChain,
  pruneTranslationStore,
  readCachedTranslations,
  translateDescription,
  translateMarkdown,
} from '../translation/index.js';

/**
 * Admin translation routes — shared derived-cache translation endpoints for the console
 * (harness marketplace, MCP browser, settings probes, and future console pages).
 *
 * Legacy `/api/admin/harness/translate*` paths are registered alongside the canonical
 * `/api/admin/translate*` paths so existing scripts and callers continue to work without breakage.
 */
export function registerTranslationRoutes(app: FastifyInstance): void {
  const handleTranslate = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as { text?: string; lang?: string; format?: string; refresh?: boolean };
    const text = (body.text || '').trim();
    if (!text) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'text is required' };
    }
    if (!body.lang) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang is required' };
    }
    const result =
      body.format === 'markdown'
        ? await translateMarkdown(text, body.lang, { refresh: body.refresh === true })
        : await translateDescription(text, body.lang);
    if ('code' in result) {
      reply.code(result.code === 'no_api_key' ? 409 : 502);
      return { status: 'error', ...result };
    }
    return { status: 'ok', ...result };
  };

  const handleTranslateStream = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as { text?: string; lang?: string; format?: string; refresh?: boolean };
    const text = (body.text || '').trim();
    if (!text || !body.lang) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'text and lang are required' };
    }
    if (body.format !== 'markdown') {
      reply.code(400);
      return {
        status: 'error',
        code: 'bad_request',
        message: "format must be 'markdown' — a description is one call and needs no progress",
      };
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    let closed = false;
    raw.on('close', () => {
      closed = true;
    });
    const send = (evt: Record<string, unknown>) => {
      if (closed) return;
      try {
        raw.write(`${JSON.stringify(evt)}\n`);
      } catch {
        closed = true;
      }
    };
    try {
      const result = await translateMarkdown(text, body.lang, {
        refresh: body.refresh === true,
        onProgress: (done, total) => send({ type: 'progress', done, total }),
      });
      if ('code' in result) send({ type: 'error', code: result.code, message: result.message });
      else send({ type: 'result', text: result.text, cached: result.cached, model: result.model });
    } catch (e) {
      send({ type: 'error', code: 'upstream', message: e instanceof Error ? e.message : String(e) });
    }
    raw.end();
  };

  const handleTranslateBatch = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as { lang?: string; texts?: unknown };
    if (!body.lang || !Array.isArray(body.texts)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang and texts[] are required' };
    }
    const texts = [
      ...new Set(
        body.texts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      ),
    ].slice(0, 50);
    if (texts.length === 0) return { status: 'ok', results: {}, errors: [] };

    const results: Record<string, { text: string; model: string; cached: boolean }> = {};
    const errors: { text: string; code: string; message: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const text = texts[cursor++];
        const result = await translateDescription(text, body.lang!);
        if ('code' in result) errors.push({ text, code: result.code, message: result.message });
        else results[text] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, texts.length) }, worker));

    // No key = every item fails the same way; say it once instead of 50 identical rows.
    if (errors.length === texts.length && errors.every((e) => e.code === 'no_api_key')) {
      reply.code(409);
      return { status: 'error', code: 'no_api_key', message: errors[0].message };
    }
    return { status: 'ok', results, errors };
  };

  const handleTranslationsLookup = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as { lang?: string; texts?: unknown; format?: string };
    if (!body.lang || !Array.isArray(body.texts)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang and texts[] are required' };
    }
    if (!isSupportedLang(body.lang)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: `unsupported language '${body.lang}'` };
    }
    const texts = body.texts
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, 500);
    return {
      status: 'ok',
      translations: readCachedTranslations(texts, body.lang, body.format === 'markdown' ? 'readme' : 'descriptions'),
    };
  };

  const handleTranslationsPrune = async (req: FastifyRequest) => {
    const body = (req.body || {}) as { maxAgeDays?: unknown; maxBytes?: unknown };
    const maxAgeDays = typeof body.maxAgeDays === 'number' ? body.maxAgeDays : undefined;
    const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
    const stats = pruneTranslationStore({
      ...(maxAgeDays !== undefined ? { maxAgeMs: Math.max(maxAgeDays, 0) * 24 * 60 * 60 * 1000 } : {}),
      ...(maxBytes !== undefined ? { maxBytes: Math.max(maxBytes, 0) } : {}),
    });
    return { status: 'ok', ...stats };
  };

  const handleTranslationsProbe = async (req: FastifyRequest) => {
    const body = (req.body || {}) as { lang?: unknown; model?: unknown };
    return probeTranslationChain(
      typeof body.lang === 'string' ? body.lang : 'en',
      typeof body.model === 'string' ? body.model : undefined
    );
  };

  // Canonical admin translation endpoints
  app.post('/api/admin/translate', handleTranslate);
  app.post('/api/admin/translate-stream', handleTranslateStream);
  app.post('/api/admin/translate-batch', handleTranslateBatch);
  app.post('/api/admin/translations', handleTranslationsLookup);
  app.post('/api/admin/translations/prune', handleTranslationsPrune);
  app.post('/api/admin/translations/probe', handleTranslationsProbe);

  // Legacy harness-scoped aliases (read/invoke compatibility)
  app.post('/api/admin/harness/translate', handleTranslate);
  app.post('/api/admin/harness/translate-stream', handleTranslateStream);
  app.post('/api/admin/harness/translate-batch', handleTranslateBatch);
  app.post('/api/admin/harness/translations', handleTranslationsLookup);
  app.post('/api/admin/harness/translations/prune', handleTranslationsPrune);
  app.post('/api/admin/harness/translations/probe', handleTranslationsProbe);
}
