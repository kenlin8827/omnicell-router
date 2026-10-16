import React, { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Plus, Trash2, ArrowUp, ArrowDown, Pencil } from 'lucide-react';
import { api, type ModelProfileView } from '../lib/api';
import { modelRefBadge } from '../lib/modelRefBadge';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { Dialog } from '../components/Dialog';

/** Slot keys seeded for a brand-new profile — the common subagent role vocabulary. */
const DEFAULT_SLOT_KEYS = ['flash', 'pro', 'max', 'vision'];

interface SlotDraft {
  key: string;
  ref: string;
}

interface ProfileDraft {
  id: string;
  name: string;
  note: string;
  slots: SlotDraft[];
}

/** Config payload → editable draft (slot map keeps insertion order). */
const toDraft = (p: ModelProfileView): ProfileDraft => ({
  id: p.id,
  name: p.name || '',
  note: p.note || '',
  slots: Object.entries(p.slots || {}).map(([key, ref]) => ({ key, ref })),
});

/** Draft → config payload; blank slot rows are dropped. */
const toPayload = (d: ProfileDraft): ModelProfileView => ({
  id: d.id.trim(),
  ...(d.name.trim() ? { name: d.name.trim() } : {}),
  ...(d.note.trim() ? { note: d.note.trim() } : {}),
  slots: Object.fromEntries(d.slots.filter(s => s.key.trim() && s.ref.trim()).map(s => [s.key.trim(), s.ref.trim()])),
});

/** Draft-level validation ('' = valid). The id is auto-derived at save time
 *  (name → slug, fallback random), so users only ever type the display name. */
const validateDraft = (draft: ProfileDraft, all: ProfileDraft[], selfIndex: number): string => {
  const name = draft.name.trim();
  if (!name) return 'modelProfiles.warnEmptyName';
  if (all.some((p, i) => i !== selfIndex && p.name.trim() === name)) return 'modelProfiles.warnDupName';
  const id = draft.id.trim();
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._\-]*$/.test(id)) return 'modelProfiles.warnBadId';
  if (id && all.some((p, i) => i !== selfIndex && p.id.trim() === id)) return 'modelProfiles.warnDupId';
  if (draft.slots.length === 0) return 'modelProfiles.warnNoSlots';
  const seen = new Set<string>();
  for (const s of draft.slots) {
    if (!s.key.trim()) return 'modelProfiles.warnEmptySlot';
    if (seen.has(s.key.trim())) return 'modelProfiles.warnDupSlot';
    seen.add(s.key.trim());
    if (!s.ref.trim()) return 'modelProfiles.warnEmptyRef';
  }
  return '';
};

/** Derive the stable config key from the display name (ASCII slug), with a
 *  random fallback for non-latin names; never collides with `taken`. */
const deriveId = (name: string, taken: Set<string>): string => {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const stem = base || `profile-${Math.random().toString(36).slice(2, 8)}`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
};

/** Editor dialog for one profile — content only; the shared Dialog owns the shell. */
const ProfileDialog: React.FC<{
  draft: ProfileDraft;
  isNew: boolean;
  all: ProfileDraft[];
  selfIndex: number; // -1 for new
  refOptions: { value: string; label: string; meta?: string }[];
  onClose: () => void;
  onSave: (draft: ProfileDraft) => Promise<boolean>;
}> = ({ draft, isNew, all, selfIndex, refOptions, onClose, onSave }) => {
  const { t } = useI18n();
  const [work, setWork] = useState<ProfileDraft>(draft);
  const [saving, setSaving] = useState(false);

  const warn = validateDraft(work, all, selfIndex);
  const patch = (p: Partial<ProfileDraft>) => setWork(prev => ({ ...prev, ...p }));
  const patchSlot = (idx: number, p: Partial<SlotDraft>) =>
    setWork(prev => ({ ...prev, slots: prev.slots.map((s, i) => (i === idx ? { ...s, ...p } : s)) }));
  const moveSlot = (idx: number, dir: -1 | 1) =>
    setWork(prev => {
      const next = [...prev.slots];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return { ...prev, slots: next };
    });

  const save = async () => {
    if (warn) return;
    setSaving(true);
    const ok = await onSave(work);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      title={isNew ? t('modelProfiles.newProfile') : `${t('modelProfiles.edit')} · ${draft.name || draft.id || '…'}`}
      closeLabel={t('common.close')}
      width={720}
      onClose={onClose}
      footerRight={
        <>
          <button className="btn" onClick={onClose}>{t('modelProfiles.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={!!warn || saving}>{t('modelProfiles.saveBtn')}</button>
        </>
      }
    >
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>{t('modelProfiles.profileName')}</div>
        <input
          className="input"
          value={work.name}
          autoFocus={isNew}
          placeholder={t('modelProfiles.nameFieldPlaceholder')}
          onChange={e => patch({ name: e.target.value })}
          style={{ width: '100%' }}
        />
      </div>

      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>{t('modelProfiles.slots')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {work.slots.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input"
                value={s.key}
                placeholder={t('modelProfiles.slotKeyPlaceholder')}
                onChange={e => patchSlot(i, { key: e.target.value })}
                style={{ width: 160, flexShrink: 0, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}
              />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>→</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Combobox
                  value={s.ref}
                  onChange={v => patchSlot(i, { ref: v })}
                  options={refOptions}
                  placeholder={t('modelProfiles.slotRefPlaceholder')}
                  panelMinWidth={360}
                />
              </div>
              <button className="btn btn-sm" title={t('modelProfiles.moveUp')} onClick={() => moveSlot(i, -1)} disabled={i === 0}><ArrowUp size={12} /></button>
              <button className="btn btn-sm" title={t('modelProfiles.moveDown')} onClick={() => moveSlot(i, 1)} disabled={i === work.slots.length - 1}><ArrowDown size={12} /></button>
              <button
                className="btn btn-sm"
                title={t('modelProfiles.deleteSlot')}
                onClick={() => setWork(prev => ({ ...prev, slots: prev.slots.filter((_, j) => j !== i) }))}
                disabled={work.slots.length <= 1}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => setWork(prev => ({ ...prev, slots: [...prev.slots, { key: '', ref: '' }] }))}
        >
          <Plus size={12} />
          <span>{t('modelProfiles.addSlot')}</span>
        </button>
      </div>

      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>{t('modelProfiles.noteLabel')}</div>
        <input className="input" value={work.note} placeholder={t('modelProfiles.notePlaceholder')} onChange={e => patch({ note: e.target.value })} style={{ width: '100%' }} />
      </div>

      {warn && (
        <div style={{ fontSize: 12, color: 'var(--accent-amber)' }}>{t(warn)}</div>
      )}
    </Dialog>
  );
};

export const ModelProfilesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [profiles, setProfiles] = useState<ProfileDraft[] | null>(null);
  const [refOptions, setRefOptions] = useState<ComboboxOption[]>([]);
  const [editing, setEditing] = useState<{ draft: ProfileDraft; index: number } | null>(null); // index -1 = new
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.getModelProfiles(), api.listGatewayModels()])
      .then(([profileList, models]) => {
        setProfiles(profileList.map(toDraft));
        // Every gateway-addressable id is a legal slot ref: virtual auto* ids,
        // registered models, combos and variant exposures all come back here.
        // Profiles store the ref verbatim — provider connectivity is checked at
        // APPLY time (the console route refuses unresolvable refs cp-failfast).
        // The backend `kind` tags which namespace each id lives in; pickers
        // badge it (a prefix test on ids would misclassify autoglm-* etc.).
        setRefOptions(models.map(m => ({
          value: m.id,
          label: m.id,
          meta: m.owned_by || undefined,
          ...modelRefBadge(m.kind, t),
        })));
      })
      .catch(err => {
        console.error('Failed to load model profiles:', err);
        setProfiles([]);
      });
  }, [t]);

  /** Persist the whole profiles list (server merges the config section). */
  const persist = useCallback(
    async (next: ProfileDraft[]) => {
      setSaving(true);
      try {
        await api.saveModelProfiles(next.map(toPayload));
        toast.success(t('modelProfiles.savedNotice'));
        return true;
      } catch (err: any) {
        toast.error(t('common.failed') + err.message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [t, toast]
  );

  const handleSave = useCallback(
    async (draft: ProfileDraft): Promise<boolean> => {
      if (!profiles) return false;
      // The id is derived here (never typed): stable across renames of existing
      // entries, slug-from-name (or random) for new ones.
      const work = draft.id.trim()
        ? draft
        : { ...draft, id: deriveId(draft.name.trim(), new Set(profiles.map(p => p.id.trim()))) };
      const next = [...profiles];
      if (editing && editing.index >= 0) next[editing.index] = work;
      else next.push(work);
      setProfiles(next); // optimistic commit; revert on failure keeps the dialog state coherent
      const ok = await persist(next);
      if (!ok) setProfiles(profiles);
      return ok;
    },
    [editing, persist, profiles]
  );

  const handleDelete = useCallback(
    async (idx: number) => {
      if (!profiles) return;
      const target = profiles[idx];
      const ok = await confirmDialog({
        title: t('modelProfiles.deleteTitle'),
        description: target.name || target.id,
        danger: true,
      });
      if (!ok) return;
      const next = profiles.filter((_, i) => i !== idx);
      setProfiles(next);
      const saved = await persist(next);
      if (!saved) setProfiles(profiles);
    },
    [persist, profiles, t, confirmDialog]
  );

  if (profiles === null) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <ClipboardList size={18} color="var(--accent)" />
          <span>{t('modelProfiles.title')}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setEditing({
            draft: { id: '', name: '', note: '', slots: DEFAULT_SLOT_KEYS.map(k => ({ key: k, ref: '' })) },
            index: -1,
          })}
        >
          <Plus size={14} />
          <span>{t('modelProfiles.newProfile')}</span>
        </button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16, whiteSpace: 'pre-line' }}>
        {t('modelProfiles.hint')}
      </div>

      {profiles.length === 0 ? (
        <div style={{ padding: '30px 0', textAlign: 'left', color: 'var(--text-dim)', fontSize: 13 }}>{t('modelProfiles.empty')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {profiles.map((p, idx) => {
            const warnKey = validateDraft(p, profiles, idx);
            return (
              <div key={idx} style={{ background: 'var(--bg-elev)', border: '1px solid var(--card-border)', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }} title={p.name ? p.id : undefined}>{p.name || p.id}</div>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-sm" title={t('modelProfiles.edit')} onClick={() => setEditing({ draft: p, index: idx })}><Pencil size={12} /></button>
                  <button className="btn btn-sm btn-danger" title={t('modelProfiles.delete')} onClick={() => handleDelete(idx)} disabled={saving}><Trash2 size={12} /></button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {p.slots.map((s, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                      <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>{s.key}</span>
                      <span style={{ color: 'var(--text-dim)' }}>→</span>
                      <span style={{ color: 'var(--text-main)' }}>{s.ref}</span>
                    </div>
                  ))}
                </div>
                {p.note && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.note}</div>}
                {warnKey && <div style={{ fontSize: 11, color: 'var(--accent-amber)' }}>{t(warnKey)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ProfileDialog
          draft={editing.draft}
          isNew={editing.index < 0}
          all={profiles}
          selfIndex={editing.index}
          refOptions={refOptions}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
};
