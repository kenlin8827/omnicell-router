import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { modelRefBadge } from '../lib/modelRefBadge';
import { sortModelOptions } from '../lib/model-options';

import { FONT_MONO } from '../lib/fonts';

/** One slot/role the decider must fill — built by the caller from the page's
 *  CURRENT draft state (unsaved edits included; the drafts are the truth).
 *  May include the main/primary slot — the CALLER decides what an assignment
 *  for it means (profile mode never targets it, since a main slot link is
 *  illegal). */
export interface SmartAssignTarget {
  key: string;
  label?: string;
  role?: string;
  current?: string;
}

/** One legal assignment value. `note` (e.g. the model a profile slot resolves
 *  to) contextualizes the choice but only `id` is ever assigned back. */
export interface SmartAssignCandidate {
  id: string;
  note?: string;
}

interface SmartAssignDialogProps {
  clientName: string;
  targets: SmartAssignTarget[];
  /** Profile-mode candidates: the linked profile's slot keys (+ model note).
   *  Absent/falsy `profileMode` → candidates derive from `models` + filter. */
  candidates?: SmartAssignCandidate[];
  profileMode: boolean;
  models: { id: string; kind?: string; members?: number; wire?: string }[];
  /** Why the candidate list looks the way it does (key-permission scoping). */
  scopeHint?: string;
  onClose: () => void;
  /** Receives target-key → candidate-id; the caller writes its own draft state. */
  onApply: (assignments: Record<string, string>) => void;
}

/** localStorage key for the last-picked decider model. */
const DECIDER_MEMORY_KEY = 'ocr_smartAssign_decider';

/** First-visit decider. `plus` is the middle rung: strong enough to reason
 *  about role needs, cheap enough that a whole assignment pass is not a
 *  flagship-priced call. A remembered pick always wins; this is only the
 *  starting point (and the fallback when a remembered id is no longer
 *  pickable). */
const DEFAULT_DECIDER = 'plus';

/**
 * "Smart assign" dialog: pick a decider model (remembered across visits; with
 * no usable memory the caller's cascade supplies one) and let the backend run
 * ONE decider call over the frontend-supplied targets/candidates. What the
 * candidates ARE — and what an assignment means (a profile slot link vs a
 * direct model ref) — is decided by the caller from the page's current profile
 * selection. Nothing is persisted here.
 */
export const SmartAssignDialog: React.FC<SmartAssignDialogProps> = ({
  clientName,
  targets,
  candidates: profileCandidates,
  profileMode,
  models,
  scopeHint,
  onClose,
  onApply,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [decider, setDecider] = useState(() => localStorage.getItem(DECIDER_MEMORY_KEY) || DEFAULT_DECIDER);
  const [busy, setBusy] = useState(false);
  /** Candidate category filter (no-profile mode only): all | tier aliases | combos | concrete models. */
  const [filter, setFilter] = useState<'all' | 'tier' | 'combo' | 'model'>('all');

  /** Every pickable decider, ordered by the SHARED model-picker ordering
   *  (`sortModelOptions`: auto/tier aliases → combos → concrete models), so this
   *  picker lists models exactly like every other one in the console. Virtual
   *  picks are legal: the backend resolves them through the same cascade the
   *  /v1/systemone surface uses (ADR-0008) — a tier alias to its healthy
   *  decision-surface pool head, `auto` to `systemone.defaultModel`. `kind` must
   *  ride the option for that ordering to group them at all.
   *  Variant siblings are EXCLUDED: they mean "base model + a pinned effort",
   *  and the decision executor has no effort-override input — accepting one
   *  would silently run a different effort than the id promises. */
  const deciderOptions = useMemo(
    () =>
      sortModelOptions(
        models
          .filter(m => m.kind !== 'variant')
          .map(m => ({
          value: m.id,
          label: m.id,
          kind: m.kind,
          meta: m.kind === 'combo' && m.members !== undefined ? t('models.memberCount', { n: m.members }) : undefined,
          ...modelRefBadge(m.kind, t),
        }))
      ),
    [models, t]
  );

  /** Fill/repair the picker once the option list is known: a remembered id
   *  that is no longer pickable (deleted model, renamed id) falls back to
   *  `DEFAULT_DECIDER`, and only to empty when even that is unavailable — the
   *  picker must never show a value the gateway cannot route. A VALID draft is
   *  never touched. */
  useEffect(() => {
    if (deciderOptions.length === 0) return;
    if (decider && deciderOptions.some(o => o.value === decider)) return;
    const fallback = deciderOptions.some(o => o.value === DEFAULT_DECIDER) ? DEFAULT_DECIDER : '';
    if (fallback !== decider) setDecider(fallback);
  }, [deciderOptions, decider]);

  /** What the current pick actually resolves to — `lite` projects onto a pool
   *  head, `auto` onto `systemone.defaultModel`. Shown under the picker so a
   *  virtual choice is never blind about which model spends the call. Empty for
   *  an unresolvable name (the confirm call then reports the real error). */
  const [resolved, setResolved] = useState('');
  useEffect(() => {
    setResolved('');
    if (!decider) return;
    let alive = true;
    api
      .resolveDecider(decider)
      .then(r => {
        if (alive && r && r.resolved !== decider) setResolved(r.resolved);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [decider]);

  /** No-profile candidates: gateway ids filtered by category. `tier` = the
   *  bare tier aliases (auto excluded — it is the routing-default entry, not a
   *  tier; still available under 'all'); `model` = registered + variants.
   *  `systemone`-wire models are dropped everywhere: they answer ONLY the
   *  decision protocol, so assigning one to a chat/agent role would break that
   *  role (ADR-0008 — the chat pool never sees them). */
  const candidates: SmartAssignCandidate[] = useMemo(() => {
    if (profileMode) return profileCandidates || [];
    const filtered = models
      .filter(m => m.wire !== 'systemone')
      .filter(m =>
        filter === 'all'
          ? true
          : filter === 'tier'
            ? m.kind === 'tier'
            : filter === 'combo'
              ? m.kind === 'combo'
              : m.kind === 'model' || m.kind === 'variant'
      );
    return filtered.map(m => ({ id: m.id }));
  }, [profileMode, profileCandidates, models, filter]);

  const confirm = async () => {
    if (!decider || busy) return;
    setBusy(true);
    try {
      const res = await api.smartAssignClient(clientName, {
        deciderModel: decider,
        targets,
        candidates,
      });
      localStorage.setItem(DECIDER_MEMORY_KEY, decider);
      onApply(res.assignments || {});
      toast.success(t('clients.smartApplyDone'));
      onClose();
    } catch (err: any) {
      toast.error(t('clients.smartFailed') + ': ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const chipStyle: React.CSSProperties = {
    padding: '3px 10px',
    borderRadius: '999px',
    border: '1px solid var(--card-border)',
    fontSize: '11px',
    fontFamily: FONT_MONO,
  };

  return (
    <Dialog
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="var(--accent)" />
          {t('clients.smartTitle')}
        </span>
      }
      subtitle={t('clients.smartSubtitle', { n: targets.length })}
      width={620}
      onClose={busy ? () => {} : onClose}
      closeLabel={t('common.close')}
      footerRight={
        <>
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>
            <span>{t('common.cancel')}</span>
          </button>
          <button className="btn btn-primary btn-sm" onClick={confirm} disabled={busy || !decider}>
            {busy ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Sparkles size={12} />}
            <span>{t('clients.smartConfirm')}</span>
          </button>
        </>
      }
    >
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {busy && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              background: 'color-mix(in srgb, var(--card-bg) 85%, transparent)',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
          >
            <Loader2 size={24} style={{ animation: 'ocr-spin 0.8s linear infinite', color: 'var(--accent)' }} />
            <div style={{ fontSize: '13px', color: 'var(--text-main)', fontWeight: 600 }}>{t('clients.smartBusy')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('clients.smartBusyHint')}</div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 6 }}>{t('clients.smartDecider')}</div>
            <Combobox value={decider} onChange={setDecider} options={deciderOptions} placeholder={t('clients.smartDeciderPick')} panelMinWidth={360} disabled={busy} />
            {resolved && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, fontFamily: FONT_MONO }}>→ {resolved}</div>
            )}
          </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {t('clients.smartCandidates', { n: candidates.length })}
            </div>
            {!profileMode && (
              <div style={{ display: 'inline-flex', gap: 4 }}>
                {(['all', 'tier', 'combo', 'model'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: '11px', padding: '2px 8px', ...(filter === f ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}) }}
                    onClick={() => setFilter(f)}
                    disabled={busy}
                  >
                    <span>{t(`clients.smartFilter${f[0].toUpperCase()}${f.slice(1)}`)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {scopeHint && (
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 6 }}>{scopeHint}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 140, overflowY: 'auto' }}>
            {candidates.map(c => (
              <span key={c.id} style={chipStyle} title={c.note}>
                {c.id}
              </span>
            ))}
          </div>
        </div>

          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 6 }}>
              {t('clients.smartTargets', { n: targets.length })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
              {targets.map(tg => (
                <div key={tg.key} style={{ fontSize: '12px', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontFamily: FONT_MONO, color: 'var(--text-main)' }}>{tg.label || tg.key}</span>
                  {tg.current && <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>→ {tg.current}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
