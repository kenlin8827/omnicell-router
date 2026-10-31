/**
 * Real connection tests for the DSN builder (ADR-0015 §D11 amendment, 2026-11).
 *
 * The generic dial in `tcp-reach.ts` proves a port answers. That is not what "the parameters are
 * right" means: a wrong password, a missing database and a TLS mismatch all answer on TCP. For the
 * two mainstream engines this module logs in with the operator's own values (`select 1` / `ping`)
 * and answers a verdict that names WHICH part failed.
 *
 * Scope is deliberately two engines: PostgreSQL and MySQL/MariaDB. Every other scheme keeps the
 * credential at the console and gets the TCP dial only — no invented protocol knowledge.
 *
 * The credential travels over the admin route (auth + CSRF gated) for this one request. It is never
 * logged, never echoed, and the driver's failure text (which never contains the password) is passed
 * through unchanged.
 */
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { Connection as MysqlConnection } from 'mysql2/promise';

export type DbEngine = 'postgres' | 'mysql';

/** Map a URL scheme to a probe engine; anything else has no credential test. */
export function dbEngineFor(driver: string): DbEngine | null {
  const scheme = driver.trim().toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  return null;
}

export type DbProbeCode =
  | 'ok'
  | 'auth_failed'
  | 'database_missing'
  | 'tls_failed'
  | 'unsupported_auth'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'error';

export interface DbProbeResult {
  code: DbProbeCode;
  /** A socket reached the server (false for refused / timeout / unresolvable host). */
  reachable: boolean;
  /** Logged in and answered a trivial request. */
  verified: boolean;
  /** The driver's own failure text; never contains the password. */
  message?: string;
}

export interface DbProbeInput {
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** DSN query params. Both engines read `sslmode`; MySQL also spells it `ssl-mode`. */
  params: Record<string, string>;
}

/** Socket connect budget; the drivers apply it per attempt. */
const CONNECT_TIMEOUT_MS = 4_000;
/** Wall clock for the whole test including TLS and the trivial query. */
const OVERALL_TIMEOUT_MS = 8_000;

type PgSsl = false | { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined };
type MysqlSsl = { rejectUnauthorized: boolean } | undefined;

function sslMode(params: Record<string, string>): string {
  return (params.sslmode ?? params['ssl-mode'] ?? '').trim().toLowerCase();
}

/**
 * PostgreSQL TLS policy, matching libpq's own vocabulary. `require` encrypts without verifying the
 * certificate; `verify-ca` verifies the chain but not the hostname; `verify-full` does both.
 * No `sslmode` means libpq's default `prefer` — TLS first, plaintext when the server has no TLS.
 */
function pgSslConfig(mode: string): PgSsl {
  switch (mode.replace(/_/g, '-')) {
    case 'disable':
      return false;
    case 'allow':
    case 'prefer':
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      // An absent mode is still `prefer`: TLS first, then the plaintext fallback in probeDatabase.
      return { rejectUnauthorized: false };
  }
}

/** MySQL TLS policy over the same vocabulary; `undefined` is a plaintext handshake. */
function mysqlSslConfig(mode: string): MysqlSsl {
  // MySQL spells the same policy with underscores (`VERIFY_CA`, `VERIFY_IDENTITY`); normalize so
  // one picker serves both engines.
  switch (mode.replace(/_/g, '-')) {
    case 'disable':
    case 'disabled':
      return undefined;
    case 'allow':
    case 'prefer':
    case 'preferred':
    case 'require':
    case 'required':
      return { rejectUnauthorized: false };
    case 'verify-ca':
    case 'verify-identity':
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

function tlsUnsupported(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('does not support ssl') ||
    text.includes('does not support secure connection') ||
    text.includes('ssl is required but')
  );
}

function tlsFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('ssl') ||
    text.includes('tls') ||
    text.includes('certificate') ||
    text.includes('secure connection')
  );
}

function timeoutResult(): DbProbeResult {
  return {
    code: 'timeout',
    reachable: false,
    verified: false,
    message: `no answer within ${OVERALL_TIMEOUT_MS} ms`,
  };
}

/**
 * Race `work` against the overall deadline and call `abort` when it expires, so a half-open TLS
 * handshake cannot pin the console. A driver answer that lands after the deadline is discarded.
 */
async function withDeadline<T>(work: Promise<T>, abort: () => void): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  // ES2022 lib (backend tsconfig): Promise.withResolvers is unavailable — executor form.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort();
      resolve(null);
    }, OVERALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function mapPostgresError(error: unknown): DbProbeResult {
  const detail = error as { code?: string; message?: string };
  const message = detail.message ?? String(error);
  switch (detail.code) {
    case '28P01':
    case '28000':
      // 28P01 = invalid password; 28000 = the server's auth rules refused this host/transport.
      return { code: 'auth_failed', reachable: true, verified: false, message };
    case '3D000':
      return { code: 'database_missing', reachable: true, verified: false, message };
    case 'ECONNREFUSED':
      return { code: 'refused', reachable: false, verified: false, message };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'unreachable', reachable: false, verified: false, message };
    case 'ETIMEDOUT':
      return { code: 'timeout', reachable: false, verified: false, message };
    default:
      break;
  }
  if (tlsFailure(message)) return { code: 'tls_failed', reachable: true, verified: false, message };
  return { code: 'error', reachable: true, verified: false, message };
}

function mapMysqlError(error: unknown): DbProbeResult {
  const detail = error as { errno?: number; code?: string; message?: string };
  const message = detail.message ?? String(error);
  switch (detail.errno) {
    case 1045: // ER_ACCESS_DENIED_ERROR — bad user/password
    case 1044: // ER_DBACCESS_DENIED_ERROR — the user cannot open this database
      return { code: 'auth_failed', reachable: true, verified: false, message };
    case 1049: // ER_BAD_DB_ERROR — unknown database
      return { code: 'database_missing', reachable: true, verified: false, message };
    case 1251: // ER_NOT_SUPPORTED_AUTH_MODE — the server demands a legacy plugin
    case 2059: // CR_AUTH_PLUGIN_CANNOT_LOAD
      return { code: 'unsupported_auth', reachable: true, verified: false, message };
    default:
      break;
  }
  switch (detail.code) {
    case 'ECONNREFUSED':
      return { code: 'refused', reachable: false, verified: false, message };
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      return { code: 'timeout', reachable: false, verified: false, message };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'unreachable', reachable: false, verified: false, message };
    case 'HANDSHAKE_SSL_ERROR':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { code: 'tls_failed', reachable: true, verified: false, message };
    default:
      break;
  }
  if (tlsFailure(message)) return { code: 'tls_failed', reachable: true, verified: false, message };
  return { code: 'error', reachable: true, verified: false, message };
}

async function attemptPostgres(input: DbProbeInput, ssl: PgSsl): Promise<DbProbeResult> {
  const client = new PgClient({
    host: input.host,
    port: input.port,
    user: input.user === '' ? undefined : input.user,
    password: input.password === '' ? undefined : input.password,
    database: input.database === '' ? undefined : input.database,
    ssl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: CONNECT_TIMEOUT_MS,
    application_name: 'ocr-dsn-test',
  });
  const close = () => {
    client.end().catch(() => {});
  };
  const outcome = await withDeadline(
    (async () => {
      try {
        await client.connect();
        await client.query('select 1');
        return {
          code: 'ok',
          reachable: true,
          verified: true,
          message: 'authenticated; select 1 succeeded',
        } as DbProbeResult;
      } catch (error) {
        return mapPostgresError(error);
      } finally {
        close();
      }
    })(),
    close
  );
  return outcome ?? timeoutResult();
}

async function attemptMysql(input: DbProbeInput, ssl: MysqlSsl): Promise<DbProbeResult> {
  let connection: MysqlConnection | undefined;
  let expired = false;
  const outcome = await withDeadline(
    (async () => {
      try {
        connection = await mysql.createConnection({
          host: input.host,
          port: input.port,
          user: input.user === '' ? undefined : input.user,
          password: input.password === '' ? undefined : input.password,
          database: input.database === '' ? undefined : input.database,
          connectTimeout: CONNECT_TIMEOUT_MS,
          ...(ssl === undefined ? {} : { ssl }),
        });
        // The deadline may have expired while the handshake was in flight; close instead of
        // leaving a connection nobody is waiting for.
        if (expired) {
          await connection.end().catch(() => {});
          return timeoutResult();
        }
        await connection.ping();
        return {
          code: 'ok',
          reachable: true,
          verified: true,
          message: 'authenticated; ping succeeded',
        } as DbProbeResult;
      } catch (error) {
        return mapMysqlError(error);
      }
    })(),
    () => {
      expired = true;
      connection?.destroy();
    }
  );
  await connection?.end().catch(() => {});
  return outcome ?? timeoutResult();
}

/**
 * Test one DSN against its real engine. `prefer` (and an absent mode, which means the same) retries
 * a plaintext handshake ONLY when the server answered that it has no TLS at all; every other
 * failure keeps its verdict, so a certificate error is never silently downgraded to plaintext.
 */
export async function probeDatabase(input: DbProbeInput): Promise<DbProbeResult> {
  const mode = sslMode(input.params);
  const prefer = mode === '' || mode === 'prefer' || mode === 'preferred' || mode === 'allow';

  if (input.engine === 'postgres') {
    const result = await attemptPostgres(input, pgSslConfig(mode));
    if (prefer && result.code !== 'ok' && tlsUnsupported(result.message ?? '')) {
      return attemptPostgres(input, false);
    }
    return result;
  }

  const result = await attemptMysql(input, mysqlSslConfig(mode));
  if (prefer && result.code !== 'ok' && tlsUnsupported(result.message ?? '')) {
    return attemptMysql(input, undefined);
  }
  return result;
}
