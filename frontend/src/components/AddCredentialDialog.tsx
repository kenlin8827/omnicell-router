import React, { useMemo, useState } from 'react';
import { Check, Globe, Key } from 'lucide-react';
import { Dialog } from './Dialog';
import { useI18n } from '../i18n/I18nContext';
import { opencodeApi, type PluginAuthType } from '../lib/api';
import { WebLoginDialog } from './WebLoginDialog';

type SavedResponse = Awaited<ReturnType<typeof opencodeApi.connectProvider>>;

/** Unified "add credential" entry point for every provider card (connected
 *  quick-add and catalog connect share it). The key form always renders; a
 *  plugin that declares console web-authorization additionally gets a method
 *  switch that hands over to the shared device-flow dialog. A plugin-declared
 *  authTypes array overrides both the tab ORDER and the default selection
 *  (first entry). Hosting this in ONE dialog keeps every future auth method a
 *  single-place change. */
export const AddCredentialDialog: React.FC<{
  providerId: string;
  providerName: string;
  /** Console web-login (plugin device flow) available alongside the key form. */
  webLogin?: boolean;
  webLoginSubmit?: boolean;
  /** Plugin-declared credential methods in display order (first = default). */
  authTypes?: PluginAuthType[];
  /** Plugin-provided, already-localized how-to hint for the key form
   *  ("where to get this key" / fallback-tab explanation). Optional. */
  keyHint?: string;
  /** Multi-credential store: the key lands as a NEW credential; single-key store: replaces. */
  multiCredential: boolean;
  /** Error surface: map a failed connect rejection to a localized message.
   *  Defaults to the raw message — pass the caller's reasonCode mapper. */
  formatError?: (err: unknown) => string;
  onClose: () => void;
  /** Key saved — the caller announces (added/updated/head-preserved) and refreshes. */
  onSaved: (res: SavedResponse) => void;
  /** Web-login flow finished — the caller refreshes. */
  onConnected: () => void;
}> = ({ providerId, providerName, webLogin, webLoginSubmit, authTypes, keyHint, multiCredential, formatError, onClose, onSaved, onConnected }) => {
  const { t } = useI18n();
  // Ordered method list: plugin-declared authTypes wins (unknown entries and
  // unavailable ones filtered out); legacy fallback is key-first with the web
  // tab after it. The default selection is always the FIRST entry.
  const methods = useMemo<('key' | 'web')[]>(() => {
    if (authTypes) {
      return authTypes
        .map((m) => (m === 'webLogin' ? 'web' : m) as 'key' | 'web')
        .filter((m) => m === 'key' || webLogin);
    }
    return webLogin ? ['key', 'web'] : ['key'];
  }, [authTypes, webLogin]);
  const [method, setMethod] = useState<'key' | 'web'>(() => (methods[0] === 'web' ? 'web' : 'key'));

  // Segmented method switch: same pill chrome as the catalog filter. Shared
  // by BOTH surfaces — the key form AND the web-login dialog render it, or a
  // web-first default would trap the user in the device-flow dialog.
  const renderMethodSwitch = () =>
    methods.length > 1 ? (
      <div style={{ display: 'inline-flex', border: '1px solid var(--card-border)', borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' }}>
        {methods.map((m, i) => (
          <button
            key={m}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: method === m ? 700 : 500,
              color: method === m ? 'var(--accent)' : 'var(--text-dim)',
              background: method === m ? 'var(--surface-hover)' : 'transparent',
              border: 'none',
              borderRight: i < methods.length - 1 ? '1px solid var(--card-border)' : 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            onClick={() => setMethod(m)}
          >
            {m === 'key' ? <Key size={12} /> : <Globe size={12} />}
            <span>{m === 'key' ? t('op.connectMethodKey') : t('op.webLoginBtn')}</span>
          </button>
        ))}
      </div>
    ) : null;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Method switch to web login: hand the surface over to the dedicated
  // device-flow dialog (its own Dialog chrome — no nested-dialog tricks).
  if (method === 'web') {
    return (
      <WebLoginDialog
        providerId={providerId}
        providerName={providerName}
        submitSupported={Boolean(webLoginSubmit)}
        switcher={renderMethodSwitch()}
        onClose={onClose}
        onConnected={onConnected}
      />
    );
  }

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await opencodeApi.connectProvider(providerId, trimmed));
    } catch (err) {
      setError(formatError ? formatError(err) : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t(multiCredential ? 'op.addKeyCredential' : 'op.updateKey')}
      subtitle={providerName}
      onClose={onClose}
      closeLabel={t('common.cancel')}
      width={480}
      footerRight={
        <button className="btn btn-sm btn-primary" disabled={busy || !key.trim()} onClick={save}>
          <Check size={12} />
          <span>{t(multiCredential ? 'op.addKeyCredential' : 'op.updateKey')}</span>
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {renderMethodSwitch()}
        {/* Plugin knowledge: where this key comes from, or why the key tab is
            a fallback (workbuddy: web-login is the primary path). Content is
            plugin-provided and localized server-side, like the preset name. */}
        {keyHint && (
          <p style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: 0, fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            <Key size={12} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
            <span>{keyHint}</span>
          </p>
        )}
        <input
          className="input"
          style={{ fontSize: 12.5 }}
          placeholder={t(multiCredential ? 'op.addKeyPrompt' : 'op.updateKeyPrompt')}
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(''); }}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        {error && <p style={{ color: 'var(--accent-rose)', fontSize: 11.5, margin: 0 }}>{error}</p>}
      </div>
    </Dialog>
  );
};
