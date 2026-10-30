import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { Dialog } from './Dialog';
import { api, type HarnessCatalogSource } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

/**
 * Per-harness plugin-market source maintenance dialog (ADR-0015 §D10/§D11): the operator git
 * sources (index tier) of the catalog that THIS harness's market tab serves, with
 * check-before-add and remove. The underlying store is GLOBAL (one marketplaces.json, mp- ids
 * shared) — a mutation here re-harvests every served harness's index, so the dialog states the
 * sharing rather than implying ownership. Built-in federated sources (pi-dev) render read-only:
 * they are not maintainable.
 */
export const HarnessSourcesDialog: React.FC<{
  harness: string;
  open: boolean;
  onClose: () => void;
}> = ({ harness, open, onClose }) => {
  const { t } = useI18n();
  const [sources, setSources] = useState<HarnessCatalogSource[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'check' | 'add' | null>(null);
  const [note, setNote] = useState('');

  const scope = harness || 'universal';

  const load = useCallback(async () => {
    if (!open) return;
    try {
      const res = await api.harnessPluginSources(scope);
      setSources(res.sources ?? []);
    } catch {
      setSources([]);
    }
  }, [scope, open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const operator = sources.filter((s) => s.id.startsWith('mp-'));
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
      width={560}
    >
      {operator.length === 0 && builtin.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('harness.srcMgmt.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {builtin.map((s) => (
            <span key={s.id} className="chip" style={{ cursor: 'default' }} title={t('harness.srcMgmt.builtin')}>
              {s.label}
            </span>
          ))}
          {operator.map((s) => (
            <span key={s.id} className="chip" style={{ cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {s.label}
              <button
                type="button"
                aria-label={t('harness.srcMgmt.remove')}
                title={t('harness.srcMgmt.remove')}
                onClick={() => void remove(s.id.slice(3))}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-dim)', cursor: 'pointer', display: 'inline-flex' }}
              >
                <Trash2 size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
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
