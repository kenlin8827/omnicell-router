import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ShieldCheck, Save, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, MonitorCog, Undo2, Terminal, Copy, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { api, type GatewayStatusResponse, type SystemProxyStatus, type InterceptPosture, type RuleIngress, type ForwardProxyRule, type HostDecision, type RuleWarning, type CaMeta, type CaTrustResponse, type ClaimSource } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { InfoTip } from '../components/InfoTip';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { copyToClipboard } from '../lib/clipboard';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS, PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, PROXY_ACCESS_LOG_PERSIST_DAYS_MAX } from '../lib/defaults';

import { FONT_MONO } from '../lib/fonts';
import { FONT_MONO_COLOR, SEC_TITLE } from '../lib/pageStyle';
import { Dialog } from '../components/Dialog';
import { ScrollTable, type ScrollTableColumn } from '../components/ScrollTable';

/**
 * Proxy Access — the SETTINGS side of the inbound forward proxy (HTTP_PROXY /
 * HTTPS_PROXY server): everything here is configuration, and the traffic those
 * rules produce is observed on the sibling Traffic Log page (`/proxy-log`).
 *
 * Layout:
 *  Card 1 — configuration, ALWAYS visible (status chip + enable / port /
 *           bypass form; Export-CA + Save live in the header).
 *  Card 2 — the setup HELP rendered as a wizard: horizontal clickable stepper,
 *           click a step → its content panel shows; prev/next walk the flow.
 * The status chip polls /api/admin/status every 4s: running / failed /
 * enabled-pending-restart / disabled — a failed start stays visible (the
 * gateway itself never fails on it).
 */

interface ForwardProxyShape {
  enabled?: boolean;
  /** Strict mode: every connection needs a key, loopback included (hot-applies). */
  requireCredential?: boolean;
  port?: number;
  /** Listen address — boot-frozen like port (shape of the listening socket). */
  host?: string;
  /** MITM CA directory — boot-frozen (cert material). */
  caDir?: string;
  /** The rule table (ADR-0018) — one ordered list, first match wins; each row is
   *  `{ match, ingress, egress }`: what happens at ingress and where the bytes exit. */
  rules?: ForwardProxyRule[];
  /** Interception posture (ADR-0018 Revision 4): `claims` = decrypt only what a
   *  live gateway plugin claims (+ explicit intercept rows); `all` = every host
   *  is decrypted (audit mode). Hot-applies on save. */
  intercept?: InterceptPosture;
  /** Concurrent inbound socket cap (default 512). Raw-YAML page only. */
  maxConnections?: number;
  accessLog?: { enabled?: boolean; bodyBytes?: number; persist?: boolean; persistDays?: number };
}

const preStyle: React.CSSProperties = {
  margin: '6px 0 0 0',
  padding: '10px 12px',
  borderRadius: '8px',
  // Terminal well (--term-bg): one step deeper than the card in dark, a
  // clear paper tint in light — the background is what makes the block read
  // as a terminal pane instead of floating mono text.
  background: 'var(--term-bg)',
  border: '1px solid var(--card-border)',
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-normal)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--text-muted)',
};

/**
 * Copyable command well shared by EVERY command/snippet in the wizard.
 *
 * The visual baseline is the CA install row's original look: a terminal
 * well with bright (`--text-main`) command text and the copy glyph sitting
 * ON the command line as a flex sibling at the right edge. All other steps
 * — verify, env snippets, client routing — inherit that look, so no step
 * grows a second species of code block.
 *
 * `prompt` is the shell-glyph decoration (`$` / `PS>`): it marks the lines
 * that can be pasted at a terminal AS-IS, and it is DISPLAY-ONLY — the copy
 * payload is always the raw `text`, glyph never included. Comment (`#`) and
 * blank lines carry no glyph; blocks of plain config values (env settings
 * that are written into a profile, not typed) take no `prompt` at all —
 * the glyph means "this line runs". The toast is the feedback: the icon
 * alone cannot confirm a hit while the command is being pasted.
 *
 * `flush` removes the 6px stand-off when a parent row already owns the
 * spacing (TrustCmdRow), keeping the badge and the well on one top edge.
 */
const CodePre: React.FC<{ text: string; prompt?: string; flush?: boolean }> = ({ text, prompt, flush = false }) => {
  const { t } = useI18n();
  const toast = useToast();
  /** Promptable = a typed command: comments and blank separators are not. */
  const isCommand = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');
  return (
    <div
      style={{
        ...preStyle,
        margin: flush ? 0 : '6px 0 0 0',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        whiteSpace: 'normal',
      }}
    >
      <pre
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          fontFamily: FONT_MONO,
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-normal)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--text-main)',
        }}
      >
        {prompt
          ? text.split('\n').map((line, i) => (
              <React.Fragment key={i}>
                {i > 0 && '\n'}
                {isCommand(line) ? (
                  <>
                    <span style={{ color: 'var(--text-dim)' }}>{prompt} </span>
                    {line}
                  </>
                ) : (
                  line
                )}
              </React.Fragment>
            ))
          : text}
      </pre>
      <button
        type="button"
        className="btn btn-sm btn-icon"
        title={t('common.copy')}
        style={{ flexShrink: 0 }}
        onClick={() =>
          void copyToClipboard(text).then(ok =>
            ok ? toast.success(t('common.copied')) : toast.error(t('common.copyFailed')),
          )
        }
      >
        <Copy size={12} />
      </button>
    </div>
  );
};


/**
 * The rule table (ADR-0018) is ONE grid: the head row and every rule row are
 * cells of the same template, so a column label can never drift off the field
 * it names (the ingress control is pinned, the match input takes the slack, and
 * the egress / actions tracks size to their widest row).
 *
 * The ingress track is wide enough for the LONGEST ingress label in the shipped
 * locales (`Abfangen (entschlüsseln)`) — a narrower pin ellipsizes the half of
 * the label that carries the consequence (decrypt). Bump it with the labels.
 */
const RULE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr) 210px max-content max-content',
  columnGap: '6px',
  rowGap: '8px',
  alignItems: 'center',
};
/** Column label of that grid — dim, uppercase, never wrapping (it would re-flow the tracks). */
const RULE_HEAD: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  whiteSpace: 'nowrap',
};


/**
 * Inline advisory strip for the egress card (ADR-0018).
 * `warn` = the table cannot do what it says (no catch-all / proxy rules with the
 * outbound proxy off); `info` = the table is currently inert (listener off).
 *
 * `action` is the finding's own one-shot fix. It trails the sentence IN THE SAME
 * INLINE FLOW, so it sits at the end of the text when there is room and wraps
 * when there is not — the sentence always keeps the full width. Two layout
 * constraints hold this together:
 * - Never a flex row with the action as a sibling: the control becomes a column
 *   constraint, the prose wraps early into a narrow ragged block, and the button
 *   floats in the whitespace the wrap created.
 * - Whatever is passed must be TEXT-LEVEL (see `.btn-note`): the line box here is
 *   16.5px, so any inline box tall enough to look like a button grows the single
 *   line it sits on, and the paragraph reads as if a gap were punched into it.
 *   That is a layout constraint, not a style preference.
 */
const EgressNote: React.FC<{ tone: 'warn' | 'info'; text: string; action?: React.ReactNode }> = ({ tone, text, action }) => (
  <div
    style={{
      display: 'flex',
      gap: '8px',
      alignItems: 'flex-start',
      padding: '8px 10px',
      marginBottom: '10px',
      borderRadius: '8px',
      border: `1px solid ${tone === 'warn' ? 'rgba(248,113,113,0.45)' : 'var(--card-border)'}`,
      background: tone === 'warn' ? 'rgba(248,113,113,0.10)' : 'var(--well-bg)',
      color: tone === 'warn' ? '#f87171' : 'var(--text-dim)',
      fontSize: 'var(--text-xs)',
      lineHeight: 1.5,
    }}
  >
    {tone === 'warn' && <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
    <div style={{ minWidth: 0 }}>
      <span>{text}</span>
      {/* Plain inline wrapper: the action is text, so it must stay in the
          paragraph's flow (an inline-flex wrapper re-introduces a box with its
          own height, which is the gap this layout exists to avoid). */}
      {action && <span style={{ marginLeft: '8px' }}>{action}</span>}
    </div>
  </div>
);

/** Swap one rule with its neighbour. Order IS the semantics — this is the only
 *  way an operator can change which rule wins. */
function moveRule<T>(rules: T[], idx: number, delta: -1 | 1): T[] {
  const to = idx + delta;
  if (to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  [next[idx], next[to]] = [next[to], next[idx]];
  return next;
}

/** New rules land BEFORE the catch-all — appended after it they would never
 *  match, which reads as "the feature is broken" rather than "you put it in the
 *  wrong place". The value is inherited from the catch-all so the common case
 *  (add an exception to the default posture) needs no second click. */
function insertRule<T extends { match: string }>(rules: T[], make: (catchAll: T | undefined) => T): T[] {
  const catchAllAt = rules.findIndex(r => r.match.trim() === '*');
  const row = make(catchAllAt >= 0 ? rules[catchAllAt] : undefined);
  if (catchAllAt < 0) return [...rules, row];
  const next = [...rules];
  next.splice(catchAllAt, 0, row);
  return next;
}


const ENV_SNIPPETS = (server: string, caPath: string): Record<string, string> => ({
  PowerShell: `$env:HTTP_PROXY='${server}'\n$env:HTTPS_PROXY='${server}'\n$env:NO_PROXY='localhost,127.0.0.1'\n$env:NODE_EXTRA_CA_CERTS='${caPath}'`,
  cmd: `set HTTP_PROXY=${server}\r\nset HTTPS_PROXY=${server}\r\nset NO_PROXY=localhost,127.0.0.1\r\nset NODE_EXTRA_CA_CERTS=${caPath}`,
  sh: `export HTTP_PROXY=${server}\nexport HTTPS_PROXY=${server}\nexport NO_PROXY=localhost,127.0.0.1\nexport NODE_EXTRA_CA_CERTS='${caPath}'`,
});

/** One OS-tagged command row of the CA trust wizard (install AND uninstall).
 *  This component owns only the OS attribution (badge) and the prose around
 *  the command (hint). The command well is the wizard's SHARED `CodePre`,
 *  whose visual baseline is THIS row's original look: terminal well, bright
 *  command text, copy glyph on the command line. Install, uninstall, the env
 *  snippets and the verify step therefore all read as one surface — same
 *  prompt rules, same copy glyph, same toast. `flush` drops the standalone
 *  stand-off so the well lines up with the badge's top edge. */
const TrustCmdRow: React.FC<{ os: string; cmd: string; hint?: string }> = ({ os, cmd, hint }) => {
  const prompt = os === 'Windows' ? 'PS>' : '$';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
      <span
        className="badge"
        style={{
          flexShrink: 0, minWidth: '60px', justifyContent: 'center',
          textTransform: 'none', letterSpacing: 0, whiteSpace: 'nowrap',
          color: 'var(--text-muted)', border: '1px solid var(--card-border)',
        }}
      >
        {os}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, flex: 1 }}>
        <CodePre text={cmd} prompt={prompt} flush />
        {hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{hint}</div>}
      </div>
    </div>
  );
};

/** The verify snippet is platform-mixed: a blank line separates the
 *  macOS/Linux half from the Windows half, and each half opens with a `#`
 *  comment. That comment is a bare platform label on the first half (the
 *  badge owns that job now) and the --ssl-no-revoke rationale on the second,
 *  which becomes the row's prose hint. Only the command stays in the well —
 *  and therefore in the clipboard payload: a pasted `#` line is dead weight
 *  in a shell. All eight locales share this shape. */
const verifyRows = (snippet: string): { os: string; cmd: string; hint?: string }[] =>
  snippet.split('\n\n').map(seg => {
    const lines = seg.split('\n');
    const comment = lines.find(l => l.trimStart().startsWith('#'))?.replace(/^\s*#\s*/, '').trim() ?? '';
    const cmd = lines.filter(l => l.trim() !== '' && !l.trimStart().startsWith('#')).join('\n');
    return {
      os: comment.startsWith('Windows') ? 'Windows' : 'macOS / Linux',
      cmd,
      hint: comment && comment !== 'macOS / Linux' ? comment : undefined,
    };
  });

/**
 * OS system-proxy ownership card: snapshot → point the OS at the inbound
 * forward proxy → one-click restore. WinINET / networksetup / gsettings per
 * platform (backend forward-proxy/system-proxy.ts); unsupported platforms
 * render an explanatory note only. Env snippets stay clipboard-only.
 * Embedded form drops the outer card frame — it is one route of the wizard's
 * client-routing step, not a card nested inside another card. `readOnly` keeps
 * the restore half alive while the forward proxy is off: pointing the OS at a
 * port nobody listens on must never be one click away in that state.
 */
const SystemProxyCard: React.FC<{ embedded?: boolean; readOnly?: boolean }> = ({ embedded = false, readOnly = false }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [st, setSt] = useState<SystemProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [shell, setShell] = useState('PowerShell');
  const [showEnv, setShowEnv] = useState(true);

  const load = useCallback(() => {
    api.getSystemProxy().then(setSt).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);
  // First snapshot decides the env-snippet disclosure: whenever the OS switch
  // is NOT the active path (off / external / stale), the terminal snippets are
  // the primary access method — open them once; afterwards the user toggles.
  const envInitedRef = useRef(false);
  useEffect(() => {
    if (envInitedRef.current || !st?.supported) return;
    envInitedRef.current = true;
    setShowEnv(st.state !== 'on');
  }, [st]);

  const act = async (kind: 'enable' | 'disable') => {
    setBusy(true);
    try {
      setSt(kind === 'enable' ? await api.enableSystemProxy() : await api.disableSystemProxy());
    } catch (err: any) {
      toast.error((kind === 'enable' ? t('proxyLog.sysEnableBtn') : t('proxyLog.sysDisableBtn')) + ': ' + (err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const stateKey: Record<string, string> = {
    on: 'proxyLog.sysStateOn',
    off: 'proxyLog.sysStateOff',
    external: 'proxyLog.sysStateExternal',
    stale: 'proxyLog.sysStateStale',
    unsupported: 'proxyLog.sysStateUnsupported',
  };
  const stateColor = st?.state === 'on' ? 'var(--accent-emerald)' : st?.state === 'stale' || st?.state === 'external' ? 'var(--accent-amber)' : 'var(--text-dim)';

  return (
    <div className={embedded ? 'sub-card' : 'card'}>
      <div className="card-header">
        <div className="card-title">
          <MonitorCog size={18} color="var(--accent)" />
          <span>{t('proxyLog.sysTitle')}</span>
          {st && (
            <span className="badge" style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: stateColor, background: 'var(--chip-bg)' }}>
              {t(stateKey[st.state] || 'proxyLog.sysStateOff')}
            </span>
          )}
        </div>
        {st?.supported && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {st.state === 'stale' && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)', alignSelf: 'center' }}>{t('proxyLog.sysStaleHint')}</span>}
            {!readOnly && (
              <button className="btn btn-primary btn-sm" disabled={busy || st.state === 'on'} onClick={() => act('enable')}>
                <MonitorCog size={12} />
                <span>{t('proxyLog.sysEnableBtn')}</span>
              </button>
            )}
            <button className="btn btn-sm" disabled={busy || st.state === 'off'} onClick={() => act('disable')}>
              <Undo2 size={12} />
              <span>{st.state === 'stale' ? t('proxyLog.sysRestoreBtn') : t('proxyLog.sysDisableBtn')}</span>
            </button>
          </div>
        )}
      </div>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', padding: '0 14px 10px' }}>
        {t('proxyLog.sysHint')}
      </div>

      {st?.supported && st.override && (
        <div style={{ padding: '0 14px 10px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
          <span style={{ marginRight: '6px' }}>{t('proxyLog.sysOverrideLabel')}</span>
          <span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{st.override}</span>
        </div>
      )}

      {st?.supported ? (
        <div style={{ padding: '0 14px 14px' }}>
          <button className="btn btn-sm" onClick={() => setShowEnv(s => !s)}>
            <Terminal size={12} />
            <span>{t('proxyLog.sysEnvBtn')}</span>
          </button>
          {showEnv && (
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '720px' }}>
              <Combobox value={shell} onChange={setShell} options={['PowerShell', 'cmd', 'sh'].map(s => ({ value: s, label: s }))} style={{ width: '160px' }} />
              {/* The shell picker above owns the variant; the command well
                  owns the copy. Same shared surface as the rest of the
                  wizard, so this optional block is not a third code style. */}
              <CodePre flush text={ENV_SNIPPETS(st.targetServer || `http://127.0.0.1:${DEFAULT_FORWARD_PROXY_PORT}`, st.caPath)[shell]} />
            </div>
          )}
        </div>
      ) : (
        st && <div style={{ padding: '0 14px 14px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.sysUnsupportedNote')}</div>
      )}
    </div>
  );
};

const stepCircle = (active: boolean): React.CSSProperties => ({
  width: '24px',
  height: '24px',
  borderRadius: '50%',
  background: active ? 'var(--btn-primary-bg)' : 'var(--surface-hover)',
  color: active ? 'var(--btn-primary-text)' : 'var(--text-dim)',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-bold)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

export const ProxyAccessPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [fp, setFp] = useState<ForwardProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<GatewayStatusResponse | null>(null);
  /** This install's CA path — interpolated into the wizard snippets so every
   *  example shows the real file instead of a placeholder. */
  const [caMeta, setCaMeta] = useState<CaMeta | null>(null);
  /** A failed `/ca/meta` (older gateway, offline console) must not strand the
   *  wizard on "Loading…": fall back to the documented `<appData>` placeholder
   *  the help copy already uses, so every snippet still renders. */
  const [caMetaFailed, setCaMetaFailed] = useState(false);
  /** Platform trust of the CA — tri-state (`unknown` ≠ not trusted). Probed on
   *  mount and on demand, NEVER polled: the backend probe spawns OS tools. */
  const [caTrust, setCaTrust] = useState<CaTrustResponse | null>(null);
  const [caTrustBusy, setCaTrustBusy] = useState(false);
  /** CA details (fingerprint / validity) — expanded by default: the
   *  fingerprint is what the operator checks against the OS trust prompt at
   *  install time, so hiding it behind a fold costs the exact click the
   *  verification moment needs. */
  const [caDetailsOpen, setCaDetailsOpen] = useState(true);
  /** Trust-route sub-tab of the trust step (step 1): `shell` = trust-store
   *  install/uninstall commands (system CA store — the default, every
   *  browser/CLI/tool), `code` = env-var injection (Node / Python CLIs,
   *  process-level, never touches the system store). The two routes never
   *  mix: uninstall is a store operation, so it lives in `shell` only. */
  const [trustRoute, setTrustRoute] = useState<'shell' | 'code'>('shell');
  /** Uninstall commands are a rare, destructive follow-up — collapsed by
   *  default so the trust step stays install-only until asked. */
  const [removeOpen, setRemoveOpen] = useState(false);
  /** Deep link from the Clients proxy tab: `/proxy-access?view=wizard` opens
   *  the trust step directly, so the CA warning is one click from its fix.
   *  `view=sys` was the retired standalone tab — it now lands on the wizard's
   *  client-routing step with the OS route preselected. */
  const deepView = new URLSearchParams(window.location.search).get('view');
  /** `/proxy-access?view=log` was the log tab of this page before it moved to
   *  its own route; saved links must keep resolving, so they redirect. */
  if (deepView === 'log') return <Navigate to="/proxy-log" replace />;
  /** Current wizard step id */
  const [step, setStep] = useState(deepView === 'sys' ? '2' : '1');
  /** Client-routing sub-tab of wizard step 2: `env` = per-process proxy vars
   *  (the default path for CLI clients), `os` = machine-wide OS proxy (the
   *  optional route for clients that ignore env vars). */
  const [clientRoute, setClientRoute] = useState<'env' | 'os'>(deepView === 'sys' ? 'os' : 'env');
  /** Page view tab: access configuration / setup wizard. The OS system-proxy
   *  switch is one route inside the wizard, not a peer tab; the traffic log is
   *  its own page (`/proxy-log`), so this page only ever CONFIGURES. */
  const [view, setView] = useState<'config' | 'wizard'>(() =>
    deepView === 'wizard' || deepView === 'sys' ? 'wizard' : 'config',
  );
  /** OS-proxy recovery is a machine-level fault, so it has to be visible from
   *  the DEFAULT tab — the wizard's sub-route is three clicks away. Probed on
   *  mount and on every tab change, never on a 5s poll: the win32 probe spawns
   *  `reg`, and the wizard card polls on its own while it is mounted. */
  const [sysStatus, setSysStatus] = useState<SystemProxyStatus | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.getSystemProxy().then(s => { if (alive) setSysStatus(s); }).catch(() => {});
    return () => { alive = false; };
  }, [view]);
  const restoreOsProxy = async () => {
    setRestoring(true);
    try {
      setSysStatus(await api.disableSystemProxy());
    } catch (err: any) {
      toast.error(t('proxyLog.sysRestoreBarBtn') + ': ' + (err?.message || err));
    } finally {
      setRestoring(false);
    }
  };
  /** Config-tab fold state. Traffic logging is ON by default and writes
   *  request/response bodies to disk, so the group starts open — a default
   *  that carries a privacy cost must not sit behind a disclosure. */
  const [fold, setFold] = useState({ log: true });
  /** The rule table (ADR-0018). Order is the semantics — the ↑↓ buttons are the
   *  ONLY thing keeping it readable, not a convenience. */
  const [ruleRows, setRuleRows] = useState<ForwardProxyRule[]>([]);
  /** Lint + preview come from the backend resolvers (never a local re-implementation). */
  const [ruleWarnings, setRuleWarnings] = useState<RuleWarning[]>([]);
  const [probeHost, setProbeHost] = useState('');
  const [probeDecision, setProbeDecision] = useState<HostDecision | null>(null);
  /** Hosts a live client-gateway plugin claims — decrypted under the `claims`
   *  posture even when the table says `passthrough` (ADR-0018 Revision 4). */
  const [claimedHosts, setClaimedHosts] = useState<string[]>([]);
  /** The same claim set attributed per plugin — the "who decrypts what" dialog. */
  const [claimSources, setClaimSources] = useState<ClaimSource[]>([]);
  const [claimsOpen, setClaimsOpen] = useState(false);
  const [tightening, setTightening] = useState(false);

  /** The config AS LOADED — the diff baseline for boot-frozen fields. The live
   *  `fp` state already contains the operator's edits, so the restart-warning
   *  diff must run against this snapshot, never against `fp` itself. */
  const bootSnapshot = useRef<ForwardProxyShape>({});
  useEffect(() => {
    api.getConfig().then(cfg => {
      const fpCfg = ((cfg as any).forwardProxy as ForwardProxyShape) || {};
      bootSnapshot.current = fpCfg;
      setFp(fpCfg);
      setRuleRows(fpCfg.rules || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getProxyCaMeta()
      .then(m => {
        if (alive) setCaMeta(m);
      })
      .catch(() => {
        if (alive) setCaMetaFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** `force` bypasses the backend's 60s TTL — required after an install, or
   *  the re-check would replay the pre-install verdict. */
  const loadCaTrust = useCallback((force = false) => {
    setCaTrustBusy(true);
    api.getProxyCaTrust(force)
      .then(r => setCaTrust(r))
      .catch(() => setCaTrust(null))
      .finally(() => setCaTrustBusy(false));
  }, []);
  useEffect(() => {
    loadCaTrust();
  }, [loadCaTrust]);

  // Runtime status poll — the chip must reflect a FAILED start (the gateway
  // keeps serving; only the proxy is absent) as clearly as a running one.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getStatus()
        .then(s => { if (alive) setStatus(s); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Lint + probe — one debounced call to the backend resolver (the same
  // function the proxy legs call, so the preview cannot disagree with reality).
  useEffect(() => {
    const host = probeHost.trim();
    const timer = setTimeout(() => {
      api
        .resolveForwardProxyRules({ host: host || undefined, rules: ruleRows, intercept: fp?.intercept })
        .then(r => {
          setRuleWarnings(r.warnings);
          setProbeDecision(r.decision);
          setClaimedHosts(r.claimed ?? []);
          setClaimSources(r.claimSources ?? []);
        })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [probeHost, ruleRows, fp?.intercept]);

  /** One-click tighten (ADR-0018 Revision 4): rewrite the catch-all to a blind
   *  tunnel and pin the posture to `claims`. The backend performs the save (and
   *  the hot-apply); this only re-reads the result, so the table on screen is
   *  what the proxy now runs. */
  const handleTighten = async () => {
    setTightening(true);
    try {
      const r = await api.tightenForwardProxyRules();
      setRuleRows(r.rules);
      setRuleWarnings(r.warnings);
      setFp(prev => ({ ...(prev || {}), rules: r.rules, intercept: r.intercept }));
      bootSnapshot.current = { ...bootSnapshot.current, rules: r.rules, intercept: r.intercept };
      toast.success(t('forwardProxy.ruleTightenDone'));
    } catch (err: any) {
      toast.error(t('common.failed') + err.message);
    } finally {
      setTightening(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // This page writes the WHOLE forwardProxy section (the server
      // shallow-merges at the top level), so it re-reads the document first and
      // spreads the on-disk value UNDER its own keys. The guarantee is
      // top-level only: keys this page does not touch (`proxy`, `upstreamTls`,
      // …) survive a save here; a key this page holds but does not render is
      // replaced by its own state, which is why the render set must stay the
      // whole editable section.
      const fresh = await api.getConfig();
      const diskFp = (fresh.forwardProxy || {}) as Record<string, unknown>;
      const fpRest = { ...(diskFp || {}), ...(fp || {}) } as Record<string, unknown>;
      const next = {
        forwardProxy: {
          ...fpRest,
          // Blank rows never persist (an empty glob
          // would match nothing but still round-trip as noise); trimming matches
          // the backend normalizer, and rows already carry the full two-field
          // shape, so they persist as-is.
          rules: ruleRows
            .filter(r => r.match.trim())
            .map(r => ({ match: r.match.trim(), ingress: r.ingress, egress: r.egress })),
        },
      } as { forwardProxy: Record<string, unknown> };
      await api.saveConfig(next);
      // Only enabled / port / host / caDir shape the listening socket and CA
      // material — boot-frozen. Everything else on this page hot-applies
      // (rules re-read the runtime ref per request), so the restart warning
      // fires ONLY when a boot-frozen field actually changed.
      const boot = bootSnapshot.current;
      const saved = next.forwardProxy;
      const frozen = (v: unknown, fallback: unknown): unknown => (v === undefined || v === '' ? fallback : v);
      const bootFrozenChanged =
        frozen(boot.enabled, false) !== frozen(saved.enabled, false) ||
        frozen(boot.port, DEFAULT_FORWARD_PROXY_PORT) !== frozen(saved.port, DEFAULT_FORWARD_PROXY_PORT) ||
        frozen(boot.host, DEFAULT_FORWARD_PROXY_HOST) !== frozen(saved.host, DEFAULT_FORWARD_PROXY_HOST) ||
        frozen(boot.caDir, '') !== frozen(saved.caDir, '');
      if (bootFrozenChanged) toast.warning(t('forwardProxy.savedNotice'));
      else toast.success(t('forwardProxy.savedHotNotice'));
    } catch (err: any) {
      toast.error(t('common.failed') + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !fp) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }


  const port = fp.port || DEFAULT_FORWARD_PROXY_PORT;
  const ingressOptions: ComboboxOption[] = [
    // Full descriptions surface on OPTION HOVER via the app-wide [data-tip]
    // provider (the panel row carries them as `meta` — never rendered inline).
    { value: 'intercept', label: t('forwardProxy.ingressIntercept'), meta: t('forwardProxy.ruleDescIngressIntercept') },
    { value: 'passthrough', label: t('forwardProxy.ingressPassthrough'), meta: t('forwardProxy.ruleDescIngressPassthrough') },
    { value: 'reject', label: t('forwardProxy.ingressReject'), meta: t('forwardProxy.ruleDescIngressReject') },
  ];
  /** Translated label for a resolved exit (probe display) — RuleExit, not RuleIngress. */
  const exitLabel = (a: HostDecision['action']): string =>
    a === 'direct' ? t('forwardProxy.exitDirect')
      : a === 'proxy' ? t('forwardProxy.exitProxy')
        : t('forwardProxy.exitReject');
  /** The ingress half of a decision, in the SAME words as the row's dropdown —
   *  the probe must not invent a second name for what the operator just picked. */
  const ingressLabel = (tunnel: boolean): string =>
    tunnel ? t('forwardProxy.ingressPassthrough') : t('forwardProxy.ingressIntercept');
  /** Columns of the "decrypted without a rule" dialog: the host, and WHICH live
   *  plugin declares it (that attribution is the whole reason the list exists). */
  const claimColumns: ScrollTableColumn[] = [
    { key: 'host', label: t('forwardProxy.ruleClaimsColHost'), width: '64%' },
    { key: 'plugin', label: t('forwardProxy.ruleClaimsColPlugin') },
  ];
  /** Row-level lint sentence for EVERY code in the mirrored union. Banner-level
   *  codes return null (the note above the table already says it); the `never`
   *  assertion makes a new backend code a typecheck failure here rather than a
   *  silently wrong sentence. */
  const rowWarningText = (code: RuleWarning['code']): string | null => {
    switch (code) {
      case 'invalid-rule': return t('forwardProxy.ruleInvalid');
      case 'unreachable-rule': return t('forwardProxy.ruleUnreachable');
      case 'proxy-rule-without-proxy': return null;
      case 'no-catch-all': return null;
      // Table-level: the catch-all row reads as "decrypt everything" but the
      // claims posture makes it decrypt nothing unclaimed — banner above.
      case 'catch-all-intercepts': return null;
      default: {
        const unmapped: never = code;
        throw new Error(`unmapped rule warning: ${unmapped}`);
      }
    }
  };


  // ── status chip ──
  const fpStatus = status?.forwardProxy;
  let dotColor = 'var(--text-dim)';
  let statusText = t('forwardProxy.statusDisabled');
  if (fpStatus?.running) {
    dotColor = 'var(--accent-emerald)';
    statusText = t('forwardProxy.statusRunning', {
      host: fpStatus.host || DEFAULT_FORWARD_PROXY_HOST,
      port: String(fpStatus.port ?? port),
      time: fpStatus.startedAt ? new Date(fpStatus.startedAt).toLocaleTimeString() : '—',
    });
  } else if (fpStatus?.error) {
    dotColor = '#f87171';
    statusText = t('forwardProxy.statusError', { error: fpStatus.error });
  } else if (fpStatus?.enabled ?? (fp.enabled ?? false)) {
    dotColor = 'var(--accent-amber)';
    statusText = t('forwardProxy.statusRestartPending');
  }

  // ── help wizard steps (content only — configuration lives in the card above) ──
  // Wizard steps (display order — the i18n key numbers are historical: the old
  // "enable proxy" step was removed since enabling lives in the always-visible
  // config card above). Steps: 1 trust CA · 2 point clients · 3 verify.
  // System-store install snippets: one row per OS so the platform reads as a
  // tag and the command as code, instead of one pre-line text blob.
  const caPath = caMeta?.path ?? (caMetaFailed ? '<appData>/forward-proxy/ca.pem' : undefined);
  const sysInstallRows: { os: string; cmd: string; hint?: string }[] = caPath
    ? [
        { os: 'Windows', cmd: t('forwardProxy.sysInstallWinCmd', { caPath }), hint: t('forwardProxy.sysInstallWinHint', { caPath }) },
        { os: 'macOS', cmd: t('forwardProxy.sysInstallMacCmd', { caPath }) },
        { os: 'Linux', cmd: t('forwardProxy.sysInstallLinuxCmd', { caPath }) },
      ]
    : [];
  // Uninstall mirrors the install: same OS rows, the SAME subject/identity the
  // trust probe looks for. The commands are identity-based on purpose — they
  // also remove a stale same-CN root left by an older per-home CA.
  const sysRemoveRows: { os: string; cmd: string; hint?: string }[] = caPath
    ? [
        { os: 'Windows', cmd: t('forwardProxy.sysRemoveWinCmd'), hint: t('forwardProxy.sysRemoveWinHint') },
        { os: 'macOS', cmd: t('forwardProxy.sysRemoveMacCmd'), hint: t('forwardProxy.sysRemoveMacHint') },
        { os: 'Linux', cmd: t('forwardProxy.sysRemoveLinuxCmd') },
      ]
    : [];

  // ── CA trust chip (tri-state: `unknown` is NOT a failure) ──
  const caTrustLabel = caTrust?.trusted === true
    ? t('forwardProxy.caTrustTrusted')
    : caTrust?.trusted === false
      ? t('forwardProxy.caTrustNotTrusted')
      : t('forwardProxy.caTrustUnknown');
  const caTrustColor = caTrust?.trusted === true
    ? 'var(--accent-emerald)'
    : caTrust?.trusted === false
      ? '#f87171'
      : 'var(--text-dim)';
  // One row, rendered in the config card AND in the trust step: installing the
  // root is the page's first action and its first support question.
  const caTrustRow = caTrust ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
      <span
        className="badge"
        style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: caTrustColor, background: 'var(--chip-bg)' }}
      >
        {caTrustLabel}
      </span>
      <InfoTip text={t('forwardProxy.caTrustHint')} />
      <button className="btn btn-sm" style={{ gap: '6px' }} disabled={caTrustBusy} onClick={() => loadCaTrust(true)}>
        <RefreshCw size={12} style={caTrustBusy ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
        <span>{t('forwardProxy.caTrustRecheck')}</span>
      </button>
      {caTrust?.trusted === false && view !== 'wizard' && (
        <button
          className="btn btn-sm"
          style={{ gap: '6px' }}
          onClick={() => {
            setStep('1');
            setView('wizard');
          }}
        >
          <BookOpen size={12} />
          <span>{t('forwardProxy.caTrustOpenWizard')}</span>
        </button>
      )}
    </div>
  ) : null;

  /** A disabled forward proxy can leave the machine pointed at a dead port
   *  (`on`) or leave an un-restored snapshot (`stale`). Both are visible here
   *  with a direct restore, so recovery never depends on finding the wizard
   *  sub-route. `proxyEnabled` is the RUNTIME flag, not the form draft. */
  const sysRestoreRow = sysStatus && sysStatus.proxyEnabled === false && (sysStatus.state === 'on' || sysStatus.state === 'stale') ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
      <span className="badge" style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: 'var(--accent-amber)', background: 'var(--chip-bg)' }}>
        {t('proxyLog.sysRestoreBarTitle')}
      </span>
      <span style={{ color: 'var(--text-dim)' }}>{t('proxyLog.sysRestoreBarHint')}</span>
      <button className="btn btn-sm" style={{ gap: '6px' }} disabled={restoring} onClick={() => void restoreOsProxy()}>
        <Undo2 size={12} />
        <span>{t('proxyLog.sysRestoreBarBtn')}</span>
      </button>
    </div>
  ) : null;

  const steps: { id: string; title: string; body: React.ReactNode }[] = [
    {
      id: '1',
      title: t('forwardProxy.step2Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep2')}</div>
          {caTrustRow}
          {caPath ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {/* Trust-route sub-tab: shell (store install) vs code (env vars).
                  Two audiences, two routes — never one linear flow where the
                  code snippet reads as a mandatory step for everyone. */}
              <SegGroup
                size="sm"
                value={trustRoute}
                onChange={v => setTrustRoute(v as 'shell' | 'code')}
                options={[
                  { value: 'shell', label: t('forwardProxy.trustTabShell') },
                  { value: 'code', label: t('forwardProxy.trustTabCode') },
                ]}
              />
              {trustRoute === 'shell' ? (
                <>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('forwardProxy.sysInstallTitle')}</div>
                  {sysInstallRows.map(row => <TrustCmdRow key={row.os} {...row} />)}
                  <details
                    open={removeOpen}
                    onToggle={e => setRemoveOpen((e.target as HTMLDetailsElement).open)}
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}
                  >
                    <summary style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', listStyle: 'none' }}>
                      <ChevronDown
                        size={12}
                        style={{ flexShrink: 0, transform: removeOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                      />
                      <span>{t('forwardProxy.sysRemoveTitle')}</span>
                    </summary>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
                      {sysRemoveRows.map(row => <TrustCmdRow key={`remove-${row.os}`} {...row} />)}
                      <div style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{t('forwardProxy.sysRemoveNote')}</div>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('forwardProxy.trustTabCodeHint')}</div>
                  <CodePre text={t('forwardProxy.helpStep2Code', { caPath })} />
                </>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
          )}
          {/* Verification details live in the trust step only: the path is
              already in every command above, the fingerprint matters exactly
              when the user is checking the root they just installed. */}
          {caMeta && (
            <details
              open={caDetailsOpen}
              onToggle={e => setCaDetailsOpen((e.target as HTMLDetailsElement).open)}
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
            >
              <summary style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', listStyle: 'none' }}>
                <ChevronDown
                  size={12}
                  style={{ flexShrink: 0, transform: caDetailsOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                />
                <span>{t('forwardProxy.caCardDetails')}</span>
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                  <span style={{ minWidth: '96px' }}>{t('forwardProxy.caCardFingerprint')}</span>
                  <span style={{ fontFamily: FONT_MONO, color: 'var(--text-main)', wordBreak: 'break-all' }}>{caMeta.fingerprintSha256}</span>
                  <button
                    className="btn btn-sm btn-icon"
                    title={t('common.copy')}
                    style={{ flexShrink: 0 }}
                    onClick={() => void copyToClipboard(caMeta.fingerprintSha256).then(ok => { if (ok) toast.success(t('forwardProxy.caCardCopied')); })}
                  >
                    <Copy size={12} />
                  </button>
                </div>
                <div>{t('forwardProxy.caCardValidUntil', { date: new Date(caMeta.notAfter).toLocaleDateString() })}</div>
              </div>
            </details>
          )}
        </div>
      ),
    },
    {
      id: '2',
      title: t('forwardProxy.step3Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Two routes, same shape as the trust step's shell/code split.
              Per-process env vars are the default; taking ownership of the OS
              proxy is the optional machine-wide route for clients that do not
              read those vars. */}
          <SegGroup
            size="sm"
            value={clientRoute}
            onChange={v => setClientRoute(v as 'env' | 'os')}
            options={[
              { value: 'env', label: t('forwardProxy.clientTabEnv') },
              { value: 'os', label: t('forwardProxy.clientTabOs') },
            ]}
          />
          {clientRoute === 'env' ? (
            <>
              <div>{t('forwardProxy.helpStep3')}</div>
              <CodePre text={t('forwardProxy.helpStep3Code', { port })} />
              {/* Only while the credential requirement is on: the env vars above
                  alone leave Chromium-based clients stuck at the auth prompt. */}
              {fp.requireCredential === true && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                  {t('forwardProxy.helpStep3Auth')}
                </div>
              )}
            </>
          ) : (
            <SystemProxyCard embedded />
          )}
        </div>
      ),
    },
    {
      id: '3',
      title: t('forwardProxy.step4Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep4')}</div>
          {caPath ? (
            /* Same OS-tagged row shape as the CA trust step: badge, command
               well with its platform prompt, prose hint. The Windows hint
               keeps the --ssl-no-revoke rationale out of the clipboard. */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {verifyRows(t('forwardProxy.helpStep4Code', { port, caPath })).map(row => (
                <TrustCmdRow key={row.os} {...row} />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
          )}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('forwardProxy.helpNotes')}</div>
        </div>
      ),
    },
  ];
  const stepIndex = Math.max(0, steps.findIndex(s => s.id === step));
  const active = steps[stepIndex];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>
      {/* View tab bar — access configuration / setup wizard. The traffic log
          is its own page, reached from the nav or the settings page's log
          section, never a third tab here. */}
      <div style={{ flexShrink: 0 }}>
        <SegGroup
          value={view}
          onChange={v => setView(v as 'config' | 'wizard')}
          size="lg"
          options={[
            { value: 'config', label: t('proxyLog.tabConfig') },
            { value: 'wizard', label: t('forwardProxy.helpTitle') },
          ]}
        />
      </div>
      {view === 'config' ? (
      <>
      {/* One full-height card: the header row is a fixed flex-shrink:0 zone
          inside the card frame, only the body below scrolls — the border stays
          a complete rectangle instead of two stacked cards. */}
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
        <div className="card-header" style={{ flexShrink: 0, padding: '20px 20px 12px', marginBottom: 0, borderBottom: '1px solid var(--divider)' }}>
          <div className="card-title">
            <ShieldCheck size={18} color="var(--accent)" />
            <span>{t('forwardProxy.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <a className="btn" href="/api/admin/proxy/ca" download style={{ gap: '6px' }}>
              {t('forwardProxy.caBtn')}
            </a>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={14} />
              <span>{t('forwardProxy.saveBtn')}</span>
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 20px' }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '12px', whiteSpace: 'pre-line' }}>
          {t('forwardProxy.hint')}
        </div>

        {/* Live runtime status chip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: dotColor,
              boxShadow: dotColor !== 'var(--text-dim)' ? `0 0 8px ${dotColor}` : undefined,
              flexShrink: 0,
            }}
          />
          <span>{statusText}</span>
        </div>
        {caTrustRow && <div style={{ marginBottom: '16px' }}>{caTrustRow}</div>}
        {sysRestoreRow && <div style={{ marginBottom: '16px' }}>{sysRestoreRow}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' }}>
          {/* ── Section 1: listener & enable ── */}
          <div className="sub-card">
            <div style={SEC_TITLE}>{t('forwardProxy.secListener')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <label className={`toggle-row${fp.enabled ? ' on' : ''}`}>
                <span style={{ fontSize: 'var(--text-md)' }}>{t('forwardProxy.enable')}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
                  <span aria-hidden="true" className={`switch-state${fp.enabled ? ' on' : ''}`}>
                    {t(fp.enabled ? 'forwardProxy.stateOn' : 'forwardProxy.stateOff')}
                  </span>
                  <Switch checked={fp.enabled ?? false} onChange={v => setFp({ ...fp, enabled: v })} />
                </span>
              </label>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('forwardProxy.port')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_FORWARD_PROXY_PORT)}
                  value={fp.port ?? ''}
                  onChange={e => {
                    const digits = e.target.value.replace(/[^0-9]/g, '');
                    setFp({ ...fp, port: digits === '' ? undefined : parseInt(digits, 10) });
                  }}
                  className="input"
                />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('forwardProxy.maxConnections')}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS)}
                  value={fp.maxConnections ?? ''}
                  onChange={e => {
                    const digits = e.target.value.replace(/[^0-9]/g, '');
                    setFp({ ...fp, maxConnections: digits === '' ? undefined : parseInt(digits, 10) });
                  }}
                  className="input"
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
                  {t('forwardProxy.maxConnectionsHint')}
                </div>
              </div>
              <label className={`toggle-row${fp.requireCredential ? ' on' : ''}`} style={{ alignItems: 'flex-start' }}>
                <span style={{ display: 'block', paddingTop: '2px', fontSize: 'var(--text-md)' }}>
                  {t('forwardProxy.requireCredential')}
                  <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px', lineHeight: 'var(--leading-normal)' }}>
                    {t('forwardProxy.requireCredentialHint')}
                  </span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', paddingTop: '2px' }}>
                  <span aria-hidden="true" className={`switch-state${fp.requireCredential ? ' on' : ''}`}>
                    {t(fp.requireCredential ? 'forwardProxy.stateOn' : 'forwardProxy.stateOff')}
                  </span>
                  <Switch
                    checked={fp.requireCredential ?? false}
                    onChange={v => setFp({ ...fp, requireCredential: v })}
                  />
                </span>
              </label>
            </div>
          </div>

          {/* ── Section 2: the rule table (ADR-0018) — ordered, first match wins ── */}
          <div className="sub-card">
            <div style={SEC_TITLE}>{t('forwardProxy.ruleTable')}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '12px', lineHeight: 1.5 }}>
              {t('forwardProxy.ruleTableHint')}
            </div>
            {/* Interception posture (ADR-0018 Revision 4). Default `claims`:
                decrypt only what a live gateway plugin claims plus explicit
                intercept rows — everything else stays a blind tunnel. `all` is
                the audit posture and says so in red. */}
            <label style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', fontSize: 'var(--text-md)', cursor: 'pointer', marginBottom: '12px' }}>
              <span style={{ display: 'block' }}>
                {t('forwardProxy.interceptAll')}
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px', lineHeight: 'var(--leading-normal)' }}>
                  {t('forwardProxy.interceptAllHint', { claimed: String(claimedHosts.length) })}
                </span>
              </span>
              <Switch
                checked={fp.intercept === 'all'}
                onChange={v => setFp({ ...fp, intercept: v ? 'all' : 'claims' })}
              />
            </label>
            {fp.intercept === 'all' && (
              <EgressNote tone="warn" text={t('forwardProxy.interceptAllWarning')} />
            )}
            {claimedHosts.length > 0 && (
              <button
                className="btn btn-sm"
                style={{ marginBottom: '10px', gap: '6px' }}
                onClick={() => setClaimsOpen(true)}
              >
                <ShieldCheck size={13} />
                <span>{t('forwardProxy.ruleClaimsBtn', { n: String(claimedHosts.length) })}</span>
              </button>
            )}
            {fp.enabled !== true && <EgressNote tone="info" text={t('forwardProxy.ruleDormant')} />}
            {ruleWarnings.some(w => w.code === 'proxy-rule-without-proxy') && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleProxyOff')} />
            )}
            {status?.forwardProxy?.upstreamInsecure === true && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleUpstreamInsecure')} />
            )}
            {ruleWarnings.some(w => w.code === 'no-catch-all') && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleNoCatchAll')} />
            )}
            {/* The tighten action is a one-shot MIGRATION affordance, not a
                standing control: it lives inside the finding it clears and
                disappears with it (the `action` slot of EgressNote). A table
                that is already tight has nothing to tighten, so a permanently
                greyed button would only be noise — re-open the finding (put the
                catch-all back to `intercept`) to see it again. */}
            {ruleWarnings.some(w => w.code === 'catch-all-intercepts') && (
              <EgressNote
                tone="warn"
                text={t('forwardProxy.ruleCatchAllIntercepts')}
                action={
                  /* A sentence-level action, not a control box: anything tall enough
                     to be a button is taller than the note's 16.5px line box, so it
                     punches a gap into exactly one line of the paragraph. See
                     `.btn-note` in styles/index.css. */
                  <button className="btn-note" disabled={tightening} onClick={handleTighten}>
                    {t('forwardProxy.ruleTighten')}
                  </button>
                }
              />
            )}
            {ruleRows.length > 0 && (
              <div style={RULE_GRID}>
                <span style={{ ...RULE_HEAD, textAlign: 'right' }}>#</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColMatch')}</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColIngress')}</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColEgress')}</span>
                {/* Right-aligned like the button group under it, so the label sits over the
                    icons instead of floating at the group's left edge. */}
                <span style={{ ...RULE_HEAD, textAlign: 'right' }}>{t('forwardProxy.ruleColActions')}</span>
                {ruleRows.map((row, idx) => {
                  const rowWarnings = ruleWarnings.filter(w => w.ruleIndex === idx);
                  return (
                    <React.Fragment key={idx}>
                      <span style={{ ...FONT_MONO_COLOR, textAlign: 'right', color: 'var(--text-dim)', fontSize: 'var(--text-xs)' }}>
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        placeholder={t('forwardProxy.pattern')}
                        value={row.match}
                        onChange={e => {
                          const next = [...ruleRows];
                          next[idx] = { ...next[idx], match: e.target.value };
                          setRuleRows(next);
                        }}
                        className="input"
                        style={rowWarnings.some(w => w.code === 'invalid-rule') ? { borderColor: '#f87171' } : undefined}
                      />
                      <Combobox
                        value={row.ingress}
                        hideMetaInTrigger
                        hoverMetaOnly
                        onChange={v => {
                          const next = [...ruleRows];
                          // A reject row never sends bytes anywhere, so its
                          // egress is pinned to direct (the toggle greys out).
                          next[idx] = { ...next[idx], ingress: v as RuleIngress, egress: v === 'reject' ? 'direct' : next[idx].egress };
                          setRuleRows(next);
                        }}
                        options={ingressOptions}
                      />
                      <label
                        style={{
                          display: 'flex', gap: '4px', alignItems: 'center',
                          fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap',
                          cursor: row.ingress === 'reject' ? 'not-allowed' : 'pointer',
                          opacity: row.ingress === 'reject' ? 0.4 : 1,
                        }}
                        title={t('forwardProxy.ruleDescEgressProxy')}
                      >
                        <input
                          type="checkbox"
                          checked={row.egress === 'proxy'}
                          disabled={row.ingress === 'reject'}
                          onChange={e => {
                            const next = [...ruleRows];
                            next[idx] = { ...next[idx], egress: e.target.checked ? 'proxy' : 'direct' };
                            setRuleRows(next);
                          }}
                        />
                        {/* The toggle IS the row's egress field, so it reads in the
                            same two words the probe uses for an exit. */}
                        {row.egress === 'proxy' ? t('forwardProxy.exitProxy') : t('forwardProxy.exitDirect')}
                      </label>
                      <div style={{ display: 'flex', gap: '6px', justifySelf: 'end' }}>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          title={t('forwardProxy.ruleMoveUp')}
                          disabled={idx === 0}
                          onClick={() => setRuleRows(moveRule(ruleRows, idx, -1))}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          title={t('forwardProxy.ruleMoveDown')}
                          disabled={idx === ruleRows.length - 1}
                          onClick={() => setRuleRows(moveRule(ruleRows, idx, 1))}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          style={{ padding: '4px 8px' }}
                          onClick={() => setRuleRows(ruleRows.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {rowWarnings.map((w, wi) => {
                        const text = rowWarningText(w.code);
                        if (!text) return null;
                        return (
                          <div
                            key={wi}
                            style={{ gridColumn: '1 / -1', marginTop: '-4px', marginLeft: '24px', fontSize: 'var(--text-xs)', color: '#f87171', lineHeight: 1.5 }}
                          >
                            {text}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start', gap: '6px', marginTop: ruleRows.length > 0 ? '10px' : 0 }}
              onClick={() => setRuleRows(insertRule(ruleRows, (c) => ({ match: '', ingress: 'intercept', egress: c?.egress ?? 'direct' })))}
            >
              <Plus size={14} />
              <span>{t('forwardProxy.ruleAdd')}</span>
            </button>
            {/* Probe — an ordered table is only readable if you can ask it a
                question, and the answer must come from the SAME resolver the
                proxy legs call (the backend), never a local re-implementation. */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={t('forwardProxy.ruleProbe')}
                /* Placeholder doubles as the hint, so mirror it as the
                   accessible name — a placeholder stops being announced once
                   the operator types, and that is exactly when the field's
                   meaning matters most. */
                aria-label={t('forwardProxy.ruleProbe')}
                value={probeHost}
                onChange={e => setProbeHost(e.target.value)}
                className="input"
                style={{ maxWidth: '260px' }}
              />
              {probeDecision && (
                <span style={{ ...FONT_MONO_COLOR, fontSize: 'var(--text-xs)', color: probeDecision.action === 'reject' ? '#f87171' : 'var(--text-muted)' }}>
                  {probeDecision.reason === 'rule'
                    ? t('forwardProxy.ruleProbeRule', {
                        action: exitLabel(probeDecision.action),
                        mode: ingressLabel(probeDecision.tunnel),
                        index: String((probeDecision.ruleIndex ?? 0) + 1),
                        match: probeDecision.match ?? '',
                      })
                    : probeDecision.reason === 'claim'
                      ? t('forwardProxy.ruleProbeClaim', {
                          action: exitLabel(probeDecision.action),
                          mode: ingressLabel(probeDecision.tunnel),
                        })
                      : t(
                          probeDecision.reason === 'loopback' ? 'forwardProxy.ruleProbeLoopback' : 'forwardProxy.ruleProbeFallback',
                          { action: exitLabel(probeDecision.action), mode: ingressLabel(probeDecision.tunnel) },
                        )}
                </span>
              )}
            </div>
          </div>

          {/* ── Section 3: traffic log switches (hot-apply on save). The ROWS the
              log records are observed on the sibling Traffic Log page, so the
              header carries the way there — the switches alone would leave the
              operator looking for the table they just configured. ── */}
          <details
            className="sub-card"
            open={fold.log}
            onToggle={e => setFold(f => ({ ...f, log: (e.target as HTMLDetailsElement).open }))}
          >
            <summary style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ChevronDown
                size={14}
                color="var(--text-dim)"
                style={{ flexShrink: 0, transform: fold.log ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
              />
              <span style={{ ...SEC_TITLE, marginBottom: 0 }}>{t('forwardProxy.secLog')}</span>
              <Link
                to="/proxy-log"
                className="btn btn-sm"
                style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={e => e.stopPropagation()}
              >
                {t('proxyLog.openLog')}
              </Link>
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {t('proxyLog.switch')}
                    <InfoTip text={t('proxyLog.switchHint')} />
                  </span>
                  <Switch checked={fp.accessLog?.enabled ?? true} onChange={v => setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), enabled: v } })} />
                </label>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {t('proxyLog.persistSwitch')}
                    <InfoTip text={t('proxyLog.persistHint')} />
                  </span>
                  <Switch checked={fp.accessLog?.persist ?? true} onChange={v => setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), persist: v } })} />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('proxyLog.persistDays')}</span>
                  <input
                    type="number"
                    min={PROXY_ACCESS_LOG_PERSIST_DAYS_MIN}
                    max={PROXY_ACCESS_LOG_PERSIST_DAYS_MAX}
                    className="input"
                    style={{ width: '90px', fontSize: 'var(--text-sm)' }}
                    value={fp.accessLog?.persistDays ?? DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS}
                    onChange={e => {
                      const n = Math.min(PROXY_ACCESS_LOG_PERSIST_DAYS_MAX, Math.max(PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, Math.floor(Number(e.target.value) || DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS)));
                      setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), persistDays: n } });
                    }}
                  />
                </div>
              </div>
            </div>
          </details>

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            {t('forwardProxy.caHint')} · {t('forwardProxy.hostNote')}
          </div>
          </div>
        </div>
      </div>
      </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Setup wizard card (its own tab; the gap comes from the scroll
           region's flex column) */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <BookOpen size={18} color="var(--accent)" />
            <span>{t('forwardProxy.helpTitle')}</span>
          </div>
          {/* Step 1 tells the user to click "Export CA Certificate"; the
              wizard is its own tab, so the button must live here too. */}
          <a className="btn" href="/api/admin/proxy/ca" download>
            {t('forwardProxy.caBtn')}
          </a>
        </div>

        {!(fp.enabled ?? false) ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)', maxWidth: '640px' }}>
              {t('forwardProxy.wizardDisabledHint')}
            </div>
            {/* The wizard has no steps to show, but the OS-proxy snapshot may
                still outlive a disabled or crashed forward proxy. Only draw the
                restore panel when OCR actually owns (or owned) the OS proxy —
                a fresh install should not see an empty system-proxy card.
                Read-only so the OS cannot be pointed at a dead port. */}
            {(sysStatus?.state === 'on' || sysStatus?.state === 'stale') && <SystemProxyCard embedded readOnly />}
          </div>
        ) : (
          <>
          {/* Horizontal clickable stepper */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px', overflowX: 'auto', paddingBottom: '4px' }}>
          {steps.map((s, i) => {
            const isActive = s.id === active.id;
            return (
              <React.Fragment key={s.id}>
                {i > 0 && <div style={{ width: '56px', height: '1px', background: 'var(--card-border)', flexShrink: 0 }} />}
                <button
                  onClick={() => setStep(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 12px 6px 6px',
                    borderRadius: '999px',
                    cursor: 'pointer',
                    background: isActive ? 'var(--chip-bg)' : 'transparent',
                    border: isActive ? '1px solid var(--card-border)' : '1px solid transparent',
                    color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                    fontSize: 'var(--text-sm)',
                    fontWeight: isActive ? 'var(--font-semibold)' : 'var(--font-medium)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <span style={stepCircle(isActive)}>{s.id}</span>
                  <span>{s.title}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Step content panel */}
        <div style={{ minHeight: '140px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)', maxWidth: '760px' }}>
          {active.body}
        </div>

        {/* Wizard navigation */}
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: '20px', marginTop: '20px', paddingTop: '14px', borderTop: '1px solid var(--divider)' }}>
          <button
            className="btn btn-sm"
            disabled={stepIndex <= 0}
            onClick={() => setStep(steps[Math.max(0, stepIndex - 1)].id)}
            style={{ gap: '6px' }}
          >
            <ChevronLeft size={13} />
            <span>{t('forwardProxy.wizardPrev')}</span>
          </button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{stepIndex + 1} / {steps.length}</span>
          <button
            className="btn btn-sm"
            disabled={stepIndex >= steps.length - 1}
            onClick={() => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)].id)}
            style={{ gap: '6px' }}
          >
            <span>{t('forwardProxy.wizardNext')}</span>
            <ChevronRight size={13} />
          </button>
        </div>
          </>
        )}
      </div>
        </div>
      )}
      {/* Who gets decrypted without a rule: the live claim set, attributed per
          plugin. A table (not an inline sentence) because the operator's real
          answer is "which plugin drags THIS host into the pipeline". */}
      {claimsOpen && (
        <Dialog
          title={t('forwardProxy.ruleClaimsTitle')}
          subtitle={t('forwardProxy.ruleClaimsHint')}
          onClose={() => setClaimsOpen(false)}
          closeLabel={t('common.close')}
          width={580}
        >
          <ScrollTable columns={claimColumns} maxHeight={380} empty={t('forwardProxy.ruleClaimsEmpty')}>
            {claimSources.flatMap(src =>
              src.hosts.map(host => (
                <tr key={`${src.pluginId}:${host}`}>
                  <td style={{ padding: '8px 10px', fontFamily: FONT_MONO, fontSize: 'var(--text-sm)' }}>{host}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{src.pluginId}</td>
                </tr>
              )),
            )}
          </ScrollTable>
        </Dialog>
      )}
    </div>
  );
};