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

fs.writeFileSync(
  serverScript,
  `
import { McpServer, ResourceTemplate } from ${JSON.stringify(
    path.resolve(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')
  )};
import { StdioServerTransport } from ${JSON.stringify(
    path.resolve(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')
  )};
import { z } from ${JSON.stringify(
    path.resolve(process.cwd(), 'node_modules/zod/index.js')
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
});
