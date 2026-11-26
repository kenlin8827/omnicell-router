/**
 * Operator-facing text for local run/build vocabulary (ADR-0040).
 *
 * Every string a local run reaches the console through lives here, because the
 * backend's vocabulary is MACHINE vocabulary: `LocalRunStatus` is a five-value
 * enum and `lastError` is an English sentence minted for logs. Rendering either
 * raw puts English (or `stopped`) inside a zh-CN console — the leak this module
 * exists to close.
 *
 * Two rules, both learned the hard way:
 *
 *  - **A status is a value, not a label.** `ready` on screen is `t(...)`, never
 *    the wire token. The wire token stays visible only in `title` (developers
 *    grep it; operators never need it).
 *  - **An error has a CLASS.** The backend pairs `lastErrorCode` (the class)
 *    with `lastError` (raw detail), the same `code` + `error` shape every other
 *    `local/` result carries. This module localizes on the class and falls back
 *    to the raw sentence only when the class is unknown — a backend sentence we
 *    have not localized yet beats a blank error, and it matches the installer's
 *    established "unknown codes stay raw" rule.
 */

/** `lastErrorCode` → i18n key (the `localModels` table both run pages read). */
const RUN_ERROR_KEYS: Record<string, string> = {
  'engine-died-before-ready': 'localModels.runErrEngineDied',
  'load-timeout': 'localModels.runErrLoadTimeout',
  'engine-exited': 'localModels.runErrEngineExited',
  'crashed-restarting': 'localModels.runErrCrashedRestarting',
  'spawn-failed': 'localModels.runErrSpawnFailed',
  'gateway-restarted': 'localModels.runErrGatewayRestarted',
};

/** `LocalRunStatus` → i18n key. */
const RUN_STATUS_KEYS: Record<string, string> = {
  starting: 'localModels.runStatusStarting',
  ready: 'localModels.runStatusReady',
  stopping: 'localModels.runStatusStopping',
  stopped: 'localModels.runStatusStopped',
  failed: 'localModels.runStatusFailed',
};

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Localized label for a run's status. An unknown value falls back to the raw
 * token rather than an empty cell — a status the console has not learned yet
 * should be visible, not invisible.
 */
export function localRunStatusLabel(status: string, t: T): string {
  const key = RUN_STATUS_KEYS[status];
  return key ? t(key) : status;
}

/**
 * Localized operator text for a run's error, or null when the run has none.
 *
 * Interpolated values are recovered from the recorded `lastError` (the backend
 * keeps the exit code / restart counter / timeout there), so the number shown
 * is always the number recorded — never a re-derivation that could disagree.
 */
export function localRunErrorMessage(
  run: { lastError?: string; lastErrorCode?: string; exitCode?: number | null },
  t: T
): string | null {
  const raw = run.lastError;
  if (!raw) return null;
  const key = run.lastErrorCode ? RUN_ERROR_KEYS[run.lastErrorCode] : undefined;
  if (!key) return raw;
  const vars: Record<string, string | number> = { detail: raw };
  if (run.exitCode != null) vars.exit = run.exitCode;
  const restart = /restart (\d+)\/(\d+)/.exec(raw);
  if (restart) {
    vars.n = restart[1];
    vars.max = restart[2];
  }
  const minutes = /within (\d+) min/.exec(raw);
  if (minutes) vars.min = minutes[1];
  return t(key, vars);
}
/** `BuildJob.errorCode` → i18n key. */
const BUILD_ERROR_KEYS: Record<string, string> = {
  'build-leg-exited': 'localModels.buildErrLegExited',
};

/**
 * Localized operator text for an engine build job's error, or null when it has
 * none. Same class-over-raw rule as `localRunErrorMessage`.
 */
export function localBuildErrorMessage(
  job: { error?: string; errorCode?: string },
  t: T
): string | null {
  const raw = job.error;
  if (!raw) return null;
  const key = job.errorCode ? BUILD_ERROR_KEYS[job.errorCode] : undefined;
  if (!key) return raw;
  const vars: Record<string, string | number> = { detail: raw };
  // `... exited (code 2)` — the code the backend recorded.
  const code = /code (-?\d+|null)/.exec(raw);
  if (code) vars.exit = code[1];
  // The leg name rides the raw sentence; copy names it as {leg}.
  const leg = /^([^\s]+) exited/.exec(raw);
  if (leg) vars.leg = leg[1];
  return t(key, vars);
}
