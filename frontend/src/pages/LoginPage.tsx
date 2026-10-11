import React, { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

/**
 * Full-screen console login view. Rendered by the App-level gate when
 * GET /api/admin/auth/session reports webAuth active + unauthenticated.
 * The session itself is an HttpOnly cookie set by POST /api/admin/auth/login.
 */
export const LoginPage: React.FC<{ onSuccess: () => void }> = ({ onSuccess }) => {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.login(username.trim(), password);
      onSuccess();
    } catch (err: any) {
      // Backend API messages are English by convention — localize at the UI
      // layer by status code; fall back to the raw message for the unexpected.
      if (err?.status === 429) {
        const m = /Retry in (\d+)s/.exec(err?.message || '');
        setError(m ? t('authLogin.locked').replace('{n}', m[1]) : t('authLogin.failed'));
      } else if (err?.status === 401) {
        setError(t('authLogin.failed'));
      } else {
        setError(err?.message || t('authLogin.failed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        width: '100%', // body/#root are display:flex — without this the wrapper shrinks to content width and hugs left
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg, #0b0e14)',
        padding: '20px',
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="card"
        style={{ width: '360px', maxWidth: '100%', padding: '28px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShieldCheck size={22} color="var(--accent)" />
          <div>
            <div style={{ fontWeight: 700, fontSize: '16px' }}>{t('authLogin.title')}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('authLogin.subtitle')}</div>
          </div>
        </div>

        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
            {t('authLogin.username')}
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="input"
          />
        </div>

        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
            {t('authLogin.password')}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="input"
          />
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--accent-red, #ef4444)',
              fontSize: '12px',
            }}
          >
            {error}
          </div>
        )}

        <button className="btn btn-primary" type="submit" disabled={submitting || !username.trim() || !password}>
          <Lock size={14} />
          <span>{submitting ? t('authLogin.submitting') : t('authLogin.submit')}</span>
        </button>
      </form>
    </div>
  );
};
