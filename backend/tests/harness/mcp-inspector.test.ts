import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  callMcpTool,
  closeAllMcpInspectSessions,
  disconnectMcpSession,
  getMcpPrompt,
  inspectMcpServer,
  readMcpResource,
} from '../../src/harness/host/mcp-inspector.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-inspect-'));
const serverScript = path.join(tmpDir, 'mock-mcp-server.mjs');

// Resolved from this file, never from `process.cwd()`: the isolated runner starts every test
// file inside its own sandbox directory, so a cwd-relative `node_modules` would not exist there.
const repoNodeModules = path.resolve(import.meta.dir, '../../../node_modules');

fs.writeFileSync(
  serverScript,
  `
import { McpServer, ResourceTemplate } from ${JSON.stringify(
    path.join(repoNodeModules, '@modelcontextprotocol/sdk/dist/esm/server/mcp.js')
  )};
import { StdioServerTransport } from ${JSON.stringify(
    path.join(repoNodeModules, '@modelcontextprotocol/sdk/dist/esm/server/stdio.js')
  )};
import { z } from ${JSON.stringify(
    path.join(repoNodeModules, 'zod/index.js')
  )};

const server = new McpServer({ name: 'mock-mcp', version: '1.2.3' });

server.registerTool(
  'echo_upper',
  {
    description: 'Echoes text in uppercase',
    inputSchema: {
      text: z.string().describe('Input text'),
      repeat: z.number().int().optional().describe('Repeat count'),
    },
  },
  async ({ text, repeat = 1 }) => ({
    content: [{ type: 'text', text: text.toUpperCase().repeat(repeat) }],
  })
);

server.registerTool(
  'fail_soft',
  {
    description: 'Returns a tool-level error',
    inputSchema: {},
  },
  async () => ({
    isError: true,
    content: [{ type: 'text', text: 'something went wrong' }],
  })
);

server.registerResource(
  'greeting',
  'mock://greeting',
  { description: 'Static greeting', mimeType: 'text/plain' },
  async () => ({
    contents: [{ uri: 'mock://greeting', mimeType: 'text/plain', text: 'hello from mock resource' }],
  })
);

server.registerResource(
  'item',
  new ResourceTemplate('mock://items/{id}', { list: undefined }),
  { description: 'Dynamic item', mimeType: 'application/json' },
  async (uri, { id }) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id }) }],
  })
);

server.registerPrompt(
  'summarize',
  {
    description: 'Summarize a topic',
    argsSchema: { topic: z.string() },
  },
  async ({ topic }) => ({
    description: 'Summary prompt',
    messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: ' + topic } }],
  })
);

console.error('mock-mcp stderr ready');
const transport = new StdioServerTransport();
await server.connect(transport);
`,
  'utf8'
);

afterAll(async () => {
  await closeAllMcpInspectSessions();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp-inspector', () => {
  test('inspects tools, resources, prompts and invokes them over stdio', async () => {
    const target = {
      mode: 'custom' as const,
      transport: 'stdio' as const,
      command: process.execPath,
      args: [serverScript],
    };

    const snap = await inspectMcpServer(target);
    expect(snap.transport).toBe('stdio');
    expect(snap.serverInfo?.name).toBe('mock-mcp');
    expect(snap.serverInfo?.version).toBe('1.2.3');
    expect(snap.tools.map((t) => t.name).sort()).toEqual(['echo_upper', 'fail_soft']);
    expect(snap.resources.map((r) => r.uri)).toEqual(['mock://greeting']);
    expect(snap.resourceTemplates.map((r) => r.uriTemplate)).toEqual(['mock://items/{id}']);
    expect(snap.prompts.map((p) => p.name)).toEqual(['summarize']);
    expect(snap.stderr.some((l) => l.includes('mock-mcp stderr ready'))).toBe(true);

    const callOk = await callMcpTool({
      sessionId: snap.sessionId,
      toolName: 'echo_upper',
      arguments: { text: 'hi', repeat: 2 },
    });
    expect(callOk.isError).toBe(false);
    expect(callOk.content).toEqual([{ type: 'text', text: 'HIHI' }]);

    const callErr = await callMcpTool({
      sessionId: snap.sessionId,
      toolName: 'fail_soft',
      arguments: {},
    });
    expect(callErr.isError).toBe(true);
    expect(callErr.content).toEqual([{ type: 'text', text: 'something went wrong' }]);

    const res = await readMcpResource({
      sessionId: snap.sessionId,
      uri: 'mock://items/42',
    });
    expect(res.contents).toEqual([{ uri: 'mock://items/42', mimeType: 'application/json', text: '{"id":"42"}' }]);

    const prompt = await getMcpPrompt({
      sessionId: snap.sessionId,
      promptName: 'summarize',
      arguments: { topic: 'MCP' },
    });
    expect(prompt.description).toBe('Summary prompt');
    expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize: MCP' } }]);

    const closed = await disconnectMcpSession(snap.sessionId);
    expect(closed).toBe(true);
    const closedAgain = await disconnectMcpSession(snap.sessionId);
    expect(closedAgain).toBe(false);
  });

  test('returns not_found when host MCP entry does not exist', async () => {
    await expect(
      inspectMcpServer({
        mode: 'host',
        host: 'opencode',
        scope: 'global',
        name: '__non_existent_mcp_server__',
      })
    ).rejects.toThrow();
  });

  test('refuses a header whose secret reference the gateway process cannot resolve', async () => {
    // An unset `${VAR}` used to expand to '' and ship `Authorization: Bearer ` to the server,
    // surfacing as an upstream 401 'missing or wrong bearer token'. Fail with the variable name.
    const err = await inspectMcpServer({
      mode: 'custom',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'Bearer ${OCR_TEST_UNSET_BEARER_XYZ}' },
    }).catch((e: unknown) => e as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe('bad_request');
    expect((err as Error).message).toContain('OCR_TEST_UNSET_BEARER_XYZ');
    expect((err as Error).message).toContain("header 'Authorization'");
  });

  test('reports an auth rejection once instead of falling back to SSE', async () => {
    // A 401 is transport-independent: retrying the legacy SSE endpoint buries the real cause.
    const posts: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        posts.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response('{"error":"missing or wrong bearer token"}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    try {
      const err = await inspectMcpServer({
        mode: 'custom',
        transport: 'auto',
        url: `http://127.0.0.1:${server.port}/mcp`,
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('bearer token');
      expect((err as Error).message).toContain('[diagnosis]');
      expect((err as Error).message).not.toContain('trying SSE');
      expect(posts.some((p) => p.includes('/mcp'))).toBe(true);
      expect(posts.length).toBeLessThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });
});
