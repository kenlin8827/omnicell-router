import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  Terminal,
  Pencil,
  List,
  BarChart3,
  Info,
} from 'lucide-react';
import { api, type ApiKeyItem, type ApiKeyModelAccess } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { Pagination } from '../components/Pagination';

const KEY_PAGE_SIZE = 20;
const KEY_PAGE_SIZES = [10, 20, 50, 100, 200];


// Tier → i18n short-label key (rendered as "lite" / its localized short name in the tier column).
const TIER_LABEL_KEYS: Record<string, string> = {
  lite: 'apiKeys.tierLite',
  plus: 'apiKeys.tierPlus',
  pro: 'apiKeys.tierPro',
  ultra: 'apiKeys.tierUltra',
};

type AccessMode = 'none' | 'allow' | 'deny';

/** Chars permitted in a model-access entry: model ids plus the `*` wildcard.
 *  Client-side mirror of backend ENTRY_PATTERN (auth/model-access.ts). */
const ENTRY_PATTERN = /^[A-Za-z0-9._:/\-]+(\*[A-Za-z0-9._:/\-]*)*$/;

/**
 * Per-key model access editor — segmented mode buttons + multi-model picker.
 * Exact ids come from the gateway catalog Combobox; arbitrary `*` wildcard
 * patterns come from the free-text input (both land as removable chips,
 * pattern chips visually accented). The mode selector is a button group, not
 * a dropdown — three mutually exclusive choices don't need a popup.
 */
const ModelAccessPicker: React.FC<{
  mode: AccessMode;
  models: string[];
  gatewayModels: { id: string; owned_by: string }[];
  onModeChange: (m: AccessMode) => void;
  onModelsChange: (models: string[]) => void;
}> = ({ mode, models, gatewayModels, onModeChange, onModelsChange }) => {
  const { t } = useI18n();
  const [patternDraft, setPatternDraft] = useState('');
  const [patternError, setPatternError] = useState('');
  const hint =
    mode === 'none' ? t('apiKeys.accessModeNone') : mode === 'allow' ? t('apiKeys.accessModeAllow') : t('apiKeys.accessModeDeny');

  const addPattern = () => {
    const entry = patternDraft.trim();
    if (!entry) return;
    if (!ENTRY_PATTERN.test(entry)) {
      setPatternError(t('apiKeys.accessPatternInvalid'));
      return;
    }
    if (models.includes(entry)) {
      setPatternError(t('apiKeys.accessPatternDuplicate'));
      return;
    }
    setPatternError('');
    setPatternDraft('');
    onModelsChange([...models, entry]);
  };

  return (
    <div>
      <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
        {t('apiKeys.accessLabel')}
      </label>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {(
          [
            ['none', t('apiKeys.accessTabNone')],
            ['allow', t('apiKeys.accessTabAllow')],
            ['deny', t('apiKeys.accessTabDeny')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={`btn btn-sm ${mode === value ? 'btn-primary' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '6px 0 0 0' }}>{hint}</p>

      {mode !== 'none' && (
        <div style={{ marginTop: '8px' }}>
          <Combobox
            multiple
            clearable
            style={{ cursor: 'pointer' }}
            value={models}
            onChange={onModelsChange}
            options={gatewayModels.map((o) => ({ value: o.id, label: o.id, meta: o.owned_by }))}
            placeholder={t('apiKeys.accessAddPlaceholder')}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <input
              type="text"
              className="input"
              value={patternDraft}
              onChange={(e) => {
                setPatternDraft(e.target.value);
                setPatternError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addPattern();
                }
              }}
              placeholder={t('apiKeys.accessPatternPlaceholder')}
              style={{ flex: 1, fontSize: '12px', fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace" }}
            />
            <button type="button" onClick={addPattern} className="btn btn-sm" disabled={!patternDraft.trim()}>
              {t('apiKeys.accessPatternAdd')}
            </button>
          </div>
          {patternError && (
            <p style={{ fontSize: '11px', color: 'var(--accent-rose)', margin: '4px 0 0 0' }}>{patternError}</p>
          )}
          {models.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                marginTop: '8px',
                // Cap the chip wall — dozens of selections scroll inside instead
                // of stretching the modal.
                maxHeight: '132px',
                overflowY: 'auto',
              }}
            >
              {models.map((id) => (
                <span
                  key={id}
                  className="badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: id.includes('*') ? 'rgba(139, 92, 246, 0.12)' : 'var(--input-bg)',
                    border: id.includes('*') ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid var(--card-border)',
                    color: id.includes('*') ? 'var(--accent-violet)' : 'var(--text-main)',
                    fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
                    fontSize: '11px',
                    // Override .badge uppercase: model ids / patterns are
                    // case-SENSITIVE — displaying them uppercased misleads.
                    textTransform: 'none',
                    letterSpacing: 'normal',
                  }}
                  title={id.includes('*') ? t('apiKeys.accessPatternBadgeTitle') : undefined}
                >
                  {id}
                  <button
                    type="button"
                    onClick={() => onModelsChange(models.filter((m) => m !== id))}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 0, fontSize: '11px' }}
                    title={t('common.delete')}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const ApiKeysPage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Single 2s reset timer shared by the secret-copy button and the id
  // sub-line (latest click wins; cleared on unmount).
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Row-hover tracker for the subtle copy affordance next to the record id
  // (icon only surfaces while hovering the id, so the row keeps a single
  // always-visible copy button — the secret one in Actions).
  const [idHover, setIdHover] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formName, setFormName] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formAccessMode, setFormAccessMode] = useState<AccessMode>('none');
  const [formAccessModels, setFormAccessModels] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Edit key modal state (name / description / model access)
  const [editingKey, setEditingKey] = useState<ApiKeyItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editAccessMode, setEditAccessMode] = useState<AccessMode>('none');
  const [editAccessModels, setEditAccessModels] = useState<string[]>([]);
  const [savingAccess, setSavingAccess] = useState(false);

  // View-effective-models modal state + per-model live call test
  const [viewingKey, setViewingKey] = useState<ApiKeyItem | null>(null);
  const [viewModels, setViewModels] = useState< Awaited<ReturnType<typeof api.getKeyModels>> | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewFilter, setViewFilter] = useState('');
  const [testState, setTestState] = useState<Record<string, 'loading' | 'ok' | 'denied' | 'error'>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const openViewModels = async (item: ApiKeyItem) => {
    setViewingKey(item);
    setViewModels(null);
    setViewFilter('');
    setTestState({});
    setTestResult({});
    setViewLoading(true);
    try {
      setViewModels(await api.getKeyModels(item.id));
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
      setViewingKey(null);
    } finally {
      setViewLoading(false);
    }
  };

  // Fire one minimal real inference call WITH this key — the ground truth of
  // what the policy does (allowed → 200 + served model; denied → 403).
  const runModelTest = async (model: string) => {
    if (!viewingKey) return;
    setTestState((prev) => ({ ...prev, [model]: 'loading' }));
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewingKey.key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
      });
      if (res.ok) {
        const served = res.headers.get('X-OCR-Model') || '';
        setTestState((prev) => ({ ...prev, [model]: 'ok' }));
        setTestResult((prev) => ({ ...prev, [model]: `200${served ? ` · ${served}` : ''}` }));
      } else {
        const body = await res.json().catch(() => ({}));
        setTestState((prev) => ({ ...prev, [model]: res.status === 403 ? 'denied' : 'error' }));
        setTestResult((prev) => ({ ...prev, [model]: body?.error?.message || `HTTP ${res.status}` }));
      }
    } catch (err: any) {
      setTestState((prev) => ({ ...prev, [model]: 'error' }));
      setTestResult((prev) => ({ ...prev, [model]: err.message || 'network error' }));
    }
  };

  // Gateway model catalog — lazy-loaded when a picker first needs it.
  const [gatewayModels, setGatewayModels] = useState<{ id: string; owned_by: string }[]>([]);

  useEffect(() => {
    const pickerVisible =
      (showCreateModal && formAccessMode !== 'none') || (!!editingKey && editAccessMode !== 'none');
    if (!pickerVisible || gatewayModels.length > 0) return;
    api
      .listGatewayModels()
      .then(setGatewayModels)
      .catch(() => {});
  }, [showCreateModal, formAccessMode, editingKey, editAccessMode, gatewayModels.length]);

  // Newly created key display modal
  const [createdKey, setCreatedKey] = useState<ApiKeyItem | null>(null);
  const [newKeyCopied, setNewKeyCopied] = useState(false);

  // Quick Connect picker modal state — declared before useBodyScrollLock so the lock sees it.
  const [showPicker, setShowPicker] = useState(false);
  const [pickerKeyId, setPickerKeyId] = useState<string | null>(null);

  useBodyScrollLock(showCreateModal || !!createdKey || showPicker || !!editingKey || !!viewingKey);

  // Active tab for quick connect code examples (OpenAI + Anthropic + System One)
  const [connectTab, setConnectTab] = useState<
    'cursor' | 'claude' | 'python' | 'anthropic' | 'curl' | 'anthropic-curl' | 'systemone-curl'
  >('cursor');

  const [page, setPage] = useState(1);
  const [keyPageSize, setKeyPageSize] = useState(KEY_PAGE_SIZE);
  const pagedKeys = keys.slice((page - 1) * keyPageSize, page * keyPageSize);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const res = await api.getApiKeys();
      if (res.status === 'ok') {
        const next = res.keys || [];
        setKeys(next);
        // Drop a stale selection if the picked key was deleted or is now missing.
        setSelectedKeyId((cur) => (cur && next.some((k) => k.id === cur) ? cur : null));
        setPickerKeyId((cur) => (cur && next.some((k) => k.id === cur) ? cur : null));
      }
    } catch (err: any) {
      console.error('Failed to load api keys:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCopy = (text: string, id: string) => {
    // Non-secure contexts / denied permissions reject the clipboard promise —
    // surface it instead of swallowing the rejection silently.
    navigator.clipboard.writeText(text).catch(() => toast.error(t('common.failed')));
    // Single timer slot: a second click supersedes the first reset, so the
    // 2s green feedback of the LATEST click is never truncated by an earlier
    // timeout (id sub-line and secret button share this state).
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopiedId(id);
    copyTimer.current = setTimeout(() => setCopiedId(null), 2000);
  };
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const handleToggleShowSecret = (id: string) => {
    setShowSecret((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleToggleEnabled = async (item: ApiKeyItem) => {
    try {
      const nextState = !item.enabled;
      const res = await api.updateApiKey(item.id, { enabled: nextState });
      if (res.success) {
        setKeys((prev) => prev.map((k) => (k.id === item.id ? { ...k, enabled: nextState } : k)));
      } else {
        toast.error(res.error || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleDelete = async (item: ApiKeyItem) => {
    const confirmMsg = t('apiKeys.deleteConfirm').replace('{name}', item.name);
    const ok = await confirmDialog({ title: confirmMsg, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;

    try {
      const res = await api.deleteApiKey(item.id);
      if (res.success) {
        setKeys((prev) => prev.filter((k) => k.id !== item.id));
      } else {
        toast.error(res.error || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setErrorMessage(t('apiKeys.namePlaceholder'));
      return;
    }
    if (formAccessMode !== 'none' && formAccessModels.length === 0) {
      setErrorMessage(t('apiKeys.accessEmptyError'));
      return;
    }

    try {
      setCreating(true);
      setErrorMessage('');
      const modelAccess: ApiKeyModelAccess | undefined =
        formAccessMode === 'none' ? undefined : { mode: formAccessMode, models: formAccessModels };
      const res = await api.createApiKey({
        name: formName.trim(),
        key: formKey.trim() || undefined,
        description: formDesc.trim() || undefined,
        modelAccess,
      });

      if (res.success && res.data) {
        setCreatedKey(res.data);
        setShowCreateModal(false);
        setFormName('');
        setFormKey('');
        setFormDesc('');
        setFormAccessMode('none');
        setFormAccessModels([]);
        fetchKeys();
      } else {
        setErrorMessage(res.error || t('common.saveFailed'));
      }
    } catch (err: any) {
      setErrorMessage(err.message || t('common.saveFailed'));
    } finally {
      setCreating(false);
    }
  };

  const openEditKey = (item: ApiKeyItem) => {
    setEditingKey(item);
    setEditName(item.name);
    setEditDesc(item.description ?? '');
    setEditAccessMode(item.modelAccess?.mode ?? 'none');
    setEditAccessModels(item.modelAccess?.models ?? []);
  };

  const handleSaveEdit = async () => {
    if (!editingKey) return;
    if (!editName.trim()) {
      toast.error(t('apiKeys.namePlaceholder'));
      return;
    }
    if (editAccessMode !== 'none' && editAccessModels.length === 0) {
      toast.error(t('apiKeys.accessEmptyError'));
      return;
    }

    try {
      setSavingAccess(true);
      const modelAccess: ApiKeyModelAccess | null =
        editAccessMode === 'none' ? null : { mode: editAccessMode, models: editAccessModels };
      const res = await api.updateApiKey(editingKey.id, {
        name: editName.trim(),
        // empty string clears the description (PUT semantics: '' = set empty)
        description: editDesc.trim(),
        modelAccess,
      });
      if (res.success && res.data) {
        setKeys((prev) => prev.map((k) => (k.id === editingKey.id ? res.data! : k)));
        setEditingKey(null);
        toast.success(t('apiKeys.accessSaved'));
      } else {
        toast.error(res.error || t('common.saveFailed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.saveFailed'));
    } finally {
      setSavingAccess(false);
    }
  };

  const activeCount = keys.filter((k) => k.enabled).length;
  const isAuthProtected = keys.length > 0;

  // Quick Connect: never inline the real key unless the user explicitly reveals it.
  // Otherwise we render a locale placeholder so screenshots / shoulder-surf don't leak.
  // Single-key: reveal is one-click. Multi-key: a Modal picker forces an explicit choice.
  const [revealKey, setRevealKey] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const keyPlaceholder = t('apiKeys.quickConnectKeyPlaceholder');
  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;
  // The picker previews whatever the user has staged in the modal — independent of the committed selection.
  const pickerPreview = keys.find((k) => k.id === pickerKeyId) ?? null;
  const inlineKey =
    revealKey && selectedKey ? selectedKey.key : keyPlaceholder;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 1. Header Hero Card */}
      <div
        className="card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              background: 'var(--accent-bg)',
              border: '1px solid var(--accent-border)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <KeyRound size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-main)' }}>
              {t('apiKeys.title')}
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {t('apiKeys.desc')}
            </p>
          </div>
        </div>

        <button
          onClick={() => {
            setErrorMessage('');
            setShowCreateModal(true);
          }}
          className="btn btn-primary"
          style={{ padding: '9px 18px', fontSize: '13px' }}
        >
          <Plus size={16} />
          <span>{t('apiKeys.newKeyBtn')}</span>
        </button>
      </div>

      {/* 2. Metrics Statistics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.totalKeys')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '8px', color: 'var(--text-main)' }}>
            {keys.length}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.activeKeys')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '8px', color: 'var(--accent-emerald)' }}>
            {activeCount}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.authStatus')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
            {isAuthProtected ? (
              <>
                <ShieldCheck size={20} color="var(--accent-emerald)" />
                <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-emerald)' }}>
                  {t('apiKeys.authProtected')}
                </span>
              </>
            ) : (
              <>
                <ShieldAlert size={20} color="var(--accent-amber)" />
                <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-amber)' }}>
                  {t('apiKeys.authOpen')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 3. Keys Table Container */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
            {t('common.loading')}
          </div>
        ) : keys.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                background: 'var(--chip-bg)',
                color: 'var(--text-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px auto',
              }}
            >
              <KeyRound size={24} />
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-main)' }}>
              {t('apiKeys.emptyTitle')}
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '420px', margin: '4px auto 16px auto' }}>
              {t('apiKeys.emptyDesc')}
            </p>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary btn-sm">
              <Plus size={14} />
              <span>{t('apiKeys.newKeyBtn')}</span>
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', minHeight: 260 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--bg-elev)',
                    borderBottom: '1px solid var(--divider)',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <th style={{ padding: '12px 20px', whiteSpace: 'nowrap' }}>{t('apiKeys.thName')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thKey')}</th>
                  <th style={{ padding: '12px 20px', whiteSpace: 'nowrap' }}>{t('apiKeys.thAccess')}</th>
                  <th style={{ padding: '12px 20px', whiteSpace: 'nowrap' }}>{t('apiKeys.thStatus')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thCreated')}</th>
                  <th style={{ padding: '12px 20px', textAlign: 'right' }}>{t('apiKeys.thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedKeys.map((item) => {
                  const isVisible = showSecret[item.id];
                  const displayKey = isVisible
                    ? item.key
                    : item.key.slice(0, 8) + '••••••••' + item.key.slice(-4);

                  return (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: '1px solid var(--divider)',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      {/* Name & Desc */}
                      <td style={{ padding: '14px 20px' }}>
                        <div
                          style={{
                            fontWeight: 700,
                            color: 'var(--text-main)',
                            // Squeezed columns must not wrap CJK names into a
                            // 2-char-per-line vertical strip — truncate instead.
                            whiteSpace: 'nowrap',
                            maxWidth: 260,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={item.name}
                        >
                          {item.name}
                        </div>
                        {/* Stable record id (`key-<8hex>`) — the join key that
                            capture/session-log attribution carries, so an
                            archived request can be traced back to this row.
                            Non-secret; click-to-copy (same discipline as the
                            Sessions page id) with a hover-revealed copy icon
                            for discoverability. */}
                        <div
                          title={t('apiKeys.idCopyHint')}
                          onClick={() => handleCopy(item.id, `id:${item.id}`)}
                          onMouseEnter={() => setIdHover(item.id)}
                          onMouseLeave={() => setIdHover(cur => (cur === item.id ? null : cur))}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '11px',
                            fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                            color:
                              copiedId === `id:${item.id}` ? 'var(--accent-emerald)' : 'var(--text-dim)',
                            cursor: 'copy',
                            marginTop: '2px',
                          }}
                        >
                          {item.id}
                          {idHover === item.id || copiedId === `id:${item.id}` ? (
                            copiedId === `id:${item.id}` ? <Check size={11} /> : <Copy size={11} />
                          ) : null}
                        </div>
                        {item.description && (
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text-dim)',
                              marginTop: '2px',
                              whiteSpace: 'nowrap',
                              maxWidth: 260,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={item.description}
                          >
                            {item.description}
                          </div>
                        )}
                      </td>

                      {/* Secret Key Display */}
                      <td style={{ padding: '14px 20px', fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '8px',
                            background: 'var(--well-bg)',
                            border: '1px solid var(--card-border)',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            color: 'var(--text-main)',
                          }}
                        >
                          <span>{displayKey}</span>
                          <button
                            onClick={() => handleToggleShowSecret(item.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-dim)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '2px',
                            }}
                            title={t('apiKeys.toggleVisTooltip')}
                          >
                            {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            onClick={() => handleCopy(item.key, item.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: copiedId === item.id ? 'var(--accent-emerald)' : 'var(--text-dim)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '2px',
                            }}
                            title={t('apiKeys.copyKeyTooltip')}
                          >
                            {copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                      </td>

                      {/* Model Access */}
                      <td style={{ padding: '14px 20px' }}>
                        <span
                          className="badge"
                          style={{
                            background: item.modelAccess
                              ? item.modelAccess.mode === 'allow'
                                ? 'rgba(16, 185, 129, 0.12)'
                                : 'rgba(245, 158, 11, 0.12)'
                              : 'var(--chip-bg)',
                            color: item.modelAccess
                              ? item.modelAccess.mode === 'allow'
                                ? 'var(--accent-emerald)'
                                : 'var(--accent-amber)'
                              : 'var(--text-muted)',
                            border: '1px solid var(--card-border)',
                          }}
                        >
                          {!item.modelAccess
                            ? t('apiKeys.accessAllBadge')
                            : item.modelAccess.mode === 'allow'
                              ? t('apiKeys.accessAllowBadge', { n: item.modelAccess.models.length })
                              : t('apiKeys.accessDenyBadge', { n: item.modelAccess.models.length })}
                        </span>
                      </td>

                      {/* Status switch */}
                      <td style={{ padding: '14px 20px' }}>
                        <button
                          onClick={() => handleToggleEnabled(item)}
                          className={item.enabled ? 'badge badge-success' : 'badge'}
                          style={{
                            cursor: 'pointer',
                            border: '1px solid',
                            borderColor: item.enabled ? 'rgba(16, 185, 129, 0.3)' : 'var(--card-border)',
                            background: item.enabled ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface-hover)',
                            color: item.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)',
                          }}
                          title={item.enabled ? t('apiKeys.enableTooltip') : t('apiKeys.disableTooltip')}
                        >
                          <span
                            className={item.enabled ? 'dot-pulse' : ''}
                            style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: item.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)',
                              display: 'inline-block',
                            }}
                          />
                          <span>{item.enabled ? t('apiKeys.statusActive') : t('apiKeys.statusDisabled')}</span>
                        </button>
                      </td>

                      {/* Created At */}
                      <td style={{ padding: '14px 20px', fontSize: '11px', color: 'var(--text-dim)' }}>
                        {new Date(item.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: '14px 20px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => navigate(`/usage?key=${encodeURIComponent(item.id)}`)}
                          className="btn btn-sm"
                          style={{ padding: '4px 8px', marginRight: '6px' }}
                          title={t('apiKeys.viewUsageTooltip')}
                        >
                          <BarChart3 size={13} />
                        </button>
                        <button
                          onClick={() => openViewModels(item)}
                          className="btn btn-sm"
                          style={{ padding: '4px 8px', marginRight: '6px' }}
                          title={t('apiKeys.viewModelsTooltip')}
                        >
                          <List size={13} />
                        </button>
                        <button
                          onClick={() => openEditKey(item)}
                          className="btn btn-sm"
                          style={{ padding: '4px 8px', marginRight: '6px' }}
                          title={t('apiKeys.editTooltip')}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(item)}
                          className="btn btn-danger btn-sm"
                          style={{ padding: '4px 8px' }}
                          title={t('apiKeys.deleteTooltip')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {keys.length > 0 && (
          <div style={{ padding: '0 20px 16px' }}>
            <Pagination
              page={page}
              pageSize={keyPageSize}
              total={keys.length}
              onChange={setPage}
              showSummary
              pageSizeOptions={KEY_PAGE_SIZES}
              onPageSizeChange={(s) => { setKeyPageSize(s); setPage(1); }}
            />
          </div>
        )}
      </div>

      {/* 4. Quick Connect Integration Card */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={18} color="var(--accent)" />
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)' }}>
              {t('apiKeys.quickConnectTitle')}
            </h2>
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {(
              [
                ['cursor', 'Cursor / IDE'],
                ['python', 'Python · OpenAI'],
                ['curl', 'cURL · OpenAI'],
                ['claude', 'Claude Code'],
                ['anthropic', 'Python · Anthropic'],
                ['anthropic-curl', 'cURL · Anthropic'],
                ['systemone-curl', 'cURL · System One'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setConnectTab(tab)}
                className={`btn btn-sm ${connectTab === tab ? 'btn-primary' : ''}`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                if (keys.length === 0) return;
                // Single-key: skip the picker, reveal immediately.
                if (keys.length === 1) {
                  setSelectedKeyId(keys[0].id);
                  setRevealKey(true);
                  return;
                }
                // Multi-key: open the picker modal, pre-selecting the current pick (or none).
                setPickerKeyId(selectedKey?.id ?? null);
                setShowPicker(true);
              }}
              title={keys.length === 0
                ? t('apiKeys.quickConnectPickerNoKeysTitle')
                : t('apiKeys.quickConnectRevealShowTitle')}
              className="btn btn-sm"
              style={{ marginLeft: '4px' }}
              disabled={keys.length === 0}
            >
              <Eye size={14} />
              <span style={{ marginLeft: '4px' }}>{t('apiKeys.quickConnectRevealShow')}</span>
            </button>
            {revealKey && selectedKey && (
              <button
                type="button"
                onClick={() => setRevealKey(false)}
                title={t('apiKeys.quickConnectRevealHideTitle')}
                className="btn btn-sm"
                style={{ marginLeft: '4px' }}
              >
                <EyeOff size={14} />
                <span style={{ marginLeft: '4px' }}>{t('apiKeys.quickConnectRevealHide')}</span>
              </button>
            )}
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {t('apiKeys.quickConnectDesc')}
        </p>

        {keys.length > 0 && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-dim)',
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              lineHeight: 1.5,
            }}
          >
            {selectedKey && revealKey
              ? t('apiKeys.quickConnectSecurityNotice', {
                  placeholder: keyPlaceholder,
                  prefix: selectedKey.key.slice(0, 10),
                  suffix: selectedKey.key.slice(-4),
                })
              : keys.length > 1
                ? t('apiKeys.quickConnectNeedPickNotice', {
                    count: keys.length,
                    action: t('apiKeys.quickConnectRevealShow'),
                  })
                : t('apiKeys.quickConnectSingleKeyNotice', {
                    placeholder: keyPlaceholder,
                    action: t('apiKeys.quickConnectRevealShow'),
                  })}
          </div>
        )}

        <pre
          style={{
            background: 'var(--well-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: '8px',
            padding: '16px',
            fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
            fontSize: '12px',
            color: 'var(--text-main)',
            overflowX: 'auto',
            lineHeight: 1.6,
          }}
        >
          {connectTab === 'cursor' && (
`# 1. 打开 Cursor -> Settings -> Models -> OpenAI API Key
# 2. 勾选 "Override OpenAI Base URL"，填入：
http://127.0.0.1:3000/v1

# 3. 在 API Key 中填入上方配发的客户端 API Key：
${inlineKey}

# 4. 模型名称选择或添加：
#    虚拟分流模型：auto / auto-lite / auto-plus / auto-pro / auto-ultra
#    或具体模型（完整 ID）：opencode/claude-sonnet-5-5、opencode/gpt-6-sol、opencode/glm-5.3`
          )}

          {connectTab === 'python' && (
`from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="${inlineKey}"
)

response = client.chat.completions.create(
    model="auto", # 智能分流：auto / auto-lite / auto-plus / auto-pro / auto-ultra
    messages=[{"role": "user", "content": "Hello OCR Gateway!"}]
)

print(response.choices[0].message.content)`
          )}

          {connectTab === 'curl' && (
`curl http://127.0.0.1:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${inlineKey}" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Ping!"}]
  }'`
          )}

          {connectTab === 'claude' && (
`# 1. 设置环境变量（或写入 ~/.claude/settings.json 的 "env" 字段）：
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=${inlineKey}

# 2. 可选：默认模型（auto = 智能分流，也可 auto-lite / auto-plus / auto-pro / auto-ultra）
export ANTHROPIC_MODEL=auto

# 3. 正常启动 claude 即可。Claude Code 的请求将自动走网关的
#    Anthropic 协议端点：POST {ANTHROPIC_BASE_URL}/v1/messages
#    （鉴权兼容 x-api-key 与 Authorization: Bearer 两种头）`
          )}

          {connectTab === 'anthropic' && (
`from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:3000",  # SDK 自动拼接 /v1/messages
    api_key="${inlineKey}"
)

message = client.messages.create(
    model="auto", # 智能分流：auto / auto-lite / auto-plus / auto-pro / auto-ultra
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello OCR Gateway!"}]
)

print(message.content[0].text)`
          )}

          {connectTab === 'anthropic-curl' && (
`curl http://127.0.0.1:3000/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${inlineKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Ping!"}]
  }'`
          )}

          {connectTab === 'systemone-curl' && (
`# System One 决策协议端点：state + 类型化问题 → 类型化答案（不走 chat 级联）
# 上游二选一：任意已注册模型（网关自动做协议转换），或原生决策模型
#（config.yaml 里配 providers[].type: systemone，如 TypeSafe Jev / 百炼决策模型）
# model 填已注册模型 ID；配置了 systemone.defaultModel 后可直接用 auto
curl http://127.0.0.1:3000/v1/systemone \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${inlineKey}" \\
  -d '{
    "model": "auto",
    "state": "订单支付后超过 24 小时未到账，用户要求立即处理",
    "questions": {
      "department": {"type": "choice", "instructions": "应该由哪个团队处理？", "criteria": {"billing": "支付、退款和账单问题", "technical": "产品故障和集成问题"}},
      "urgent":     {"type": "noul",   "instructions": "是否需要立即通知值班人员？"},
      "severity":   {"type": "score",  "instructions": "这个问题有多严重？", "criteria": ["轻微问题", "部分功能受影响", "核心功能不可用"]}
    }
  }'`
          )}
        </pre>
      </div>

      {/* 4b. Modal: pick which API key to ship in the snippets */}
      {showPicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('apiKeys.quickConnectPickerTitle')}
          onClick={(e) => {
            // Backdrop click closes the picker without picking anything.
            if (e.target === e.currentTarget) setShowPicker(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            zIndex: 110,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '520px',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '18px 22px',
                borderBottom: '1px solid var(--divider)',
              }}
            >
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.quickConnectPickerTitle')}
              </h3>
              <button
                type="button"
                aria-label={t('apiKeys.quickConnectPickerCancel')}
                onClick={() => setShowPicker(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-dim)',
                  fontSize: '18px',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            <p
              style={{
                padding: '14px 22px 0',
                fontSize: '12px',
                color: 'var(--text-muted)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {t('apiKeys.quickConnectPickerDesc', { count: keys.length })}
            </p>

            <div
              style={{
                padding: '14px 22px',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                minHeight: 0,
              }}
            >
              {/* Combobox scales to 100+ keys: options > 8 auto-renders a filter input (see Combobox.tsx). */}
              <Combobox
                value={pickerKeyId ?? ''}
                onChange={(v) => setPickerKeyId(v || null)}
                placeholder={t('apiKeys.quickConnectPickerSearchPlaceholder')}
                options={keys.map((k) => ({
                  value: k.id,
                  label: `${k.name}  ·  ${k.key.slice(0, 8)}…${k.key.slice(-4)}`,
                  meta: k.enabled ? t('apiKeys.statusActive') : t('apiKeys.statusDisabled'),
                }))}
                clearable
                forceFilter
              />

              {pickerPreview && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'var(--well-bg)',
                    border: '1px solid var(--card-border)',
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--text-main)', marginBottom: '4px' }}>
                    {pickerPreview.name}
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
                      fontSize: '11px',
                      color: 'var(--text-dim)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {pickerPreview.key}
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 22px',
                borderTop: '1px solid var(--divider)',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowPicker(false)}
                >
                  {t('apiKeys.quickConnectPickerCancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!pickerPreview}
                  onClick={() => {
                    if (!pickerPreview) return;
                    setSelectedKeyId(pickerPreview.id);
                    setRevealKey(true);
                    setShowPicker(false);
                  }}
                >
                  <Check size={13} />
                  <span style={{ marginLeft: '4px' }}>{t('apiKeys.quickConnectPickerConfirm')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. Modal: Create API Key */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.createModalTitle')}
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'rgba(244, 63, 94, 0.15)', border: '1px solid rgba(244, 63, 94, 0.3)', color: 'var(--accent-rose)', fontSize: '12px' }}>
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleCreateSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.nameLabel')} <span style={{ color: 'var(--accent-rose)' }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('apiKeys.namePlaceholder')}
                  className="input"
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.customKeyLabel')}
                </label>
                <input
                  type="text"
                  value={formKey}
                  onChange={(e) => setFormKey(e.target.value)}
                  placeholder={t('apiKeys.customKeyPlaceholder')}
                  className="input"
                />
              </div>

              <ModelAccessPicker
                mode={formAccessMode}
                models={formAccessModels}
                gatewayModels={gatewayModels}
                onModeChange={setFormAccessMode}
                onModelsChange={setFormAccessModels}
              />

              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.descLabel')}
                </label>
                <textarea
                  rows={2}
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder={t('apiKeys.descPlaceholder')}
                  className="input"
                  style={{ resize: 'none' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} className="btn">
                  {t('apiKeys.cancelBtn')}
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? t('common.loading') : t('apiKeys.createBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5a. Modal: View effective models for one key + live call test */}
      {viewingKey && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('apiKeys.viewModelsTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setViewingKey(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '560px',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.viewModelsTitle')}
              </h3>
              <button
                onClick={() => setViewingKey(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {viewingKey.name}
              <span
                className="badge"
                style={{
                  marginLeft: '8px',
                  background: viewModels
                    ? viewModels.mode === 'allow'
                      ? 'rgba(16, 185, 129, 0.12)'
                      : viewModels.mode === 'deny'
                        ? 'rgba(245, 158, 11, 0.12)'
                        : 'var(--chip-bg)'
                    : 'var(--chip-bg)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--card-border)',
                }}
              >
                {!viewModels || viewModels.mode === 'none'
                  ? t('apiKeys.accessAllBadge')
                  : viewModels.mode === 'allow'
                    ? t('apiKeys.accessAllowBadge', { n: viewModels.policyModels.length })
                    : t('apiKeys.accessDenyBadge', { n: viewModels.policyModels.length })}
              </span>
              {/* Test-call hint lives on hover only — zero floor space. */}
              <span title={t('apiKeys.modelsTestHint')} style={{ flexShrink: 0, cursor: 'help', display: 'inline-flex', verticalAlign: '-2px' }}>
                <Info size={13} color="var(--text-dim)" />
              </span>
            </p>

            {viewLoading || !viewModels ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                {t('common.loading')}
              </div>
            ) : (
              (() => {
                const q = viewFilter.trim().toLowerCase();
                const matches = (m: { id: string; provider: string; tier: string }) =>
                  !q ||
                  m.id.toLowerCase().includes(q) ||
                  m.provider.toLowerCase().includes(q) ||
                  (m.tier || '').toLowerCase().includes(q);
                const allowed = viewModels.models.filter((m) => m.allowed && matches(m));
                const denied = viewModels.models.filter((m) => !m.allowed && matches(m));
                // Grid columns: id takes the remaining width; tier & result are
                // content-sized (auto) so they hug the right-side button cluster —
                // no fixed-width voids in between.
                const rowGrid: React.CSSProperties = {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) auto auto 44px',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '5px 8px',
                  borderBottom: '1px solid var(--divider)',
                };
                const renderRow = (m: { id: string; provider: string; tier: string; virtual: boolean }) => {
                  const st = testState[m.id];
                  return (
                    <div key={m.id} style={rowGrid}>
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
                          fontSize: '12px',
                          color: 'var(--text-main)',
                        }}
                      >
                        {m.id}
                      </span>
                      <span
                        title={m.tier ? t('apiKeys.modelsTierTitle', { tier: m.tier }) : undefined}
                        style={{
                          fontSize: '10px',
                          color: 'var(--text-dim)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.tier ? `${m.tier}·${t(TIER_LABEL_KEYS[m.tier] ?? '')}` : ''}
                      </span>
                      <span
                        title={testResult[m.id]}
                        style={{
                          fontSize: '11px',
                          maxWidth: '150px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          justifySelf: 'end',
                        }}
                      >
                        {st === 'loading' && <span style={{ color: 'var(--text-dim)' }}>…</span>}
                        {st === 'ok' && <span style={{ color: 'var(--accent-emerald)' }}>✓ {testResult[m.id]}</span>}
                        {st === 'denied' && <span style={{ color: 'var(--accent-amber)' }}>✗ {testResult[m.id]}</span>}
                        {st === 'error' && <span style={{ color: 'var(--accent-rose)' }}>✗ {testResult[m.id]}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => runModelTest(m.id)}
                        disabled={st === 'loading'}
                        className="btn btn-sm"
                        style={{ padding: '2px 8px', fontSize: '11px', justifySelf: 'end' }}
                      >
                        {t('apiKeys.modelsTestBtn')}
                      </button>
                    </div>
                  );
                };
                return (
                  <>
                    <input
                      type="text"
                      className="input"
                      value={viewFilter}
                      onChange={(e) => setViewFilter(e.target.value)}
                      placeholder={t('apiKeys.viewModelsSearchPlaceholder')}
                      style={{ fontSize: '12px', flexShrink: 0 }}
                    />
                    {allowed.length === 0 && denied.length === 0 && (
                      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                        {t('common.noResults')}
                      </div>
                    )}
                    {allowed.length > 0 && (
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent-emerald)', marginBottom: '6px' }}>
                          {t('apiKeys.modelsAllowedGroup', { n: allowed.length })}
                        </div>
                        <div style={{ maxHeight: '240px', overflowY: 'auto' }}>{allowed.map(renderRow)}</div>
                      </div>
                    )}
                    {denied.length > 0 && (
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', marginBottom: '6px' }}>
                          {t('apiKeys.modelsDeniedGroup', { n: denied.length })}
                        </div>
                        <div style={{ maxHeight: '160px', overflowY: 'auto' }}>{denied.map(renderRow)}</div>
                      </div>
                    )}
                  </>
                );
              })()
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button onClick={() => setViewingKey(null)} className="btn btn-primary">
                {t('apiKeys.doneBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5b. Modal: Edit API Key (name / description / model access) */}
      {editingKey && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('apiKeys.editModalTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingKey(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.editModalTitle')}
              </h3>
              <button
                onClick={() => setEditingKey(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div>
              <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                {t('apiKeys.nameLabel')} <span style={{ color: 'var(--accent-rose)' }}>*</span>
              </label>
              <input
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t('apiKeys.namePlaceholder')}
                className="input"
              />
            </div>

            <ModelAccessPicker
              mode={editAccessMode}
              models={editAccessModels}
              gatewayModels={gatewayModels}
              onModeChange={setEditAccessMode}
              onModelsChange={setEditAccessModels}
            />

            <div>
              <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                {t('apiKeys.descLabel')}
              </label>
              <textarea
                rows={2}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder={t('apiKeys.descPlaceholder')}
                className="input"
                style={{ resize: 'none' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
              <button onClick={() => setEditingKey(null)} className="btn">
                {t('apiKeys.cancelBtn')}
              </button>
              <button onClick={handleSaveEdit} disabled={savingAccess} className="btn btn-primary">
                {savingAccess ? t('common.loading') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. Modal: Key Created Success Alert */}
      {createdKey && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: 'rgba(16, 185, 129, 0.15)',
                  color: 'var(--accent-emerald)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Check size={18} />
              </div>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.createdNoticeTitle')}
              </h3>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {t('apiKeys.createdNoticeDesc')}
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                background: 'var(--well-bg)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                padding: '10px 14px',
                borderRadius: '8px',
                fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
                fontSize: '12px',
                color: 'var(--accent-emerald)',
                wordBreak: 'break-all',
              }}
            >
              <span>{createdKey.key}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey.key);
                  setNewKeyCopied(true);
                  setTimeout(() => setNewKeyCopied(false), 2000);
                }}
                className="btn btn-sm"
                title={t('apiKeys.copyKeyTooltip')}
              >
                {newKeyCopied ? <Check size={14} color="var(--accent-emerald)" /> : <Copy size={14} />}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
              <button onClick={() => setCreatedKey(null)} className="btn btn-primary">
                {t('apiKeys.doneBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
