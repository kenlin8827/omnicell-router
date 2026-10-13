import { useState } from 'react';
import { opencodeApi } from './api';
import { runPool } from './runPool';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';

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
      setTestResults((prev) => ({ ...prev, [target.key]: r }));
      return r;
    } catch (err: any) {
      const failed: ModelTestOutcome = { ok: false, error: err.message };
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
