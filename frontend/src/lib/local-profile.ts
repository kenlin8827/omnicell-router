/**
 * Reading one engine's launch profile off a model record.
 *
 * ADR-0039 stores profiles per engine in `model.profiles[engineId]`. Records
 * written before it kept a single top-level `strata` field; the backend folds
 * that in on read and migrates it on the first write, but a console that is
 * merely DISPLAYING an untouched record still sees the old spelling. Doing the
 * fold here — once — is why no page or form has to know which engines are old
 * (ADR-0039: the console names no engine).
 */
import type { LocalInstalledModel } from './api';

/** One engine's stored profile, legacy single-engine spelling folded in. */
export function engineProfileOf(
  model: LocalInstalledModel,
  engineId: string
): Record<string, unknown> | null {
  const stored = model.profiles?.[engineId];
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return stored as Record<string, unknown>;
  }
  if (engineId === 'strata' && model.strata) {
    return model.strata as unknown as Record<string, unknown>;
  }
  return null;
}

/** True when the record carries a non-empty profile for that engine. */
export function hasEngineProfile(model: LocalInstalledModel, engineId: string): boolean {
  const profile = engineProfileOf(model, engineId);
  return !!profile && Object.keys(profile).length > 0;
}
