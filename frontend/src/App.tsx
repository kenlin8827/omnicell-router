import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { CachePage } from './pages/CachePage';
import { RulesPage } from './pages/RulesPage';
import { KeysPage } from './pages/KeysPage';
import { ModelsPage } from './pages/ModelsPage';
import { CatalogSourcesPage } from './pages/CatalogSourcesPage';
import { ProxyPage } from './pages/ProxyPage';
import { ProxyAccessPage } from './pages/ProxyAccessPage';
import { TokenSaverPage } from './pages/TokenSaverPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { GuardrailsPage } from './pages/GuardrailsPage';
import { SessionsPage } from './pages/SessionsPage';
import { LogsPage } from './pages/LogsPage';
import { CapturesPage } from './pages/CapturesPage';
import { ClientsPage } from './pages/ClientsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutoPage } from './pages/AutoPage';
import { CombosPage } from './pages/CombosPage';
import { YamlPage } from './pages/YamlPage';
import { ConfirmProvider } from './components/ConfirmProvider';
import { ToastProvider } from './components/ToastProvider';

export const App: React.FC = () => {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="tiers" element={<RulesPage />} />
        <Route path="auto" element={<AutoPage />} />
        <Route path="combos" element={<CombosPage />} />
        <Route path="cache" element={<CachePage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="providers" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="catalog" element={<CatalogSourcesPage />} />
        <Route path="proxy" element={<ProxyPage />} />
        <Route path="token-saver" element={<TokenSaverPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="proxy-access" element={<ProxyAccessPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="captures" element={<CapturesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="yaml" element={<YamlPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
        </Routes>
      </ConfirmProvider>
    </ToastProvider>
  );
};
