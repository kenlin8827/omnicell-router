import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, AlertOctagon, Archive, ArrowDownLeft, ArrowLeftRight, ArrowUpRight,
  BarChart3, Boxes, BrainCircuit, ClipboardList, CloudDownload, Cpu,
  FileCode2, FolderCog, Gauge, Globe, KeyRound, Layers, LayoutGrid, LogOut, Menu,
  MessagesSquare, Monitor, MonitorSmartphone, Moon, Network, PanelLeftClose, PanelLeftOpen, Plug,
  Puzzle, RotateCcw, ScrollText, Search, Settings, Settings2, ShieldAlert,
  ShieldCheck, Shuffle, Sliders, Sun, Users, Wallet, Waves, Waypoints, Zap, Github, type LucideIcon,
} from 'lucide-react';
import { api, type GatewayStatusResponse, type UpdateCheckResponse } from '../lib/api';
import { gatewayBaseUrl } from '../lib/gateway-url';
import { resolveStoredTheme, resolveThemePreference, THEME_STORAGE_KEY, type ThemePreference } from '../lib/theme';
import { readNavPreference, NAV_STYLE_CHANGED_EVENT, type NavPreference } from '../lib/navStyle';
import { useI18n } from '../i18n/I18nContext';
import { LANGUAGES } from '../i18n/languages';
import type { Lang } from '../i18n/types';
import { useConfirm } from './ConfirmProvider';
import { useToast } from './ToastProvider';
import { Combobox } from './Combobox';
import { QuotaPeek } from './QuotaPeek';
import { CommandPalette, type CommandItem } from './CommandPalette';
import { UpdateBanner } from './UpdateBanner';
import { WindowControls } from './WindowControls';
import { DownloadCenter } from './DownloadCenter';
import { copyToClipboard } from '../lib/clipboard';
import { GITHUB_REPO_URL } from '../lib/links';
import { STAR_REMINDER_CHANGED_EVENT, isStarNudgeDone } from '../lib/starReminder';

/** Latest release the operator dismissed; a NEWER release prompts again. */
const UPDATE_DISMISSED_KEY = 'ocr_update_dismissed_version';

interface NavItemDef {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  badge?: string;
  end?: boolean;
}

interface NavGroupDef {
  id: string;
  headingKey: string;
  /** 11px caption under the rail glyph when the operator turns captions on;
   *  short on purpose (long headings ellipsize at 76px). */
  shortKey: string;
  icon: LucideIcon;
  items: NavItemDef[];
}

const NAV_GROUP_DEFS: NavGroupDef[] = [
  { id: 'grp-overview', headingKey: 'nav.grpOverview', shortKey: 'nav.shortOverview', icon: Activity,
    items: [{ to: '/', labelKey: 'nav.overview', icon: LayoutGrid, end: true }] },
  { id: 'grp-access', headingKey: 'nav.grpAccess', shortKey: 'nav.shortAccess', icon: ArrowDownLeft, items: [
    { to: '/api-keys', labelKey: 'nav.apiKeys', icon: KeyRound },
    { to: '/playground', labelKey: 'nav.playground', icon: MessagesSquare },
    { to: '/clients', labelKey: 'nav.clients', icon: MonitorSmartphone, badge: '3' },
    { to: '/proxy-access', labelKey: 'nav.proxyAccess', icon: ShieldCheck },
  ] },
  { id: 'grp-upstream', headingKey: 'nav.grpUpstream', shortKey: 'nav.shortUpstream', icon: ArrowUpRight, items: [
    { to: '/providers', labelKey: 'nav.providers', icon: Plug },
    { to: '/models', labelKey: 'nav.models', icon: Cpu },
    { to: '/catalog', labelKey: 'nav.catalogSources', icon: CloudDownload },
    { to: '/proxy-upstream', labelKey: 'nav.proxy', icon: ArrowLeftRight },
    { to: '/token-saver', labelKey: 'nav.tokenSaver', icon: Zap },
  ] },
  { id: 'grp-traffic', headingKey: 'nav.grpTraffic', shortKey: 'nav.shortTraffic', icon: Shuffle, items: [
    { to: '/tiers', labelKey: 'nav.rules', icon: Network },
    { to: '/route-entries', labelKey: 'nav.routeEntries', icon: Waypoints },
    { to: '/auto', labelKey: 'nav.auto', icon: BrainCircuit },
    { to: '/combos', labelKey: 'nav.combos', icon: Layers },
    { to: '/model-profiles', labelKey: 'nav.modelProfiles', icon: ClipboardList },
  ] },
  { id: 'grp-safety', headingKey: 'nav.grpSafety', shortKey: 'nav.shortSafety', icon: ShieldCheck, items: [
    { to: '/guardrails', labelKey: 'nav.guardrails', icon: ShieldAlert },
    { to: '/breaker-rules', labelKey: 'nav.breakerRules', icon: Settings2 },
  ] },
  { id: 'grp-observability', headingKey: 'nav.grpObservability', shortKey: 'nav.shortObservability', icon: Waves, items: [
    { to: '/sessions', labelKey: 'nav.sessions', icon: Users },
    { to: '/usage', labelKey: 'nav.usage', icon: BarChart3 },
    { to: '/quota', labelKey: 'nav.quota', icon: Wallet },
    { to: '/rate-limit', labelKey: 'nav.rateLimit', icon: Gauge },
    { to: '/failures', labelKey: 'nav.failures', icon: AlertOctagon },
    { to: '/captures', labelKey: 'nav.captures', icon: Archive },
    { to: '/logs', labelKey: 'nav.logs', icon: ScrollText },
  ] },
  { id: 'grp-harness', headingKey: 'nav.grpHarness', shortKey: 'nav.shortHarness', icon: Boxes, items: [
    { to: '/harness/plugins', labelKey: 'nav.plugins', icon: Layers },
    { to: '/harness/skills', labelKey: 'nav.skills', icon: Zap },
    { to: '/harness/mcp', labelKey: 'nav.mcp', icon: Plug },
  ] },
  { id: 'grp-system', headingKey: 'nav.grpSystem', shortKey: 'nav.shortSystem', icon: Settings, items: [
    { to: '/environments', labelKey: 'nav.environments', icon: FolderCog },
    { to: '/settings', labelKey: 'nav.settings', icon: Sliders },
    { to: '/plugins', labelKey: 'nav.pluginsManage', icon: Puzzle },
    { to: '/yaml', labelKey: 'nav.yaml', icon: FileCode2 },
  ] },
];

const ROUTE_META_KEYS: Record<string, { groupKey: string; titleKey: string }> = {
  '/': { groupKey: 'nav.grpOverview', titleKey: 'nav.overview' },
  '/tiers': { groupKey: 'nav.grpTraffic', titleKey: 'nav.rules' },
  '/route-entries': { groupKey: 'nav.grpTraffic', titleKey: 'nav.routeEntries' },
  '/auto': { groupKey: 'nav.grpTraffic', titleKey: 'nav.auto' },
  '/combos': { groupKey: 'nav.grpTraffic', titleKey: 'nav.combos' },
  '/model-profiles': { groupKey: 'nav.grpTraffic', titleKey: 'nav.modelProfiles' },
  '/api-keys': { groupKey: 'nav.grpAccess', titleKey: 'nav.apiKeys' },
  '/playground': { groupKey: 'nav.grpAccess', titleKey: 'nav.playground' },
  '/providers': { groupKey: 'nav.grpUpstream', titleKey: 'nav.providers' },
  '/models': { groupKey: 'nav.grpUpstream', titleKey: 'nav.models' },
  '/catalog': { groupKey: 'nav.grpUpstream', titleKey: 'nav.catalogSources' },
  '/harness/plugins': { groupKey: 'nav.grpHarness', titleKey: 'nav.plugins' },
  '/harness/skills': { groupKey: 'nav.grpHarness', titleKey: 'nav.skills' },
  '/harness/mcp': { groupKey: 'nav.grpHarness', titleKey: 'nav.mcp' },
  '/proxy-upstream': { groupKey: 'nav.grpUpstream', titleKey: 'nav.proxy' },
  '/token-saver': { groupKey: 'nav.grpUpstream', titleKey: 'nav.tokenSaver' },
  '/clients': { groupKey: 'nav.grpAccess', titleKey: 'nav.clients' },
  '/proxy-access': { groupKey: 'nav.grpAccess', titleKey: 'nav.proxyAccess' },
  '/guardrails': { groupKey: 'nav.grpSafety', titleKey: 'nav.guardrails' },
  '/breaker-rules': { groupKey: 'nav.grpSafety', titleKey: 'nav.breakerRules' },
  '/sessions': { groupKey: 'nav.grpObservability', titleKey: 'nav.sessions' },
  '/usage': { groupKey: 'nav.grpObservability', titleKey: 'nav.usage' },
  '/rate-limit': { groupKey: 'nav.grpObservability', titleKey: 'nav.rateLimit' },
  '/failures': { groupKey: 'nav.grpObservability', titleKey: 'nav.failures' },
  '/quota': { groupKey: 'nav.grpObservability', titleKey: 'nav.quota' },
  '/logs': { groupKey: 'nav.grpObservability', titleKey: 'nav.logs' },
  '/captures': { groupKey: 'nav.grpObservability', titleKey: 'nav.captures' },
  '/environments': { groupKey: 'nav.grpSystem', titleKey: 'nav.environments' },
  '/settings': { groupKey: 'nav.grpSystem', titleKey: 'nav.settings' },
  '/plugins': { groupKey: 'nav.grpSystem', titleKey: 'nav.pluginsManage' },
  '/yaml': { groupKey: 'nav.grpSystem', titleKey: 'nav.yaml' },
};

/** Which group the panel lists, derived from the pathname. Navigation owns
 *  the selection: landing on a page selects its group, while a rail click
 *  only previews another group until the next navigation. Deliberately not
 *  persisted — a reload shows the group of the page actually open rather
 *  than a preview left over from the previous session. */
function groupIdForPath(pathname: string): string {
  const match = NAV_GROUP_DEFS.find((group) =>
    group.items.some((item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(`${item.to}/`)))
  );
  return match?.id ?? NAV_GROUP_DEFS[0].id;
}

export const Layout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { lang, setLang, t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [status, setStatus] = useState<GatewayStatusResponse | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string>(() => groupIdForPath(location.pathname));
  const [compact, setCompact] = useState(() => localStorage.getItem('ocr_nav_compact') === '1');
  const [navPreference, setNavPreference] = useState<NavPreference>(readNavPreference);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => resolveThemePreference(localStorage.getItem(THEME_STORAGE_KEY)));

  /** Once the operator used the star CTA, the header repository button drops
   *  its "star us" tooltip — it stays a plain repo link. Re-read on the shared
   *  change event (same document) and on `storage` (another tab / window). */
  const [starNudgeDone, setStarNudgeDone] = useState(isStarNudgeDone);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [dismissedUpdate, setDismissedUpdate] = useState<string>(() => {
    try {
      return localStorage.getItem(UPDATE_DISMISSED_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    const sync = () => setNavPreference(readNavPreference());
    window.addEventListener(NAV_STYLE_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(NAV_STYLE_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    const sync = () => setStarNudgeDone(isStarNudgeDone());
    window.addEventListener(STAR_REMINDER_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(STAR_REMINDER_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const [webAuthActive, setWebAuthActive] = useState(false);

  useEffect(() => {
    const applyTheme = () => document.documentElement.setAttribute('data-theme', resolveStoredTheme(themePreference));
    applyTheme();
    localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themePreference]);
  useEffect(() => localStorage.setItem('ocr_nav_compact', compact ? '1' : '0'), [compact]);

  useEffect(() => {
    api.getAuthSession()
      .then((session) => setWebAuthActive(Boolean(session.webAuth?.active)))
      .catch(() => setWebAuthActive(false));
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api.getStatus();
      setStatus(data);
      setStatusError(false);
    } catch (error) {
      console.warn('Failed to poll gateway status:', error);
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 3000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  /** One background read per console load; while the gateway's GitHub call is
   *  still in flight the answer is `checking: true` and a few short polls
   *  collect the settled snapshot. Failures are silent — a gateway with no
   *  egress must not grow an error strip for a display-only check. */
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const poll = async () => {
      try {
        const info = await api.getUpdateCheck();
        if (cancelled) return;
        setUpdateInfo(info);
        attempts += 1;
        if (info.checking && attempts < 5) timer = window.setTimeout(poll, 4000);
      } catch {
        // Display-only: older gateways and offline starts simply show nothing.
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const currentRouteMeta = ROUTE_META_KEYS[location.pathname] ??
    Object.keys(ROUTE_META_KEYS)
      .filter((route) => route !== '/' && location.pathname.startsWith(`${route}/`))
      .sort((a, b) => b.length - a.length)
      .map((route) => ROUTE_META_KEYS[route])[0] ??
    { groupKey: 'nav.grpOverview', titleKey: 'nav.overview' };

  const routeGroupId = groupIdForPath(location.pathname);

  /** Navigation owns the selection: landing on a page selects its group, so a
   *  deep link never leaves the panel showing an unrelated section. */
  useEffect(() => {
    setMobileOpen(false);
    setActiveGroupId(routeGroupId);
  }, [location.pathname, routeGroupId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commandItems = useMemo<CommandItem[]>(() =>
    NAV_GROUP_DEFS.flatMap((group) => group.items.map((item) => ({
      to: item.to, label: t(item.labelKey), group: t(group.headingKey), icon: item.icon,
    }))), [t]);

  const copyGatewayUrl = () => {
    if (!status) return;
    const url = gatewayBaseUrl(status.port);
    void copyToClipboard(url)
      .then((ok) => (ok ? toast.success(t('nav.footerUrlCopied')) : toast.error(t('common.failed') + url)));
  };

  const handleRestartGateway = async () => {
    const ok = await confirmDialog({ title: t('header.restartConfirm') });
    if (!ok) return;
    try {
      const result = await api.restartGateway();
      if (result.status === 'failed') {
        toast.error(result.message || t('header.restartFailed'));
        return;
      }
      toast.info(t('header.restarting'));
    } catch {
      toast.error(t('header.restartFailed'));
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (let attempt = 0; attempt < 86; attempt += 1) {
      try {
        const response = await fetch('/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // The replacement process is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    toast.error(t('header.restartTimeout'));
    window.location.reload();
  };

  const themeOptions = [
    { value: 'light', label: t('header.themes.light'), icon: <Sun size={14} /> },
    { value: 'dark', label: t('header.themes.dark'), icon: <Moon size={14} /> },
    { value: 'system', label: t('header.themes.system'), icon: <Monitor size={14} /> },
  ];

  const gatewayOnline = Boolean(status) && !statusError;
  const trippedBreakers = status?.circuitBreakers?.tripped || 0;
  /** Rail click: selecting a group also re-opens a collapsed panel instead of
   *  leaving the click inert, which is the only way back out of compact mode. */
  const selectGroup = (groupId: string) => {
    setActiveGroupId(groupId);
    setCompact(false);
  };
  const activeGroupDef = NAV_GROUP_DEFS.find((group) => group.id === activeGroupId) ?? NAV_GROUP_DEFS[0];
  const navStyle = navPreference.style;
  /** `compact` only ever means "fold the rail's item list away", so it applies
   *  to the rail style alone; flat IS the list. */
  const railCollapsed = navStyle === 'rail' && compact;
  /** Below 900px the sidebar is a drawer; a persisted compact flag must not
   *  leave that drawer showing a rail with no panel in it. */
  const showPanel = !railCollapsed || mobileOpen;
  const railLabels = navStyle === 'rail' && navPreference.railLabels;

  const renderNavItem = (item: NavItemDef) => {
    const Icon = item.icon;
    return (
      <NavLink key={item.to} to={item.to} end={item.end}
        className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
        <Icon size={17} /><span className="nav-item-label">{t(item.labelKey)}</span>
        {item.badge && <span className="nav-item-badge">{item.badge}</span>}
      </NavLink>
    );
  };

  const latestRelease = updateInfo?.updateAvailable ? updateInfo.latestVersion : null;
  const showUpdate = Boolean(latestRelease && latestRelease !== dismissedUpdate);
  const dismissUpdate = () => {
    if (!latestRelease) return;
    setDismissedUpdate(latestRelease);
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, latestRelease);
    } catch {
      // Persistence is best-effort; the banner stays hidden for this mount.
    }
  };

  return (
    <div className="app-shell">
      {mobileOpen && <button className="sidebar-scrim" type="button" aria-label={t('common.close')} onClick={() => setMobileOpen(false)} />}
      <aside className={`app-sidebar is-${navStyle}${railCollapsed ? ' is-compact' : ''}${railLabels ? ' has-rail-labels' : ''}${mobileOpen ? ' is-mobile-open' : ''}`}>
        {/* First level: one glyph per group. The rail is the stable anchor —
            its eight buttons never move, so muscle memory survives whatever
            the panel is showing. Only the rail style has one. */}
        {navStyle === 'rail' && <div className="app-rail">
          <NavLink to="/" className="brand-mark-link" aria-label="OmniCellRouter">
            <span className="brand-mark"><Zap size={19} strokeWidth={2.4} /></span>
          </NavLink>
          <nav className="rail-nav" aria-label={t('nav.consoleTag')}>
            {NAV_GROUP_DEFS.map((group) => {
              const GroupIcon = group.icon;
              const isActive = group.id === activeGroupDef.id;
              return (
                <button type="button" key={group.id}
                  className={`rail-btn${isActive ? ' is-active' : ''}${railLabels ? ' has-caption' : ''}`}
                  onClick={() => selectGroup(group.id)} title={t(group.headingKey)}
                  aria-label={t(group.headingKey)} aria-controls={showPanel ? 'nav-panel' : undefined}
                  aria-current={isActive ? 'true' : undefined}>
                  <GroupIcon size={18} />
                  {railLabels && <span className="rail-btn-label">{t(group.shortKey)}</span>}
                </button>
              );
            })}
          </nav>
          <div className="rail-footer">
            <button type="button" className="app-icon-button sidebar-collapse" onClick={() => setCompact((value) => !value)}
              title={t(railCollapsed ? 'nav.expand' : 'nav.collapse')} aria-label={t(railCollapsed ? 'nav.expand' : 'nav.collapse')}>
              {railCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
        </div>}

        {/* Second level: the item list. A rail lists the selected group; flat
            lists every group under a static label. Nothing is hidden by hover
            or by a fold in either style. */}
        {showPanel && <div className="app-navpanel">
          <div className="panel-brand">
            <div className="brand-copy">
              <NavLink to="/" className="brand-name"><strong>OmniCellRouter</strong></NavLink>
              <small>
                {showUpdate && updateInfo && latestRelease ? (
                  <a className="brand-update" href={updateInfo.releaseUrl} target="_blank" rel="noreferrer"
                    title={t('update.banner', { version: latestRelease, current: updateInfo.currentVersion })}
                    aria-label={t('update.banner', { version: latestRelease, current: updateInfo.currentVersion })}>
                    {t('nav.version', { version: status?.version ?? __APP_VERSION__ })} → {latestRelease}
                  </a>
                ) : (
                  <>{t('nav.consoleTag')} · {t('nav.version', { version: status?.version ?? __APP_VERSION__ })}</>
                )}
              </small>
            </div>
          </div>

          {/* The `Ctrl K` badge only where the row has room for it: in the rail
              style the panel is 188-196px wide and the badge would eat ~46px of
              it, truncating the label. Header search and the palette itself
              still advertise the shortcut either way. */}
          <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)} title={t('nav.searchPlaceholder')}>
            <Search size={15} /><span>{t('nav.searchPlaceholder')}</span>
            {navStyle === 'flat' && <kbd>Ctrl K</kbd>}
          </button>

          {/* rail: the selected group's items. flat: every group under a static
              label. */}
          {navStyle === 'rail' && <>
            <div className="panel-heading">{t(activeGroupDef.headingKey)}</div>
            <nav className="sidebar-nav" id="nav-panel" aria-label={t(activeGroupDef.headingKey)}>
              {activeGroupDef.items.map(renderNavItem)}
            </nav>
          </>}

          {navStyle === 'flat' && <nav className="sidebar-nav" id="nav-panel" aria-label={t('nav.consoleTag')}>
            {NAV_GROUP_DEFS.map((group) => (
              <React.Fragment key={group.id}>
                <div className="panel-heading">{t(group.headingKey)}</div>
                {group.items.map(renderNavItem)}
              </React.Fragment>
            ))}
          </nav>}

          <div className="sidebar-footer">
            <div className="sidebar-status-row">
              <span className={`status-dot${gatewayOnline ? ' is-online' : ''}`} title={t(gatewayOnline ? 'nav.footerOnline' : 'nav.footerOffline')} />
              {status ? <button type="button" onClick={copyGatewayUrl} title={t('nav.footerCopyUrl', { url: gatewayBaseUrl(status.port) })}>:{status.port}</button>
                : <span>{t('nav.footerOffline')}</span>}
            </div>
            {status && <button type="button" className="sidebar-env" onClick={() => navigate('/environments')} title={status.env?.configPath}>
              <FolderCog size={12} /><span>{status.env?.name ?? '—'}</span>
            </button>}
            <div className="sidebar-quota"><QuotaPeek /></div>
          </div>
        </div>}
      </aside>

      <div className="app-workspace">
        {/* Frameless desktop shell: the header doubles as the window title
            bar. `deep` = drag anywhere in this subtree except clickable
            elements (buttons, inputs, links); double-click toggles maximize. */}
        <header className="app-header" data-tauri-drag-region="deep">
          <div className="header-heading">
            <button type="button" className="app-icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label={t('nav.openMenu')} title={t('nav.openMenu')}>
              <Menu size={19} />
            </button>
            <div className="header-breadcrumb">
              <span>{t(currentRouteMeta.groupKey)}</span><i>/</i><strong>{t(currentRouteMeta.titleKey)}</strong>
            </div>
            <span className={`header-health${gatewayOnline ? ' is-online' : ''}`}>
              <span className="status-dot" />{t(gatewayOnline ? 'nav.footerOnline' : 'nav.footerOffline')}
            </span>
          </div>
          <div className="header-actions">
            <button type="button" className="header-search" onClick={() => setPaletteOpen(true)}>
              <Search size={15} /><span>{t('nav.searchPlaceholder')}</span><kbd>Ctrl K</kbd>
            </button>
            <div className="header-preferences" title={t('header.switchLang')}>
              <Globe size={14} />
              <Combobox variant="ghost" value={lang} onChange={(value) => setLang(value as Lang)} options={LANGUAGES}
                style={{ width: 'auto', padding: '7px 6px', fontSize: 'var(--text-sm)' }} />
            </div>
            <Combobox variant="ghost" value={themePreference} onChange={(value) => setThemePreference(resolveThemePreference(value))} options={themeOptions}
              style={{ width: 136, flexShrink: 0, padding: '7px 8px', fontSize: 'var(--text-sm)' }} />
            {/* Repository link, same 36px icon-button anatomy as its neighbours:
                the header's icon row is the one place a lone brand glyph reads
                as native chrome. A plain anchor — the desktop shell's external
                link interceptor routes it to the system browser. */}
            <a className="app-icon-button header-github" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer"
              title={t(starNudgeDone ? 'starReminder.footerRepo' : 'starReminder.footerStar')}
              aria-label={t(starNudgeDone ? 'starReminder.footerRepo' : 'starReminder.footerStar')}>
              <Github size={16} />
            </a>
            <DownloadCenter />
            <span className="header-separator" />
            <button className="app-icon-button" onClick={handleRestartGateway} title={t('header.restart')} aria-label={t('header.restart')}>
              <RotateCcw size={16} />
            </button>
            <button className="app-icon-button header-breaker" onClick={() => navigate('/guardrails')} title={t('nav.guardrails')} aria-label={t('nav.guardrails')}>
              <ShieldAlert size={16} />{trippedBreakers > 0 && <span>{trippedBreakers}</span>}
            </button>
            {webAuthActive && <button className="app-icon-button" title={t('settings.waLogout')} aria-label={t('settings.waLogout')}
              onClick={async () => {
                const ok = await confirmDialog({ title: t('settings.waLogoutConfirmTitle'), description: t('settings.waLogoutConfirmDesc'), confirmLabel: t('settings.waLogout') });
                if (ok) api.logout().finally(() => window.location.reload());
              }}><LogOut size={16} /></button>}
          </div>
          <WindowControls />
        </header>
        {showUpdate && updateInfo && latestRelease && (
          <UpdateBanner
            currentVersion={updateInfo.currentVersion}
            latestVersion={latestRelease}
            releaseUrl={updateInfo.releaseUrl}
            onDismiss={dismissUpdate}
          />
        )}
        <main className="app-main"><div className="page-canvas"><Outlet context={{ status, statusError, refreshStatus }} /></div></main>
      </div>
      <CommandPalette open={paletteOpen} items={commandItems} onClose={() => setPaletteOpen(false)} onSelect={(to) => navigate(to)} />
    </div>
  );
};
