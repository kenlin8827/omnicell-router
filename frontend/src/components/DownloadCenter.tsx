import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, FolderOpen, Copy, Check, X } from 'lucide-react';
import {
  cancelDownload,
  clearFinishedDownloads,
  getDownloads,
  subscribeDownloads,
  type DownloadState,
  type DownloadTask,
} from '../lib/download-manager';
import { isDesktopShell, openLocalPath } from '../lib/download';
import { useI18n } from '../i18n/I18nContext';
import { copyToClipboard } from '../lib/clipboard';

const ACTIVE: DownloadState[] = ['preparing', 'downloading', 'saving'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function statusKey(state: DownloadState): string {
  return {
    preparing: 'downloads.preparing',
    downloading: 'downloads.downloading',
    saving: 'downloads.saving',
    done: 'downloads.done',
    failed: 'downloads.failed',
    canceled: 'downloads.canceled',
  }[state];
}

/**
 * Desktop-only download shelf. A Tauri window has no browser download UI, and
 * the save dialog only appears once the bytes are ready — without this panel
 * the operator has no idea a transfer is running, how far it got, or where the
 * file ended up. A plain browser keeps its own downloads surface, so the
 * trigger is not rendered there.
 */
export function DownloadCenter(): React.ReactElement | null {
  const { t } = useI18n();
  const tasks = useSyncExternalStore(subscribeDownloads, getDownloads);
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const desktop = isDesktopShell();
  const active = tasks.filter((task) => ACTIVE.includes(task.state)).length;

  // A new transfer is the one moment the panel MUST be visible; later rows can
  // stay behind the toggle.
  useEffect(() => {
    if (active > 0) setOpen(true);
  }, [active]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  // A shelf that survives clicks elsewhere competes with the page it covers;
  // dismiss on any outside press or Escape, like every other popover here.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // No history → no shelf: an empty download surface is pure noise. This
  // matches the browser, where the downloads list appears with the first file
  // and disappears when it is cleared.
  if (!desktop || tasks.length === 0) return null;

  const copyPath = (task: DownloadTask): void => {
    if (!task.path) return;
    void copyToClipboard(task.path).then(() => setCopiedId(task.id));
  };

  return (
    <div className="download-center" ref={rootRef}>
      <button
        type="button"
        className="app-icon-button"
        onClick={() => setOpen((v) => !v)}
        title={t('downloads.title')}
        aria-label={t('downloads.title')}
        aria-expanded={open}
      >
        <Download size={16} />
        <span className="download-badge">{active > 0 ? active : tasks.length}</span>
      </button>

      {open && (
        <div className="download-panel" role="dialog" aria-label={t('downloads.title')}>
          <div className="download-panel-head">
            <strong>{t('downloads.title')}</strong>
            <div className="download-panel-head-actions">
              <button type="button" className="download-link" onClick={clearFinishedDownloads}>
                {t('downloads.clearDone')}
              </button>
              <button
                type="button"
                className="app-icon-button download-close"
                onClick={() => setOpen(false)}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <ul className="download-list">
            {tasks.map((task) => {
              const pct = task.total ? Math.min(100, Math.round((task.loaded / task.total) * 100)) : null;
              const shownPath = task.path ?? task.dir ?? '';
              return (
                <li key={task.id} className={`download-row is-${task.state}`}>
                  <div className="download-row-head">
                    <span className="download-name" title={task.name}>{task.name}</span>
                    <span className={`download-state is-${task.state}`}>{t(statusKey(task.state))}</span>
                  </div>

                  <div
                    className={`download-bar${pct === null ? ' is-indeterminate' : ''}`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct ?? undefined}
                  >
                    <span style={{ width: pct === null ? '35%' : `${pct}%` }} />
                  </div>

                  <div className="download-meta">
                    <span>
                      {formatBytes(task.loaded)}
                      {task.total ? ` / ${formatBytes(task.total)}` : ''}
                      {pct !== null ? ` · ${pct}%` : ''}
                    </span>
                    {(task.state === 'preparing' || task.state === 'downloading') && (
                      <button type="button" className="download-link" onClick={() => cancelDownload(task.id)}>
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>

                  {shownPath && (
                    <div className="download-path" title={shownPath}>
                      <span>{shownPath}</span>
                      <button
                        type="button"
                        className="app-icon-button download-mini"
                        onClick={() => void openLocalPath(task.dir ?? task.path ?? '')}
                        title={t('downloads.openFolder')}
                        aria-label={t('downloads.openFolder')}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        type="button"
                        className="app-icon-button download-mini"
                        onClick={() => copyPath(task)}
                        title={t('downloads.copyPath')}
                        aria-label={t('downloads.copyPath')}
                      >
                        {copiedId === task.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </div>
                  )}

                  {task.error && <div className="download-error">{task.error}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
