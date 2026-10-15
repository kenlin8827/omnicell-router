import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RouterConfig, WebAuthConfig } from '../config/types.js';
import { getEnvPaths } from '../config/env.js';

/* ------------------------------------------------------------------------- *
 * Console (web UI) authentication — username/password login for /admin.
 *
 * Design:
 *  - Password stored ONLY as `scrypt$<saltHex>$<hashHex>` in config.yaml
 *    (webAuth.passwordHash). Plaintext never persists.
 *  - Stateless HMAC-signed session token in an HttpOnly SameSite=Lax cookie
 *    (`ocr_session`). The signing secret lives in the ACTIVE ENVIRONMENT's
 *    webauth-secret file (every env including default, under envs/<name>/;
 *    created on first use) so sessions survive gateway restarts — the UI
 *    "Restart Gateway" button and daemon self-heal must not log the operator
 *    out. Per-env secrets also stop a cookie from one env being replayed as
 *    valid in another.
 *  - Non-loopback binding (0.0.0.0, ::, LAN IP) FORCES webAuth on:
 *    validateWebAuthStartup() hard-fails the boot when disabled, because an
 *    unauthenticated admin console reachable from the LAN is a real hole.
 * ------------------------------------------------------------------------- */

/** Is this bind host loopback-only? 0.0.0.0 / :: / empty = ALL interfaces → NOT loopback. */
export function isLoopbackHost(host?: string): boolean {
  const h = (host || '').trim().toLowerCase();
  if (!h) return false; // unset host → treat as all-interfaces (conservative)
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (h === '::' || h === '[::]' || h === '*' || h === '0.0.0.0') return false;
  if (h.startsWith('127.')) return true;
  return false;
}

/**
 * webAuth is ACTIVE (console requires login) when explicitly enabled, or
 * when the bind host is non-loopback (forced — see validateWebAuthStartup).
 */
export function isWebAuthActive(config: Pick<RouterConfig, 'webAuth' | 'host'>): boolean {
  if (config.webAuth?.enabled === true) return true;
  return !isLoopbackHost(config.host);
}

/** The three /api/admin/auth/* endpoints that must stay reachable pre-login. */
export function isAdminAuthEndpoint(url: string): boolean {
  return (
    url === '/api/admin/auth/login' ||
    url === '/api/admin/auth/logout' ||
    url === '/api/admin/auth/session'
  );
}

/* ─── Password hashing (scrypt) ─────────────────────────────────────────── */

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false; // unknown format (e.g. hand-written plaintext) never verifies
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ─── Session signing secret (persisted across restarts) ────────────────── */

let cachedSecret: Buffer | undefined;

function sessionSecretFile(): string {
  // Per-ENVIRONMENT secret (<home>/envs/<env>/webauth-secret): two envs signed
  // with different secrets can never replay each other's session cookies.
  return getEnvPaths().webauthSecretPath;
}

/**
 * Load (or create) the HMAC session secret. Falls back to an ephemeral
 * per-process secret if the file is unreadable — sessions then die on
 * restart instead of taking the gateway down.
 */
export function getSessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const file = sessionSecretFile();
  try {
    if (fs.existsSync(file)) {
      const hex = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        cachedSecret = Buffer.from(hex, 'hex');
        return cachedSecret;
      }
    }
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    cachedSecret = secret;
    return cachedSecret;
  } catch {
    // Ephemeral fallback: never crash the gateway over a secret file.
    cachedSecret = crypto.randomBytes(32);
    return cachedSecret;
  }
}

/** Test seam: replace the in-memory secret (does not touch the file). */
export function _setSessionSecretForTests(secret: Buffer): void {
  cachedSecret = secret;
}

/* ─── Stateless session token ────────────────────────────────────────────── */

export const SESSION_COOKIE = 'ocr_session';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function sign(payload: string, secret: Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createSessionToken(now = Date.now(), ttlMs = SESSION_TTL_MS, secret = getSessionSecret()): string {
  const expiry = now + ttlMs;
  const payload = String(expiry);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now(), secret = getSessionSecret()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(payload)) return false;
  const expiry = Number(payload);
  if (expiry <= now) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parse the `ocr_session` cookie out of a raw Cookie header value. */
export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionSetCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/* ─── Login brute-force guard (in-memory, per IP) ───────────────────────── */

const LOCKOUT_BASE_MS = 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const failureMap = new Map<string, { count: number; lockUntil: number }>();

/** Throws when the IP is locked out; returns remaining-allowed info otherwise. */
export function checkLoginAllowed(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const rec = failureMap.get(ip);
  if (!rec) return { allowed: true };
  if (rec.lockUntil > Date.now()) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  const rec = failureMap.get(ip) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    // Exponential: 1min, 2min, 4min, ... capped at 15min
    const backoff = Math.min(LOCKOUT_BASE_MS * 2 ** (rec.count - MAX_FAILURES), LOCKOUT_MAX_MS);
    rec.lockUntil = Date.now() + backoff;
  }
  failureMap.set(ip, rec);
}

export function recordLoginSuccess(ip: string): void {
  failureMap.delete(ip);
}

/* ─── Boot-time validation ──────────────────────────────────────────────── */

/**
 * Hard-fails (throws) when the webAuth config is inconsistent with the bind
 * host. Called once on gateway boot — an insecure or unusable console auth
 * setup must be loud, never silently coerced.
 *  - non-loopback host + enabled=false → throw (LAN-exposed open console)
 *  - enabled=true but credentials missing → throw (console locks itself)
 */
export function validateWebAuthStartup(config: Pick<RouterConfig, 'webAuth' | 'host'>): void {
  const loopback = isLoopbackHost(config.host);
  const wa: WebAuthConfig | undefined = config.webAuth;

  if (!loopback && wa?.enabled !== true) {
    throw new Error(
      `[webAuth] Gateway binds non-loopback host '${config.host}' — the admin console would be reachable ` +
        `from the network without login. Set webAuth.enabled=true with webAuth.username + webAuth.passwordHash ` +
        `in config.yaml (passwordHash = scrypt$<saltHex>$<hashHex>; generate via the console Settings page ` +
        `on a loopback bind), or bind 127.0.0.1.`
    );
  }
  if (wa?.enabled === true && (!wa.username?.trim() || !wa.passwordHash)) {
    throw new Error(
      `[webAuth] webAuth.enabled=true but username/passwordHash are missing — the console would lock itself. ` +
        `Configure both in config.yaml or set enabled=false (loopback bind only).`
    );
  }
}

/** Credentials completeness check used by the login endpoint + UI config endpoint. */
export function hasWebAuthCredentials(wa?: WebAuthConfig): boolean {
  return Boolean(wa?.username?.trim() && wa?.passwordHash);
}
