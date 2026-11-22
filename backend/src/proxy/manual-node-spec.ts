/**
 * Single source of truth for the manual-node form (ADR-0022).
 *
 * One field table drives all three directions:
 *   - sanitizing a typed draft (`sanitizeTypedNode`),
 *   - rendering a typed row into the generated Clash mapping (`manualNodeMapping`),
 *   - projecting a stored YAML mapping back into the form (`manualNodeFields`).
 *
 * Adding a field is one row here plus a control in the console. Keeping the
 * three directions in one table is deliberate: they used to be separate
 * hand-written functions and could silently drift.
 */
import type { MihomoManualNode } from '../config/types.js';

/** Protocol whitelist. Order is the console's dropdown order. */
export const MANUAL_NODE_PROTOCOLS = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'http', 'socks5'] as const;

export type ManualNodeProtocol = typeof MANUAL_NODE_PROTOCOLS[number];

export const MANUAL_NODE_SS_CIPHERS = [
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
] as const;
export const MANUAL_NODE_VMESS_CIPHERS = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'] as const;
export const MANUAL_NODE_NETWORKS = ['tcp', 'ws', 'grpc', 'h2'] as const;
export const MANUAL_NODE_FINGERPRINTS = [
  'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized',
] as const;
export const MANUAL_NODE_SS_PLUGINS = ['obfs', 'v2ray-plugin'] as const;
export const MANUAL_NODE_OBFS_MODES = ['http', 'tls'] as const;
export const MANUAL_NODE_IP_VERSIONS = ['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer'] as const;
export const MANUAL_NODE_OBFS_TYPES = ['salamander'] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ALPN_RE = /^[A-Za-z0-9./_-]{1,32}$/;
const REALITY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHORT_ID_RE = /^[0-9a-fA-F]{0,16}$/;
const PORTS_RE = /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/;

type Kind = 'text' | 'host' | 'uuid' | 'bool' | 'int' | 'enum' | 'alpn';

export interface ManualNodeFieldSpec {
  key: keyof MihomoManualNode;
  kind: Kind;
  max?: number;
  /** int bounds (inclusive). */
  min?: number;
  maxValue?: number;
  values?: readonly string[];
  pattern?: RegExp;
  /** Mapping path; dotted segments create/read nested objects. */
  path?: string | ((node: Pick<MihomoManualNode, 'type'>) => string);
  /** Emit/keep the field only when this holds (rendering and projection). */
  when?: (node: MihomoManualNode) => boolean;
  encode?: (value: unknown) => unknown;
  decode?: (value: unknown) => unknown;
  /** Projected when the mapping omits the key (form defaults). */
  fallback?: unknown;
}

const SPEC_LIST: ManualNodeFieldSpec[] = [
  { key: 'cipher', kind: 'enum', values: MANUAL_NODE_SS_CIPHERS, path: 'cipher' },
  { key: 'password', kind: 'text', max: 256, path: 'password' },
  { key: 'username', kind: 'text', max: 256, path: 'username' },
  { key: 'uuid', kind: 'uuid', path: 'uuid' },
  { key: 'alterId', kind: 'int', min: 0, maxValue: 65535, path: 'alterId' },
  { key: 'vmessCipher', kind: 'enum', values: MANUAL_NODE_VMESS_CIPHERS, path: 'cipher', when: n => n.type === 'vmess' },
  {
    key: 'network', kind: 'enum', values: MANUAL_NODE_NETWORKS, path: 'network',
    when: n => Boolean(n.network) && n.network !== 'tcp',
  },
  { key: 'tls', kind: 'bool', path: 'tls', when: n => n.tls === true },
  {
    key: 'sni', kind: 'host', max: 253,
    path: n => (n.type === 'vmess' || n.type === 'vless' ? 'servername' : 'sni'),
    when: n => Boolean(n.sni),
  },
  { key: 'flow', kind: 'enum', values: ['xtls-rprx-vision'], path: 'flow', when: n => n.flow === 'xtls-rprx-vision' },
  {
    key: 'wsPath', kind: 'text', max: 256, path: 'ws-opts.path',
    when: n => n.network === 'ws', encode: value => value || '/',
  },
  {
    key: 'wsHost', kind: 'host', max: 253, path: 'ws-opts.headers.Host',
    when: n => n.network === 'ws' && Boolean(n.wsHost),
  },
  {
    key: 'grpcServiceName', kind: 'text', max: 64, path: 'grpc-opts.grpc-service-name',
    when: n => n.network === 'grpc' && Boolean(n.grpcServiceName),
  },
  {
    key: 'h2Host', kind: 'host', max: 253, path: 'h2-opts.host',
    when: n => n.network === 'h2' && Boolean(n.h2Host),
    encode: value => [value],
    decode: value => (Array.isArray(value) ? value[0] : value),
  },
  {
    key: 'h2Path', kind: 'text', max: 256, path: 'h2-opts.path',
    when: n => n.network === 'h2' && Boolean(n.h2Path),
  },
  {
    key: 'realityPublicKey', kind: 'text', max: 64, pattern: REALITY_KEY_RE,
    path: 'reality-opts.public-key', when: n => Boolean(n.realityPublicKey),
  },
  {
    key: 'realityShortId', kind: 'text', max: 16, pattern: SHORT_ID_RE,
    path: 'reality-opts.short-id', when: n => Boolean(n.realityPublicKey) && Boolean(n.realityShortId),
  },
  {
    key: 'alpn', kind: 'alpn', path: 'alpn',
    when: n => Array.isArray(n.alpn) && n.alpn.length > 0,
    encode: value => [...(value as string[])],
    decode: value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []),
  },
  {
    key: 'clientFingerprint', kind: 'enum', values: MANUAL_NODE_FINGERPRINTS,
    path: 'client-fingerprint', when: n => Boolean(n.clientFingerprint),
  },
  { key: 'skipCertVerify', kind: 'bool', path: 'skip-cert-verify', when: n => n.skipCertVerify === true },
  { key: 'udp', kind: 'bool', path: 'udp', when: n => n.udp === true },
  { key: 'tfo', kind: 'bool', path: 'tfo', when: n => n.tfo === true },
  {
    key: 'ipVersion', kind: 'enum', values: MANUAL_NODE_IP_VERSIONS,
    path: 'ip-version', when: n => Boolean(n.ipVersion),
  },
  { key: 'plugin', kind: 'enum', values: MANUAL_NODE_SS_PLUGINS, path: 'plugin', when: n => Boolean(n.plugin) },
  { key: 'pluginMode', kind: 'text', max: 32, path: 'plugin-opts.mode', when: n => Boolean(n.plugin) },
  { key: 'pluginHost', kind: 'host', max: 253, path: 'plugin-opts.host', when: n => Boolean(n.plugin) && Boolean(n.pluginHost) },
  { key: 'pluginPath', kind: 'text', max: 256, path: 'plugin-opts.path', when: n => Boolean(n.plugin) && Boolean(n.pluginPath) },
  { key: 'pluginTls', kind: 'bool', path: 'plugin-opts.tls', when: n => Boolean(n.plugin) && n.pluginTls === true },
  { key: 'obfs', kind: 'enum', values: MANUAL_NODE_OBFS_TYPES, path: 'obfs', when: n => Boolean(n.obfs) },
  {
    key: 'obfsPassword', kind: 'text', max: 256, path: 'obfs-password',
    when: n => n.obfs === 'salamander' && Boolean(n.obfsPassword),
  },
  { key: 'up', kind: 'text', max: 32, path: 'up', when: n => Boolean(n.up) },
  { key: 'down', kind: 'text', max: 32, path: 'down', when: n => Boolean(n.down) },
  { key: 'ports', kind: 'text', max: 64, path: 'ports', when: n => Boolean(n.ports) },
];

export const MANUAL_NODE_SPEC: Partial<Record<keyof MihomoManualNode, ManualNodeFieldSpec>> =
  Object.fromEntries(SPEC_LIST.map(spec => [spec.key, spec]));

const BASE = ['tls', 'skipCertVerify', 'udp', 'tfo', 'ipVersion'] as const;

/** Fields each protocol owns; this is also the form's field set. */
export const MANUAL_NODE_FIELDS: Record<ManualNodeProtocol, readonly (keyof MihomoManualNode)[]> = {
  ss: ['cipher', 'password', 'udp', 'tfo', 'plugin', 'pluginMode', 'pluginHost', 'pluginPath', 'pluginTls', 'ipVersion'],
  vmess: ['uuid', 'alterId', 'vmessCipher', 'network', 'wsPath', 'wsHost', 'grpcServiceName', 'h2Host', 'h2Path',
    'tls', 'sni', 'alpn', 'clientFingerprint', 'skipCertVerify', 'udp', 'tfo', 'ipVersion'],
  vless: ['uuid', 'flow', 'network', 'wsPath', 'wsHost', 'grpcServiceName', 'h2Host', 'h2Path',
    'tls', 'sni', 'realityPublicKey', 'realityShortId', 'alpn', 'clientFingerprint', 'skipCertVerify', 'udp', 'tfo', 'ipVersion'],
  trojan: ['password', 'network', 'wsPath', 'wsHost', 'grpcServiceName', 'h2Host', 'h2Path',
    'sni', 'alpn', 'clientFingerprint', 'skipCertVerify', 'udp', 'tfo', 'ipVersion'],
  hysteria2: ['password', 'sni', 'alpn', 'skipCertVerify', 'obfs', 'obfsPassword', 'up', 'down', 'ports', 'ipVersion'],
  http: [...BASE, 'username', 'password'],
  socks5: [...BASE, 'username', 'password'],
};

/** Credential fields a row cannot omit (validated after coercion). */
const REQUIRED: Partial<Record<ManualNodeProtocol, readonly (keyof MihomoManualNode)[]>> = {
  ss: ['cipher', 'password'],
  vmess: ['uuid'],
  vless: ['uuid'],
  trojan: ['password'],
  hysteria2: ['password'],
};

const MANUAL_NODE_TYPE_SET = new Set<string>(MANUAL_NODE_PROTOCOLS);

export function isManualNodeProtocol(type: string): type is ManualNodeProtocol {
  return MANUAL_NODE_TYPE_SET.has(type.trim().toLowerCase());
}

export function manualNodeFieldsFor(type: string): readonly (keyof MihomoManualNode)[] {
  return isManualNodeProtocol(type) ? MANUAL_NODE_FIELDS[type] : [];
}

/** Mapping keys the form owns, for the overlay's clear-a-field path. */
export const MANUAL_NODE_FORM_KEYS = [
  'name', 'type', 'server', 'port',
  'cipher', 'vmessCipher', 'password', 'username', 'uuid', 'alterId',
  'network', 'ws-opts', 'grpc-opts', 'h2-opts', 'tls', 'servername', 'sni', 'flow',
  'reality-opts', 'alpn', 'client-fingerprint', 'skip-cert-verify', 'udp', 'tfo', 'ip-version',
  'plugin', 'plugin-opts', 'obfs', 'obfs-password', 'up', 'down', 'ports',
] as const;

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || value.length > max) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
  return value;
}

function cleanHost(raw: unknown, max: number): string {
  const value = cleanText(raw, max);
  if (!value || /\s/.test(value) || value.includes('/')) return '';
  return value;
}

function coerce(spec: ManualNodeFieldSpec, raw: unknown): unknown {
  switch (spec.kind) {
    case 'bool':
      return raw === true;
    case 'int': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(value)) return undefined;
      if (spec.min !== undefined && value < spec.min) return undefined;
      if (spec.maxValue !== undefined && value > spec.maxValue) return undefined;
      return value;
    }
    case 'enum': {
      if (typeof raw !== 'string') return undefined;
      const value = raw.trim().toLowerCase();
      return spec.values?.includes(value) ? value : undefined;
    }
    case 'alpn': {
      if (!Array.isArray(raw)) return undefined;
      const list = raw
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim().toLowerCase())
        .filter(item => ALPN_RE.test(item))
        .slice(0, 8);
      return list.length ? list : undefined;
    }
    case 'uuid': {
      const value = typeof raw === 'string' ? raw.trim() : '';
      return UUID_RE.test(value) ? value.toLowerCase() : undefined;
    }
    case 'host':
      return cleanHost(raw, spec.max ?? 253) || undefined;
    case 'text':
      return cleanText(raw, spec.max ?? 256) || undefined;
    default:
      return undefined;
  }
}

/**
 * Coerce + validate one typed draft. Returns null when the row must be
 * rejected; `errorField` names the offending field for the API's 400.
 */
export function sanitizeTypedNode(
  rec: Record<string, unknown>,
  id: string,
): { node: MihomoManualNode | null; errorField?: string } {
  const name = cleanText(rec.name, 64);
  const type = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
  const server = cleanHost(rec.server, 253);
  const rawPort = typeof rec.port === 'number' ? rec.port : Number(rec.port);
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 0;
  if (!name) return { node: null, errorField: 'name' };
  if (!isManualNodeProtocol(type)) return { node: null, errorField: 'type' };
  if (!server) return { node: null, errorField: 'server' };
  if (!port) return { node: null, errorField: 'port' };

  const node: MihomoManualNode = { id, name, type, server, port };
  for (const key of MANUAL_NODE_FIELDS[type]) {
    const spec = MANUAL_NODE_SPEC[key];
    if (!spec) continue;
    const raw = rec[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = coerce(spec, raw);
    if (value === undefined) return { node: null, errorField: key };
    if (spec.pattern && !spec.pattern.test(String(value))) return { node: null, errorField: key };
    (node as unknown as Record<string, unknown>)[key] = value;
  }

  // Form defaults that the generated mapping expects as concrete values.
  if (type === 'vmess') {
    node.alterId = node.alterId ?? 0;
    node.vmessCipher = node.vmessCipher ?? 'auto';
  }
  if (type === 'vmess' || type === 'vless' || type === 'trojan') node.network = node.network ?? 'tcp';
  if (type === 'ss' || type === 'vmess' || type === 'vless' || type === 'http' || type === 'socks5') {
    node.tls = node.tls === true;
  }
  if (type === 'trojan' || type === 'hysteria2' || type === 'http' || type === 'socks5') {
    node.skipCertVerify = node.skipCertVerify === true;
  }
  node.udp = node.udp === true;
  node.tfo = node.tfo === true;
  // trojan is TLS-only; h2 is not a trojan transport in mihomo.
  if (type === 'trojan' && node.network === 'h2') return { node: null, errorField: 'network' };
  // Plugin option tuples: mode is protocol/plugin specific, a stray mode is
  // an operator error the console can name instead of silently dropping.
  if (type === 'ss' && node.plugin) {
    if (node.plugin === 'obfs') {
      if (node.pluginMode && !(MANUAL_NODE_OBFS_MODES as readonly string[]).includes(node.pluginMode)) return { node: null, errorField: 'pluginMode' };
      if (node.pluginTls) return { node: null, errorField: 'pluginTls' };
      if (node.pluginPath) return { node: null, errorField: 'pluginPath' };
    } else {
      if (node.pluginMode && node.pluginMode !== 'websocket') return { node: null, errorField: 'pluginMode' };
      if (node.pluginMode) node.pluginMode = 'websocket';
    }
  }
  if (type === 'hysteria2' && node.ports && !PORTS_RE.test(node.ports)) return { node: null, errorField: 'ports' };

  for (const key of REQUIRED[type] ?? []) {
    if (!node[key]) return { node: null, errorField: key };
  }
  if (type === 'vless') {
    if (node.realityShortId && !node.realityPublicKey) return { node: null, errorField: 'realityPublicKey' };
  }
  return { node };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function resolvePath(spec: ManualNodeFieldSpec, node: Pick<MihomoManualNode, 'type'>): string | undefined {
  return typeof spec.path === 'function' ? spec.path(node) : spec.path;
}

/** One typed row → the proxy keys the form owns. */
export function manualNodeMapping(node: MihomoManualNode): Record<string, unknown> {
  const mapping: Record<string, unknown> = {
    name: node.name, type: node.type, server: node.server, port: node.port,
  };
  for (const key of manualNodeFieldsFor(node.type)) {
    const spec = MANUAL_NODE_SPEC[key];
    if (!spec || !spec.path) continue;
    if (spec.when && !spec.when(node)) continue;
    const value = node[key];
    if (value === undefined || value === null || value === '') continue;
    const path = resolvePath(spec, node);
    if (!path) continue;
    setPath(mapping, path, spec.encode ? spec.encode(value) : value);
  }
  // vmess always carries an AEAD cipher and an alterId; older stored rows may
  // omit them and the core treats absent `cipher` as "not auto".
  if (node.type === 'vmess') {
    mapping.alterId = mapping.alterId ?? 0;
    mapping.cipher = mapping.cipher ?? 'auto';
  }
  return mapping;
}

/** A stored mapping → the form-owned fields. */
export function manualNodeFields(mapping: Record<string, unknown>): Partial<MihomoManualNode> {
  const type = typeof mapping.type === 'string' ? mapping.type.trim().toLowerCase() : '';
  const fields: Partial<MihomoManualNode> = {};
  for (const key of manualNodeFieldsFor(type)) {
    const spec = MANUAL_NODE_SPEC[key];
    if (!spec || !spec.path) continue;
    const path = resolvePath(spec, { type });
    if (!path) continue;
    const raw = getPath(mapping, path);
    if (raw === undefined || raw === null) {
      if (spec.kind === 'bool') (fields as Record<string, unknown>)[key] = false;
      continue;
    }
    const value = spec.decode ? spec.decode(raw) : raw;
    if (value === undefined) continue;
    if (spec.kind === 'bool') {
      (fields as Record<string, unknown>)[key] = value === true;
      continue;
    }
    if (spec.kind === 'int' || spec.kind === 'text' || spec.kind === 'host' || spec.kind === 'uuid') {
      (fields as Record<string, unknown>)[key] = String(value).trim();
      continue;
    }
    if (spec.kind === 'enum' || spec.kind === 'alpn') {
      (fields as Record<string, unknown>)[key] = value;
      continue;
    }
  }
  if (type === 'vmess' || type === 'vless' || type === 'trojan') fields.network = fields.network ?? 'tcp';
  if (type === 'vmess') {
    fields.vmessCipher = fields.vmessCipher ?? 'auto';
    fields.alterId = fields.alterId ?? 0;
  }
  return fields;
}

/**
 * Credential field a stored mapping is missing, or null when it is complete.
 *
 * A raw pasted mapping is validated by identity alone in the router, but the
 * core loads the WHOLE generated document: one `ss` without a cipher or a
 * `vmess` without a uuid makes mihomo reject the file, which takes every node
 * down. The typed path already enforces this through `REQUIRED`; the mapping
 * path projects the same fields here so both entry points agree. A protocol
 * outside the whitelist owns its own options, so it answers null (identity
 * only, exactly as the sanitizer promises).
 */
export function missingNodeCredential(mapping: Record<string, unknown>): string | null {
  const type = typeof mapping.type === 'string' ? mapping.type.trim().toLowerCase() : '';
  if (!isManualNodeProtocol(type)) return null;
  const fields = manualNodeFields(mapping) as Record<string, unknown>;
  for (const key of REQUIRED[type] ?? []) {
    if (!fields[key as string]) return key as string;
  }
  return null;
}

/** Protocol + enum catalogs, so the console never mirrors a whitelist. */
export function manualNodeCatalog() {
  return {
    protocols: [...MANUAL_NODE_PROTOCOLS],
    fields: Object.fromEntries(Object.entries(MANUAL_NODE_FIELDS)),
    enums: {
      ssCiphers: [...MANUAL_NODE_SS_CIPHERS],
      vmessCiphers: [...MANUAL_NODE_VMESS_CIPHERS],
      networks: [...MANUAL_NODE_NETWORKS],
      fingerprints: [...MANUAL_NODE_FINGERPRINTS],
      ssPlugins: [...MANUAL_NODE_SS_PLUGINS],
      obfsModes: [...MANUAL_NODE_OBFS_MODES],
      ipVersions: [...MANUAL_NODE_IP_VERSIONS],
      obfsTypes: [...MANUAL_NODE_OBFS_TYPES],
    },
  };
}
