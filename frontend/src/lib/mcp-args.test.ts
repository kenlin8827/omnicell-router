/**
 * MCP launch-argument text helpers.
 *
 * The regression this guards: a DBHub launch line with a quoted DSN —
 * `--transport http --port 8080 --dsn "postgres://…?sslmode=disable"` — reverse-rendered as ONE
 * row whose flag swallowed the line up to `sslmode` and whose value was `disable`, because the
 * quoted run was treated as a single token and the `=` inside the URL was taken as the flag
 * separator.
 */
import { describe, expect, it } from 'vitest';
import { argRowTokens, argRowsFromArgv, formatArgLine, parseArgLine } from './mcp-args';

const DSN_LINE =
  '--transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"';

describe('parseArgLine', () => {
  it('keeps a quoted value together, including its `=` and `?`', () => {
    expect(parseArgLine(DSN_LINE)).toEqual([
      '--transport',
      'http',
      '--port',
      '8080',
      '--dsn',
      'postgres://user:password@localhost:5432/dbname?sslmode=disable',
    ]);
  });

  it('unwraps a whole line pasted inside one outer quote pair', () => {
    expect(parseArgLine(`"${DSN_LINE}"`)).toEqual(parseArgLine(DSN_LINE));
  });

  it('straightens typographic quotes from a doc or an IME', () => {
    expect(parseArgLine(`--dsn “postgres://db?sslmode=disable”`)).toEqual([
      '--dsn',
      'postgres://db?sslmode=disable',
    ]);
  });

  it('keeps Windows backslashes inside a quoted path', () => {
    expect(parseArgLine('--db "C:\\data\\db"')).toEqual(['--db', 'C:\\data\\db']);
    expect(parseArgLine('--db "C:\\data\\say \\"hi\\""')).toEqual(['--db', 'C:\\data\\say "hi"']);
  });
});

describe('argRowsFromArgv', () => {
  it('splits the DBHub line into flag/value rows at the real separators', () => {
    expect(argRowsFromArgv(parseArgLine(DSN_LINE))).toEqual([
      { flag: '--transport', value: 'http' },
      { flag: '--port', value: '8080' },
      { flag: '--dsn', value: 'postgres://user:password@localhost:5432/dbname?sslmode=disable' },
    ]);
  });

  it('never splits a token that carries whitespace at an `=` inside its value', () => {
    expect(argRowsFromArgv(['--transport http --port 8080 --dsn "postgres://x?sslmode=disable"'])).toEqual([
      {
        flag: '',
        value: '--transport http --port 8080 --dsn "postgres://x?sslmode=disable"',
      },
    ]);
  });

  it('reads `--flag=value`, lone switches and positionals', () => {
    expect(argRowsFromArgv(['--port=8080', 'serve', '--verbose'])).toEqual([
      { flag: '--port', value: '8080' },
      { flag: '', value: 'serve' },
      { flag: '--verbose', value: '' },
    ]);
  });
});

describe('formatArgLine', () => {
  it('round-trips the DBHub line through rows', () => {
    const rows = argRowsFromArgv(parseArgLine(DSN_LINE));
    expect(parseArgLine(formatArgLine(rows.flatMap(argRowTokens)))).toEqual(parseArgLine(DSN_LINE));
  });
});
