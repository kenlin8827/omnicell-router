import { useState } from 'react';
import { opencodeApi, OcApiError, type ProbeHintCode, type TestProviderResult } from './api';
import { runPool } from './runPool';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';

type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Probe hint codes → i18n keys (mirrors backend ProbeHintCode, api.ts). */
const PROBE_HINT_KEY: Record<ProbeHintCode, string> = {
  regionBlocked: 'op.probeHintRegion',
  authFailed: 'op.probeHintAuth',
  protocolMismatch: 'op.probeHintProtocol',
  urlModelMismatch: 'op.probeHintUrlModel',
  rateLimited: 'op.probeHintRate',
  upstreamError: 'op.probeHintUpstream',
  businessRejected: 'op.probeHintBusiness',
  endpointNotFound: 'op.probeHintNotFound',
};

/** Test-route 400 precondition reasonCodes → i18n keys (console.ts). */
const TEST_REASON_KEY: Record<string, string> = {
  no_testable_model: 'op.reasonNoTestableModel',
  no_base_url: 'op.reasonNoBaseUrl',
  account_not_testable: 'op.reasonAccountNotTestable',
};

/**
 * Compose the localized display string from a failed probe's machine limbs:
 * `HTTP <status> —— <category label> | <upstream body>`. The label is a short
 * CLASSIFICATION only (product rule 2026-10-14: classify, never speculate or
 * instruct) — the provider's own error body stays the detail. Transport/
 * unroutable failures are single localized limbs. Unknown codes stay raw +
 * loud (gap #8 rule).
 */
export const composeProbeError = (r: TestProviderResult, t: TFn): string => {
  // Skew passthrough: a backend predating the machine-limb contract still
  // sends a composed `error` string — show it raw rather than swallow the
  // diagnosis down to the bare fallback.
  if (
    r.httpStatus === undefined && !r.transportCode && !r.unroutableCode &&
    !r.hintCode && !r.upstreamBody && r.error
  )
    return r.error;
  if (r.transportCode === 'timeout') return t('op.probeTimeout', { ms: r.timeoutMs ?? 0 });
  if (r.transportCode === 'unreachable')
    return t('op.probeUnreachable', { url: r.transportUrl ?? '?', cause: r.transportCause ?? '?' });
  if (r.unroutableCode)
    return t(
      r.unroutableCode === 'unknownPackage' ? 'op.probeUnroutableUnknownPkg' : 'op.probeUnroutableDedicated',
      { npm: r.unroutableNpm || '—' }
    );
  let s = r.httpStatus !== undefined ? `HTTP ${r.httpStatus}` : t('op.testFailMsg');
  if (r.hintCode) s += ` —— ${t(PROBE_HINT_KEY[r.hintCode] ?? r.hintCode)}`;
  if (r.upstreamBody) s += ` | ${r.upstreamBody}`;
  if (r.triedModels && r.triedModels.length > 1)
    s += ` (${t('op.testRotated', { n: r.triedModels.length, models: r.triedModels.join(', ') })})`;
  return s;
};

/** Compose the localized message for a thrown pull/test OcApiError. Unknown
 * reasonCodes fall through to the raw server message. */
export const apiErrorText = (err: unknown, providerId: string, t: TFn): string => {
  const e = err as OcApiError;
  const code = e?.reasonCode;
  if (code && TEST_REASON_KEY[code])
    return t(TEST_REASON_KEY[code], { provider: providerId, account: (e.body as any)?.accountId ?? '' });
  if (code === 'pull_unreachable')
    return t('op.probeUnreachable', { url: (e.body as any)?.url ?? '?', cause: (e.body as any)?.cause ?? '?' });
  if (code === 'pull_non_json') return t('op.pullNonJson', { url: (e.body as any)?.url ?? '?' });
  if (code === 'pull_http') {
    const b = (e.body ?? {}) as { url?: string; httpStatus?: number; upstreamBody?: string };
    let s = t('op.pullHttp', { url: b.url ?? '?', status: b.httpStatus ?? 0 });
    if (b.upstreamBody) s += ` | ${b.upstreamBody}`;
    return s;
  }
  return e?.message ?? String(err);
};

/**
 * One probe target: provider + optional concrete model. `key` identifies the
 * UI row in the shared state (provider id on /providers, model id inside
 * ProviderModelsDialog, `providerId/modelId` on /models).
 */
export interface ModelTestTarget {
  key: string;
  providerId: string;
  modelId?: string;
  /** Pin the probe to ONE credential row (KeysPage account list); default = provider head. */
  accountId?: string;
}

/** Probe outcome — the ok:false shape also covers HTTP-level failures. */
export interface ModelTestOutcome {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

const CONCURRENCY = 4;
/** Batch tests above this count fire real inference calls — confirm first. */
const CONFIRM_ABOVE = 20;

/**
 * Shared upstream-connectivity probe state behind every console "Test" button
 * (KeysPage providers, ProviderModelsDialog rows, ModelsPage rows). Owns the
 * testing/results/batch state, the toasts and the >N batch confirmation so the
 * three call sites cannot drift apart.
 */
export const useModelTest = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, ModelTestOutcome>>({});
  const [testAll, setTestAll] = useState<{ running: boolean; done: number; total: number }>({
    running: false,
    done: 0,
    total: 0,
  });

  /** True while any probe (single or batch) is in flight. */
  const isBusy = testAll.running || testingIds.size > 0;

  /** Single probe without toasts — shared by the row button and the batch run. */
  const runTest = async (target: ModelTestTarget): Promise<ModelTestOutcome> => {
    setTestingIds((prev) => new Set(prev).add(target.key));
    try {
      const payload: { modelId?: string; accountId?: string } = {};
      if (target.modelId) payload.modelId = target.modelId;
      if (target.accountId) payload.accountId = target.accountId;
      const r = await opencodeApi.testProvider(target.providerId, Object.keys(payload).length ? payload : undefined);
      // The wire carries machine limbs only — compose the localized display
      // ONCE here so every outcome surface (card/badge/toast/title) stays raw.
      const outcome: ModelTestOutcome = { ...r, error: r.ok ? undefined : composeProbeError(r, t) };
      setTestResults((prev) => ({ ...prev, [target.key]: outcome }));
      return outcome;
    } catch (err: any) {
      const failed: ModelTestOutcome = { ok: false, error: apiErrorText(err, target.providerId, t) };
      setTestResults((prev) => ({ ...prev, [target.key]: failed }));
      return failed;
    } finally {
      setTestingIds((prev) => {
        const n = new Set(prev);
        n.delete(target.key);
        return n;
      });
    }
  };

  /** One probe + toast. Label: requested model → resolved probe model → key. */
  const testOne = async (target: ModelTestTarget) => {
    const r = await runTest(target);
    if (r.ok) toast.success(t('op.testOkMsg', { model: target.modelId || r.model || target.key, ms: r.latencyMs ?? 0 }));
    else toast.error(r.error || t('op.testFailMsg'));
  };

  /** Batch probe with bounded concurrency; confirms above `confirmAbove` targets. */
  const testAllTargets = async (targets: ModelTestTarget[], opts?: { confirmAbove?: number }) => {
    if (isBusy || targets.length === 0) return;
    const confirmAbove = opts?.confirmAbove ?? CONFIRM_ABOVE;
    if (targets.length > confirmAbove) {
      const ok = await confirmDialog({
        title: t('op.testAllConfirmTitle', { n: targets.length }),
        description: t('op.testAllConfirmDesc'),
      });
      if (!ok) return;
    }
    setTestAll({ running: true, done: 0, total: targets.length });
    let okCount = 0;
    await runPool(targets, CONCURRENCY, async (x) => {
      const r = await runTest(x);
      if (r.ok) okCount++;
      setTestAll((prev) => ({ ...prev, done: prev.done + 1 }));
    });
    setTestAll((prev) => ({ ...prev, running: false }));
    toast[okCount === targets.length ? 'success' : 'error'](
      t('op.testAllDone', { ok: okCount, n: targets.length })
    );
  };

  return { testingIds, testResults, testAll, isBusy, runTest, testOne, testAllTargets };
};
