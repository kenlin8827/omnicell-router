/**
 * FilePickerModal — a system-style file/folder browser backed by the
 * gateway's read-only listing route (`GET /api/admin/local-models/fs`).
 *
 * Browsers cannot hand out absolute paths, so a local web console browses
 * server-side instead: the modal walks the gateway machine's filesystem,
 * Windows starts at the drive list, and `mode` decides what a selection is —
 * 'dir' picks the folder being viewed, 'gguf' picks a highlighted .gguf file
 * (folders are just navigation there). Used by the local-models settings page
 * (storage dir) and the local-models page (import).
 */
import React, { useEffect, useState } from 'react';
import { ArrowUp, FileAudio, Folder, FolderOpen } from 'lucide-react';
import {
  api,
  type FsEntry,
  type FsListingResponse,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { useBackdropDismiss } from '../lib/useBackdropDismiss';

export const FilePickerModal: React.FC<{
  open: boolean;
  /** 'dir' = pick the viewed folder; 'gguf' = pick a highlighted .gguf file. */
  mode: 'dir' | 'gguf';
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}> = ({ open, mode, initialPath, onPick, onClose }) => {
  const { t } = useI18n();
  const [listing, setListing] = useState<FsListingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pickedFile, setPickedFile] = useState('');
  /** Editable path bar: paste a location and hit Enter to jump straight there. */
  const [pathInput, setPathInput] = useState('');
  const backdrop = useBackdropDismiss(onClose);
  useBodyScrollLock(open);

  // Plain function (not useCallback) so it always sees the current listing:
  // a failed jump needs it to stay put instead of falling back to the start.
  const load = async (target: string) => {
    setLoading(true);
    setError('');
    try {
      const next = await api.listFsDirectory(target, mode === 'gguf');
      setListing(next);
      setPathInput(next.path);
      setPickedFile('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (listing) {
        // Typo'd jump: keep the current view, surface the reason.
        setPathInput(listing.path);
        setError(message);
      } else {
        // Dead initial path (dir not created yet, renamed): start screen.
        try {
          const fallback = await api.listFsDirectory('', mode === 'gguf');
          setListing(fallback);
          setPathInput(fallback.path);
        } catch (fallbackErr) {
          setError(fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setListing(null);
      setPickedFile('');
      void load(initialPath?.trim() ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const dirs = listing?.entries.filter((e: FsEntry) => e.type === 'dir') ?? [];
  const files = listing?.entries.filter((e: FsEntry) => e.type === 'file') ?? [];

  const choose = () => {
    if (mode === 'gguf' && pickedFile) onPick(pickedFile);
    else if (mode === 'dir' && listing?.path) onPick(listing.path);
  };

  return (
    <div
      {...backdrop}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'ocr-fade-in 0.15s ease',
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          padding: '18px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>
            {mode === 'dir' ? t('localModels.pickerTitleDir') : t('localModels.pickerTitleImport')}
          </span>
          <button
            className="btn btn-sm"
            style={{ flexShrink: 0, justifyContent: 'center' }}
            title={t('localModels.pickerUp')}
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void load(listing.parent)}
          >
            <ArrowUp size={13} />
          </button>
        </div>

        <input
          className="input"
          title={t('localModels.pickerPathHint')}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading) void load(pathInput.trim());
            if (e.key === 'Escape') setPathInput(listing?.path ?? '');
          }}
          placeholder={t('localModels.pickerPathHint')}
          spellCheck={false}
        />

        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', border: '1px solid var(--divider)', borderRadius: 8 }}>
          {loading && (
            <div style={{ padding: 16, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.filesLoading')}</div>
          )}
          {!loading && error && (
            <div style={{ padding: 16, fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{error}</div>
          )}
          {!loading && !error && dirs.length === 0 && files.length === 0 && (
            <div style={{ padding: 16, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.pickerEmpty')}</div>
          )}
          {!loading && !error && dirs.map((e) => (
            <button
              key={e.path}
              className="btn"
              style={{ justifyContent: 'flex-start', gap: 8, border: 'none', borderBottom: '1px solid var(--divider)', borderRadius: 0, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
              onDoubleClick={() => void load(e.path)}
              onClick={() => void load(e.path)}
            >
              <Folder size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            </button>
          ))}
          {!loading && !error && files.map((e) => {
            const picked = pickedFile === e.path;
            return (
              <button
                key={e.path}
                className="btn"
                style={{
                  justifyContent: 'flex-start', gap: 8, border: 'none', borderBottom: '1px solid var(--divider)', borderRadius: 0, padding: '8px 12px', fontSize: 'var(--text-sm)',
                  ...(picked ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--text-main)' } : {}),
                }}
                onClick={() => setPickedFile(picked ? '' : e.path)}
                onDoubleClick={() => onPick(e.path)}
              >
                <FileAudio size={14} style={{ color: picked ? 'var(--accent)' : 'var(--text-dim)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            disabled={loading || (mode === 'gguf' ? !pickedFile : !listing?.path)}
            onClick={choose}
          >
            <FolderOpen size={13} />
            <span>{mode === 'gguf' ? t('localModels.pickerChooseFile') : t('localModels.pickerChooseDir')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
