import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { RulesPage } from './pages/RulesPage';
import { KeysPage } from './pages/KeysPage';
import { ModelsPage } from './pages/ModelsPage';
import { CatalogSourcesPage } from './pages/CatalogSourcesPage';
import { ProxyPage } from './pages/ProxyPage';
import { ProxyAccessPage } from './pages/ProxyAccessPage';
import { TokenSaverPage } from './pages/TokenSaverPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { GuardrailsPage } from './pages/GuardrailsPage';
import { BreakerRulesPage } from './pages/BreakerRulesPage';
import { SessionsPage } from './pages/SessionsPage';
import { UsagePage } from './pages/UsagePage';
import { RateLimitPage } from './pages/RateLimitPage';
import { QuotaPage } from './pages/QuotaPage';
import { LogsPage } from './pages/LogsPage';
import { CapturesPage } from './pages/CapturesPage';
import { ClientsPage } from './pages/ClientsPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutoPage } from './pages/AutoPage';
import { CombosPage } from './pages/CombosPage';
import { ModelProfilesPage } from './pages/ModelProfilesPage';
import { FlywheelPage } from './pages/FlywheelPage';
import { YamlPage } from './pages/YamlPage';
import { ConfirmProvider } from './components/ConfirmProvider';
import { ToastProvider } from './components/ToastProvider';
import { TooltipProvider } from './components/TooltipProvider';
import { LoginPage } from './pages/LoginPage';
import { api } from './lib/api';

type AuthGateState = 'checking' | 'ok' | 'locked';

export const App: React.FC = () => {
  // Console-auth gate: on boot, ask the gateway whether the webAuth console
  // login is active and whether this browser already holds a session cookie.
  const [authState, setAuthState] = useState<AuthGateState>('checking');

  useEffect(() => {
    let alive = true;
    api
      .getAuthSession()
      .then((s) => {
        if (alive) setAuthState(s.authenticated ? 'ok' : 'locked');
      })
      .catch(() => {
        // Gateway unreachable (or older backend without the auth probe):
        // render the console as before instead of bricking the UI.
        if (alive) setAuthState('ok');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh' }} />;
  }
  if (authState === 'locked') {
    return <LoginPage onSuccess={() => setAuthState('ok')} />;
  }

  return (
    <ToastProvider>
      <TooltipProvider>
      <ConfirmProvider>
        <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="tiers" element={<RulesPage />} />
        <Route path="auto" element={<AutoPage />} />
        <Route path="combos" element={<CombosPage />} />
        <Route path="model-profiles" element={<ModelProfilesPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="providers" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="catalog" element={<CatalogSourcesPage />} />
        <Route path="proxy" element={<ProxyPage />} />
        <Route path="token-saver" element={<TokenSaverPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="proxy-access" element={<ProxyAccessPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="breaker-rules" element={<BreakerRulesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="rate-limit" element={<RateLimitPage />} />
        <Route path="quota" element={<QuotaPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="captures" element={<CapturesPage />} />
        <Route path="flywheel" element={<FlywheelPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="yaml" element={<YamlPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
        </Routes>
      </ConfirmProvider>
      </TooltipProvider>
    </ToastProvider>
  );
};
