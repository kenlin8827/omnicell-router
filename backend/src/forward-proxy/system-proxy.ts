import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getOcrHomeDir } from '../cli/paths.js';
import { getRuntimeConfigRef } from '../config/index.js';
import { caCertPath } from './ca.js';

/**
 * Cross-platform OS system-proxy ownership for OCR's two local endpoints: the
 * inbound forward proxy (`owner: 'forward'`) and the Clash core's mixed port
 * (`owner: 'clash'`).
 *
 * Model — ONE owner, snapshot-and-restore, never blind-off:
 *  - `enable` reads the CURRENT OS proxy settings (whatever they point at —
 *    including a user's clash/v2ray), snapshots them to
 *    `<ocrHome>/forward-proxy/system-proxy.json`, then points the OS proxy at
 *    127.0.0.1:<port> with a bypass list.
 *  - There is exactly ONE snapshot slot, and it always holds the PRE-OCR
 *    state. Re-enabling the same endpoint refreshes; enabling the OTHER
 *    endpoint REWRITES the OS pointer and updates the snapshot's `owner` —
 *    it never re-reads the OS, whose values at that moment are ours.
 *  - `disable` restores the snapshot verbatim and deletes it, whichever owner
 *    set it. Without a snapshot OCR owns nothing, so disable is a NO-OP — it
 *    never blind-offs a proxy it did not set (a user's clash/v2ray keeps
 *    working).
 *  - The snapshot file doubles as crash detection: if it exists while the OS
 *    no longer points at us (or after a hard kill), the state reads `stale`
 *    and the console offers one-click restore.
 *
 * The bypass list differs BY OWNER, because the endpoints route differently:
 * the inbound proxy decides ingress per rule (unmatched traffic is tunneled
 * through), so only loopback + literal `direct` hosts are bypassed; the Clash
 * core's generated config ends in `MATCH,<group>`, so private/LAN ranges must
 * also stay DIRECT or they would be dragged into the tunnel.
 *
 * Platforms: win32 (WinINET registry), darwin (networksetup, every enabled
 * network service), linux with GNOME/gsettings. Anything else reports
 * `unsupported` — the UI hides the controls instead of pretending.
 */

const exec = promisify(execFile);

export type SystemProxyState = 'off' | 'on' | 'external' | 'stale' | 'unsupported';
/** Which OCR endpoint the OS proxy points at. */
export type SystemProxyOwner = 'forward' | 'clash';

export interface SystemProxyStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  state: SystemProxyState;
  /** Owner recorded in the snapshot; ABSENT while OCR owns nothing. */
  owner?: SystemProxyOwner;
  /** OS proxy server currently configured, when readable. */
  currentServer?: string;
  /** The server WE would set / have set. */
  targetServer?: string;
  override?: string;
  caPath: string;
  /** Present when OCR owns (or owned) the OS proxy — the restore payload. */
  snapshot?: SystemProxySnapshot;
}

interface WinSnapshot {
  ProxyEnable: number;
  ProxyServer: string;
  ProxyOverride: string;
  AutoConfigURL: string;
}
interface MacServiceSnapshot {
  service: string;
  web: { enabled: boolean; host: string; port: number };
  secure: { enabled: boolean; host: string; port: number };
  bypass: string[];
}
interface GnomeSnapshot {
  mode: string;
  http: { host: string; port: number };
  https: { host: string; port: number };
  ignoreHosts: string[];
}
interface SystemProxySnapshot {
  platform: NodeJS.Platform;
  setAt: number;
  targetServer: string;
  /** Endpoint this OCR surface pointed the OS at. Absent in older snapshots =
   *  `forward`, the only owner that existed then. */
  owner: SystemProxyOwner;
  win?: WinSnapshot;
  mac?: MacServiceSnapshot[];
  gnome?: GnomeSnapshot;
}

const snapshotPath = (): string => path.join(getOcrHomeDir(), 'forward-proxy', 'system-proxy.json');

function readSnapshot(): SystemProxySnapshot | undefined {
  try {
    const raw = fs.readFileSync(snapshotPath(), 'utf8');
    const parsed = JSON.parse(raw) as SystemProxySnapshot;
    if (!parsed.owner) parsed.owner = 'forward';
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSnapshot(s: SystemProxySnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true });
  fs.writeFileSync(snapshotPath(), JSON.stringify(s, null, 2));
}

function clearSnapshot(): void {
  try {
    fs.unlinkSync(snapshotPath());
  } catch {}
}

/** Loopback + the rule table's literal `direct` hosts, in the platform's override syntax. */
export function buildOverride(bypassList: string[], platform: NodeJS.Platform): string {
  const hosts = ['localhost', '127.0.0.1', '<local>'];
  for (const h of bypassList) {
    if (h) hosts.push(h);
  }
  return platform === 'win32' ? hosts.join(';') : JSON.stringify(hosts);
}

/**
 * What an enable call does with the snapshot slot:
 *  - `snapshot` — no owner yet, so the current OS settings ARE the user's and
 *    must be recorded before we overwrite them;
 *  - `refresh` — we already point the OS at this exact endpoint; re-enabling
 *    must NOT re-read the snapshot slot (the OS now holds OUR value);
 *  - `switch` — we own a different endpoint; rewrite the OS pointer and the
 *    snapshot's owner/target, keeping the PRE-OCR payload untouched.
 */
export type SystemProxyPlan = 'snapshot' | 'refresh' | 'switch';

export function planSystemProxyAction(
  snapshot: Pick<SystemProxySnapshot, 'targetServer'> | undefined,
  targetServer: string,
): SystemProxyPlan {
  if (!snapshot) return 'snapshot';
  return snapshot.targetServer === targetServer ? 'refresh' : 'switch';
}

/**
 * Private / link-local / CGNAT ranges that stay DIRECT when the OS proxy points
 * at the Clash mixed port. Same set as the PAC's direct list
 * (proxy/mihomo-pac.ts `PRIVATE_RANGES`), in each bypass syntax: WinINET takes
 * `x.*` wildcards, the networksetup / gsettings lists take CIDR.
 */
const LAN_BYPASS_WILDCARDS: readonly string[] = [
  '10.*',
  '172.16.*', '172.17.*', '172.18.*', '172.19.*',
  '172.20.*', '172.21.*', '172.22.*', '172.23.*',
  '172.24.*', '172.25.*', '172.26.*', '172.27.*',
  '172.28.*', '172.29.*', '172.30.*', '172.31.*',
  '192.168.*',
  '169.254.*',
  '100.64.*',
];
const LAN_BYPASS_CIDR: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
];

export function lanBypassHosts(platform: NodeJS.Platform): string[] {
  return [...(platform === 'win32' ? LAN_BYPASS_WILDCARDS : LAN_BYPASS_CIDR)];
}

/* ── win32 ─────────────────────────────────────────────────────────────── */

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
/**
 * Normalize the Windows Internet Settings into the single server the OS is
 * ACTUALLY using:
 *   - `ProxyEnable=0` means the `ProxyServer` value is stale → nothing;
 *   - `AutoConfigURL` (PAC) wins over the manual server when present;
 *   - WinINET's per-scheme form (`http=host:port;https=host:port`) reduces to
 *     one `host:port` (https preferred) so ownership comparison and the port
 *     label see a real endpoint.
 */
export function normalizeProxyServer(raw: string, enabled: number, pac: string): string | undefined {
  if (pac.trim()) return pac.trim();
  if (!enabled) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const https = /(?:^|;)https=([^;]+)/i.exec(value)?.[1];
  const http = /(?:^|;)http=([^;]+)/i.exec(value)?.[1];
  return (https || http || value.split(';')[0]).trim() || undefined;
}

async function winRead(): Promise<WinSnapshot & { _server?: string }> {
  const { stdout } = await exec('reg', ['query', WIN_KEY]);
  const get = (name: string): string => {
    const m = new RegExp(`\\s${name}\\s+REG_(SZ|DWORD)\\s+(.*)`, 'i').exec(stdout);
    return m ? m[2].trim() : '';
  };
  const hex = (v: string): number => (v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10) || 0);
  return {
    ProxyEnable: hex(get('ProxyEnable')),
    ProxyServer: get('ProxyServer'),
    ProxyOverride: get('ProxyOverride'),
    AutoConfigURL: get('AutoConfigURL'),
    _server: normalizeProxyServer(get('ProxyServer'), hex(get('ProxyEnable')), get('AutoConfigURL')),
  };
}

async function winSet(server: string, override: string): Promise<void> {
  const args = (v: string, t: string, d: string): string[] => ['add', WIN_KEY, '/v', v, '/t', t, '/d', d, '/f'];
  await exec('reg', args('ProxyEnable', 'REG_DWORD', '1'));
  await exec('reg', args('ProxyServer', 'REG_SZ', server));
  await exec('reg', args('ProxyOverride', 'REG_SZ', override));
  // A PAC URL wins over ProxyEnable/ProxyServer — park it while we own the proxy.
  await exec('reg', ['delete', WIN_KEY, '/v', 'AutoConfigURL', '/f']).catch(() => {});
}

async function winRestore(s: WinSnapshot): Promise<void> {
  const args = (v: string, t: string, d: string): string[] => ['add', WIN_KEY, '/v', v, '/t', t, '/d', d, '/f'];
  await exec('reg', args('ProxyEnable', 'REG_DWORD', String(s.ProxyEnable)));
  await exec('reg', args('ProxyServer', 'REG_SZ', s.ProxyServer));
  await exec('reg', args('ProxyOverride', 'REG_SZ', s.ProxyOverride));
  if (s.AutoConfigURL) await exec('reg', args('AutoConfigURL', 'REG_SZ', s.AutoConfigURL)).catch(() => {});
}

/* ── darwin ────────────────────────────────────────────────────────────── */

async function macServices(): Promise<string[]> {
  const { stdout } = await exec('networksetup', ['-listallnetworkservices']);
  return stdout
    .split('\n')
    .slice(1) // first line is the legend
    .map(l => l.replace(/^\*/, '').trim())
    .filter(l => l && !l.includes('(disabled)'));
}

async function macRead(service: string): Promise<MacServiceSnapshot> {
  const trip = async (kind: 'web' | 'secure'): Promise<MacServiceSnapshot['web']> => {
    const { stdout } = await exec('networksetup', [`-get${kind}proxy`, service]);
    const enabled = /Enabled: Yes/.test(stdout);
    const host = /Server: (.*)/.exec(stdout)?.[1]?.trim() ?? '';
    const port = parseInt(/Port: (\d+)/.exec(stdout)?.[1] ?? '0', 10) || 0;
    return { enabled, host, port };
  };
  const { stdout } = await exec('networksetup', ['-getproxybypassdomains', service]);
  const bypass = stdout.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('There aren'));
  return { service, web: await trip('web'), secure: await trip('secure'), bypass };
}

async function macSet(service: string, server: string, overrideHosts: string[]): Promise<void> {
  const [host, port] = server.split(':');
  await exec('networksetup', ['-setwebproxy', service, host, port]);
  await exec('networksetup', ['-setsecurewebproxy', service, host, port]);
  await exec('networksetup', ['-setproxybypassdomains', service, ...overrideHosts]);
}

async function macRestore(s: MacServiceSnapshot): Promise<void> {
  const svc = s.service;
  if (s.web.enabled && s.web.host) {
    await exec('networksetup', ['-setwebproxy', svc, s.web.host, String(s.web.port)]);
  } else {
    await exec('networksetup', ['-setwebproxystate', svc, 'off']);
  }
  if (s.secure.enabled && s.secure.host) {
    await exec('networksetup', ['-setsecurewebproxy', svc, s.secure.host, String(s.secure.port)]);
  } else {
    await exec('networksetup', ['-setsecurewebproxystate', svc, 'off']);
  }
  if (s.bypass.length) {
    await exec('networksetup', ['-setproxybypassdomains', svc, ...s.bypass]);
  }
}

/* ── linux GNOME ───────────────────────────────────────────────────────── */

async function gnomeRead(): Promise<GnomeSnapshot> {
  const g = async (key: string): Promise<string> => {
    const { stdout } = await exec('gsettings', ['get', 'org.gnome.system.proxy', key]);
    return stdout.trim();
  };
  const parseHost = (v: string): string => (/^'(.*)'$/.exec(v)?.[1] ?? v.replace(/^'/, '').replace(/'$/, ''));
  const trip = async (kind: 'http' | 'https'): Promise<GnomeSnapshot['http']> => ({
    host: parseHost(await g(`${kind}.host`)),
    port: parseInt(await g(`${kind}.port`), 10) || 0,
  });
  const ignoreRaw = await g('ignore-hosts');
  let ignoreHosts: string[] = [];
  try {
    ignoreHosts = JSON.parse(ignoreRaw.replace(/^@as /, '')) as string[];
  } catch {}
  return { mode: parseHost(await g('mode')), http: await trip('http'), https: await trip('https'), ignoreHosts };
}

async function gnomeSet(server: string, ignoreHosts: string[]): Promise<void> {
  const [host, port] = server.split(':');
  const s = async (key: string, val: string): Promise<void> => {
    await exec('gsettings', ['set', 'org.gnome.system.proxy', key, val]);
  };
  await s('mode', "'manual'");
  await s('http.host', `'${host}'`);
  await s('http.port', port);
  await s('https.host', `'${host}'`);
  await s('https.port', port);
  await s('ignore-hosts', JSON.stringify(ignoreHosts));
}

async function gnomeRestore(snap: GnomeSnapshot): Promise<void> {
  const set = async (key: string, val: string): Promise<void> => {
    await exec('gsettings', ['set', 'org.gnome.system.proxy', key, val]);
  };
  await set('mode', `'${snap.mode === 'manual' ? 'manual' : 'none'}'`);
  if (snap.mode === 'manual') {
    await set('http.host', `'${snap.http.host}'`);
    await set('http.port', String(snap.http.port));
    await set('https.host', `'${snap.https.host}'`);
    await set('https.port', String(snap.https.port));
    await set('ignore-hosts', JSON.stringify(snap.ignoreHosts));
  }
}

/* ── public surface ────────────────────────────────────────────────────── */

function platformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' || (platform === 'linux' && Boolean(process.env.XDG_CURRENT_DESKTOP && /gnome|unity|cinnamon/i.test(process.env.XDG_CURRENT_DESKTOP)));
}

/** Current snapshot server (the one we set), for ownership comparison. */
async function readCurrentServer(platform: NodeJS.Platform): Promise<string | undefined> {
  try {
    if (platform === 'win32') return (await winRead())._server || undefined;
    if (platform === 'darwin') {
      // First enabled service is enough for a preflight: a proxy that owns the
      // machine is normally set on the active service too.
      const svc = (await macServices())[0];
      if (!svc) return undefined;
      const s = await macRead(svc);
      const pick = s.secure.enabled && s.secure.host ? s.secure : s.web.enabled && s.web.host ? s.web : undefined;
      return pick ? `${pick.host}:${pick.port}` : undefined;
    }
    if (platform === 'linux') {
      const g = await gnomeRead();
      return g.mode === 'manual' && g.http.host ? `${g.http.host}:${g.http.port}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The HTTP proxy the OS itself is using right now, with its bypass list —
 *  the egress a normal application on this machine would take. A PAC
 *  (`AutoConfigURL`) is NOT resolvable from a socket probe, so it yields
 *  nothing and callers fall back to a direct connection instead of guessing. */
export interface OsProxyEndpoint {
  /** `host:port`, possibly with `user:pass@` — Windows stores auth that way. */
  server: string;
  bypass: string[];
}

export async function readOsProxyEndpoint(): Promise<OsProxyEndpoint | undefined> {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const s = await winRead();
      if (!s.ProxyEnable || s.AutoConfigURL.trim()) return undefined;
      const server = pickWinServer(s.ProxyServer);
      if (!server) return undefined;
      return { server, bypass: s.ProxyOverride.split(';').map(v => v.trim()).filter(Boolean) };
    }
    if (platform === 'darwin') {
      for (const svc of await macServices()) {
        const s = await macRead(svc);
        const pick = s.secure.enabled && s.secure.host ? s.secure : s.web.enabled && s.web.host ? s.web : undefined;
        if (pick) return { server: `${pick.host}:${pick.port}`, bypass: s.bypass };
      }
      return undefined;
    }
    if (platform === 'linux') {
      const g = await gnomeRead();
      if (g.mode !== 'manual') return undefined;
      const pick = g.https.host ? g.https : g.http.host ? g.http : undefined;
      return pick ? { server: `${pick.host}:${pick.port}`, bypass: g.ignoreHosts } : undefined;
    }
  } catch {
    // A probe must never fail because the OS settings are unreadable; the
    // caller treats "no endpoint" as "connect directly".
    return undefined;
  }
  return undefined;
}

/** WinINET's per-scheme form (`http=host:port;https=host:port`) reduces to
 *  one endpoint; an `http://` prefix is stripped but `user:pass@` is kept.
 *  A SOCKS-only config (`socks=host:port`) yields nothing: the machine leg
 *  speaks the HTTP proxy protocol, and reporting a direct run is honester
 *  than dialing `socks=...` as a hostname. */
function pickWinServer(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const https = /(?:^|;)https=([^;]+)/i.exec(value)?.[1];
  const http = /(?:^|;)http=([^;]+)/i.exec(value)?.[1];
  const pick = (https || http || value.split(';')[0]).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!pick || /^[a-z]+=/i.test(pick)) return undefined;
  return pick;
}

function ipv4ToInt(addr: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some(n => n > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127\./.test(host);

/**
 * Would the OS send `host` through its proxy, given the OS bypass list?
 * Covers the syntaxes the three platforms actually store: WinINET wildcards
 * (`192.168.*`, `<local>`), macOS/Linux CIDR entries and domain suffixes.
 * Loopback is ALWAYS direct — a proxy in front of a loopback target would
 * either loop back into this gateway or fail for no diagnosable reason.
 */
export function osProxyBypasses(host: string, bypass: string[]): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHost(name)) return true;
  const ip = ipv4ToInt(name);
  for (const entry of bypass) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    if (e === '<local>') {
      // WinINET: plain host names, no dot. An IP address is never "<local>".
      if (!name.includes('.') && !ip) return true;
      continue;
    }
    if (e.includes('/') && ip !== undefined) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(e);
      if (m) {
        const base = ipv4ToInt(m[1]);
        const bits = Number(m[2]);
        if (base !== undefined && bits >= 0 && bits <= 32) {
          const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
          if ((ip & mask) === (base & mask)) return true;
        }
      }
      continue;
    }
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // `.example.com`
      if (name === e.slice(2) || name.endsWith(suffix)) return true;
      continue;
    }
    if (e.startsWith('.')) {
      if (name === e.slice(1) || name.endsWith(e)) return true;
      continue;
    }
    if (e.includes('*')) {
      const pattern = e.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      if (new RegExp(`^${pattern}$`).test(name)) return true;
      continue;
    }
    if (name === e) return true;
  }
  return false;
}

export async function getSystemProxyStatus(targetPort: number, bypassList: string[]): Promise<SystemProxyStatus> {
  const platform = process.platform;
  const supported = platformSupported(platform);
  const targetServer = `127.0.0.1:${targetPort}`;
  const base: SystemProxyStatus = {
    platform,
    supported,
    state: supported ? 'off' : 'unsupported',
    targetServer,
    override: buildOverride(bypassList, platform),
    caPath: caCertPath(getRuntimeConfigRef()?.forwardProxy?.caDir),
  };
  if (!supported) return base;
  const snapshot = readSnapshot();
  const currentServer = await readCurrentServer(platform);
  if (snapshot) {
    const owned = currentServer === snapshot.targetServer;
    return { ...base, state: owned ? 'on' : 'stale', owner: snapshot.owner, currentServer, snapshot };
  }
  return { ...base, state: currentServer ? 'external' : 'off', currentServer };
}

/**
 * Point the OS proxy at one of OCR's local endpoints, snapshotting first.
 * See `planSystemProxyAction` for how an existing snapshot is treated.
 */
export async function enableSystemProxy(
  targetPort: number,
  bypassList: string[],
  owner: SystemProxyOwner = 'forward',
): Promise<SystemProxyStatus> {
  const platform = process.platform;
  if (!platformSupported(platform)) throw new Error(`system proxy not supported on ${platform}`);
  const targetServer = `127.0.0.1:${targetPort}`;
  const snapshot = readSnapshot();
  const plan = planSystemProxyAction(snapshot, targetServer);
  if (plan === 'refresh') {
    // Same endpoint: never re-read the OS here — it points at OUR server, and
    // re-snapshotting would overwrite (and permanently lose) the user's
    // original proxy configuration. Only a relabelled owner is worth a write.
    if (snapshot!.owner !== owner) writeSnapshot({ ...snapshot!, owner });
    return getSystemProxyStatus(targetPort, bypassList);
  }
  const overrideHosts = ['localhost', '127.0.0.1', '<local>', ...bypassList.filter(Boolean)];
  /** `switch` keeps the snapshot's PRE-OCR payload; only `snapshot` reads the OS. */
  const original = plan === 'snapshot' ? undefined : snapshot!;
  if (platform === 'win32') {
    const snap = original ? original.win! : await winRead();
    await winSet(targetServer, buildOverride(bypassList, platform));
    writeSnapshot({ platform, setAt: Date.now(), targetServer, owner, win: snap });
  } else if (platform === 'darwin') {
    const services = await macServices();
    const snaps = original ? original.mac! : await Promise.all(services.map(macRead));
    await Promise.all(services.map(svc => macSet(svc, targetServer, overrideHosts)));
    writeSnapshot({ platform, setAt: Date.now(), targetServer, owner, mac: snaps });
  } else {
    const snap = original ? original.gnome! : await gnomeRead();
    await gnomeSet(targetServer, overrideHosts);
    writeSnapshot({ platform, setAt: Date.now(), targetServer, owner, gnome: snap });
  }
  return getSystemProxyStatus(targetPort, bypassList);
}

/** Restore whatever the OS proxy was before OCR took ownership. */
export async function disableSystemProxy(targetPort: number, bypassList: string[]): Promise<SystemProxyStatus> {
  const snapshot = readSnapshot();
  if (!snapshot) {
    // Nothing owned — deliberately a no-op: without a snapshot we cannot
    // know what to restore, so touching the OS proxy here could blind-off
    // a proxy OCR never set (a user's clash/v2ray). File-header contract.
    return getSystemProxyStatus(targetPort, bypassList);
  }
  try {
    if (snapshot.win) await winRestore(snapshot.win);
    if (snapshot.mac) await Promise.all(snapshot.mac.map(macRestore));
    if (snapshot.gnome) await gnomeRestore(snapshot.gnome);
  } finally {
    clearSnapshot();
  }
  return getSystemProxyStatus(targetPort, bypassList);
}
