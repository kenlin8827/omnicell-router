/**
 * MCP launch-argument text helpers — the one space-separated line the sheet edits and the argv
 * table the visual editor round-trips through.
 *
 * Operators paste real shell lines, so the parser has to survive what a shell would accept:
 * single/double quotes, an escaped quote or backslash, and typographic quotes from a doc. It also
 * unwraps a whole line pasted inside one outer quote pair — without that, the quoted run swallows
 * every separator and the line parses as ONE token (the bug behind the `--dsn` URL being split at
 * the `=` inside `?sslmode=disable`).
 */

/** Straighten typographic quotes so a pasted command parses like one typed. */
const straightenQuotes = (text: string): string => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

/** Split a command line on whitespace; quotes keep one value together. */
export const parseArgLine = (text: string): string[] => {
  let chars = straightenQuotes(text.trim());
  const first = chars[0];
  if (
    chars.length >= 2 &&
    (first === '"' || first === "'") &&
    chars.endsWith(first) &&
    /^--?/.test(chars.slice(1, -1).trim())
  ) {
    chars = chars.slice(1, -1).trim();
  }
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < chars.length) {
        const next = chars[i + 1]!;
        // Only `\"` and `\\` are escapes — a Windows path keeps its backslashes.
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else current += ch;
      } else if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
};

/** Render argv as one line; a token carrying whitespace is quoted so `parseArgLine` round-trips. */
export const formatArgLine = (tokens: string[]): string =>
  tokens
    .map((token) => (/[\s"']/.test(token) ? `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : token))
    .join(' ');

/** One editable argv entry, before the page attaches its row id and registry metadata. */
export interface ParsedArgRow {
  /** `--flag` for a named argument, empty for a positional value. */
  flag: string;
  value: string;
}

/**
 * Reverse-render argv into rows: `--flag value`, `--flag=value`, a lone switch, or a bare
 * positional. A flag is ONE token with no whitespace — a token that carries whitespace can never
 * be split at an `=` that belongs to its value.
 */
export const argRowsFromArgv = (tokens: string[]): ParsedArgRow[] => {
  const rows: ParsedArgRow[] = [];
  const isFlag = (token: string): boolean => /^--?[^\s]+$/.test(token);
  const isEqFlag = (token: string): boolean => /^--?[^\s=]+=/.test(token);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isEqFlag(token)) {
      const eq = token.indexOf('=');
      rows.push({ flag: token.slice(0, eq), value: token.slice(eq + 1) });
    } else if (isFlag(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !/^--?/.test(next)) {
        rows.push({ flag: token, value: next });
        i++;
      } else {
        rows.push({ flag: token, value: '' });
      }
    } else {
      rows.push({ flag: '', value: token });
    }
  }
  return rows;
};

/** Compose one row back into argv tokens; an empty value keeps a lone flag (a boolean switch). */
export const argRowTokens = (row: ParsedArgRow): string[] => {
  const flag = row.flag.trim();
  if (flag) return row.value === '' ? [flag] : [flag, row.value];
  return row.value === '' ? [] : [row.value];
};
