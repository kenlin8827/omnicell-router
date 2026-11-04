/**
 * URL-style DSN parse/format helpers for the MCP parameter builder (ADR-0015 §D11).
 *
 * A `dsn`-format flag carries a connection string: `scheme://[user[:pass]@]host[:port][/db]?k=v&k=v`.
 * This module round-trips ONE such string against the structured fields the builder edits. It is
 * URL-style only: an ODBC `DSN=;UID=;PWD=` string or a `file:/path` (no `//`) returns `null` from
 * `parseDsn`, and the builder falls back to the raw textarea. The value itself is never executed;
 * the builder's Test connection sends the parsed fields (credential included) to the local gateway
 * for PostgreSQL/MySQL only, and every other scheme gets a credential-free TCP dial.
 *
 * Encoding: the WHATWG `URL` getters return user / password / pathname percent-ENCODED, while
 * `URLSearchParams` values are decoded — so `parseDsn` decodes the former and `formatDsn` re-encodes,
 * keeping the round-trip byte-stable for the common case (a credential with `@` or `+`).
 */

/** Structured fields the builder edits. `driver` is the scheme without the trailing `:`. */
export interface DsnFields {
  driver: string;
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
  /** Ordered key=value params after `?` (sslmode, charset, …). */
  params: { key: string; value: string }[];
}

/** Common network-DB drivers the builder offers as a picker (value = the URL scheme). An unknown
 *  scheme parsed out of an existing value is appended to the picker so it stays visible. */
export const DSN_DRIVERS: { value: string; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'mongodb+srv', label: 'MongoDB (SRV)' },
  { value: 'redis', label: 'Redis' },
  { value: 'rediss', label: 'Redis (TLS)' },
];

/**
 * Connection-string flag names — the console needs this WITHOUT a network probe so an existing
 * launch (EDIT opens rows from argv, which carry no `format`) still offers the structured builder.
 * Mirrors `DSN_NAME` in `backend/src/harness/host/mcp-cli.ts`; the two must change together.
 */
export const DSN_FLAG_RE = /\bdsn\b|connection[\s_-]?string|conn[\s_-]?str|database[\s_-]?url|db[\s_-]?url/i;

/** True for a launch flag that carries a connection string (`--dsn`, `--connection-string`, …). */
export const isDsnFlag = (name: string): boolean => DSN_FLAG_RE.test(name);

/** Engines the console can really log into — mirrors `dbEngineFor` in
 *  `backend/src/harness/db-probe.ts`; the two must change together. */
export type DsnEngine = 'postgres' | 'mysql';
export const dsnEngineFor = (driver: string): DsnEngine | null => {
  const scheme = driver.trim().toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  return null;
};

/** SSL-mode values offered when a postgres-flavoured driver is chosen. */
export const DSN_SSLMODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

/** Default port per driver, used only to make the reachability test dialable when the operator
 *  left the port blank — the serialized value itself stays port-less. `mongodb+srv` is absent on
 *  purpose: that form resolves hosts from DNS SRV records and accepts no port. */
export const DSN_DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  rediss: 6379,
};

/**
 * The `host:port` a client would dial for these fields; null when the value is not dialable — no
 * host, no port and no known default, or a host that is not a bare name/address. The test derives
 * its dial target from here; whether the credential travels with the request is the engine's call
 * (PostgreSQL/MySQL log in, every other scheme dials only).
 */
export function dsnTarget(fields: Pick<DsnFields, 'driver' | 'host' | 'port'>): { host: string; port: number } | null {
  const host = fields.host.trim().replace(/^\[(.*)\]$/, '$1');
  if (host === '' || /[\s/@]/.test(host)) return null;
  const raw = fields.port.trim();
  const port = raw === '' ? DSN_DEFAULT_PORTS[fields.driver.trim().toLowerCase()] : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const SCHEME_RE = /^[a-z+][a-z0-9+.-]*:\/\//i;

/** Percent-decode, returning the input unchanged if the sequence is malformed. */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Encode a path segment, keeping `/` so a multi-segment database name survives the round-trip. */
const encodePath = (s: string): string => s.split('/').map(encodeURIComponent).join('/');

/**
 * Parse a URL-style DSN into fields. Returns `null` for anything that is not `scheme://…` (the
 * builder then falls back to the raw textarea). An empty string returns blank fields so a fresh
 * row opens the builder with empty inputs, not the fallback.
 */
export function parseDsn(raw: string): DsnFields | null {
  const value = raw.trim();
  if (value === '') return { driver: '', user: '', password: '', host: '', port: '', database: '', params: [] };
  if (!SCHEME_RE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const params: { key: string; value: string }[] = [];
  url.searchParams.forEach((v, k) => params.push({ key: k, value: v }));
  return {
    driver: url.protocol.replace(/:$/, ''),
    user: decode(url.username),
    password: decode(url.password),
    host: url.hostname,
    port: url.port,
    database: decode(url.pathname.replace(/^\//, '')),
    params,
  };
}

/**
 * Format fields back into one DSN string. A blank driver yields `''` (an empty row stays empty).
 * Re-encodes user / password / database / params so the round-trip is byte-stable; an unknown
 * driver is kept verbatim.
 */
export function formatDsn(fields: DsnFields): string {
  const driver = fields.driver.trim();
  if (driver === '') return '';
  let out = `${driver}://`;
  if (fields.user !== '' || fields.password !== '') {
    out += encodeURIComponent(fields.user);
    if (fields.password !== '') out += `:${encodeURIComponent(fields.password)}`;
    out += '@';
  }
  out += fields.host;
  if (fields.port !== '') out += `:${fields.port}`;
  if (fields.database !== '') out += `/${encodePath(fields.database)}`;
  const qs = fields.params
    .filter((p) => p.key.trim() !== '')
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&');
  if (qs !== '') out += `?${qs}`;
  return out;
}

/** A display-only copy of the DSN with the password replaced by bullets; for the compact cell.
 *  The rest of the string is kept byte-stable (the password may carry percent-encoding), so the
 *  bullets are literal and never re-encoded. */
export function maskDsn(raw: string): string {
  const fields = parseDsn(raw);
  if (fields === null || fields.password === '') return raw;
  const marker = `:${encodeURIComponent(fields.password)}@`;
  const at = raw.indexOf(marker);
  if (at < 0) return raw; // an unusual encoding we did not reverse — keep the raw value visible
  const masked = '•'.repeat(Math.min(fields.password.length, 12));
  return raw.slice(0, at) + `:${masked}@` + raw.slice(at + marker.length);
}
