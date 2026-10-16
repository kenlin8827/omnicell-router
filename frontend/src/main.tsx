import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { I18nProvider } from './i18n/I18nContext';
import { resolveStoredTheme, THEME_STORAGE_KEY } from './lib/theme';
// Self-hosted fonts (no external CDN dependency: works offline / intranet / mainland China)
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/600.css';
import '@fontsource/noto-sans-sc/700.css';
import './styles/index.css';

// Apply the persisted theme before first paint: the auth gate renders
// LoginPage without mounting Layout (which owns the theme picker), so
// otherwise the pre-login views always show the default theme. Legacy ids
// stored before the theme rename are migrated by resolveStoredTheme.
document.documentElement.setAttribute(
  'data-theme',
  resolveStoredTheme(localStorage.getItem(THEME_STORAGE_KEY)),
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>
);
