/**
 * DSN parse/format round-trip tests for the MCP parameter builder (ADR-0015 §D11).
 *
 * The motivating case is the DBHub launch line: `--dsn "postgres://…?sslmode=disable"`. The
 * builder edits structured fields and serializes back to one string, so the contract that
 * matters is byte-stable round-tripping of a real connection string — plus a clean `null` for
 * anything that is not `scheme://…` (the builder then falls back to the raw textarea).
 */
import { describe, expect, it } from 'vitest';
import { DSN_DRIVERS, formatDsn, maskDsn, parseDsn } from './dsn';

const DBHUB = 'postgres://user:password@localhost:5432/dbname?sslmode=disable';

describe('parseDsn', () => {
  it('splits the DBHub line into the builder fields', () => {
    expect(parseDsn(DBHUB)).toEqual({
      driver: 'postgres',
      user: 'user',
      password: 'password',
      host: 'localhost',
      port: '5432',
      database: 'dbname',
      params: [{ key: 'sslmode', value: 'disable' }],
    });
  });

  it('returns null for a non-URL connection string (ODBC-style)', () => {
    expect(parseDsn('DSN=MyDSN;UID=user;PWD=pass')).toBeNull();
  });

  it('returns null for a file path with no `//` (sqlite)', () => {
    expect(parseDsn('file:/path/to/db.sqlite')).toBeNull();
  });

  it('returns null for plain text that is not a DSN', () => {
    expect(parseDsn('not a url')).toBeNull();
  });

  it('returns blank fields for an empty value so the builder opens empty', () => {
    expect(parseDsn('')).toEqual({
      driver: '',
      user: '',
      password: '',
      host: '',
      port: '',
      database: '',
      params: [],
    });
  });

  it('decodes a percent-encoded credential back to the typed value', () => {
    expect(parseDsn('postgres://user:p%40ss@host:5432/db')).toEqual({
      driver: 'postgres',
      user: 'user',
      password: 'p@ss',
      host: 'host',
      port: '5432',
      database: 'db',
      params: [],
    });
  });

  it('parses a redis DSN whose user is empty but password is set', () => {
    expect(parseDsn('redis://:pass@host:6379/0')).toEqual({
      driver: 'redis',
      user: '',
      password: 'pass',
      host: 'host',
      port: '6379',
      database: '0',
      params: [],
    });
  });

  it('parses a hostless postgres DSN (`postgres:///dbname`)', () => {
    expect(parseDsn('postgres:///dbname')).toEqual({
      driver: 'postgres',
      user: '',
      password: '',
      host: '',
      port: '',
      database: 'dbname',
      params: [],
    });
  });

  it('keeps params in insertion order', () => {
    const fields = parseDsn('mysql://u:p@host/db?a=1&b=2&c=3');
    expect(fields?.params.map((p) => p.key)).toEqual(['a', 'b', 'c']);
  });

  it('keeps IPv6 brackets inside the host field', () => {
    expect(parseDsn('postgres://u:p@[::1]:5432/db')).toEqual({
      driver: 'postgres',
      user: 'u',
      password: 'p',
      host: '[::1]',
      port: '5432',
      database: 'db',
      params: [],
    });
  });
});

describe('formatDsn', () => {
  it('round-trips the DBHub line byte-for-byte', () => {
    expect(formatDsn(parseDsn(DBHUB)!)).toBe(DBHUB);
  });

  it('round-trips a percent-encoded credential', () => {
    expect(formatDsn(parseDsn('postgres://user:p%40ss@host:5432/db')!)).toBe('postgres://user:p%40ss@host:5432/db');
  });

  it('round-trips a DSN with no credentials', () => {
    expect(formatDsn(parseDsn('postgres://host:5432/db')!)).toBe('postgres://host:5432/db');
  });

  it('round-trips a redis DSN with an empty user', () => {
    expect(formatDsn(parseDsn('redis://:pass@host:6379/0')!)).toBe('redis://:pass@host:6379/0');
  });

  it('round-trips a hostless postgres DSN', () => {
    expect(formatDsn(parseDsn('postgres:///dbname')!)).toBe('postgres:///dbname');
  });

  it('round-trips a multi-segment database name', () => {
    expect(formatDsn(parseDsn('postgres://host/path/to/db')!)).toBe('postgres://host/path/to/db');
  });

  it('round-trips an IPv6 host', () => {
    expect(formatDsn(parseDsn('postgres://u:p@[::1]:5432/db')!)).toBe('postgres://u:p@[::1]:5432/db');
  });

  it('round-trips an mongodb+srv DSN with params', () => {
    const v = 'mongodb+srv://u:p@cluster.abcd.mongodb.net/db?retryWrites=true';
    expect(formatDsn(parseDsn(v)!)).toBe(v);
  });

  it('returns an empty string for a blank driver', () => {
    expect(formatDsn({ driver: '', user: 'u', password: 'p', host: 'h', port: '5', database: 'd', params: [] })).toBe('');
  });
});

describe('maskDsn', () => {
  it('replaces the password with bullets and round-trips the rest', () => {
    expect(maskDsn(DBHUB)).toBe('postgres://user:••••••••@localhost:5432/dbname?sslmode=disable');
  });

  it('leaves a DSN with no password unchanged', () => {
    expect(maskDsn('postgres://host:5432/db')).toBe('postgres://host:5432/db');
  });

  it('returns the input unchanged when it does not parse', () => {
    expect(maskDsn('DSN=;UID=;PWD=')).toBe('DSN=;UID=;PWD=');
  });
});

describe('DSN_DRIVERS', () => {
  it('uses the URL scheme as the option value so a parsed driver maps directly', () => {
    expect(DSN_DRIVERS.map((d) => d.value)).toContain('postgres');
    expect(DSN_DRIVERS.map((d) => d.value)).toContain('mongodb+srv');
  });
});
