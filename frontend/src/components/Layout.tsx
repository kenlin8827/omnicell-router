import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid,
  Network,
  KeyRound,
  MonitorSmartphone,
  ShieldAlert,
  Users,
  Sliders,
  FileCode2,
  RefreshCw,
  Search,
  ChevronDown,
  RotateCcw,
  Globe,
  Plug,
  Cpu,
  CloudDownload,
  ArrowLeftRight,
  Zap,
  Activity,
  Shuffle,
  BrainCircuit,
  Layers,
  Server,
  LogIn,
  LogOut,
  ShieldCheck,
  Waves,
  BarChart3,
  Settings,
  ScrollText,
  Archive,
  FolderCog,
  type LucideIcon,
} from 'lucide-react';
import { api, type GatewayStatusResponse } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from './Combobox';

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
  icon: LucideIcon;
  items: NavItemDef[];
}

const NAV_GROUP_DEFS: NavGroupDef[] = [
  {
    id: 'grp-overview',
    headingKey: 'nav.grpOverview',
    icon: Activity,
    items: [
      { to: '/', labelKey: 'nav.overview', icon: LayoutGrid, end: true },
    ],
  },
  {
    id: 'grp-access',
    headingKey: 'nav.grpAccess',
    icon: LogIn,
    items: [
      { to: '/api-keys', labelKey: 'nav.apiKeys', icon: KeyRound },
      { to: '/clients', labelKey: 'nav.clients', icon: MonitorSmartphone, badge: '3' },
      { to: '/proxy-access', labelKey: 'nav.proxyAccess', icon: ShieldCheck },
    ],
  },
  {
    id: 'grp-traffic',
    headingKey: 'nav.grpTraffic',
    icon: Shuffle,
    items: [
      { to: '/tiers', labelKey: 'nav.rules', icon: Network },
      { to: '/combos', labelKey: 'nav.combos', icon: Layers },
      { to: '/auto', labelKey: 'nav.auto', icon: BrainCircuit },
    ],
  },
  {
    id: 'grp-upstream',
    headingKey: 'nav.grpUpstream',
    icon: Server,
    items: [
      { to: '/providers', labelKey: 'nav.providers', icon: Plug },
      { to: '/models', labelKey: 'nav.models', icon: Cpu },
      { to: '/catalog', labelKey: 'nav.catalogSources', icon: CloudDownload },
      { to: '/proxy', labelKey: 'nav.proxy', icon: ArrowLeftRight },
      { to: '/token-saver', labelKey: 'nav.tokenSaver', icon: Zap },
    ],
  },
  {
    id: 'grp-safety',
    headingKey: 'nav.grpSafety',
    icon: ShieldCheck,
    items: [
      { to: '/guardrails', labelKey: 'nav.guardrails', icon: ShieldAlert },
    ],
  },
  {
    id: 'grp-observability',
    headingKey: 'nav.grpObservability',
    icon: Waves,
    items: [
      { to: '/sessions', labelKey: 'nav.sessions', icon: Users },
      { to: '/usage', labelKey: 'nav.usage', icon: BarChart3 },
      { to: '/captures', labelKey: 'nav.captures', icon: Archive },
      { to: '/flywheel', labelKey: 'nav.flywheel', icon: BrainCircuit },
      { to: '/logs', labelKey: 'nav.logs', icon: ScrollText },
    ],
  },
  {
    id: 'grp-system',
    headingKey: 'nav.grpSystem',
    icon: Settings,
    items: [
      { to: '/environments', labelKey: 'nav.environments', icon: FolderCog },
      { to: '/settings', labelKey: 'nav.settings', icon: Sliders },
      { to: '/yaml', labelKey: 'nav.yaml', icon: FileCode2 },
    ],
  },
];

const ROUTE_META_KEYS: Record<string, { groupKey: string; titleKey: string }> = {
  '/': { groupKey: 'nav.grpOverview', titleKey: 'nav.overview' },
  '/tiers': { groupKey: 'nav.grpTraffic', titleKey: 'nav.rules' },
  '/auto': { groupKey: 'nav.grpTraffic', titleKey: 'nav.auto' },
  '/combos': { groupKey: 'nav.grpTraffic', titleKey: 'nav.combos' },
  '/api-keys': { groupKey: 'nav.grpAccess', titleKey: 'nav.apiKeys' },
  '/providers': { groupKey: 'nav.grpUpstream', titleKey: 'nav.providers' },
  '/models': { groupKey: 'nav.grpUpstream', titleKey: 'nav.models' },
  '/catalog': { groupKey: 'nav.grpUpstream', titleKey: 'nav.catalogSources' },
  '/proxy': { groupKey: 'nav.grpUpstream', titleKey: 'nav.proxy' },
  '/token-saver': { groupKey: 'nav.grpUpstream', titleKey: 'nav.tokenSaver' },
  '/clients': { groupKey: 'nav.grpAccess', titleKey: 'nav.clients' },
  '/proxy-access': { groupKey: 'nav.grpAccess', titleKey: 'nav.proxyAccess' },
  '/guardrails': { groupKey: 'nav.grpSafety', titleKey: 'nav.guardrails' },
  '/sessions': { groupKey: 'nav.grpObservability', titleKey: 'nav.sessions' },
  '/usage': { groupKey: 'nav.grpObservability', titleKey: 'nav.usage' },
  '/logs': { groupKey: 'nav.grpObservability', titleKey: 'nav.logs' },
  '/captures': { groupKey: 'nav.grpObservability', titleKey: 'nav.captures' },
  '/flywheel': { groupKey: 'nav.grpObservability', titleKey: 'nav.flywheel' },
  '/environments': { groupKey: 'nav.grpSystem', titleKey: 'nav.environments' },
  '/settings': { groupKey: 'nav.grpSystem', titleKey: 'nav.settings' },
  '/yaml': { groupKey: 'nav.grpSystem', titleKey: 'nav.yaml' },
};

export const Layout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { lang, setLang, t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [status, setStatus] = useState<GatewayStatusResponse | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState(() => localStorage.getItem('ocr_theme') || 'obsidian');
  // Console webAuth active → show the logout control in the header.
  const [webAuthActive, setWebAuthActive] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ocr_theme', theme);
  }, [theme]);

  useEffect(() => {
    api
      .getAuthSession()
      .then(s => setWebAuthActive(Boolean(s.webAuth?.active)))
      .catch(() => setWebAuthActive(false));
  }, []);

  // Footer port chip — copying the gateway base URL is the console's most
  // frequent manual step (pasting it into a client config), so the port is a
  // one-click copy. 127.0.0.1 matches the snippets on the Clients/ApiKeys pages.
  const copyGatewayUrl = () => {
    if (!status) return;
    const url = `http://127.0.0.1:${status.port}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success(t('nav.footerUrlCopied')))
      .catch(() => toast.error(t('common.failed') + url));
  };

  // Load gateway status periodically
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await api.getStatus();
        setStatus(data);
        setStatusError(false);
      } catch (err) {
        console.warn('Failed to poll gateway status:', err);
        setStatusError(true);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleResetBreakers = async () => {
    const ok = await confirmDialog({ title: t('header.resetConfirm') });
    if (!ok) return;
    try {
      await api.resetBreakers();
      toast.success(t('header.resetSuccess'));
      const data = await api.getStatus();
      setStatus(data);
    } catch (err: any) {
      toast.error(t('header.resetFailed') + err.message);
    }
  };

  const handleRestartGateway = async () => {
    const ok = await confirmDialog({ title: t('header.restartConfirm') });
    if (!ok) return;
    try {
      const res = await api.restartGateway();
      if (res.status === 'failed') {
        // Spawn failed — the gateway KEEPS RUNNING (console.ts never exits
        // without a replacement). No reload: the console is still live.
        toast.error(res.message || t('header.restartFailed'));
        return;
      }
      toast.info(t('header.restarting'));
    } catch {
      toast.error(t('header.restartFailed'));
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    // The old process dies ~0.5s after acknowledging; the replacement needs a
    // few seconds to boot. Poll /health (served by the gateway itself) until
    // it is back, then reload — up to ~45s.
    await new Promise((r) => setTimeout(r, 2000));
    for (let i = 0; i < 86; i++) {
      try {
        const res = await fetch('/health', { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // gateway still offline
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    toast.error(t('header.restartTimeout'));
    window.location.reload();
  };

  const currentRouteMeta = ROUTE_META_KEYS[location.pathname] || {
    groupKey: 'OpenCode Router',
    titleKey: 'Dashboard',
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0 }}>
      {/* Sidebar Navigation */}
      <aside
        style={{
          width: '270px',
          background: 'var(--sidebar-bg)',
          backdropFilter: 'blur(24px)',
          borderRight: '1px solid var(--card-border)',
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
          zIndex: 40,
          overflowY: 'hidden',
        }}
      >
        {/* Brand Header */}
        <div
          style={{
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            borderBottom: '1px solid var(--card-border)',
          }}
        >
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, var(--accent), var(--accent-emerald))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#000',
              fontWeight: 800,
              boxShadow: '0 0 16px var(--accent-glow)',
            }}
          >
            <Zap size={18} strokeWidth={2.5} fill="currentColor" />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '-0.02em' }}>OpenCode Router</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
              {t('nav.consoleTag')}
            </div>
          </div>
        </div>

        {/* Sidebar Search Bar — fixed above the nav scroller; only the tree
            below scrolls, so nothing ever paints underneath these bars and
            the translucent sidebar background can't ghost scrolled items */}
        <div style={{ padding: '12px 14px 4px 14px' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={13} style={{ position: 'absolute', left: '10px', color: 'var(--text-dim)', pointerEvents: 'none' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('nav.searchPlaceholder')}
              className="input"
              style={{
                fontSize: '12px',
                padding: '7px 10px 7px 30px',
                borderRadius: '8px',
              }}
            />
          </div>
        </div>

        {/* Grouped Multi-Menu Tree — the ONLY scrolling region in the sidebar */}
        <div style={{ padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {NAV_GROUP_DEFS.map(group => {
            const filteredItems = group.items.filter(item => {
              const label = t(item.labelKey);
              return label.toLowerCase().includes(searchQuery.toLowerCase());
            });

            if (searchQuery && filteredItems.length === 0) return null;
            const isCollapsed = !searchQuery && collapsedGroups[group.id];

            return (
              <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div
                  onClick={() => toggleGroup(group.id)}
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    // Group headers are navigation labels, not tertiary meta:
                    // muted, so they hold up at 11px on paper themes.
                    color: 'var(--text-muted)',
                    padding: '6px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    userSelect: 'none',
                    borderRadius: '6px',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <group.icon size={12} strokeWidth={2.5} />
                    {t(group.headingKey)}
                  </span>
                  <ChevronDown
                    size={13}
                    style={{
                      transition: 'transform 0.2s ease',
                      transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                    }}
                  />
                </div>

                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {filteredItems.map(item => {
                      const Icon = item.icon;
                      const label = t(item.labelKey);
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.end}
                          style={({ isActive }) => ({
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 12px',
                            borderRadius: '8px',
                            fontSize: '13px',
                            fontWeight: isActive ? 600 : 500,
                            color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                            background: isActive ? 'var(--surface-hover)' : 'transparent',
                            border: isActive ? '1px solid var(--card-border)' : '1px solid transparent',
                            textDecoration: 'none',
                            transition: 'all 0.15s ease',
                          })}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <Icon size={16} />
                            <span>{label}</span>
                          </div>
                          {item.badge && (
                            <span
                              style={{
                                fontSize: '10px',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                background: 'var(--surface-hover)',
                                color: 'var(--text-dim)',
                                fontWeight: 600,
                              }}
                            >
                              {item.badge}
                            </span>
                          )}
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar Footer — one line, left-aligned with the menu grid: the dot
            sits flush at the icon column's left edge (padding 22px) and the
            port trails it 4px, so the lamp reads attached to its endpoint.
            Segment order: ● + listening port (the dot
            binds to the live endpoint, VS Code / Docker convention — the port
            copies the gateway base URL), then the active env (book-set) tag
            (navigates to the Environments page; its icon carries the menu
            label color, not the accent), and the static runtime version
            trails at the far right — the weakest slot, since it never
            changes while running. The two clickable segments stay paired
            up front; "default:3000" would misread as a host:port address,
            so they are separate targets. Version still
            comes live from /api/admin/status (a stale cached bundle can't
            misreport); the build-time constant is the fallback until status
            arrives or while the gateway is unreachable, and the dot color makes
            that fallback visible. Replaces the old hardcoded "OpenCode Router
            Gateway Console" tagline, which duplicated the brand header and
            skipped i18n. */}
        {(() => {
          const gatewayOnline = Boolean(status) && !statusError;
          const chipStyle = {
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            whiteSpace: 'nowrap' as const,
            cursor: 'pointer',
          };
          const sepStyle = { color: 'var(--divider)' };
          return (
            <div
              style={{
                padding: '14px 14px 14px 22px',
                borderTop: '1px solid var(--divider)',
                fontSize: '11px',
                color: 'var(--text-dim)',
                fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: '10px',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {/* Dot + port are one tight unit — the lamp belongs to the
                  endpoint (4px apart). The dot sits flush at the icon column's
                  left edge (padding 22px = same x as the menu icons); the port
                  trails at 32px. Lamp-to-edge proximity wins over the old
                  48px label-column alignment — a floating status light reads
                  as detached. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <span
                  title={gatewayOnline ? t('nav.footerOnline') : t('nav.footerOffline')}
                  className={gatewayOnline ? 'dot-pulse' : undefined}
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: gatewayOnline ? 'var(--accent-emerald)' : 'var(--text-dim)',
                    boxShadow: gatewayOnline ? '0 0 6px var(--accent-emerald)' : 'none',
                  }}
                />
                {status ? (
                  <button
                    type="button"
                    onClick={copyGatewayUrl}
                    title={t('nav.footerCopyUrl', { url: `http://127.0.0.1:${status.port}` })}
                    style={chipStyle}
                  >
                    :{status.port}
                  </button>
                ) : (
                  <span>{t('nav.footerOffline')}</span>
                )}
              </span>
              {status && (
                <>
                  <span style={sepStyle}>·</span>
                  <button
                    type="button"
                    onClick={() => navigate('/environments')}
                    title={status.env?.configPath}
                    style={{ ...chipStyle, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    <FolderCog size={11} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                    {status.env?.name ?? '—'}
                  </button>
                </>
              )}
              <span style={sepStyle}>·</span>
              {t('nav.version', { version: status?.version ?? __APP_VERSION__ })}
            </div>
          );
        })()}
      </aside>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {/* Top Header */}
        <header
          style={{
            backdropFilter: 'blur(20px)',
            background: 'var(--header-bg)',
            borderBottom: '1px solid var(--card-border)',
            position: 'sticky',
            top: 0,
            zIndex: 30,
            padding: '12px clamp(14px, 2.5vw, 28px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            rowGap: 8,
          }}
        >
          {/* Breadcrumb Trail */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 500, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <span className="hdr-crumb-group" style={{ color: 'var(--text-muted)' }}>{t(currentRouteMeta.groupKey)}</span>
            <span style={{ color: 'var(--text-dim)' }}>/</span>
            <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>{t(currentRouteMeta.titleKey)}</span>
          </div>

          {/* Right Action Tools — the env (book-set) chip and the Live-port pill
              used to live here; both moved to the always-visible sidebar footer
              (version + status dot + env:port) to avoid triple duplication. */}
          <div className="hdr-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', rowGap: 8, justifyContent: 'flex-end' }}>
            {/* Language Switcher (i18n) */}
            <button
              className="btn"
              onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              title={t('header.switchLang')}
            >
              <Globe size={13} color="var(--accent)" />
              <span className="hdr-label hdr-label-opt" style={{ fontWeight: 700 }}>{t('header.langBtn')}</span>
            </button>

            {/* Console Logout — only when webAuth login is active */}
            {webAuthActive && (
              <button
                className="btn"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: t('settings.waLogoutConfirmTitle'),
                    description: t('settings.waLogoutConfirmDesc'),
                    confirmLabel: t('settings.waLogout'),
                  });
                  if (ok) api.logout().finally(() => window.location.reload());
                }}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                title={t('settings.waLogout')}
              >
                <LogOut size={13} color="var(--accent-red, #ef4444)" />
                <span className="hdr-label hdr-label-opt" style={{ fontWeight: 700 }}>{t('settings.waLogout')}</span>
              </button>
            )}

            {/* Theme Picker */}
            <Combobox
              style={{ width: 'clamp(120px, 13vw, 168px)', flexShrink: 0, padding: '6px 12px', fontSize: '12px', cursor: 'pointer' }}
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'obsidian', label: t('header.themes.obsidian'), swatch: '#06b6d4' },
                { value: 'indigo', label: t('header.themes.indigo'), swatch: '#6366f1' },
                { value: 'cyber', label: t('header.themes.cyber'), swatch: '#10b981' },
                { value: 'violet', label: t('header.themes.violet'), swatch: '#8b5cf6' },
                { value: 'sunset', label: t('header.themes.sunset'), swatch: '#f43f5e' },
                { value: 'light', label: t('header.themes.light'), swatch: '#0284c7' },
                { value: 'amber', label: t('header.themes.amber'), swatch: '#d97706' },
              ]}
            />

            {/* Quick Actions */}
            <button className="btn" onClick={handleRestartGateway} title={t('header.restart')}>
              <RotateCcw size={13} />
              <span className="hdr-label">{t('header.restart')}</span>
            </button>
            <button className="btn btn-primary" onClick={handleResetBreakers} title={t('header.resetBreakers')}>
              <RefreshCw size={13} />
              <span className="hdr-label">{t('header.resetBreakers')}</span>
            </button>
          </div>
        </header>

        {/* Page Content Container — scrolls for long pages so the sidebar and
            header stay fixed; fixed-viewport pages (logs/captures) get their
            own internal scrollbars because this box has a definite height. */}
        <main style={{ padding: 'clamp(14px, 2.5vw, 28px)', flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
          <Outlet context={{ status, statusError }} />
        </main>
      </div>
    </div>
  );
};
