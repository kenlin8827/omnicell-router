import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Layers, Plus, Trash2, ArrowUp, ArrowDown, AlertTriangle, Pencil, X, Wand2, GripVertical, Power, Zap, Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { api, opencodeApi, type ComboView, type ComboMemberView, type ComboTestResult } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { Combobox } from '../components/Combobox';
import {
  DROPDOWN_PANEL_Z,
  dropdownSurfaceStyle,
  positionDropdown,
  type DropdownPosition,
} from '../components/dropdown';
import { Pagination } from '../components/Pagination';
import { fmtLatency } from '../lib/format';
import { sortModelOptions } from '../lib/model-options';
import { memberRuleMatch } from '../lib/glob';

import { FONT_MONO } from '../lib/fonts';
import { MEMBER_ACTIONS_W, MEMBER_GUTTER_W, MEMBER_QUICK_CHIP_CAP, MEMBER_WEIGHT_INPUT } from '../lib/member-row-rails';
import { MEMBER_WEIGHT_MAX } from '../lib/defaults';
import { type SelectionStrategy, normalizeSelection } from '../lib/selection';
/** Explicit label map — never derive the i18n key from the value: the canonical
 *  `weighted_round_robin` would camel-case into a key that does not exist.
 *  Anything outside the two rotation spellings reads as the default. */
const selectionLabelKey = (s: SelectionStrategy): string =>
  s === 'weighted_round_robin' ? 'combos.selWeighted' : s === 'round_robin' ? 'combos.selRoundRobin' : 'combos.selPriority';

/** Virtual model ids routing owns — a combo must never shadow them. */
const RESERVED_COMBO_IDS = new Set(['auto', 'lite', 'plus', 'pro', 'ultra']);
const COMBOS_PAGE_SIZE = 12;
const COMBOS_PAGE_SIZES = [12, 24, 48];
/** Combo cards show at most this many member chips; longer chains collapse into a "+N more" row. */
const COMBO_PREVIEW_MEMBERS = 6;

interface MemberDraft {
  id: string;
  weight: number;
}

interface ComboDraft {
  id: string;
  selection: SelectionStrategy;
  disabled: boolean;
  models: MemberDraft[];
  note: string;
}

/** Config payload → editable draft (members may arrive as strings or {id, weight}). */
const toDraft = (c: ComboView): ComboDraft => ({
  id: c.id,
  selection: normalizeSelection(c.selection),
  disabled: c.disabled === true,
  models: (c.members || []).map((m: ComboMemberView) => ({ id: m.id, weight: m.weight ?? 1 })),
  note: c.note || '',
});

/** Draft → config payload; weight 1 members serialize as bare strings for readable YAML. */
const toPayload = (d: ComboDraft) => ({
  id: d.id.trim(),
  selection: d.selection,
  ...(d.disabled ? { disabled: true } : {}),
  ...(d.note.trim() ? { note: d.note.trim() } : {}),
  models: d.models.map(m => (m.weight > 1 ? { id: m.id, weight: m.weight } : m.id)),
});

/** Draft-level validation ('' = valid). Kept in sync between the drawer and card badges. */
const validateDraft = (draft: ComboDraft, all: ComboDraft[], selfIndex: number, modelIds: ReadonlySet<string>): string => {
  const id = draft.id.trim();
  if (!id) return 'combos.warnEmptyId';
  if (RESERVED_COMBO_IDS.has(id)) return 'combos.warnReservedId';
  if (modelIds.has(id)) return 'combos.warnShadowModel';
  if (all.some((c, i) => i !== selfIndex && c.id.trim() === id)) return 'combos.warnDupId';
  if (draft.models.length === 0) return 'combos.warnNoMembers';
  const seen = new Set<string>();
  for (const m of draft.models) {
    if (!m.id) return 'combos.warnEmptyMember';
    if (seen.has(m.id)) return 'combos.warnDupMember';
    seen.add(m.id);
  }
  return '';
};

const BREAKER_DOT_COLOR: Record<string, string> = {
  CLOSED: 'var(--accent-emerald)',
  OPEN: 'var(--accent-rose)',
  HALF_OPEN: 'var(--accent-amber)',
};

/** Breaker-state dot for one member chip on a combo card. */
const HealthDot: React.FC<{ member?: ComboMemberView }> = ({ member }) => {
  if (!member) return null; // unregistered — the chip itself is already styled as a warning
  const color = BREAKER_DOT_COLOR[member.breakerState || 'CLOSED'] || BREAKER_DOT_COLOR.CLOSED;
  return (
    <span
      title={member.breakerState || 'CLOSED'}
      style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }}
    />
  );
};

/**
 * The member list is structurally `realRows ++ [addRow]`: the LAST slot is always
 * a blank row used to append, so there is no "add member" button and no way to
 * end up with zero rows. Typing an id into the add-row promotes it into the real
 * range and a fresh blank takes its place (the row keeps its key/index, so focus
 * and caret survive the promotion).
 *
 * The add-row is a rendering slot, never data: validation and save both go
 * through `realMembers`, so config.yaml can never receive an empty member and the
 * cards/counts on the page never see the phantom row.
 */
const BLANK_MEMBER = (): MemberDraft => ({ id: '', weight: 1 });
/**
 * The add-row and the real rows must share one leading gutter and one trailing
 * action cell, otherwise their pickers and weight boxes sit a few px off each
 * other and the list reads as two different kinds of row. The rails themselves
 * are declared once in lib/member-row-rails (the tier editor uses the same
 * ones). MEMBER_ACTIONS_W is only the first-paint width here: the real one is
 * measured from the quick-add button (see actionsW) so the column is flush in
 * every locale.
 */
const withAddRow = (real: readonly MemberDraft[]): MemberDraft[] => [...real, BLANK_MEMBER()];
const realMembers = (models: readonly MemberDraft[]): MemberDraft[] => models.slice(0, -1);
/** Seed the editor from a saved draft: a trailing blank is adopted as the add-row. */
const asEditorList = (models: readonly MemberDraft[]): MemberDraft[] =>
  withAddRow(models.length > 0 && models[models.length - 1].id.trim() === '' ? models.slice(0, -1) : models);

/** Centered editor dialog for one combo (portal, Esc/backdrop close). */
const ComboDialog: React.FC<{
  draft: ComboDraft;
  isNew: boolean;
  all: ComboDraft[];
  selfIndex: number; // -1 for new
  modelOptions: { value: string; label: string }[];
  /** Every registered physical model id (incl. unconnected providers). */
  registeredIds: ReadonlySet<string>;
  onClose: () => void;
  onSave: (draft: ComboDraft) => Promise<boolean>;
}> = ({ draft, isNew, all, selfIndex, modelOptions, registeredIds, onClose, onSave }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [work, setWork] = useState<ComboDraft>(() => ({ ...draft, models: asEditorList(draft.models) }));
  const [pattern, setPattern] = useState('');
  /**
   * Wildcard bulk-add lives in a popover anchored to the add-row button, not in the
   * dialog body: a hit list of dozens of models would push the member list around.
   * It reuses the `Combobox` popup primitives (portal + fixed panel + outside-click)
   * so the two cannot drift, and it stays BELOW the Escape order: while it is open,
   * Escape cancels the popover instead of throwing away the whole draft.
   */
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickPos, setQuickPos] = useState<DropdownPosition | null>(null);
  const quickBtnRef = useRef<HTMLButtonElement>(null);
  const quickPanelRef = useRef<HTMLDivElement>(null);
  const quickInputRef = useRef<HTMLInputElement>(null);
  /**
   * One action column for every row: the member rows hold three icon buttons and
   * the add-row one text button, and the label length is locale-dependent, so the
   * shared width is measured from the button instead of guessed. The trio then
   * stretches to the same box, which makes the column flush on BOTH edges.
   */
  const [actionsW, setActionsW] = useState<number | null>(null);
  const placeQuick = useCallback(
    () => setQuickPos(quickBtnRef.current ? positionDropdown(quickBtnRef.current, 340, 320) : null),
    []
  );
  const closeQuick = useCallback(() => {
    setQuickOpen(false);
    setPattern('');
  }, []);
  const [saving, setSaving] = useState(false);
  // Native HTML5 drag-and-drop for member rows. A row is only draggable while
  // its grip handle is held (armedIdx), so text selection inside the member
  // Combobox inputs keeps working.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [armedIdx, setArmedIdx] = useState<number | null>(null);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // While the quick-add popover is open, Escape cancels it, not the draft.
      if (quickOpen) {
        closeQuick();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, quickOpen, closeQuick]);

  // Re-anchor while the dialog scrolls, and dismiss on pointerdown outside
  // trigger + panel (the same pair of rules Combobox applies to its own panel).
  useEffect(() => {
    if (!quickOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (quickPanelRef.current?.contains(target) || quickBtnRef.current?.contains(target)) return;
      closeQuick();
    };
    window.addEventListener('scroll', placeQuick, true);
    window.addEventListener('resize', placeQuick);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', placeQuick, true);
      window.removeEventListener('resize', placeQuick);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [quickOpen, placeQuick, closeQuick]);

  useEffect(() => {
    if (quickOpen) quickInputRef.current?.focus();
  }, [quickOpen]);

  useEffect(() => {
    const el = quickBtnRef.current;
    if (!el) return;
    // The button is flex-shrink:0 inside the cell, so its natural width never
    // depends on actionsW and measuring it cannot feed back into its own size.
    // A 0 reading means it has no layout box yet (this effect can run before the
    // portal subtree is laid out), NOT that the column is 0px wide: taking it
    // literally spills both action cells out of the row, so keep the fallback and
    // re-measure on the next frame instead.
    let raf = 0;
    const measure = () => {
      const w = el.offsetWidth;
      if (w > 0) setActionsW(w);
      else raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const actionCellW = actionsW ? `${actionsW}px` : MEMBER_ACTIONS_W;

  const members = realMembers(work.models);
  const warn = validateDraft({ ...work, models: members }, all, selfIndex, registeredIds);
  const patch = (p: Partial<ComboDraft>) => setWork(prev => ({ ...prev, ...p }));

  /**
   * Edit one row. Writing an id into the add-row commits it as a member and opens
   * a new add-row below; a weight-only tweak does NOT commit (an id-less member
   * would light up the warnEmptyMember badge for what is still just an input).
   */
  const patchMember = (idx: number, p: Partial<MemberDraft>) =>
    setWork(prev => {
      const real = realMembers(prev.models);
      if (idx < real.length) {
        return { ...prev, models: withAddRow(real.map((m, i) => (i === idx ? { ...m, ...p } : m))) };
      }
      const next = { ...prev.models[prev.models.length - 1], ...p };
      return { ...prev, models: next.id.trim() ? withAddRow([...real, next]) : [...real, next] };
    });
  const removeMember = (idx: number) =>
    setWork(prev => ({ ...prev, models: withAddRow(realMembers(prev.models).filter((_, j) => j !== idx)) }));
  const moveMember = (idx: number, dir: -1 | 1) =>
    setWork(prev => {
      const next = realMembers(prev.models);
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...prev, models: withAddRow(next) };
    });
  /** Drag-and-drop reorder: move the member at `from` to position `to`. */
  const reorderMember = (from: number, to: number) =>
    setWork(prev => {
      const next = realMembers(prev.models);
      const [moved] = next.splice(from, 1);
      // Clamped so dropping on the add-row means "move to the end", and the
      // phantom row can never be pushed into the middle of the chain.
      next.splice(Math.min(to, next.length), 0, moved);
      return { ...prev, models: withAddRow(next) };
    });

  /**
   * A model already in the chain is not offered again. `Combobox` is select-only
   * (it never commits typed text), so filtering the options stops a duplicate at
   * the input instead of after it; `warnDupMember` stays in `validateDraft` as the
   * legacy-data backstop. A row always keeps its own id so its label resolves.
   */
  const memberIds = useMemo(() => new Set(realMembers(work.models).map(m => m.id)), [work.models]);
  const rowOptions = (selfId: string) => modelOptions.filter(o => o.value === selfId || !memberIds.has(o.value));

  /**
   * Wildcard bulk-add is two-step: the input matches live and the hit list is
   * shown, and only the confirm (Enter is the same action once that list is on
   * screen) appends. Models already in the chain are reported as skipped instead
   * of being filtered out silently.
   *
   * Matching is the SAME member-rule vocabulary the tier page and the backend
   * speak (`memberRuleMatch`): `*` / `?` globs, no wildcard = substring, and a
   * registered full id pins only itself — never a longer sibling. A private
   * `*`-only anchored regex here used to diverge on all three counts.
   */
  const patternMatch = useMemo(() => {
    const p = pattern.trim();
    if (!p) return null;
    // The exact-pin test must read the FULL registered universe, not the
    // connected-only hit list: a registered model whose provider is offline
    // is still a registered id, so naming it exactly must not fall back to
    // substring and swallow a connected longer sibling.
    const registeredLower = new Set(Array.from(registeredIds, (id) => id.toLowerCase()));
    const isRegistered = (id: string) => registeredLower.has(id.trim().toLowerCase());
    const hits = modelOptions.filter(o => memberRuleMatch(p, o.value, isRegistered));
    return { fresh: hits.filter(o => !memberIds.has(o.value)), skipped: hits.filter(o => memberIds.has(o.value)) };
  }, [pattern, modelOptions, memberIds, registeredIds]);
  const commitPattern = () => {
    if (!patternMatch || patternMatch.fresh.length === 0) return;
    const add = patternMatch.fresh.map(o => ({ id: o.value, weight: 1 }));
    setWork(prev => ({ ...prev, models: withAddRow([...realMembers(prev.models), ...add]) }));
    setPattern('');
    toast.success(t('combos.patternAdded', { count: add.length }));
  };

  const handleSave = async () => {
    if (warn || saving) return;
    setSaving(true);
    // The add-row is an input, not a member — it never leaves the dialog.
    const ok = await onSave({ ...work, models: members });
    setSaving(false);
    if (ok) onClose();
  };

  // Close on backdrop click only when BOTH press and release happen on the
  // overlay itself — a click that starts inside the form and ends on the
  // overlay (text-selection drag) must not dismiss the dialog. While the
  // quick-add popover is open the backdrop click belongs to that layer alone
  // (its own pointerdown handler dismisses it), so the draft survives.
  /**
   * Chips in the quick-add preview are a spot-check, not the decision (the count
   * line carries that), so each list is capped (`MEMBER_QUICK_CHIP_CAP`, shared
   * with the tier editor) and the tail collapses into one `+N` chip whose
   * tooltip still names every hidden id. Keeps the popover about half as tall
   * for a broad wildcard like `*`.
   */
  const chipTail = (list: { value: string; label: string }[]) => {
    const hidden = list.slice(MEMBER_QUICK_CHIP_CAP);
    if (hidden.length === 0) return null;
    return (
      <span
        title={hidden.map(o => o.value).join('\n')}
        style={{
          fontFamily: FONT_MONO,
          fontSize: 'var(--text-2xs)',
          padding: '2px 6px',
          borderRadius: '4px',
          border: '1px solid var(--divider)',
          color: 'var(--text-dim)',
        }}
      >
        +{hidden.length}
      </span>
    );
  };

  const mouseDownOnOverlay = React.useRef(false);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'var(--scrim)',
        display: 'flex',
        overflowY: 'auto',
        padding: '16px',
        animation: 'ocr-fade-in 0.15s ease',
      }}
      onMouseDown={e => {
        mouseDownOnOverlay.current = e.target === e.currentTarget && !quickOpen;
      }}
      onMouseUp={e => {
        setArmedIdx(null); // disarm even if the pointer left the grip handle
        if (!quickOpen && mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          margin: 'auto',
          width: '100%',
          maxWidth: 640,
          maxHeight: '85vh',
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderBottom: '1px solid var(--divider)',
          }}
        >
          <Layers size={16} color="var(--accent)" />
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-semibold)' }}>
            {isNew ? t('combos.newCombo') : `${t('combos.edit')} · ${draft.id || '…'}`}
          </span>
          <button className="btn btn-sm" style={{ marginLeft: 'auto', padding: '4px 6px' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.comboId')}
            </label>
            <input
              type="text"
              placeholder={t('combos.comboIdPlaceholder')}
              value={work.id}
              onChange={e => patch({ id: e.target.value })}
              className="input"
              style={{ fontFamily: FONT_MONO }}
            />
          </div>

          <div>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.selection')}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['priority', 'weighted_round_robin', 'round_robin'] as SelectionStrategy[]).map(s => (
                <button
                  key={s}
                  type="button"
                  className={work.selection === s ? 'btn btn-primary' : 'btn'}
                  style={{ fontSize: 'var(--text-sm)', flex: 1 }}
                  onClick={() => patch({ selection: s })}
                >
                  {t(selectionLabelKey(s))}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                {t('combos.members')}
              </label>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
                {t('combos.memberCount', { count: members.length })}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {work.models.map((member, mIdx) => {
                const isAddRow = mIdx === work.models.length - 1;
                const known = registeredIds.has(member.id);
                return (
                  <div
                    key={mIdx}
                    draggable={armedIdx === mIdx}
                    onDragStart={e => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(mIdx)); // Firefox requires data to start a drag
                      setDragIdx(mIdx);
                    }}
                    onDragOver={e => {
                      if (dragIdx === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (overIdx !== mIdx) setOverIdx(mIdx);
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      if (dragIdx !== null && dragIdx !== mIdx) reorderMember(dragIdx, mIdx);
                      setDragIdx(null);
                      setOverIdx(null);
                      setArmedIdx(null);
                    }}
                    onDragEnd={() => {
                      setDragIdx(null);
                      setOverIdx(null);
                      setArmedIdx(null);
                    }}
                    style={{
                      display: 'flex',
                      gap: '6px',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      borderRadius: '6px',
                      border: dragIdx !== null && overIdx === mIdx && dragIdx !== mIdx
                        ? '1px dashed var(--accent)'
                        : isAddRow
                          ? '1px dashed var(--divider)'
                          : '1px solid transparent',
                      opacity: dragIdx === mIdx ? 0.4 : 1,
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        // The add-row rail holds only the +, so center it there;
                        // real rows stay left-packed (grip + number).
                        justifyContent: isAddRow ? 'center' : undefined,
                        gap: '6px',
                        width: MEMBER_GUTTER_W,
                        flexShrink: 0,
                        color: 'var(--text-dim)',
                      }}
                    >
                      {isAddRow ? <Plus size={13} /> : (
                        <span
                          title={t('combos.dragSort')}
                          onMouseDown={() => setArmedIdx(mIdx)}
                          onMouseUp={() => setArmedIdx(null)}
                          style={{ cursor: 'grab', display: 'inline-flex' }}
                        >
                          <GripVertical size={13} />
                        </span>
                      )}
                      {/* Real rows carry their 1-based chain number; the
                          add-row drops that cell entirely (the picker's start
                          x comes from the fixed gutter width, not this cell),
                          leaving the rail empty so the + centers in it. */}
                      {!isAddRow && (
                        <span style={{ fontSize: 'var(--text-xs)', width: '22px', textAlign: 'right' }}>
                          {`${mIdx + 1}.`}
                        </span>
                      )}
                    </span>
                    <Combobox
                      value={member.id}
                      onChange={v => patchMember(mIdx, { id: v })}
                      options={rowOptions(member.id)}
                      placeholder={isAddRow ? t('combos.addRowPlaceholder') : t('combos.memberPlaceholder')}
                      panelMinWidth={360}
                      style={{ fontSize: 'var(--text-sm)', padding: '5px 10px', flex: 1, minWidth: '220px' }}
                    />
                    {/* ONLY `weighted_round_robin` reads member weight (rotation
                        share); priority and round_robin ignore it, so the field
                        is not offered under them. */}
                    {work.selection === 'weighted_round_robin' && (
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
                      >
                        {t('combos.weight')}
                        <input
                          type="number"
                          min={1}
                          max={MEMBER_WEIGHT_MAX}
                          value={member.weight}
                          onChange={e => patchMember(mIdx, { weight: Math.min(MEMBER_WEIGHT_MAX, Math.max(1, Number(e.target.value) || 1)) })}
                          className="input"
                          style={MEMBER_WEIGHT_INPUT}
                        />
                      </label>
                    )}
                    {!isAddRow && (
                      <div
                        style={{
                          display: 'flex',
                          gap: '4px',
                          width: actionCellW,
                          justifyContent: 'space-between',
                          flexShrink: 0,
                        }}
                      >
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          disabled={mIdx === 0}
                          onClick={() => moveMember(mIdx, -1)}
                          title={t('combos.moveUp')}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          disabled={mIdx >= members.length - 1}
                          onClick={() => moveMember(mIdx, 1)}
                          title={t('combos.moveDown')}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          style={{ padding: '4px 6px' }}
                          onClick={() => removeMember(mIdx)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                    {isAddRow && (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          width: actionCellW,
                          flexShrink: 0,
                        }}
                      >
                        <button
                          ref={quickBtnRef}
                          className="btn btn-sm"
                          style={{ gap: '5px', whiteSpace: 'nowrap', flexShrink: 0 }}
                          onClick={() => {
                            if (quickOpen) {
                              closeQuick();
                              return;
                            }
                            placeQuick();
                            setQuickOpen(true);
                          }}
                          title={t('combos.patternHint')}
                        >
                          <Wand2 size={13} />
                          <span>{t('combos.quickAdd')}</span>
                        </button>
                      </div>
                    )}
                    {!known && member.id && (
                      <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>
                        <AlertTriangle size={12} />
                        <span>{t('combos.unregisteredWarn')}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {quickOpen &&
                quickPos &&
                createPortal(
                  <div
                    ref={quickPanelRef}
                    style={{
                      position: 'fixed',
                      ...quickPos,
                      zIndex: DROPDOWN_PANEL_Z,
                      ...dropdownSurfaceStyle,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                        <Wand2 size={13} />
                        {t('combos.quickAdd')}
                      </span>
                      <button
                        className="btn btn-sm"
                        style={{ padding: '2px 6px' }}
                        onClick={closeQuick}
                        title={t('common.cancel')}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <input
                      ref={quickInputRef}
                      className="input"
                      style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                      placeholder={t('combos.patternPlaceholder')}
                      value={pattern}
                      onChange={e => setPattern(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitPattern();
                        }
                      }}
                    />
                    {!patternMatch ? (
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 1.5 }}>{t('combos.patternHint')}</span>
                    ) : (
                      <>
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            // Rose only for a real miss — everything-already-present is
                            // informational, not an error.
                            color:
                              !patternMatch.fresh.length && !patternMatch.skipped.length
                                ? 'var(--accent-rose)'
                                : 'var(--text-dim)',
                          }}
                        >
                          {patternMatch.fresh.length
                            ? t('combos.patternPreview', { count: patternMatch.fresh.length, skipped: patternMatch.skipped.length })
                            : patternMatch.skipped.length
                              ? t('combos.patternAllPresent')
                              : t('combos.patternNoMatch')}
                        </span>
                        {patternMatch.fresh.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                            {patternMatch.fresh.slice(0, MEMBER_QUICK_CHIP_CAP).map(o => (
                              <span
                                key={o.value}
                                title={o.label}
                                style={{
                                  fontFamily: FONT_MONO,
                                  fontSize: 'var(--text-2xs)',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'var(--bg-elev)',
                                  color: 'var(--text-muted)',
                                }}
                              >
                                {o.value}
                              </span>
                            ))}
                            {chipTail(patternMatch.fresh)}
                          </div>
                        )}
                        {patternMatch.skipped.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{t('combos.patternSkipped')}</span>
                            {patternMatch.skipped.slice(0, MEMBER_QUICK_CHIP_CAP).map(o => (
                              <span
                                key={o.value}
                                title={o.label}
                                style={{
                                  fontFamily: FONT_MONO,
                                  fontSize: 'var(--text-2xs)',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  border: '1px solid var(--divider)',
                                  color: 'var(--text-dim)',
                                }}
                              >
                                {o.value}
                              </span>
                            ))}
                            {chipTail(patternMatch.skipped)}
                          </div>
                        )}
                      </>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ alignSelf: 'flex-end' }}
                      onClick={commitPattern}
                      disabled={!patternMatch || patternMatch.fresh.length === 0}
                    >
                      {patternMatch && patternMatch.fresh.length > 0
                        ? t('combos.patternConfirm', { count: patternMatch.fresh.length })
                        : t('combos.patternAdd')}
                    </button>
                  </div>,
                  document.body
                )}
            </div>
          </div>

          <div>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.noteLabel')}
            </label>
            <textarea
              className="input"
              rows={2}
              placeholder={t('combos.notePlaceholder')}
              value={work.note}
              onChange={e => patch({ note: e.target.value })}
              style={{ fontSize: 'var(--text-sm)', resize: 'vertical' }}
            />
          </div>

          {warn && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>
              <AlertTriangle size={13} />
              <span>{t(warn)}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            padding: '12px 16px',
            borderTop: '1px solid var(--divider)',
          }}
        >
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!!warn || saving}>
            {t('combos.saveBtn')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const CombosPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [combos, setCombos] = useState<ComboDraft[] | null>(null);
  // Introspection meta by combo id (active flag + member registered/tier/
  // breaker state) for card rendering.
  const [meta, setMeta] = useState<Record<string, ComboView>>({});
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  // Every registered physical model id (incl. unconnected providers) — used to
  // tell "unregistered" apart from "provider offline" for existing members.
  const [registeredIds, setRegisteredIds] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ draft: ComboDraft; index: number } | null>(null); // index -1 = new
  const [, setSaving] = useState(false);
  const [combosPage, setCombosPage] = useState(1);
  const [combosPageSize, setCombosPageSize] = useState(COMBOS_PAGE_SIZE);
  // Absolute combo indices whose member chain is expanded past COMBO_PREVIEW_MEMBERS.
  // Cleared whenever the list order could shift (paging / save) so indices never point at the wrong card.
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  // One-shot end-to-end combo tests (card ⚡ button): per-combo in-flight set
  // and last result; the result chip persists visually until the next click.
  const [testingCombos, setTestingCombos] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, ComboTestResult>>({});

  // Card-list drag-and-drop (same armed-grip pattern as the member rows in
  // ComboDialog): a card is only draggable while its grip is held, so text
  // selection on the cards keeps working.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [armedIdx, setArmedIdx] = useState<number | null>(null);

  const refreshMeta = useCallback(() => {
    api
      .getCombos()
      .then(res => {
        const next: Record<string, ComboView> = {};
        for (const c of res.combos || []) next[c.id] = c;
        setMeta(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([api.getCombos(), api.listGatewayModels(), opencodeApi.listProviders()])
      .then(([comboRes, models, provRes]) => {
        const byId: Record<string, ComboView> = {};
        for (const c of comboRes.combos || []) byId[c.id] = c;
        setMeta(byId);
        setCombos((comboRes.combos || []).map(toDraft));
        // Registered physical models only — virtual tier aliases (auto + bare tier names) and combos
        // are owned_by 'omnicell-router'. Tier presence is deliberately NOT
        // the criterion: combos are the sanctioned way to call models that no
        // tier member list claims, so those must stay selectable here.
        const registered = models.filter(m => m.owned_by !== 'omnicell-router');
        const connected = new Set((provRes.providers || []).filter(p => p.auth?.connected).map(p => p.id));
        setRegisteredIds(new Set(registered.map(m => m.id)));
        setModelOptions(sortModelOptions(registered.filter(m => connected.has(m.owned_by)).map(m => ({ value: m.id, label: m.id }))));
      })
      .catch(err => {
        console.error('Failed to load combos:', err);
        setCombos([]);
      });
  }, []);

  /** Persist the whole combos list (server merges the section + hot-applies). */
  const persist = useCallback(
    async (next: ComboDraft[]) => {
      setSaving(true);
      try {
        await api.saveConfig({ combos: next.map(toPayload) });
        toast.success(t('combos.savedNotice'));
        refreshMeta();
        setExpandedCards(new Set()); // deletes can shift indices — drop per-card expansion
        return true;
      } catch (err: any) {
        toast.error(t('common.failed') + err.message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refreshMeta, t, toast]
  );

  const handleDrawerSave = useCallback(
    async (draft: ComboDraft): Promise<boolean> => {
      if (!combos) return false;
      const next = [...combos];
      if (editing && editing.index >= 0) next[editing.index] = draft;
      else next.push(draft);
      setCombos(next); // optimistic commit; revert on failure keeps the drawer state coherent
      const ok = await persist(next);
      if (!ok) setCombos(combos);
      return ok;
    },
    [combos, editing, persist]
  );

  const handleDelete = useCallback(
    async (idx: number) => {
      if (!combos) return;
      const target = combos[idx];
      const ok = await confirmDialog({
        title: t('combos.deleteTitle'),
        description: target.id,
        danger: true,
      });
      if (!ok) return;
      const next = combos.filter((_, i) => i !== idx);
      setCombos(next);
      const saved = await persist(next);
      if (!saved) setCombos(combos);
    },
    [combos, persist, t, confirmDialog]
  );

  /** Flip the operator-disable flag and persist the whole list (server hot-applies). */
  const handleToggleDisabled = useCallback(
    async (idx: number) => {
      if (!combos) return;
      const next = combos.map((c, i) => (i === idx ? { ...c, disabled: !c.disabled } : c));
      setCombos(next);
      const saved = await persist(next);
      if (!saved) setCombos(combos);
    },
    [combos, persist]
  );

  /** Move the card at `from` to position `to` (list order = config order) and persist.
   *  Sole reorder path — grip drag only reaches cards on the current page; for
   *  cross-page moves the user widens the page size (48) or pages first. */
  const reorderCombo = useCallback(
    async (from: number, to: number) => {
      if (!combos || from === to || to < 0 || to >= combos.length) return;
      const next = [...combos];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setExpandedCards(new Set()); // order shifted — member expansion may point at the wrong card
      setCombos(next);
      const saved = await persist(next);
      if (!saved) setCombos(combos);
    },
    [combos, persist]
  );

  /** One real minimal completion through the production pipeline. Precondition
   * throws (the id went inactive between render and click) localize via the
   * reasonCode; genuine chain failures show the gateway's own message. */
  const handleTest = useCallback(
    async (comboId: string) => {
      if (!comboId || testingCombos.has(comboId)) return;
      setTestingCombos(prev => new Set(prev).add(comboId));
      try {
        const res = await api.testCombo(comboId);
        setTestResults(prev => ({ ...prev, [comboId]: res }));
        if (res.ok) {
          const base = t('combos.testOk', { combo: comboId, model: res.modelUsed || '—', n: fmtLatency(res.latencyMs ?? NaN) });
          toast.success(
            res.failoverOccurred && res.failoverPath?.length
              ? base + t('combos.testOkFailover', { path: res.failoverPath.join(' → ') })
              : base
          );
        } else {
          toast.error(t('combos.testFailed', { combo: comboId, error: res.error || `HTTP ${res.httpStatus ?? '?'}` }));
        }
      } catch (err: any) {
        const failMsg = err?.reasonCode === 'combo_inactive' ? t('combos.testInactive') : err?.message || String(err);
        const failed: ComboTestResult = {
          status: 'ok',
          ok: false,
          combo: comboId,
          error: failMsg,
        };
        setTestResults(prev => ({ ...prev, [comboId]: failed }));
        toast.error(t('combos.testFailed', { combo: comboId, error: failMsg }));
      } finally {
        setTestingCombos(prev => {
          const next = new Set(prev);
          next.delete(comboId);
          return next;
        });
      }
    },
    [t, toast, testingCombos]
  );

  if (combos === null) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <Layers size={18} color="var(--accent)" />
          <span>{t('combos.title')}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setEditing({ draft: { id: '', selection: 'priority', disabled: false, models: [{ id: '', weight: 1 }], note: '' }, index: -1 })}
        >
          <Plus size={14} />
          <span>{t('combos.addCombo')}</span>
        </button>
      </div>

      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)', marginBottom: '16px', whiteSpace: 'pre-line' }}>
        {t('combos.hint')}
      </div>

      {combos.length === 0 ? (
        <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-dim)', padding: '16px 0' }}>{t('combos.empty')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '14px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
          {combos
            .slice((combosPage - 1) * combosPageSize, combosPage * combosPageSize)
            .map((combo, rel) => {
            // idx must stay the ABSOLUTE index into `combos` — edit/delete address by it.
            const idx = (combosPage - 1) * combosPageSize + rel;
            const comboMeta = meta[combo.id.trim()];
            const membersMeta = comboMeta?.members || [];
            const inactive = comboMeta ? comboMeta.active === false : false;
            const isDisabled = combo.disabled;
            const modelIds = registeredIds;
            const warn = validateDraft(combo, combos, idx, modelIds);
            // Unroutable = every member's registration probe came back false
            // (meta loaded, members configured) — the routing path fail-fasts
            // this combo, so the card must say so beyond per-chip styling.
            const unroutable =
              !warn && membersMeta.length > 0 && combo.models.length > 0 && membersMeta.every((m) => !m.registered);
            const cid = combo.id.trim();
            const testRes = testResults[cid];
            const isTesting = testingCombos.has(cid);
            const collapsed = combo.models.length > COMBO_PREVIEW_MEMBERS && !expandedCards.has(idx);
            const shownMembers = collapsed ? combo.models.slice(0, COMBO_PREVIEW_MEMBERS) : combo.models;
            return (
              <div
                key={idx}
                className="card"
                draggable={armedIdx === idx}
                onDragStart={e => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(idx)); // Firefox requires data to start a drag
                  setDragIdx(idx);
                }}
                onDragOver={e => {
                  if (dragIdx === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overIdx !== idx) setOverIdx(idx);
                }}
                onDrop={e => {
                  e.preventDefault();
                  if (dragIdx !== null && dragIdx !== idx) void reorderCombo(dragIdx, idx);
                  setDragIdx(null);
                  setOverIdx(null);
                  setArmedIdx(null);
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                  setArmedIdx(null);
                }}
                style={{
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  margin: 0,
                  opacity: isDisabled ? 0.55 : dragIdx === idx ? 0.4 : 1,
                  borderColor: dragIdx !== null && overIdx === idx && dragIdx !== idx ? 'var(--accent)' : warn || inactive ? 'var(--accent-rose)' : undefined,
                  borderStyle: dragIdx !== null && overIdx === idx && dragIdx !== idx ? 'dashed' : undefined,
                }}
              >
                {/* Card head: grip + id + strategy badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    title={t('combos.dragSort')}
                    onMouseDown={() => setArmedIdx(idx)}
                    onMouseUp={() => setArmedIdx(null)}
                    style={{ cursor: 'grab', color: 'var(--text-dim)', display: 'inline-flex', flexShrink: 0 }}
                  >
                    <GripVertical size={14} />
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)', wordBreak: 'break-all' }}>
                    {combo.id.trim() || <span style={{ color: 'var(--accent-rose)' }}>—</span>}
                  </span>
                  {inactive && (
                    <span
                      title={t('combos.inactiveWarn')}
                      style={{ fontSize: 'var(--text-2xs)', padding: '2px 6px', borderRadius: '10px', color: 'var(--accent-rose)', border: '1px solid var(--accent-rose)', whiteSpace: 'nowrap' }}
                    >
                      {t('combos.inactiveBadge')}
                    </span>
                  )}
                  {isDisabled && (
                    <span
                      title={t('combos.disabledWarn')}
                      style={{ fontSize: 'var(--text-2xs)', padding: '2px 6px', borderRadius: '10px', color: 'var(--accent-amber)', border: '1px solid var(--accent-amber)', whiteSpace: 'nowrap' }}
                    >
                      {t('combos.disabledBadge')}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 'var(--text-2xs)',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      border: '1px solid var(--card-border)',
                      color: 'var(--text-dim)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t(selectionLabelKey(combo.selection))}
                  </span>
                </div>

                {combo.note.trim() && (
                  <div
                    title={combo.note}
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {combo.note}
                  </div>
                )}

                {/* Member chips (failover chain order) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {shownMembers.map((m, mIdx) => {
                    const mm = membersMeta.find(x => x.id === m.id);
                    const unregistered = m.id && mm && !mm.registered;
                    return (
                      <div
                        key={mIdx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '7px',
                          fontSize: 'var(--text-sm)',
                          padding: '5px 8px',
                          borderRadius: '6px',
                          background: 'var(--bg-elev)',
                          border: unregistered ? '1px dashed var(--accent-rose)' : '1px solid transparent',
                        }}
                      >
                        <span style={{ color: 'var(--text-dim)', fontSize: 'var(--text-2xs)', width: '14px' }}>{mIdx + 1}</span>
                        <HealthDot member={mm} />
                        <span title={m.id} style={{ fontFamily: FONT_MONO, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.id || <span style={{ color: 'var(--accent-rose)' }}>{t('combos.warnEmptyMember')}</span>}
                        </span>
                        {combo.selection === 'weighted_round_robin' && (m.weight ?? 1) > 1 && (
                          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>×{m.weight}</span>
                        )}
                      </div>
                    );
                  })}
                  {combo.models.length > COMBO_PREVIEW_MEMBERS && (
                    <button
                      className="btn btn-sm"
                      style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', padding: '2px 8px' }}
                      onClick={e => {
                        e.stopPropagation();
                        setExpandedCards(prev => {
                          const next = new Set(prev);
                          if (next.has(idx)) next.delete(idx);
                          else next.add(idx);
                          return next;
                        });
                      }}
                    >
                      {collapsed
                        ? t('combos.showMoreMembers', { count: combo.models.length - COMBO_PREVIEW_MEMBERS })
                        : t('combos.collapseMembers')}
                    </button>
                  )}
                </div>

                {/* Card foot: count + actions — pinned to the card bottom so
                    footers align across cards of different member counts
                    (grid rows stretch cards to equal height). */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 'auto', paddingTop: '2px' }}>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {combo.models.length} {t('combos.membersUnit')}
                  </span>
                  {(warn || unroutable) && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>
                      <AlertTriangle size={11} />
                      <span>{t(warn || 'combos.warnAllUnregistered')}</span>
                    </span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {testRes && (
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 'var(--text-2xs)',
                          whiteSpace: 'nowrap',
                          color: testRes.ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                        }}
                        title={
                          testRes.ok
                            ? `${testRes.modelUsed || '—'}${
                                testRes.failoverOccurred && testRes.failoverPath?.length
                                  ? ` (${testRes.failoverPath.join(' → ')})`
                                  : ''
                              }${testRes.servedCredentialPrefix ? ` · ${testRes.servedCredentialPrefix}` : ''} — ${testRes.latencyMs ?? 0} ms`
                            : testRes.error
                        }
                      >
                        {testRes.ok ? `✓${fmtLatency(testRes.latencyMs ?? NaN)}` : '✗'}
                      </span>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ padding: '4px 8px' }}
                      title={isTesting ? t('op.testing') : t('combos.testBtn')}
                      disabled={isTesting || inactive || !cid}
                      onClick={e => {
                        e.stopPropagation();
                        void handleTest(cid);
                      }}
                    >
                      {isTesting ? <Loader2 size={13} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={13} />}
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '4px 8px', opacity: 1, color: isDisabled ? 'var(--accent-amber)' : undefined }}
                      title={isDisabled ? t('combos.enableBtn') : t('combos.disableBtn')}
                      onClick={e => {
                        e.stopPropagation();
                        void handleToggleDisabled(idx);
                      }}
                    >
                      <Power size={13} />
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '4px 8px' }}
                      title={t('combos.edit')}
                      onClick={e => {
                        e.stopPropagation();
                        setEditing({ draft: { ...combo, models: combo.models.map(m => ({ ...m })) }, index: idx });
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ padding: '4px 8px' }}
                      onClick={e => {
                        e.stopPropagation();
                        void handleDelete(idx);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {combos !== null && combos.length > 0 && (
        <Pagination
          page={combosPage}
          pageSize={combosPageSize}
          total={combos.length}
          onChange={p => { setCombosPage(p); setExpandedCards(new Set()); }}
          showSummary
          pageSizeOptions={COMBOS_PAGE_SIZES}
          onPageSizeChange={(s) => { setCombosPageSize(s); setCombosPage(1); setExpandedCards(new Set()); }}
        />
      )}

      {editing && (
        <ComboDialog
          draft={editing.draft}
          isNew={editing.index < 0}
          all={combos}
          selfIndex={editing.index}
          modelOptions={modelOptions}
          registeredIds={registeredIds}
          onClose={() => setEditing(null)}
          onSave={handleDrawerSave}
        />
      )}
    </div>
  );
};
