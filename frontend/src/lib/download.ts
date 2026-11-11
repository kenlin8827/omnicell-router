import { downloadDir } from '@tauri-apps/api/path';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-shell';

/**
 * Download plumbing shared by every console export.
 *
 * In a plain browser the export ends at a `createObjectURL` + `<a download>`
 * click (the browser owns the save UI). In the desktop shell there is no
 * browser download machinery at all: the console must ask WHERE to save with
 * a native dialog and write the bytes through the fs plugin. The plugin
 * modules are imported statically but only invoked behind `isDesktopShell()`,
 * so a browser console never touches Tauri IPC.
 */

/** True when the console runs inside the Tauri desktop shell. */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Save a Blob through the browser's download idiom. The anchor must be in the
 * document and the URL must outlive the click: WebView2 reads the blob
 * asynchronously, so removing the anchor or revoking the URL synchronously can
 * yield a silently failed download there.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type SaveOutcome =
  | { status: 'browser' }
  | { status: 'canceled' }
  | { status: 'saved'; path: string };

/**
 * Choose a destination and write the bytes.
 *
 * Desktop: native save dialog → fs write (the dialog extends the fs scope to
 * the picked path, so no broad filesystem permission is granted). Browser:
 * the usual anchor click. The caller shows the returned path; a canceled
 * dialog is a normal outcome, not an error.
 */
export async function saveBlobInteractive(blob: Blob, filename: string): Promise<SaveOutcome> {
  if (!isDesktopShell()) {
    saveBlob(blob, filename);
    return { status: 'browser' };
  }
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  // Open in the OS Downloads folder — the same place a browser would use —
  // while still letting the operator pick any destination.
  const downloads = await downloadDir();
  const separator = downloads.includes('\\') ? '\\' : '/';
  const defaultPath = `${downloads.replace(/[\\/]+$/, '')}${separator}${filename}`;
  const path = await save({
    defaultPath,
    canCreateDirectories: true,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
  if (!path) return { status: 'canceled' };
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return { status: 'saved', path };
}

/** Reveal a finished download in the OS file manager (desktop only). */
export async function openLocalPath(path: string): Promise<void> {
  if (!isDesktopShell() || !path) return;
  await open(path);
}

/** Parent directory of a Windows or POSIX path (display only). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}
