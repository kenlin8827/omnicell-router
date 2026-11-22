/**
 * Playground tool sandbox — the tools a model may call from the playground.
 *
 * The point of this file is to exercise the TOOL PATH, not to give the model a
 * computer: what the playground tests is whether a tool definition survives the
 * gateway's conversion, whether the model's chosen name and arguments arrive
 * intact on this wire, and whether a tool result makes it back into the next
 * request. Every tool here answers from an in-memory virtual filesystem, so a
 * call is deterministic, cheap, and cannot touch the operator's machine.
 *
 * There is deliberately NO execute / shell tool. A tool that runs a command is
 * the one capability that turns "the model returned a tool call" into "the host
 * ran something", and model output is driven by untrusted content (a captured
 * prompt, an upstream provider, a pasted page). Nothing about testing the
 * gateway's tool support needs that risk: `read`/`write`/`edit`/`grep`/`ls`/`rm`
 * over a virtual filesystem exercises every shape a real tool loop produces —
 * a required string, an optional number, a nested object, a multi-line exact
 * match — which is exactly the payload diversity the wire conversion can
 * corrupt.
 *
 * Executors never throw. A failure is a STRING handed back to the model, the
 * same way a real tool reports `error: ...`, because the tool-error leg is one
 * of the paths worth testing.
 */

/** JSON Schema subset the three wires all accept for `parameters`. Kept loose
 *  on purpose — this is a description of an object schema, not a validator. */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface PlaygroundTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
  run(args: Record<string, unknown>): string;
}

/** The virtual tree. Seeded so a first call always has something to read, and
 *  mutable so `write`/`edit`/`rm` have observable consequences across a
 *  conversation. Module-level: one sandbox per console session. */
const SEED: ReadonlyArray<readonly [string, string]> = [
  [
    'README.md',
    '# Sandbox\n\nA virtual filesystem the playground tools read and write.\nNothing here touches the host.\n',
  ],
  [
    'src/index.ts',
    "import { add } from './util';\n\nexport const total = (xs: number[]): number => xs.reduce((sum, x) => sum + x, add(0));\n",
  ],
  ['src/util.ts', 'export const add = (a: number, b: number): number => a + b;\n'],
  [
    'data/report.csv',
    'model,input,output\nqwen3.8-flash,1200,340\ndeepseek-chat,900,220\n',
  ],
];

let files = new Map<string, string>(SEED.map(([path, body]) => [path, body]));

/** Restore the seed tree — the panel's reset button, and what a test starts from. */
export function resetSandbox(): void {
  files = new Map(SEED.map(([path, body]) => [path, body]));
}

/** Current tree, for display (`ls /` in the panel) and for tests. */
export function sandboxFiles(): Array<[string, string]> {
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Normalize a model-supplied path: leading/trailing slashes are stripped, `..` is not allowed.
 *  A model that tries `../../etc/passwd` gets an error string, not a hole. */
function tidyPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!path) return null;
  if (path.split('/').some(seg => seg === '..' || seg === '.')) return null;
  return path;
}

/** Normalize an optional directory/file scope for `ls` and `grep`. Accepts
 *  sandbox root spellings (``, `.`, `./`, `/`) as `""` and strips trailing
 *  slashes so `ls`'s own `"src/"` output feeds back cleanly. */
function tidyScope(raw: unknown): string | null {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/{2,}/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return '';
  return tidyPath(trimmed);
}

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined;

const intArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

const fail = (message: string): string => `error: ${message}`;

/** `1\ttext` — a line number per row, the shape agents are trained to read. */
function numbered(path: string, body: string, offset: number, limit: number): string {
  const lines = body.split('\n');
  // A trailing newline produces one empty final element; the file does not have
  // a phantom last line, so it is dropped before slicing.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const slice = lines.slice(offset, limit > 0 ? offset + limit : undefined);
  if (slice.length === 0) return fail(`${path} has no lines at offset ${offset}`);
  return slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

const readTool: PlaygroundTool = {
  name: 'read',
  description:
    'Read a text file from the sandbox filesystem. Returns numbered lines. Use offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the sandbox root, e.g. "src/index.ts".' },
      offset: { type: 'number', description: '1-based line to start at. Default 1.' },
      limit: { type: 'number', description: 'Maximum number of lines. Default 200.' },
    },
    required: ['path'],
  },
  run(args) {
    const path = tidyPath(args.path);
    if (!path) return fail('path must be a relative path inside the sandbox');
    const body = files.get(path);
    if (body === undefined) {
      const near = [...files.keys()].filter(p => p.startsWith(path.split('/')[0] ?? ''));
      return fail(`no such file: ${path}${near.length ? `. Try one of: ${near.join(', ')}` : ''}`);
    }
    const offset = Math.max(0, (intArg(args, 'offset') ?? 1) - 1);
    return numbered(path, body, offset, intArg(args, 'limit') ?? 200);
  },
};

const writeTool: PlaygroundTool = {
  name: 'write',
  description: 'Create a file, or replace its whole contents. Parent directories are implied.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the sandbox root.' },
      content: { type: 'string', description: 'Full new contents of the file.' },
    },
    required: ['path', 'content'],
  },
  run(args) {
    const path = tidyPath(args.path);
    if (!path) return fail('path must be a relative path inside the sandbox');
    const content = str(args, 'content');
    if (content === undefined) return fail('content must be a string');
    const existed = files.has(path);
    files.set(path, content);
    return `${existed ? 'overwrote' : 'created'} ${path} (${content.length} bytes)`;
  },
};

const editTool: PlaygroundTool = {
  name: 'edit',
  description:
    'Replace an exact substring in a file. oldText must appear EXACTLY ONCE — include enough surrounding context to make it unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the sandbox root.' },
      oldText: { type: 'string', description: 'Exact text to find, including whitespace and line breaks.' },
      newText: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  run(args) {
    const path = tidyPath(args.path);
    if (!path) return fail('path must be a relative path inside the sandbox');
    const body = files.get(path);
    if (body === undefined) return fail(`no such file: ${path}`);
    const oldText = str(args, 'oldText');
    const newText = str(args, 'newText');
    if (oldText === undefined || newText === undefined) return fail('oldText and newText must be strings');
    if (!oldText) return fail('oldText must not be empty');
    const first = body.indexOf(oldText);
    if (first < 0) return fail('oldText not found in ' + path);
    if (body.indexOf(oldText, first + oldText.length) >= 0) {
      // Ambiguity is the failure mode this tool exists to expose: a model that
      // does not widen its anchor would corrupt a real file.
      return fail(`oldText appears more than once in ${path}; include more context`);
    }
    files.set(path, body.slice(0, first) + newText + body.slice(first + oldText.length));
    return `edited ${path}`;
  },
};

const grepTool: PlaygroundTool = {
  name: 'grep',
  description: 'Search the sandbox for a JavaScript regular expression, one match per line as path:line: text.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression source.' },
      path: { type: 'string', description: 'Optional file or directory to search. Default: everything.' },
    },
    required: ['pattern'],
  },
  run(args) {
    const source = str(args, 'pattern');
    if (!source) return fail('pattern must be a non-empty string');
    let re: RegExp;
    try {
      re = new RegExp(source, 'i');
    } catch (err) {
      return fail(`invalid regular expression: ${(err as Error).message}`);
    }
    const scope = tidyScope(args.path);
    if (scope === null) return fail('path must be a relative path inside the sandbox');
    const hits: string[] = [];
    for (const [path, body] of sandboxFiles()) {
      if (scope && path !== scope && !path.startsWith(`${scope}/`)) continue;
      body.split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${path}:${i + 1}: ${line}`);
      });
    }
    return hits.length ? hits.slice(0, 200).join('\n') : 'no matches';
  },
};

const lsTool: PlaygroundTool = {
  name: 'ls',
  description: 'List sandbox files, optionally under one directory. Directories are printed with a trailing slash.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Optional directory. Default: the sandbox root.' } },
  },
  run(args) {
    const scope = tidyScope(args.path);
    if (scope === null) return fail('path must be a relative path inside the sandbox');
    const names = new Set<string>();
    for (const [path] of sandboxFiles()) {
      if (scope) {
        if (!path.startsWith(`${scope}/`)) continue;
        names.add(path.slice(scope.length + 1).split('/')[0] + (path.slice(scope.length + 1).includes('/') ? '/' : ''));
        continue;
      }
      const [head, ...rest] = path.split('/');
      names.add(rest.length > 0 ? `${head}/` : (head as string));
    }
    return names.size ? [...names].sort().join('\n') : fail(`no such directory: ${scope || '/'}`);
  },
};

const rmTool: PlaygroundTool = {
  name: 'rm',
  description: 'Delete one sandbox file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the sandbox root.' } },
    required: ['path'],
  },
  run(args) {
    const path = tidyPath(args.path);
    if (!path) return fail('path must be a relative path inside the sandbox');
    return files.delete(path) ? `removed ${path}` : fail(`no such file: ${path}`);
  },
};

/** The selectable set, in panel order. */
export const PLAYGROUND_TOOLS: readonly PlaygroundTool[] = [
  readTool,
  writeTool,
  editTool,
  grepTool,
  lsTool,
  rmTool,
];

export const PLAYGROUND_TOOL_BY_NAME: Record<string, PlaygroundTool> = Object.fromEntries(
  PLAYGROUND_TOOLS.map(tool => [tool.name, tool])
);

/**
 * Execute one call as a model sent it: the name is looked up in the registry and
 * the arguments arrive as the RAW JSON STRING the wire carried, so a truncated
 * or malformed payload is reported exactly the way a real runner would.
 * Never throws — the assistant loop must always be able to hand something back.
 */
export function runPlaygroundTool(name: string, argsJson: string): string {
  const tool = PLAYGROUND_TOOL_BY_NAME[name];
  if (!tool) return fail(`unknown tool: ${name}. Available: ${PLAYGROUND_TOOLS.map(t => t.name).join(', ')}`);
  let args: Record<string, unknown> = {};
  if (argsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('arguments must be a JSON object');
      args = parsed as Record<string, unknown>;
    } catch (err) {
      return fail(`arguments are not valid JSON: ${(err as Error).message}`);
    }
  }
  try {
    return tool.run(args);
  } catch (err) {
    return fail((err as Error)?.message ?? 'tool failed');
  }
}
