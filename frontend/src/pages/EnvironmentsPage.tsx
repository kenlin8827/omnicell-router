import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Download,
  Check,
  FolderCog,
  Loader2,
  PackageOpen,
  PencilRuler,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  api,
  EnvApiError,
  ENV_ARCHIVE_FORMAT,
  ENV_ARCHIVE_VERSION,
  ENV_IMPORT_BODY_LIMIT_BYTES,
  type AdminEnvironment,
  type AdminEnvTemplate,
  type AdminEnvType,
  type EnvironmentsListResponse,
  type EnvArchiveManifest,
} from '../lib/api';
import { strFromU8, unzipSync } from 'fflate';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Dialog } from '../components/Dialog';
import { Field } from '../components/Form';
import { Combobox } from '../components/Combobox';
import { Switch } from '../components/Switch';

// Mirrors backend ENV_NAME_RE (backend/src/config/env.ts) — case-insensitive
// on purpose: the gateway accepts "Staging" and lower-cases it on disk.
const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
// Mirrors backend RESERVED_NAMES = [DEFAULT_ENV_NAME, POINTER_FILE].
const RESERVED_ENV_NAMES = ['default', 'current'];
// Backend DEFAULT_ENV_NAME — the bootstrap environment (never editable).
const BOOTSTRAP_DEFAULT_ENV = 'default';

/**
 * Payload files the export dialog offers as checkboxes. config.yaml is NOT in
 * this list — it is the book-set definition itself and always included. Raw
 * training data (flywheel + layer2 decisions) defaults OFF: conversation-
 * derived and potentially large; the trained model and the custom catalog
 * default ON (small, knowledge-shaped). Keys mirror backend PAYLOAD_KEYS
 * (backend/src/config/env-archive.ts) — the backend ignores unknown keys.
 */
const ARCHIVE_PAYLOAD_OPTIONS: Array<{ key: string; i18nKey: string; defaultOn: boolean }> = [
  { key: 'models/layer1-classifier.json', i18nKey: 'env.export.payloadClassifier', defaultOn: true },
  { key: 'catalog/custom.json', i18nKey: 'env.export.payloadCustom', defaultOn: true },
  { key: 'catalog/overrides.json', i18nKey: 'env.export.payloadOverrides', defaultOn: true },
  { key: 'data/flywheel.jsonl', i18nKey: 'env.export.payloadFlywheel', defaultOn: false },
  { key: 'data/layer2-decisions.jsonl', i18nKey: 'env.export.payloadDecisions', defaultOn: false },
];

const defaultExportInclude = (): Record<string, boolean> =>
  Object.fromEntries(ARCHIVE_PAYLOAD_OPTIONS.map((o) => [o.key, o.defaultOn]));

// Legacy imports (pre-structured provenance) store the generated English
// sentence in description — match it back so old book-sets localize too.
// Any other description is operator text and renders verbatim.
const LEGACY_IMPORTED_DESC_RE = /^imported from "(.+)" \(OCR (.+)\)$/;

/** The provenance line under the env name: operator description wins, else localized import stamp. */
function envProvenance(
  e: AdminEnvironment,
  t: (path: string, params?: Record<string, string | number>) => string
): string | null {
  if (e.description) {
    const m = LEGACY_IMPORTED_DESC_RE.exec(e.description);
    return m ? t('env.importedFrom', { name: m[1], version: m[2] }) : e.description;
  }
  return e.importedFrom
    ? t('env.importedFrom', { name: e.importedFrom.name, version: e.importedFrom.appVersion })
    : null;
}

const MONO = "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace";
const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

const TH_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-dim)',
  textAlign: 'left',
  padding: '8px 10px',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: '11px 10px',
  fontSize: 12.5,
  color: 'var(--text-main)',
  // Name cells can grow a second line (description) — keep the other cells
  // centered against the tallest one instead of pinned to the top.
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--divider)',
};

/** Parsed archive fields the import panel shows before anything is POSTed. */
interface ArchiveSummary {
  sourceName: string;
  sourceType: AdminEnvType;
  appVersion: string;
  secrets: string;
  redactedCount: number;
  payloadKeys: string[];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/**
 * Environment admin: list / create / rename / trash /
 * sandbox-reset / export / import, plus the pointer-switch flow that hands the
 * gateway over to a replacement process bound to another book-set.
 *
 * The switch is the only destructive-ish action here: it restarts the process
 * serving this page, so the flow mirrors Layout's handleRestartGateway —
 * confirm → POST → poll /health → reload (or jump origin when the target env
 * listens on a different port).
 */
export const EnvironmentsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();

  const [data, setData] = useState<EnvironmentsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [switching, setSwitching] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cType, setCType] = useState<AdminEnvType>('regular');
  const [cTemplate, setCTemplate] = useState<AdminEnvTemplate>('blank');
  const [cDesc, setCDesc] = useState('');
  const [cError, setCError] = useState('');
  const [cSubmitting, setCSubmitting] = useState(false);

  const [renameTarget, setRenameTarget] = useState<AdminEnvironment | null>(null);
  const [rName, setRName] = useState('');
  const [rDesc, setRDesc] = useState('');
  const [rError, setRError] = useState('');
  const [rSubmitting, setRSubmitting] = useState(false);

  const [exportTarget, setExportTarget] = useState<AdminEnvironment | null>(null);
  const [exportSecrets, setExportSecrets] = useState(false);
  const [exportInclude, setExportInclude] = useState<Record<string, boolean>>(defaultExportInclude);
  const [exportEncrypt, setExportEncrypt] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [importEncrypted, setImportEncrypted] = useState(false);
  const [iPassword, setIPassword] = useState('');
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [iName, setIName] = useState('');
  const [iError, setIError] = useState('');
  const [iConflict, setIConflict] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getEnvironments());
      setLoadError('');
    } catch (err: any) {
      // Store the raw text only; the localized prefix is applied at render so
      // `load` stays free of `t` (and therefore stable across re-renders).
      setLoadError(String(err?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const list = data?.environments ?? [];
    return typeFilter === 'all' ? list : list.filter((e) => e.type === typeFilter);
  }, [data, typeFilter]);

  const runningName = data?.running ?? '';
  const pointerName = data?.current ?? '';
  const pendingRestart = !!data && pointerName !== runningName;
  const runningEnv = data?.environments.find((e) => e.name === runningName);

  // Localized headline for the known HTTP statuses; the backend message is
  // always appended because it names the exact rule that failed.
  const errorText = (err: unknown, byStatus: Record<number, string>): string => {
    const e = err as EnvApiError;
    const detail = e?.message || t('common.failed');
    const key = typeof e?.status === 'number' ? byStatus[e.status] : undefined;
    return key ? `${t(key)} — ${detail}` : detail;
  };

  const nameProblem = (raw: string): string => {
    const name = raw.trim();
    if (!ENV_NAME_RE.test(name)) return t('env.nameInvalid');
    if (RESERVED_ENV_NAMES.includes(name.toLowerCase())) return t('env.nameReserved');
    return '';
  };

  /* ─── Mutations ────────────────────────────────────────────────────────── */

  const closeCreate = () => {
    setCreateOpen(false);
    setCName('');
    setCType('regular');
    setCTemplate('blank');
    setCDesc('');
    setCError('');
  };

  const submitCreate = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const problem = nameProblem(cName);
    if (problem) {
      setCError(problem);
      return;
    }
    setCError('');
    setCSubmitting(true);
    try {
      await api.createEnvironment({
        name: cName.trim(),
        type: cType,
        template: cTemplate,
        description: cDesc.trim() || undefined,
      });
      toast.success(t('env.createdOk', { name: cName.trim() }));
      closeCreate();
      await load();
    } catch (err) {
      // Keep the dialog open: create failures are almost always the name.
      setCError(errorText(err, { 400: 'env.error.nameInvalid', 409: 'env.error.nameTaken' }));
    } finally {
      setCSubmitting(false);
    }
  };

  const openRename = (e: AdminEnvironment) => {
    setRenameTarget(e);
    setRName(e.name);
    setRDesc(e.description ?? '');
    setRError('');
  };

  const submitRename = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!renameTarget) return;
    const name = rName.trim();
    const problem = nameProblem(name);
    if (problem) {
      setRError(problem);
      return;
    }
    setRError('');
    setRSubmitting(true);
    try {
      await api.updateEnvironment(renameTarget.name, { name, description: rDesc.trim() || null });
      toast.success(t('env.savedOk'));
      setRenameTarget(null);
      await load();
    } catch (err) {
      const e = err as EnvApiError;
      // This route answers 409 for BOTH "target name taken" and "env is
      // running"; the backend text disambiguates.
      if (e?.status === 409 && /already exists/i.test(e.message ?? '')) {
        setRError(`${t('env.error.nameTaken')} — ${e.message}`);
      } else {
        setRError(
          errorText(err, { 400: 'env.error.cannotModifyDefault', 409: 'env.error.cannotModifyRunning' }),
        );
      }
    } finally {
      setRSubmitting(false);
    }
  };

  const handleDelete = async (e: AdminEnvironment) => {
    const ok = await confirmDialog({
      title: t('env.delete.confirmTitle', { name: e.name }),
      description: `${t('env.delete.confirmBody')} ${t('env.trashNote')}`,
      confirmLabel: t('env.delete.confirmLabel'),
      danger: true,
    });
    if (!ok) return;
    setBusy(e.name);
    try {
      await api.deleteEnvironment(e.name);
      toast.success(t('env.deletedOk', { name: e.name }));
      await load();
    } catch (err) {
      toast.error(
        errorText(err, { 400: 'env.error.cannotModifyDefault', 409: 'env.error.cannotModifyRunning' }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async (e: AdminEnvironment) => {
    const ok = await confirmDialog({
      title: t('env.reset.confirmTitle', { name: e.name }),
      description: t('env.reset.confirmBody'),
      confirmLabel: t('env.reset.confirmLabel'),
      danger: true,
    });
    if (!ok) return;
    setBusy(e.name);
    try {
      await api.resetEnvironment(e.name);
      toast.success(t('env.resetOk', { name: e.name }));
      await load();
    } catch (err) {
      toast.error(
        errorText(err, { 400: 'env.error.cannotModifyDefault', 409: 'env.error.cannotModifyRunning' }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    if (!exportTarget) return;
    if (exportEncrypt) {
      if (exportPassword.length === 0) {
        setExportError(t('env.export.passwordRequired'));
        return;
      }
      if (exportPassword !== exportPasswordConfirm) {
        setExportError(t('env.export.passwordMismatch'));
        return;
      }
    }
    setExportError('');
    setExporting(true);
    try {
      const include = ARCHIVE_PAYLOAD_OPTIONS.filter((o) => exportInclude[o.key]).map((o) => o.key);
      const { blob, filename } = await api.exportEnvironment(exportTarget.name, {
        // Encrypted implies plaintext keys inside the encrypted layer (the
        // backend enforces the same rule — UI mirrors it with a locked switch).
        includeSecrets: exportEncrypt || exportSecrets,
        includePayload: include,
        encrypt: exportEncrypt,
        password: exportEncrypt ? exportPassword : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('env.exportOk', { name: exportTarget.name }));
      closeExport();
    } catch (err) {
      toast.error(errorText(err, {}));
    } finally {
      setExporting(false);
    }
  };

  /** Close + full state reset (dialog closes via three paths: cancel button,
   * overlay onClose, and the success path). */
  const closeExport = () => {
    setExportTarget(null);
    setExportSecrets(false);
    setExportEncrypt(false);
    setExportPassword('');
    setExportPasswordConfirm('');
    setExportError('');
  };

  /* ─── Import ───────────────────────────────────────────────────────────── */

  const closeImport = () => {
    setImportOpen(false);
    setImportEncrypted(false);
    setIPassword('');
    setArchiveFile(null);
    setSummary(null);
    setIName('');
    setIError('');
    setIConflict('');
  };

  const readArchive = async (file: File) => {
    setIError('');
    setIConflict('');
    setSummary(null);
    setArchiveFile(file);
    setImportEncrypted(false);
    setIPassword('');
    // Size gate BEFORE reading: the import route caps the request body
    // (fastify bodyLimit) and the page uploads the file bytes verbatim.
    if (file.size > ENV_IMPORT_BODY_LIMIT_BYTES) {
      const mb = String(Math.round(ENV_IMPORT_BODY_LIMIT_BYTES / (1024 * 1024)));
      setIError(t('env.import.tooLarge', { mb }));
      return;
    }
    // Local manifest preview for PLAINTEXT archives only. Whether the body is
    // encrypted is decided by the BACKEND on submit (no client-side magic
    // sniffing): a preview failure here just means no summary — submit will
    // either import or come back with "Archive is encrypted".
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entries = unzipSync(bytes, { filter: (f) => f.name === 'manifest.json' });
      const manifestU8 = entries['manifest.json'];
      const manifest = manifestU8 ? (JSON.parse(strFromU8(manifestU8)) as EnvArchiveManifest) : null;
      if (manifest && typeof manifest === 'object' && manifest.format === ENV_ARCHIVE_FORMAT) {
        // Client-side version gate: an archive from a newer OCR would only be
        // rejected server-side after uploading up to 64 MB.
        if (typeof manifest.version === 'number' && manifest.version > ENV_ARCHIVE_VERSION) {
          setIError(t('env.error.versionUnsupported'));
          return;
        }
        const srcName =
          typeof manifest.source?.name === 'string' && manifest.source.name ? manifest.source.name : '';
        // The manifest carries no payload list — the checksums keys ARE the
        // carried-content list (config + every included payload file).
        const checksums =
          manifest.checksums && typeof manifest.checksums === 'object'
            ? (manifest.checksums as Record<string, unknown>)
            : {};
        setSummary({
          sourceName: srcName || '—',
          sourceType: manifest.source?.type === 'sandbox' ? 'sandbox' : 'regular',
          appVersion: typeof manifest.source?.appVersion === 'string' ? manifest.source.appVersion : 'unknown',
          secrets: typeof manifest.secrets === 'string' ? manifest.secrets : '',
          redactedCount: Array.isArray(manifest.redactedPaths) ? manifest.redactedPaths.length : 0,
          payloadKeys: Object.keys(checksums).filter((k) => k !== 'config'),
        });
        // Prefill only when the archive's own name is usable here: pre-filling
        // a reserved name ("default") would pre-load a guaranteed error.
        setIName(nameProblem(srcName) ? '' : srcName);
      }
    } catch {
      // not a plaintext zip — encrypted or corrupt; the backend decides
    }
    setIConflict('');
  };

  const submitImport = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!archiveFile) return;
    const name = iName.trim();
    const problem = nameProblem(name);
    if (problem) {
      setIError(problem);
      return;
    }
    setIError('');
    setIConflict('');
    setImporting(true);
    try {
      // `?name=` overrides the archive's own env name — create-mode import
      // always makes a NEW env. The password (when the backend demanded one)
      // travels ONLY in the request header.
      await api.importEnvironment(archiveFile, name, {
        password: iPassword.length > 0 ? iPassword : undefined,
        mode: 'create',
      });
      toast.success(t('env.import.success', { name }));
      closeImport();
      await load();
    } catch (err) {
      const e = err as EnvApiError;
      if (e?.status === 400 && /x-ocr-archive-password|encrypted/i.test(e?.message ?? '')) {
        // Server-driven password prompt: the archive is encrypted, the header
        // was absent — reveal the field and let the user retry.
        setImportEncrypted(true);
        setIError(t('env.import.encrypted'));
      } else if (e?.status === 400 && /decryption/i.test(e?.message ?? '')) {
        setImportEncrypted(true);
        setIError(t('env.import.decryptFailed'));
      } else if (e?.status === 409 && e.suggestion) {
        setIConflict(e.suggestion);
        setIError(t('env.import.nameConflict', { name }));
      } else {
        setIError(errorText(err, { 400: 'env.error.archiveInvalid' }));
      }
    } finally {
      setImporting(false);
    }
  };

  /** Recoverable overwrite: confirm, then re-POST in replace mode (the old
   * book-set moves to envs/.trash server-side before anything is written). */
  const overwriteImport = async () => {
    if (!archiveFile) return;
    const name = iName.trim();
    const ok = await confirmDialog({
      title: t('env.import.overwriteTitle', { name }),
      description: t('env.import.overwriteBody'),
      confirmLabel: t('env.import.overwrite', { name }),
    });
    if (!ok) return;
    setIError('');
    setIConflict('');
    setImporting(true);
    try {
      await api.importEnvironment(archiveFile, name, {
        password: iPassword.length > 0 ? iPassword : undefined,
        mode: 'replace',
      });
      toast.success(t('env.import.success', { name }));
      closeImport();
      await load();
    } catch (err) {
      const e = err as EnvApiError;
      if (e?.status === 400 && /x-ocr-archive-password|encrypted/i.test(e?.message ?? '')) {
        setImportEncrypted(true);
        setIError(t('env.import.encrypted'));
      } else if (e?.status === 400 && /decryption/i.test(e?.message ?? '')) {
        setImportEncrypted(true);
        setIError(t('env.import.decryptFailed'));
      } else {
        setIError(errorText(err, { 400: 'env.error.archiveInvalid', 409: 'env.error.switchInProgress' }));
      }
    } finally {
      setImporting(false);
    }
  };

  /* ─── Switch (pointer write + gateway handover) ────────────────────────── */

  const handleSwitch = async (e: AdminEnvironment) => {
    // One switch in flight at a time (the backend mirrors this with a 409 on
    // re-entry); the buttons are disabled too — this guards the queued click.
    if (switching !== null) return;
    const ok = await confirmDialog({
      title: t('env.switch.confirmTitle', { name: e.name }),
      description: `${t('env.switch.confirmBody')} ${t('env.switch.reloginWarning')}`,
      confirmLabel: t('env.switch.confirmLabel'),
    });
    if (!ok) return;

    setSwitching(e.name);
    let result: Awaited<ReturnType<typeof api.switchEnvironment>> | null = null;
    // A gateway that ANSWERED with an error body means the switch did NOT
    // start (re-entry 409, pointer-write 500, …) → surface it, never poll.
    // A request that died with no parseable body is the handover race: the old
    // process exits ~0.5s after acknowledging, so fall through to the poll.
    let switchError: string | null = null;
    try {
      result = await api.switchEnvironment(e.name);
    } catch (err) {
      if (err instanceof EnvApiError && err.hasErrorBody) {
        switchError = errorText(err, { 409: 'env.error.switchInProgress' });
      }
    }

    if (switchError) {
      setSwitching(null);
      toast.error(switchError);
      await load();
      return;
    }

    if (result?.status === 'failed') {
      setSwitching(null);
      toast.error(`${t('env.switch.failed')}${result.error ?? ''}`);
      await load();
      return;
    }
    if (result?.status === 'ok') {
      setSwitching(null);
      toast.info(t('env.switch.alreadyRunning', { name: e.name }));
      await load();
      return;
    }

    const newPort = result?.newPort;
    // The target env's own config.yaml picks the port; when it differs we must
    // follow the browser to the new origin instead of reloading this one.
    const target = newPort ? `${window.location.protocol}//${window.location.hostname}:${newPort}` : null;
    if (newPort) toast.info(t('env.switch.portChangeNotice', { port: String(newPort) }));
    else toast.info(t('env.switch.restarting', { name: e.name }));

    // Same budget as Layout's restart: 2s boot grace, then up to ~43s of polls.
    await new Promise((r) => setTimeout(r, 2000));
    for (let i = 0; i < 86; i++) {
      try {
        // Cross-origin polling cannot read the response (no CORS), but an
        // opaque reply still proves the new port is listening — that is all
        // readiness needs here.
        const res = await fetch(`${target ?? ''}/health`, {
          mode: target ? 'no-cors' : 'same-origin',
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok || res.type === 'opaque') {
          // Carry the current path (/admin/environments) so the operator lands
          // back on this page at the new origin instead of the console root.
          if (target) window.location.href = `${target}${window.location.pathname}${window.location.search}`;
          else window.location.reload();
          return;
        }
      } catch {
        // gateway still offline
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    toast.error(t('header.restartTimeout'));
    window.location.reload();
  };

  /* ─── Render helpers ───────────────────────────────────────────────────── */

  const actionStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    whiteSpace: 'nowrap',
  };

  // Transient lock only: a running env can be renamed/trashed after it stops.
  // The bootstrap default is a permanent lock, handled by hiding those actions.
  const lockReason = (e: AdminEnvironment): string | undefined => {
    if (e.running) return t('env.error.cannotModifyRunning');
    return undefined;
  };

  const summaryRow = (label: string, value: React.ReactNode) => (
    <div key={label} style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.6 }}>
      <span style={{ color: 'var(--text-dim)', flexShrink: 0, minWidth: 110 }}>{label}</span>
      <span style={{ fontFamily: MONO, color: 'var(--text-main)', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, height: '100%', minHeight: 0 }}>
      {/* Header: which book-set is live right now, and whether a switch is pending */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <FolderCog size={18} color="var(--accent)" />
            <span>{t('env.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setImportOpen(true)} style={actionStyle}>
              <Upload size={13} />
              <span>{t('env.action.import')}</span>
            </button>
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)} style={actionStyle}>
              <Plus size={13} />
              <span>{t('env.action.create')}</span>
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
          {t('env.subtitle')}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', rowGap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('env.running')}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{runningName || '—'}</span>
          {runningEnv?.name === BOOTSTRAP_DEFAULT_ENV && (
            <span className="badge badge-info">{t('env.badge.bootstrap')}</span>
          )}
          {runningEnv && (
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-dim)' }} title={runningEnv.configPath}>
              {runningEnv.configPath}
            </span>
          )}
          {pendingRestart && (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginLeft: 6 }}>
                {t('env.pointer')}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: 'var(--accent-amber)' }}>
                {pointerName}
              </span>
              <span className="badge badge-warning">{t('env.badge.pendingRestart')}</span>
            </>
          )}
        </div>

        {pendingRestart && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: 'var(--accent-amber)', fontSize: 12 }}>
            <AlertTriangle size={14} />
            <span>{t('env.pendingRestart', { name: pointerName })}</span>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>{t('env.switchHint')}</div>
      </div>

      {/* Environments table */}
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8, rowGap: 8 }}>
          <div className="card-title" style={{ minWidth: 0 }}>
            <PackageOpen size={18} color="var(--accent)" />
            <span>{t('env.col.name')}</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 500 }}>
              {data ? `${data.environments.length}` : ''}
            </span>
          </div>
          <Combobox
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { value: 'all', label: t('env.filter.all') },
              { value: 'regular', label: t('env.type.regular') },
              { value: 'sandbox', label: t('env.type.sandbox') },
            ]}
            style={{ width: 150, padding: '5px 10px', fontSize: 12 }}
          />
        </div>

        {loadError && (
          <div style={{ fontSize: 12, color: 'var(--accent-rose)', marginBottom: 12 }}>
            {t('env.loadFailed')}
            {loadError}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable' }}>
          {loading && !data ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 12.5 }}>
              <colgroup>
                <col style={{ width: '26%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '17%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '29%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--divider)' }}>
                  <th scope="col" style={TH_STYLE}>{t('env.col.name')}</th>
                  <th scope="col" style={TH_STYLE}>{t('env.col.type')}</th>
                  <th scope="col" style={TH_STYLE}>{t('env.col.location')}</th>
                  <th scope="col" style={TH_STYLE}>{t('env.col.size')}</th>
                  <th scope="col" style={TH_STYLE}>{t('env.col.created')}</th>
                  <th scope="col" style={{ ...TH_STYLE, textAlign: 'right' }}>{t('env.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const isBootstrap = e.name === BOOTSTRAP_DEFAULT_ENV;
                  const lock = lockReason(e);
                  const isSwitching = switching === e.name;
                  const isBusy = busy === e.name;
                  const provenance = envProvenance(e, t);
                  return (
                    <tr
                      key={e.name}
                      style={{ background: e.running ? 'color-mix(in srgb, var(--accent-emerald) 6%, transparent)' : undefined }}
                    >
                      <td style={TD_STYLE}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 4 }}>
                          <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, wordBreak: 'break-all' }}>
                            {e.name}
                          </span>
                          {e.running && <span className="badge badge-success">{t('env.badge.running')}</span>}
                          {e.current && !e.running && (
                            <span className="badge badge-warning">{t('env.badge.current')}</span>
                          )}
                          {isBootstrap && (
                            <span className="badge badge-info">{t('env.badge.bootstrap')}</span>
                          )}
                        </div>
                        {provenance && (
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
                            {provenance}
                          </div>
                        )}
                      </td>
                      <td style={TD_STYLE}>
                        {e.type === 'sandbox' ? (
                          <span className="badge badge-amber">{t('env.type.sandbox')}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>{t('env.type.regular')}</span>
                        )}
                      </td>
                      <td style={{ ...TD_STYLE, fontFamily: MONO, fontSize: 11.5 }} title={e.configPath}>
                        {t('env.loc.envs', { name: e.name })}
                      </td>
                      <td style={{ ...TD_STYLE, fontFamily: MONO, fontSize: 11.5 }}>{fmtBytes(e.sizeBytes)}</td>
                      <td style={{ ...TD_STYLE, color: 'var(--text-muted)' }}>{fmtDate(e.createdAt)}</td>
                      <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {!e.running && (
                            <button
                              className="btn btn-sm"
                              // Only ONE switch may be in flight: the backend
                              // guards re-entry with 409, so every row's switch
                              // button locks while any switch is running.
                              disabled={switching !== null}
                              title={switching !== null && !isSwitching ? t('env.error.switchInProgress') : undefined}
                              onClick={() => void handleSwitch(e)}
                              style={actionStyle}
                            >
                              {isSwitching ? <Loader2 size={12} style={SPIN} /> : <ArrowLeftRight size={12} />}
                              <span>{t('env.action.switch')}</span>
                            </button>
                          )}
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setExportTarget(e);
                              setExportSecrets(false);
                              setExportInclude(defaultExportInclude());
                            }}
                            style={actionStyle}
                          >
                            <Download size={12} />
                            <span>{t('env.action.export')}</span>
                          </button>
                          {/* Bootstrap default is permanently immutable — the backend
                              rejects rename/trash with 400 — so hide the actions
                              instead of showing a disabled button that can never work. */}
                          {!isBootstrap && (
                            <button
                              className="btn btn-sm"
                              disabled={!!lock}
                              title={lock}
                              onClick={() => openRename(e)}
                              style={actionStyle}
                            >
                              <PencilRuler size={12} />
                              <span>{t('env.action.rename')}</span>
                            </button>
                          )}
                          {e.type === 'sandbox' && (
                            <button
                              className="btn btn-sm"
                              disabled={!!lock || isBusy}
                              title={lock}
                              onClick={() => void handleReset(e)}
                              style={actionStyle}
                            >
                              {isBusy ? <Loader2 size={12} style={SPIN} /> : <RotateCcw size={12} />}
                              <span>{t('env.action.reset')}</span>
                            </button>
                          )}
                          {!isBootstrap && (
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={!!lock || isBusy}
                              title={lock}
                              onClick={() => void handleDelete(e)}
                              style={actionStyle}
                            >
                              <Trash2 size={12} />
                              <span>{t('env.action.delete')}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!loading && rows.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>{t('env.empty')}</div>
          )}
        </div>
      </div>

      {/* Create */}
      {createOpen && (
        <Dialog
          title={t('env.create.title')}
          subtitle={t('env.create.nameHint')}
          footerRight={
            <>
              <button type="button" className="btn" onClick={closeCreate}>
                {t('common.cancel')}
              </button>
              <button type="submit" form="env-create-form" className="btn btn-primary" disabled={cSubmitting}>
                {cSubmitting && <Loader2 size={12} style={SPIN} />}
                <span>{t('env.create.submit')}</span>
              </button>
            </>
          }
          onClose={closeCreate}
          closeLabel={t('common.close')}
          width={520}
        >
          <form
            id="env-create-form"
            onSubmit={(e) => void submitCreate(e)}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <Field label={t('env.create.nameLabel')}>
              <input
                type="text"
                className="input"
                value={cName}
                aria-label={t('env.create.nameLabel')}
                placeholder={t('env.create.namePlaceholder')}
                onChange={(e) => {
                  setCName(e.target.value);
                  setCError('');
                }}
                style={{ fontFamily: MONO }}
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10 }}>
              <Field label={t('env.create.typeLabel')}>
                <Combobox
                  value={cType}
                  onChange={(v) => setCType(v === 'sandbox' ? 'sandbox' : 'regular')}
                  options={[
                    { value: 'regular', label: t('env.type.regular') },
                    { value: 'sandbox', label: t('env.type.sandbox') },
                  ]}
                />
              </Field>
              <Field label={t('env.create.templateLabel')}>
                <Combobox
                  value={cTemplate}
                  onChange={(v) => setCTemplate(v as AdminEnvTemplate)}
                  options={[
                    { value: 'blank', label: t('env.create.template.blank') },
                    { value: 'copy-current', label: t('env.create.template.copyCurrent') },
                    { value: 'copy-default', label: t('env.create.template.copyDefault') },
                  ]}
                />
              </Field>
            </div>
            <Field label={t('env.create.descLabel')}>
              <input
                type="text"
                className="input"
                value={cDesc}
                aria-label={t('env.create.descLabel')}
                placeholder={t('env.create.descPlaceholder')}
                onChange={(e) => setCDesc(e.target.value)}
              />
            </Field>
            {cError && <div style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{cError}</div>}
          </form>
        </Dialog>
      )}

      {/* Rename / description */}
      {renameTarget && (
        <Dialog
          title={t('env.rename.title', { name: renameTarget.name })}
          subtitle={t('env.rename.hint')}
          footerRight={
            <>
              <button type="button" className="btn" onClick={() => setRenameTarget(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" form="env-rename-form" className="btn btn-primary" disabled={rSubmitting}>
                {rSubmitting && <Loader2 size={12} style={SPIN} />}
                <span>{t('env.rename.submit')}</span>
              </button>
            </>
          }
          onClose={() => setRenameTarget(null)}
          closeLabel={t('common.close')}
          width={520}
        >
          <form
            id="env-rename-form"
            onSubmit={(e) => void submitRename(e)}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <Field label={t('env.rename.nameLabel')}>
              <input
                type="text"
                className="input"
                value={rName}
                aria-label={t('env.rename.nameLabel')}
                onChange={(e) => {
                  setRName(e.target.value);
                  setRError('');
                }}
                style={{ fontFamily: MONO }}
              />
            </Field>
            <Field label={t('env.rename.descLabel')}>
              <input
                type="text"
                className="input"
                value={rDesc}
                aria-label={t('env.rename.descLabel')}
                onChange={(e) => setRDesc(e.target.value)}
              />
            </Field>
            {rError && <div style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{rError}</div>}
          </form>
        </Dialog>
      )}

      {/* Export — the include-secrets checkbox is the explicit decision surface */}
      {exportTarget && (
        <Dialog
          title={t('env.export.title', { name: exportTarget.name })}
          subtitle={t('env.export.formatNote')}
          footerRight={
            <>
              <button type="button" className="btn" onClick={closeExport}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={exportSecrets ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={exporting}
                onClick={() => void handleExport()}
                style={actionStyle}
              >
                {exporting ? <Loader2 size={12} style={SPIN} /> : <Download size={12} />}
                <span>{t('env.export.submit')}</span>
              </button>
            </>
          }
          onClose={closeExport}
          closeLabel={t('common.close')}
          width={520}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              cursor: exportEncrypt ? 'default' : 'pointer',
              userSelect: 'none',
              opacity: exportEncrypt ? 0.75 : 1,
            }}
          >
            <Switch
              checked={exportEncrypt || exportSecrets}
              onChange={setExportSecrets}
              size="sm"
              disabled={exportEncrypt}
              ariaLabel={t('env.export.includeSecrets')}
            />
            <span>{t('env.export.includeSecrets')}</span>
          </label>
          {exportSecrets && !exportEncrypt && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid var(--accent-rose)',
                background: 'color-mix(in srgb, var(--accent-rose) 10%, transparent)',
                color: 'var(--accent-rose)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{t('env.export.secretsWarning')}</span>
            </div>
          )}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              cursor: 'pointer',
              userSelect: 'none',
              marginTop: 4,
            }}
          >
            <Switch
              checked={exportEncrypt}
              onChange={(v) => {
                setExportEncrypt(v);
                setExportError('');
                // Encrypted layer protects plaintext keys — imply secrets=include.
                if (v) setExportSecrets(true);
              }}
              size="sm"
              ariaLabel={t('env.export.encrypt')}
            />
            <span>{t('env.export.encrypt')}</span>
          </label>
          {exportEncrypt && (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--card-border)',
                  background: 'var(--bg-elev)',
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{t('env.export.encryptHint')}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label={t('env.export.password')}>
                    <input
                      type="password"
                      className="input"
                      value={exportPassword}
                      autoComplete="new-password"
                      aria-label={t('env.export.password')}
                      onChange={(e) => setExportPassword(e.target.value)}
                      style={{ fontFamily: MONO, fontSize: 12, padding: '7px 10px' }}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={t('env.export.passwordConfirm')}>
                    <input
                      type="password"
                      className="input"
                      value={exportPasswordConfirm}
                      autoComplete="new-password"
                      aria-label={t('env.export.passwordConfirm')}
                      onChange={(e) => setExportPasswordConfirm(e.target.value)}
                      style={{ fontFamily: MONO, fontSize: 12, padding: '7px 10px' }}
                    />
                  </Field>
                </div>
              </div>
              {exportError && <div style={{ color: 'var(--accent-rose)', fontSize: 12 }}>{exportError}</div>}
            </>
          )}
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-dim)',
              }}
            >
              {t('env.export.payloadSection')}
            </div>
            {ARCHIVE_PAYLOAD_OPTIONS.map((opt) => (
              <label
                key={opt.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <Switch
                  checked={!!exportInclude[opt.key]}
                  onChange={(v) => setExportInclude((prev) => ({ ...prev, [opt.key]: v }))}
                  size="sm"
                  ariaLabel={t(opt.i18nKey)}
                />
                <span>{t(opt.i18nKey)}</span>
              </label>
            ))}
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('env.export.payloadHint')}
            </div>
          </div>
        </Dialog>
      )}

      {/* Import */}
      {importOpen && (
        <Dialog
          title={t('env.import.title')}
          footerRight={
            <>
              <button type="button" className="btn" onClick={closeImport}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                form="env-import-form"
                className="btn btn-primary"
                disabled={!archiveFile || importing || (importEncrypted && iPassword.length === 0)}
              >
                {importing && <Loader2 size={12} style={SPIN} />}
                <span>{t('env.import.submit')}</span>
              </button>
            </>
          }
          onClose={closeImport}
          closeLabel={t('common.close')}
          width={560}
        >
          <form
            id="env-import-form"
            onSubmit={(e) => void submitImport(e)}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <Field label={t('env.import.pickFile')}>
              <input
                type="file"
                accept=".orc_env.zip,.zip"
                className="input"
                aria-label={t('env.import.pickFile')}
                style={{ fontSize: 12, padding: '7px 10px' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readArchive(file);
                }}
              />
            </Field>

            {importEncrypted && (
              <Field
                label={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} style={{ color: 'var(--accent-amber)' }} />
                    {t('env.import.password')}
                  </span>
                }
                hint={t('env.import.encrypted')}
              >
                <input
                  type="text"
                  className="input secret-mask"
                  value={iPassword}
                  // Existing-secret prompt, like the copy-key re-auth gate: any
                  // type="password" makes Chrome pop the credential dropdown
                  // (fill saved login / generate / save prompt) and Edge inject
                  // its green key glyph — no autocomplete value suppresses
                  // either. Masking via .secret-mask (styles/index.css) keeps
                  // password managers away entirely.
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('env.import.password')}
                  onChange={(e) => {
                    setIPassword(e.target.value);
                    setIError('');
                  }}
                  style={{ fontFamily: MONO, fontSize: 12, padding: '7px 10px' }}
                />
              </Field>
            )}

            {summary && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '12px',
                  borderRadius: 8,
                  border: '1px solid var(--card-border)',
                  background: 'var(--bg-elev)',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)', marginBottom: 6 }}>
                  {t('env.import.summary')}
                </div>                {summaryRow(t('env.import.source'), summary.sourceName)}
                {summaryRow(t('env.col.type'), summary.sourceType === 'sandbox' ? t('env.type.sandbox') : t('env.type.regular'))}
                {summaryRow(t('env.import.appVersion'), summary.appVersion)}
                {summaryRow(
                  t('env.import.secrets'),
                  summary.secrets === 'included'
                    ? t('env.import.secretsIncluded')
                    : summary.secrets === 'redacted'
                      ? t('env.import.secretsRedacted')
                      : '—',
                )}
                {summaryRow(t('env.import.redactedCount'), String(summary.redactedCount))}
                {summaryRow(t('env.import.payloadFiles'), summary.payloadKeys.length ? summary.payloadKeys.join(', ') : '—')}
              </div>
            )}

            {archiveFile && (
              <Field label={t('env.import.nameLabel')} hint={t('env.create.nameHint')}>
                <input
                  type="text"
                  className="input"
                  value={iName}
                  aria-label={t('env.import.nameLabel')}
                  onChange={(e) => {
                    setIName(e.target.value);
                    setIError('');
                    setIConflict('');
                  }}
                  style={{ fontFamily: MONO }}
                />
              </Field>
            )}

            {iConflict && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={actionStyle}
                  onClick={() => {
                    setIName(iConflict);
                    setIError('');
                    setIConflict('');
                  }}
                >
                  <Check size={12} />
                  <span>{t('env.import.useSuggestion', { name: iConflict })}</span>
                </button>
                {iConflict && iName.trim() && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    style={actionStyle}
                    disabled={importing}
                    onClick={() => void overwriteImport()}
                  >
                    <Upload size={12} />
                    <span>{t('env.import.overwrite', { name: iName.trim() })}</span>
                  </button>
                )}
              </div>
            )}

            {iError && <div style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{iError}</div>}
          </form>
        </Dialog>
      )}
    </div>
  );
};
