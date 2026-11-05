import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, ExternalLink, Globe, KeyRound } from 'lucide-react';
import { Dialog } from './Dialog';
import { useI18n } from '../i18n/I18nContext';
import { opencodeApi } from '../lib/api';
import { FONT_MONO } from '../lib/fonts';

type Phase = 'starting' | 'waiting' | 'done' | 'failed';

/** Poll attempt cap: 150 × 2s = 5 minutes, same budget the old inline flow used. */
const POLL_MAX_ATTEMPTS = 150;
const POLL_INTERVAL_MS = 2000;

/**
 * Shared console web-authorization dialog (plugin device flow). Owns the
 * start → poll loop that used to live inline in KeysPage, and — because the
 * BACKEND polls the vendor with the session `state` itself — presents the
 * authorize URL as copyable text: the operator may open it on this machine
 * OR on any other, and the poll completes here either way. Plugins that
 * declare `webLogin.submit` additionally accept a manually pasted token.
 */
export const WebLoginDialog: React.FC<{
  providerId: string;
  providerName: string;
  submitSupported: boolean;
  /** Optional auth-method switch rendered above the flow (the caller's key/web
   *  tabs) — without it a web-first default would trap the user in this dialog. */
  switcher?: React.ReactNode;
  onClose: () => void;
  /** Fired once when the credential lands (poll or submit) — caller refreshes. */
  onConnected: () => void;
}> = ({ providerId, providerName, submitSupported, switcher, onClose, onConnected }) => {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('starting');
  const [authUrl, setAuthUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Guards the async poll against the unmount race: a late done after close
  // must not fire onConnected or flip state.
  const doneRef = useRef(false);
  // Interval handle lives in a ref so a manual submit can stop the poll loop.
  const pollTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { authUrl } = await opencodeApi.webLoginStart(providerId);
        if (cancelled) return;
        setAuthUrl(authUrl);
        setPhase('waiting');
      } catch (err) {
        if (cancelled) return;
        setPhase('failed');
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      let attempts = 0;
      timer = window.setInterval(async () => {
        pollTimerRef.current = timer;
        attempts += 1;
        try {
          const r = await opencodeApi.webLoginPoll(providerId);
          if (cancelled || doneRef.current) return;
          if (r.done || r.error) {
            doneRef.current = true;
            window.clearInterval(timer);
            if (r.done) {
              setPhase('done');
              onConnected();
            } else {
              setPhase('failed');
              setError(r.error ?? t('op.webLoginFailed'));
            }
          }
        } catch {
          // Transient poll failures ride until the attempt cap.
        }
        if (attempts >= POLL_MAX_ATTEMPTS && !cancelled && !doneRef.current) {
          window.clearInterval(timer);
          setPhase('failed');
          setError(t('op.webLoginFailed'));
        }
      }, POLL_INTERVAL_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const handleSubmit = async () => {
    // Guard BEFORE any state write: a double Enter must not re-enter while the
    // first submit is in flight.
    if (submitting) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const r = await opencodeApi.webLoginSubmit(providerId, trimmed);
      if (r.connected) {
        doneRef.current = true;
        if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
        setPhase('done');
        setCode('');
        onConnected();
      } else {
        setPhase('failed');
        setError(r.error ?? t('op.webLoginFailed'));
      }
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Globe size={15} />{t('op.webLoginTitle')}</span>}
      subtitle={providerName}
      onClose={onClose}
      closeLabel={t('common.close')}
      width={560}
    >
      {switcher}
      {/* The tip describes the WEB flow only — it belongs inside the flow
          body, below the method switcher, not in the dialog subtitle slot
          where it would read as describing both tabs. */}
      <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0 }}>{t('op.webLoginTip')}</p>
      {phase === 'starting' && <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0 }}>{t('op.webLoginStarting')}</p>}
      {phase !== 'starting' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, margin: '0 0 4px' }}>{t('op.webLoginAuthUrlLabel')}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <code
                style={{
                  flex: 1,
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  padding: '7px 9px',
                  border: '1px solid var(--card-border)',
                  borderRadius: 6,
                  wordBreak: 'break-all',
                  background: 'var(--chip-bg)',
                  userSelect: 'all',
                }}
              >
                {authUrl}
              </code>
              <button
                className="btn btn-sm"
                title={t('op.webLoginCopyUrl')}
                onClick={() => {
                  navigator.clipboard.writeText(authUrl);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <a className="btn btn-sm" href={authUrl} target="_blank" rel="noopener noreferrer" title={t('op.webLoginOpenBrowser')}>
                <ExternalLink size={12} />
                <span>{t('op.webLoginOpenBrowser')}</span>
              </a>
            </div>
          </div>

          {phase === 'waiting' && <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0 }}>{t('op.webLoginWaiting')}</p>}
          {phase === 'done' && <p style={{ color: 'var(--accent-emerald)', fontSize: 12, margin: 0 }}>{t('op.webLoginDone')}</p>}
          {phase === 'failed' && <p style={{ color: 'var(--accent-rose)', fontSize: 12, margin: 0 }}>{error || t('op.webLoginFailed')}</p>}

          {submitSupported && phase !== 'done' && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, margin: '0 0 4px' }}>{t('op.webLoginSubmitLabel')}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  style={{ fontSize: 12, flex: 1 }}
                  placeholder={t('op.webLoginSubmitPlaceholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                />
                <button className="btn btn-sm btn-primary" disabled={submitting || !code.trim()} onClick={handleSubmit}>
                  <KeyRound size={12} />
                  <span>{t('op.webLoginSubmitBtn')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
};
