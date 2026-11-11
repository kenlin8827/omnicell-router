import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n } from '../i18n/I18nContext';

/** The console is also served as a plain web page; only the desktop shell's
 *  webview injects the IPC bridge, so the controls appear only there. */
const IN_DESKTOP_SHELL =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Frameless window title-bar controls. The desktop shell creates the main
 * window with `decorations(false)`, so the app header IS the title bar: it
 * carries `data-tauri-drag-region` (drag + double-click maximize, handled by
 * Tauri's injected script) and this cluster of minimize / maximize / close
 * buttons. Kept out of the React tree in a browser tab, where the commands
 * do not exist.
 */
export const WindowControls: React.FC = () => {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IN_DESKTOP_SHELL) return;
    const win = getCurrentWindow();
    // DOM resize fires for every window-state change we care about (maximize,
    // restore, Aero snap); polling the shell from there needs no extra event
    // permission.
    const sync = () => {
      win.isMaximized().then(setMaximized).catch(() => {});
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  if (!IN_DESKTOP_SHELL) return null;

  const win = getCurrentWindow();
  // A rejected command (capability not granted, window already gone) must not
  // surface as an unhandled promise rejection in the console.
  const run = (op: Promise<unknown>) => {
    op.catch(() => {});
  };

  const maximizeLabel = t(maximized ? 'header.restore' : 'header.maximize');
  return (
    <div className="window-controls">
      <button type="button" className="window-control" title={t('header.minimize')} aria-label={t('header.minimize')}
        onClick={() => run(win.minimize())}>
        <Minus size={15} />
      </button>
      <button type="button" className="window-control" title={maximizeLabel} aria-label={maximizeLabel}
        onClick={() => run(win.toggleMaximize())}>
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button type="button" className="window-control is-close" title={t('header.close')} aria-label={t('header.close')}
        onClick={() => run(win.close())}>
        <X size={16} />
      </button>
    </div>
  );
};
