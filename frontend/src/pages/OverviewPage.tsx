import React, { useState, useEffect, useCallback } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import {
  Activity,
  Zap,
  Cpu,
  Clock,
  ShieldCheck,
  Terminal,
  ArrowRight,
} from 'lucide-react';
import { api, type GatewayStatusResponse, type UsageStatsResponse } from '../lib/api';
import { BrandIcon } from '../components/BrandIcons';
import { Combobox } from '../components/Combobox';
import { useI18n } from '../i18n/I18nContext';

const REFRESH_INTERVAL_MS = 10_000;

// Time-range presets for the Overview's usage cards. '0' = the backend's
// default whole-trace-ring window (no `since` param sent).
const RANGE_OPTIONS: { value: string; labelKey: string; hours: number }[] = [
  { value: '1', labelKey: 'overview.range.1h', hours: 1 },
  { value: '24', labelKey: 'overview.range.24h', hours: 24 },
  { value: '168', labelKey: 'overview.range.7d', hours: 168 },
];

export const OverviewPage: React.FC = () => {
  const { status, statusError } = useOutletContext<{ status: GatewayStatusResponse | null; statusError: boolean }>();
  const { t } = useI18n();
  const metrics = status?.metrics;

  // All four header cards report TRACE-WINDOWED raw counts from
  // /api/admin/usage (requests / input tokens / output tokens / avg
  // latency). Cost accounting was deliberately removed — these are counts,
  // not dollars. Until the first window fetch completes we fall back to the
  // cumulative FinOps token counters so the cards never look empty.
  const [rangeHours, setRangeHours] = useState<string>('24');
  const [usage, setUsage] = useState<UsageStatsResponse | null>(null);

  const loadWindow = useCallback(async () => {
    const hours = Number(rangeHours);
    const sinceMs = hours > 0 ? Date.now() - hours * 3_600_000 : undefined;
    try {
      setUsage(await api.getUsageStats(sinceMs));
    } catch (err) {
      console.error('[Overview] usage refresh failed:', err);
    }
  }, [rangeHours]);

  useEffect(() => {
    loadWindow();
  }, [loadWindow]);

  useEffect(() => {
    const timer = setInterval(loadWindow, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadWindow]);

  const totals = usage?.totals;
  const requests = totals?.requests ?? metrics?.totalRequests ?? 0;
  const inputTokens = totals?.inputTokens ?? metrics?.tokens.totalInputTokens ?? 0;
  const outputTokens = totals?.outputTokens ?? metrics?.tokens.totalOutputTokens ?? 0;
  const cachedTokens = totals?.cachedTokens ?? metrics?.tokens.totalCachedTokens ?? 0;
  // Latency stays windowed when available; the cumulative FinOps average is
  // the in-flight fallback (semantics identical, just wider window).
  const latency = totals ? totals.avgLatencyMs : Math.round(metrics?.latency.avgMs || 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Gateway unreachable banner */}
      {statusError && !status && (
        <div
          style={{
            padding: '10px 16px',
            borderRadius: '8px',
            border: '1px solid var(--accent-rose)',
            background: 'rgba(244, 63, 94, 0.08)',
            color: 'var(--accent-rose)',
            fontSize: '13px',
          }}
        >
          {t('overview.statusOffline')}
        </div>
      )}

      {/* 4 Core Usage Metrics */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          {t('overview.windowScope')}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('overview.rangeLabel')}</span>
          <Combobox
            value={rangeHours}
            onChange={setRangeHours}
            options={RANGE_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) }))}
            style={{ fontSize: '12px', padding: '5px 10px', width: '120px' }}
          />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.requests')}</span>
            <Activity size={16} color="var(--accent-emerald)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--accent-emerald)' }}>
            {requests.toLocaleString()}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.requestsSub', { fallbacks: (metrics?.fallbackCount ?? 0).toLocaleString() })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.tokensIn')}</span>
            <Cpu size={16} color="var(--accent)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--text-main)' }}>
            {inputTokens.toLocaleString()}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.tokensInSub', { cached: cachedTokens.toLocaleString() })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.tokensOut')}</span>
            <Zap size={16} color="var(--accent-violet)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--text-main)' }}>
            {outputTokens.toLocaleString()}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.tokensOutSub')}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.avgLatency')}</span>
            <Clock size={16} color="var(--accent-amber)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--text-main)' }}>
            {latency} ms
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.latencySub')}
          </div>
        </div>
      </div>

      {/* 4-Tier Pipeline Topology Architecture */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Zap size={16} />
            <span>{t('overview.pipelineTitle')}</span>
          </div>
          <Link to="/tiers" className="btn btn-sm">
            <span>{t('overview.pipelineBtn')}</span>
            <ArrowRight size={12} />
          </Link>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
          <div className="sub-card" style={{ padding: 14 }}>
            <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 700 }}>STAGE 1</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage1')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage1Desc')}</div>
          </div>
          <div className="sub-card" style={{ padding: 14 }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-emerald)', fontWeight: 700 }}>STAGE 2</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage2')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage2Desc')}</div>
          </div>
          <div className="sub-card" style={{ padding: 14 }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-violet)', fontWeight: 700 }}>STAGE 3</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage3')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage3Desc')}</div>
          </div>
          <div className="sub-card" style={{ padding: 14 }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-rose)', fontWeight: 700 }}>STAGE 4</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage4')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage4Desc')}</div>
          </div>
        </div>
      </div>

      {/* Two Column Section: Client Interception & Circuit Breakers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '20px' }}>
        {/* Clients Hub Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Terminal size={16} />
              <span>{t('overview.clientsCardTitle')}</span>
            </div>
            <Link to="/clients" className="btn btn-sm">{t('overview.manage')}</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {status?.clients?.map(c => (
              <div
                key={c.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'var(--well-bg)',
                  border: '1px solid var(--card-border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <BrandIcon name={c.name === 'opencode-proxy' ? 'opencode' : c.name} size={18} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{c.name === 'opencode-proxy' ? t('clients.nameOpencodeProxy') : c.displayName}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                      {c.configPath}
                    </div>
                  </div>
                </div>
                <div>
                  {c.hooked ? (
                    <span className="badge badge-success">{t('overview.hooked')}</span>
                  ) : (
                    <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                      {t('overview.notHooked')}
                    </span>
                  )}
                </div>
              </div>
            )) || <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>...</div>}
          </div>
        </div>

        {/* Circuit Breakers Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <ShieldCheck size={16} />
              <span>{t('overview.breakersCardTitle')}</span>
            </div>
            <Link to="/guardrails" className="btn btn-sm">{t('overview.viewAll')}</Link>
          </div>
          <div style={{ display: 'flex', gap: '16px', marginBottom: '14px' }}>
            <div style={{ flex: 1, padding: '12px', background: 'var(--bg-elev)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.totalBreakers')}</div>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>{status?.circuitBreakers?.total || 0}</div>
            </div>
            <div style={{ flex: 1, padding: '12px', background: 'var(--bg-elev)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.openBreakers')}</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: status?.circuitBreakers?.tripped ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
                {status?.circuitBreakers?.tripped || 0}
              </div>
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
            {t('overview.breakersDesc')}
          </div>
        </div>
      </div>
    </div>
  );
};
