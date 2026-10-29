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
import { PlaygroundPage } from './pages/PlaygroundPage';
import { GuardrailsPage } from './pages/GuardrailsPage';
import { BreakerRulesPage } from './pages/BreakerRulesPage';
import { SessionsPage } from './pages/SessionsPage';
import { UsagePage } from './pages/UsagePage';
import { RateLimitPage } from './pages/RateLimitPage';
import { FailuresPage } from './pages/FailuresPage';
import { QuotaPage } from './pages/QuotaPage';
import { LogsPage } from './pages/LogsPage';
import { CapturesPage } from './pages/CapturesPage';
import { ClientsPage } from './pages/ClientsPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutoPage } from './pages/AutoPage';
import { CombosPage } from './pages/CombosPage';
import { ModelProfilesPage } from './pages/ModelProfilesPage';
import { RouteEntriesPage } from './pages/RouteEntriesPage';
import { YamlPage } from './pages/YamlPage';
import { HarnessPage } from './pages/HarnessPage';
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
        <Route path="route-entries" element={<RouteEntriesPage />} />
        <Route path="auto" element={<AutoPage />} />
        <Route path="combos" element={<CombosPage />} />
        <Route path="model-profiles" element={<ModelProfilesPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="providers" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="catalog" element={<CatalogSourcesPage />} />
        <Route path="proxy-upstream" element={<ProxyPage />} />
        <Route path="token-saver" element={<TokenSaverPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="proxy-access" element={<ProxyAccessPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="breaker-rules" element={<BreakerRulesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="rate-limit" element={<RateLimitPage />} />
        <Route path="failures" element={<FailuresPage />} />
        <Route path="quota" element={<QuotaPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="captures" element={<CapturesPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="yaml" element={<YamlPage />} />
        <Route path="harness/skills" element={<HarnessPage kind="skill" />} />
        <Route path="harness/mcp" element={<HarnessPage kind="mcp" />} />
        <Route path="harness/extensions" element={<HarnessPage kind="extension" />} />
        {/* Same page, landing harness in the URL: for a kind that WRITES into a client (an
            extension package, an MCP server config) the runtime is part of the artifact's identity,
            so it must survive reload, bookmark and Back/Forward. The bare routes above redirect
            into the first harness that has a verified landing. A skill's rail selects a READER
            (nine runtimes load one `.agents/skills` tree), and it is in the URL for the same
            reason: which runtime you are looking at is a location, not view state. */}
        <Route path="harness/skills/:harness" element={<HarnessPage kind="skill" />} />
        <Route path="harness/mcp/:harness" element={<HarnessPage kind="mcp" />} />
        <Route path="harness/extensions/:harness" element={<HarnessPage kind="extension" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
        </Routes>
      </ConfirmProvider>
      </TooltipProvider>
    </ToastProvider>
  );
};
