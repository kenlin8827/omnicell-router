// Desktop (Tauri webview) workaround for "open in browser" links.
//
// The desktop shell loads the console as a REMOTE page (http://127.0.0.1:<port>)
// into its webview. A plain <a target="_blank"> raises WebView2's
// NewWindowRequested there, which wry swallows by default — the click does
// nothing. The Tauri IPC bridge IS injected for remote documents (wry uses
// AddScriptToExecuteOnDocumentCreated), and capabilities/remote-shell.json
// grants that origin shell:allow-open, so intercepting the click and calling
// the shell plugin's open() reaches the system browser. In a real browser
// __TAURI_INTERNALS__ is absent and this installs nothing — links keep
// their native target="_blank" behavior.
import { open } from '@tauri-apps/plugin-shell';

/**
 * Open an absolute http(s) URL outside the app.
 *
 * Prefer this over a bare `<a target="_blank">` when the click also needs to
 * run app code: the interceptor below hijacks clicks in the CAPTURE phase and
 * stops propagation, so a React onClick on such an anchor is never reached in
 * the desktop shell. A plain button + this helper is deterministic in both
 * hosts (system browser via the shell plugin; a new tab in a real browser).
 */
export function openExternal(url: string): void {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void open(url).catch(() => {
      // Nothing to fall back to inside the webview: NewWindowRequested is
      // swallowed by wry, and window.open would hit the same wall.
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function installExternalOpenInterceptor(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const anchor = e.target.closest('a[target="_blank"]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.href;
      if (!/^https?:/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      void open(href).catch(() => {
        // The webview ate the click already; nothing else to fall back to.
      });
    },
    // Capture: markdown-rendered anchors live in nested component trees, and
    // nothing else in the app must see a click we are about to hijack.
    true
  );
}
