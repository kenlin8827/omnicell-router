// Clipboard write for BOTH runtimes the console ships in.
//
// Inside the desktop shell the console is a REMOTE page (http://127.0.0.1:<port>)
// loaded into a webview window. The engine's own clipboard API raises its
// permission prompt the first time a page uses it (Tauri #12007 — an "allow
// access to the clipboard" bubble the operator has to answer), and it also
// rejects with `Document is not focused` when the click that lands on an
// inactive window runs before WebView2 focuses the document — the exact shape
// of a "first click after alt-tab" copy. The clipboard-manager plugin writes
// through native IPC instead: no webview prompt, no focus/activation
// requirement. Its grant lives in capabilities/remote-shell.json next to the
// shell:allow-open grant the same remote origin already needs.
//
// In a real browser `__TAURI_INTERNALS__` is absent and the standard
// navigator.clipboard path is right; the legacy execCommand path stays for
// non-secure LAN binds (the console is served over plain http there, where
// navigator.clipboard does not exist).
import { writeText as writeTextNative } from '@tauri-apps/plugin-clipboard-manager';

const copyViaTextarea = (text: string): boolean => {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Keep the scratch node out of the layout AND out of view while selected.
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  // `ta.select()` moves focus onto the scratch node; removing it would leave
  // the keyboard user on <body> after one copy (Enter on the button is gone).
  const focused = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  focused?.focus?.();
  return ok;
};

/** Clipboard write with a boolean outcome (callers surface success/failure toasts). */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      await writeTextNative(text);
      return true;
    } catch {
      // Plugin unavailable in this shell build — fall through to the web path.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaTextarea(text);
  }
};
