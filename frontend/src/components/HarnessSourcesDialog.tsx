import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, RefreshCw } from 'lucide-react';
import { Dialog } from './Dialog';
import { Switch } from './Switch';
import { api, type HarnessCatalogSource, type HarnessMarketplaceEntry } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

/**
 * Per-harness plugin-market source maintenance dialog (ADR-0015 §D9/§D10/§D11): full CRUD over
 * the operator git sources — add (probe-first), edit in place (enable/disable + the rescan
 * schedule), manual rescan with a reported diff, remove. The underlying store is GLOBAL (one
 * marketplaces.json, mp- ids shared) — a mutation here re-harvests every served harness's index,
 * so the dialog states the sharing rather than implying ownership. Built-in federated sources
 * render read-only: they are not maintainable.
 */
export const HarnessSourcesDialog: React.FC<{
  harness: string;
  /** The open tab's kind — the dialog lists only sources that serve it (§D11 kind isolation). */
  kind: 'skill' | 'plugin';
  open: boolean;
  onClose: () => void;
}> = ({ harness, kind, open, onClose }) => {
  const { t } = useI18n();
  const [sources, setSources] = useState<HarnessCatalogSource[]>([]);
  const [entries, setEntries] = useState<HarnessMarketplaceEntry[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const scope = harness || 'universal';

  const load = useCallback(async () => {
    if (!open) return;
    try {
      const res = await api.harnessPluginSources(scope, kind);
      setSources(res.sources ?? []);
      setEntries(res.operator ?? []);
    } catch {
      setSources([]);
      setEntries([]);
    }
  }, [scope, kind, open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const builtin = sources.filter((s) => !s.id.startsWith('mp-'));

  const check = async () => {
    if (!url.trim()) return;
    setBusy('check');
    setNote('');
    try {
      const res = await api.harnessPluginCheckSource(scope, url.trim());
      setNote(res.ok ? t('harness.srcMgmt.checkOk').replace('{skills}', String(res.skills)).replace('{mcps}', String(res.mcps)).replace('{plugins}', String(res.plugins)) : res.message ?? t('harness.srcMgmt.fail'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!url.trim()) return;
    setBusy('add');
    setNote('');
    try {
      const res = await api.harnessPluginRegisterSource(scope, url.trim());
      setNote(res.message ?? t('harness.srcMgmt.addOk'));
      setUrl('');
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (slug: string, enabled: boolean) => {
    setNote('');
    try {
      await api.harnessPluginUpdateSource(scope, slug, { enabled });
      setNote(t('harness.srcMgmt.updated').replace('{slug}', slug));
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  const setRescan = async (slug: string, enabled: boolean, intervalMs: number) => {
    setNote('');
    try {
      await api.harnessPluginUpdateSource(scope, slug, { rescan: { enabled, intervalMs } });
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  const rescan = async (slug: string) => {
    setBusy(`rescan:${slug}`);
    setNote('');
    try {
      const res = await api.harnessPluginRescanSource(scope, slug);
      const diff = res.diff;
      setNote(
        diff
          ? t('harness.srcMgmt.rescanDiff').replace('{added}', String(diff.added.length)).replace('{removed}', String(diff.removed.length)).replace('{rows}', String(res.rows))
          : t('harness.srcMgmt.rescanOk').replace('{rows}', String(res.rows)),
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (slug: string) => {
    try {
      await api.harnessPluginRemoveSource(scope, slug);
      await load();
      setNote(t('harness.srcMgmt.removed').replace('{slug}', slug));
    } catch (e) {
      setNote(e instanceof Error ? e.message : t('harness.srcMgmt.fail'));
    }
  };

  if (!open) return null;

  return (
    <Dialog
      title={t('harness.srcMgmt.title')}
      subtitle={t('harness.srcMgmt.shared')}
      onClose={onClose}
      closeLabel={t('harness.srcMgmt.close')}
      width={620}
    >
      {entries.length === 0 && builtin.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('harness.srcMgmt.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {builtin.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="chip" style={{ cursor: 'default' }} title={t('harness.srcMgmt.builtin')}>
                {s.label}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('harness.srcMgmt.builtin')}</span>
            </div>
          ))}
          {entries.map((e) => (
            <div
              key={e.slug}
              style={{
                border: '1px solid var(--divider)',
                borderRadius: 6,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                opacity: e.enabled ? undefined : 0.55,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="chip" style={{ cursor: 'default', fontFamily: 'var(--mono, monospace)' }}>{e.repo}</span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>mp-{e.slug}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Switch size="sm" checked={e.enabled} ariaLabel={t('harness.srcMgmt.enabled')} onChange={(v) => void toggle(e.slug, v)} />
                  <button
                    type="button"
                    className="btn btn-sm"
                    title={t('harness.srcMgmt.rescanNow')}
                    disabled={busy !== null}
                    onClick={() => void rescan(e.slug)}
                  >
                    {busy === `rescan:${e.slug}` ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                  </button>
                  <button
                    type="button"
                    aria-label={t('harness.srcMgmt.remove')}
                    title={t('harness.srcMgmt.remove')}
                    onClick={() => void remove(e.slug)}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-dim)', cursor: 'pointer', display: 'inline-flex' }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ color: 'var(--text-dim)' }}>{t('harness.srcMgmt.rescanEnabled')}</span>
                <Switch size="sm" checked={e.rescan.enabled} ariaLabel={t('harness.srcMgmt.rescanEnabled')} onChange={(v) => void setRescan(e.slug, v, e.rescan.intervalMs)} />
                <input
                  className="input"
                  type="number"
                  min={1}
                  style={{ width: 72, height: 22, fontSize: 11 }}
                  aria-label={t('harness.srcMgmt.intervalMin')}
                  value={Math.round(e.rescan.intervalMs / 60000)}
                  onChange={(ev) => {
                    const minutes = Math.max(Number(ev.target.value) || 0, 1);
                    void setRescan(e.slug, e.rescan.enabled, minutes * 60000);
                  }}
                />
                <span style={{ color: 'var(--text-dim)' }}>{t('harness.srcMgmt.intervalMin')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderTop: '1px solid var(--divider)', paddingTop: 10 }}>
        <input
          className="input"
          style={{ flex: '1 1 240px', fontSize: 12, height: 28 }}
          placeholder={t('harness.srcMgmt.placeholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
          }}
        />
        <button type="button" className="btn btn-sm" disabled={!url.trim() || busy !== null} onClick={() => void check()}>
          {busy === 'check' ? <Loader2 size={12} className="spin" /> : null}
          {t('harness.srcMgmt.check')}
        </button>
        <button type="button" className="btn btn-sm" disabled={!url.trim() || busy !== null} onClick={() => void add()}>
          {busy === 'add' ? <Loader2 size={12} className="spin" /> : <Plus size={12} />}
          {t('harness.srcMgmt.add')}
        </button>
      </div>
      {note && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{note}</div>
      )}
    </Dialog>
  );
};
