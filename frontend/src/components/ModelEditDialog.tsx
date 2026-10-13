import React, { useState, useEffect } from 'react';
import { Check, Loader2, Wand2 } from 'lucide-react';
import { opencodeApi } from '../lib/api';
import { matchCatalogModel, catalogAutofillPatch, detectEffortLevel } from '../lib/catalogAutofill';
import { effortOptionList, EFFORT_LADDER, effectiveEffortLadder } from '../lib/effort';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { Field, FieldRow, FormSection } from '../components/Form';
import { EffortChips } from '../components/Chip';
import { ModalityPicker } from '../components/ModalityPicker';
import { VariantListEditor } from '../components/VariantListEditor';
import { Switch } from './Switch';

// The modality chips come from lib/modality.ts (shared with OcrEditModal —
// single source of truth for the option set and labels) via
// components/ModalityPicker.tsx.
// Effort dropdown options come from lib/effort.ts (single source of truth):
// 6-level ladder + a UI "unset" sentinel, labels rendered as
// `<wire> (<localized>)` so users see the protocol token they will send
// on the wire, with a short hint in their language.

interface ModelFormState {
  modelKey: string;
  name: string;
  modelID: string;
  tools: boolean;
  /** capability flags `reasoning` / `temperature` (standard catalog booleans) */
  reasoning: boolean;
  temperature: boolean;
  /** supported thinking levels (def-level `reasoningOptions`); empty = follow the catalog */
  efforts: string[];
  inputMod: string[];
  outputMod: string[];
  contextLimit: string;
  outputLimit: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  reasoningEffort: string;
  headersText: string;
  bodyText: string;
  reasoningField: string;
  variants: { id: string; effort: string }[];
}

const defTools = (d: any): boolean => d?.capabilities?.tools ?? d?.tool_call === true;
const defInput = (d: any): string[] => d?.capabilities?.input ?? d?.modalities?.input ?? [];
const defOutput = (d: any): string[] => d?.capabilities?.output ?? d?.modalities?.output ?? [];
/** def-level `reasoningOptions` effort values (empty = follow the catalog). */
const defEfforts = (d: any): string[] => {
  const eff = (Array.isArray(d?.reasoningOptions) ? d.reasoningOptions : []).find((o: any) => o?.type === 'effort');
  return Array.isArray(eff?.values) ? eff.values.map(String) : [];
};

const formFromDef = (modelKey: string, d: any): ModelFormState => ({
  modelKey,
  name: d?.name || '',
  modelID: d?.modelID || '',
  tools: defTools(d),
  reasoning: d?.reasoning === true,
  temperature: d?.temperature === true,
  efforts: defEfforts(d),
  inputMod: defInput(d).length ? [...defInput(d)] : ['text'],
  outputMod: defOutput(d).length ? [...defOutput(d)] : ['text'],
  contextLimit: d?.limit?.context ? String(d.limit.context) : '',
  outputLimit: d?.limit?.output ? String(d.limit.output) : '',
  costInput: typeof d?.cost?.input === 'number' ? String(d.cost.input) : '',
  costOutput: typeof d?.cost?.output === 'number' ? String(d.cost.output) : '',
  costCacheRead: typeof d?.cost?.cache_read === 'number' ? String(d.cost.cache_read) : '',
  costCacheWrite: typeof d?.cost?.cache_write === 'number' ? String(d.cost.cache_write) : '',
  reasoningEffort: d?.settings?.reasoningEffort || '',
  headersText: Object.entries(d?.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
  bodyText: d?.body && Object.keys(d.body).length > 0 ? JSON.stringify(d.body, null, 2) : '',
  reasoningField: d?.compatibility?.reasoningField || '',
  variants: Array.isArray(d?.variants)
    ? d.variants.map((v: any) => ({ id: v.id || '', effort: v.settings?.reasoningEffort || '' }))
    : [],
});

/**
 * Self-contained single-model editor (opencode v2 schema): fetches the model's
 * current definition from opencode.jsonc, edits it in place, PATCHes back.
 * Used from the /models page rows of config-defined models.
 */
export const ModelEditDialog: React.FC<{
  providerId: string;
  modelId: string;
  blur?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}> = ({ providerId, modelId, blur = false, onClose, onSaved }) => {
  const { t } = useI18n();
  const toast = useToast();
  // Body scroll lock lives in the shared Dialog shell.

  const [form, setForm] = useState<ModelFormState | null>(null);
  /** Open-time `reasoning` / `temperature` as stored in the def; undefined = not
   *  set, i.e. the model follows the catalog. */
  const defFlags = React.useRef<{ reasoning?: boolean; temperature?: boolean }>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false);

  /** Auto-fill blank form fields from the best catalog match (never overwrites entered values). */
  const handleAutofill = async () => {
    if (!form) return;
    const want = form.modelID.trim() || form.modelKey.trim();
    if (!want) {
      toast.info(t('op.pmAutofillNoId'));
      return;
    }
    setFilling(true);
    try {
      const hit = await matchCatalogModel(providerId, form.modelID, form.modelKey);
      if (!hit) {
        toast.info(t('op.pmAutofillNone', { id: want }));
        return;
      }
      const m = hit.model;
      const p = catalogAutofillPatch(m);
      const effort = detectEffortLevel([form.modelID, form.modelKey]);
      setForm((prev) => {
        if (!prev) return prev;
        const d = { ...prev };
        const isDefaultMod = (a: string[]) => a.length === 1 && a[0] === 'text';
        if (!d.name && p.name) d.name = p.name;
        if (!d.contextLimit && p.contextLimit) d.contextLimit = p.contextLimit;
        if (!d.outputLimit && p.outputLimit) d.outputLimit = p.outputLimit;
        if (!d.costInput && p.costInput) d.costInput = p.costInput;
        if (!d.costOutput && p.costOutput) d.costOutput = p.costOutput;
        if (!d.costCacheRead && p.costCacheRead) d.costCacheRead = p.costCacheRead;
        if (!d.costCacheWrite && p.costCacheWrite) d.costCacheWrite = p.costCacheWrite;
        if (d.efforts.length === 0 && Array.isArray((m as any).reasoningOptions)) d.efforts = effectiveEffortLadder(m as any);
        if (isDefaultMod(d.inputMod) && p.inputMod) d.inputMod = [...p.inputMod];
        if (isDefaultMod(d.outputMod) && p.outputMod) d.outputMod = [...p.outputMod];
        // reasoning effort encoded in the id itself ('...-high') — fill when unset
        if (!d.reasoningEffort && effort) d.reasoningEffort = effort;
        return d;
      });
      const matchedId = `${m.providerId}/${m.id}`;
      toast.success(
        hit.alternatives > 1
          ? t('op.pmAutofillAmbiguous', { n: hit.alternatives, id: matchedId })
          : t('op.pmAutofillMatched', { id: matchedId })
      );
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setFilling(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await opencodeApi.listProviderModels(providerId);
        const d = (res.models || {})[modelId];
        if (!d) throw new Error(`Model '${modelId}' not found for provider '${providerId}'`);
        defFlags.current = { reasoning: d?.reasoning, temperature: d?.temperature };
        const next = formFromDef(modelId, d);
        setForm(next);
      } catch (err: any) {
        toast.error(err.message);
        onClose();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, modelId]);

  const handleSave = async () => {
    if (!form) return;
    const f = form;
    // Backstop for data the form did not produce (pulled from the catalog, or
    // hand-edited in opencode.jsonc): a default effort outside the declared
    // levels would be pinned onto every request that omits one. Picking a
    // default auto-checks its level, so this only fires on pre-existing
    // mismatches. An empty ladder declares no explicit levels → skip.
    if (f.reasoningEffort && f.efforts.length > 0 && !f.efforts.includes(f.reasoningEffort)) {
      toast.error(t('op.pmEffortNotInLadder', { effort: f.reasoningEffort }));
      return;
    }
    const payload: any = {
      name: f.name.trim() || undefined,
      modelID: f.modelID.trim() || undefined,
      // `disabled` (hide from catalog) is intentionally NOT sent: it is a
      // one-click row action in the models list, so re-patching it here would
      // silently re-enable a model the user hid from that list.
      capabilities: { tools: f.tools, input: f.inputMod, output: f.outputMod },
      settings: f.reasoningEffort ? { reasoningEffort: f.reasoningEffort } : {},
      // non-empty list materializes as reasoningOptions=[{type:'effort'}]; an empty
      // list means "thinking but no explicit level control" ({type:'toggle'}). A
      // model known to be non-reasoning must not advertise levels at all.
      reasoningEfforts: !f.reasoning && defFlags.current.reasoning !== undefined ? [] : EFFORT_LADDER.filter((l) => f.efforts.includes(l)),
      headersText: f.headersText,
      bodyText: f.bodyText,
      compatibility: f.reasoningField.trim() ? { reasoningField: f.reasoningField.trim() } : {},
      variants: f.variants.filter((v) => v.id.trim()).map((v) => ({ id: v.id.trim(), settings: v.effort ? { reasoningEffort: v.effort } : undefined })),
      contextLimit: f.contextLimit ? Number(f.contextLimit) : undefined,
      outputLimit: f.outputLimit ? Number(f.outputLimit) : undefined,
      newId: f.modelKey.trim() && f.modelKey.trim() !== modelId ? f.modelKey.trim() : undefined,
    };
    // cost ($/1M): always sent — the backend treats a present `cost` key as
    // full replace, so blanking a field clears the stored value. Invalid
    // input (non-numeric / negative) is dropped, i.e. treated as blank.
    const cost: Record<string, number> = {};
    const costNum = (s: string): number | undefined => {
      const t = s.trim();
      if (!t) return undefined;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const cIn = costNum(f.costInput);
    const cOut = costNum(f.costOutput);
    const cRead = costNum(f.costCacheRead);
    const cWrite = costNum(f.costCacheWrite);
    if (cIn !== undefined) cost.input = cIn;
    if (cOut !== undefined) cost.output = cOut;
    if (cRead !== undefined) cost.cache_read = cRead;
    if (cWrite !== undefined) cost.cache_write = cWrite;
    payload.cost = cost;
    // capability flags are booleans and a Switch has no "unset" position, so each
    // one is sent only when it changed — otherwise an untouched model would pin
    // an explicit `false` into the def and stop following the catalog.
    for (const key of ['reasoning', 'temperature'] as const) {
      if (f[key] !== (defFlags.current[key] === true)) payload[key] = f[key];
    }
    if (!payload.capabilities.tools && payload.capabilities.input.length === 0 && payload.capabilities.output.length === 0) {
      payload.capabilities = {};
    }
    try {
      if (f.bodyText.trim()) JSON.parse(f.bodyText);
    } catch {
      toast.error(t('op.pmBodyInvalid'));
      return;
    }
    setSaving(true);
    try {
      await opencodeApi.updateProviderModel(providerId, modelId, payload);
      onSaved?.();
      onClose();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const spin: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

  const footer = !form ? undefined : (
    <>
      <button className="btn" onClick={onClose}>
        {t('op.pmCancel')}
      </button>
      <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
        {saving ? <Loader2 size={12} style={spin} /> : <Check size={12} />}
        <span>{t('op.pmSave')}</span>
      </button>
    </>
  );

  return (
    <Dialog
      title={t('op.pmEditTitle')}
      subtitle={<span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>{providerId}</span>}
      headerActions={
        <button
          className="btn btn-sm"
          title={t('op.pmAutofillTip')}
          disabled={filling}
          onClick={handleAutofill}
          style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px' }}
        >
          {filling ? <Loader2 size={13} style={spin} /> : <Wand2 size={13} />}
          <span style={{ fontSize: 11 }}>{t('op.pmAutofill')}</span>
        </button>
      }
      footerRight={footer}
      onClose={onClose}
      closeLabel={t('op.pmCancel')}
      width={660}
      blur={blur}
    >
      {loading || !form ? (
        <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
          <Loader2 size={14} style={{ ...spin, marginRight: 6 }} />
          {t('common.loading')}
        </div>
      ) : (
        <>
          {/* Canonical field order, shared with the OCR source editor:
              identity → capability → limits → cost → reasoning → variants → raw. */}
          <FormSection title={t('form.identity')}>
            <FieldRow>
              <Field label={t('op.pmAddId')}>
                <input className="input" style={{ fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", width: '100%' }} value={form.modelKey} onChange={(e) => setForm({ ...form, modelKey: e.target.value })} />
              </Field>
              <Field label={t('op.pmEditName')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && handleSave()} />
              </Field>
            </FieldRow>
            <Field label={t('op.pmModelID')}>
              <input className="input" style={{ fontSize: 12, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", width: '100%' }} placeholder="gpt-5.2" value={form.modelID} onChange={(e) => setForm({ ...form, modelID: e.target.value })} />
            </Field>
          </FormSection>

          <FormSection title={t('form.capability')}>
            {/* same shape as the OCR source editor: a 3-up grid of
                switch + label, no extra per-field label */}
            <FieldRow columns={3}>
              <label className="form-switch">
                <Switch size="sm" checked={form.tools} onChange={(v) => setForm({ ...form, tools: v })} ariaLabel={t('models.badgeToolCall')} />
                {t('models.badgeToolCall')}
              </label>
              <label className="form-switch">
                <Switch size="sm" checked={form.reasoning} onChange={(v) => setForm({ ...form, reasoning: v })} ariaLabel={t('models.badgeReasoning')} />
                {t('models.badgeReasoning')}
              </label>
              <label className="form-switch">
                <Switch size="sm" checked={form.temperature} onChange={(v) => setForm({ ...form, temperature: v })} ariaLabel={t('op.pmTemperature')} />
                {t('op.pmTemperature')}
              </label>
            </FieldRow>
            <Field label={t('op.pmModalities')}>
              <ModalityPicker
                input={form.inputMod}
                output={form.outputMod}
                onChange={({ input, output }) => setForm({ ...form, inputMod: input, outputMod: output })}
                inputLabel={t('models.modalitiesInput')}
                outputLabel={t('models.modalitiesOutput')}
              />
            </Field>
          </FormSection>

          <FormSection title={t('form.limits')}>
            <FieldRow>
              <Field label={t('op.pmEditContext')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="200000" value={form.contextLimit} onChange={(e) => setForm({ ...form, contextLimit: e.target.value })} />
              </Field>
              <Field label={t('op.pmEditOutput')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="64000" value={form.outputLimit} onChange={(e) => setForm({ ...form, outputLimit: e.target.value })} />
              </Field>
            </FieldRow>
          </FormSection>

          <FormSection title={t('form.cost')}>
            <FieldRow columns={4}>
              <Field label={t('op.pmCostInput')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.00" value={form.costInput} onChange={(e) => setForm({ ...form, costInput: e.target.value })} />
              </Field>
              <Field label={t('op.pmCostOutput')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="15.00" value={form.costOutput} onChange={(e) => setForm({ ...form, costOutput: e.target.value })} />
              </Field>
              <Field label={t('op.pmCostCacheRead')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="0.30" value={form.costCacheRead} onChange={(e) => setForm({ ...form, costCacheRead: e.target.value })} />
              </Field>
              <Field label={t('op.pmCostCacheWrite')}>
                <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.75" value={form.costCacheWrite} onChange={(e) => setForm({ ...form, costCacheWrite: e.target.value })} />
              </Field>
            </FieldRow>
          </FormSection>

          <FormSection title={t('form.reasoning')}>
            <Field label={t('op.pmSettingsReasoning')}>
              <Combobox
                style={{ fontSize: 12, width: '100%', cursor: 'pointer', maxWidth: 220 }}
                value={form.reasoningEffort}
                onChange={(v) =>
                  setForm({ ...form, reasoningEffort: v, efforts: v && !form.efforts.includes(v) ? [...form.efforts, v] : form.efforts })
                }
                // picking a default auto-checks that level, so the default is
                // always one of the levels the model declares
                options={effortOptionList(t)}
              />
            </Field>
            <Field
              label={t('op.pmEfforts')}
              hint={!form.reasoning && defFlags.current.reasoning !== undefined ? t('models.reasoningOffHint') : undefined}
            >
              {/* un-checking the level the default points at clears the default */}
              <EffortChips
                value={form.efforts}
                onChange={(next) => setForm({ ...form, efforts: next, reasoningEffort: next.includes(form.reasoningEffort) ? form.reasoningEffort : '' })}
              />
            </Field>
            <Field label={t('op.pmReasoningField')}>
              <input className="input" style={{ fontSize: 12, width: '100%', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }} placeholder="reasoning_content" list="ocr-thinking-fields-m" value={form.reasoningField} onChange={(e) => setForm({ ...form, reasoningField: e.target.value })} />
              <datalist id="ocr-thinking-fields-m">
                <option value="reasoning" />
                <option value="reasoning_content" />
                <option value="reasoning_text" />
              </datalist>
            </Field>
          </FormSection>

          <FormSection title={t('form.variants')}>
            <VariantListEditor
              value={form.variants}
              onChange={(variants) => setForm({ ...form, variants })}
              addLabel={t('op.pmAdd')}
              removeLabel={t('op.pmRemoveVariant')}
              effortWidth={110}
            />
          </FormSection>

          <FormSection title={t('form.raw')}>
            <Field label={t('op.pmHeaders')}>
              <textarea className="input" style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", resize: 'vertical' }} placeholder={'X-Team: platform'} value={form.headersText} onChange={(e) => setForm({ ...form, headersText: e.target.value })} />
            </Field>
            <Field label={t('op.pmBody')}>
              <textarea className="input" style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", resize: 'vertical' }} placeholder={'{ "store": false }'} value={form.bodyText} onChange={(e) => setForm({ ...form, bodyText: e.target.value })} />
            </Field>
          </FormSection>
        </>
      )}
    </Dialog>
  );
};
