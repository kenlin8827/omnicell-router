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
