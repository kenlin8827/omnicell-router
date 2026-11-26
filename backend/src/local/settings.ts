/**
 * Local-models settings (console-configurable, persisted at
 * `<ocrHome>/local-settings.json`).
 *
 * Three console fields override the environment defaults, each resolved at
 * use time with the chain  page setting → environment variable → built-in
 * default:
 * - hfEndpoint: the HuggingFace base URL (a mirror such as hf-mirror.com).
 *   Env: HF_ENDPOINT / OCR_HF_ENDPOINT; default: the public hub.
 * - hfToken: bearer token for gated repos. Env: HF_TOKEN / OCR_HF_TOKEN.
 * - modelsDir: where GGUF weights are stored; default `<ocrHome>/models`.
 *
 * The file is read on every use (a few hundred bytes): console edits apply
 * to the next request without a gateway restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';

export interface LocalModelSettings {
  /** HuggingFace base URL override (mirror). Absent = env/default. */
  hfEndpoint?: string;
  /** Bearer token override. Absent = env/anonymous. */
  hfToken?: string;
  /** GGUF storage directory override. Absent = `<ocrHome>/models`. */
  modelsDir?: string;
  /** Engine-level setup values, per engine id (ADR-0039 §10) — optional pins
   *  over the directories the gateway owns (Strata: workspace/dataRoot/python).
   *  Keys and values are validated by the owning engine's `setup.normalize`;
   *  this store keeps only string maps. */
  engineSetup?: Record<string, Record<string, string>>;
}

export function localSettingsFile(): string {
  return path.join(getOcrHomeDir(), 'local-settings.json');
}

/** The built-in storage location every fallback ends at. */
export function defaultModelsDir(): string {
  return path.join(getOcrHomeDir(), 'models');
}

export function readLocalModelSettings(): LocalModelSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(localSettingsFile(), 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: LocalModelSettings = {};
    for (const key of ['hfEndpoint', 'hfToken', 'modelsDir'] as const) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    // Engine setup maps: keep only string→string entries; the owning engine's
    // normalize() decides which KEYS are real when the value is read.
    const setup = parsed.engineSetup;
    if (setup && typeof setup === 'object' && !Array.isArray(setup)) {
      const clean: Record<string, Record<string, string>> = {};
      for (const [engineId, blob] of Object.entries(setup as Record<string, unknown>)) {
        if (!blob || typeof blob !== 'object' || Array.isArray(blob)) continue;
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(blob as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim()) values[key] = value.trim();
        }
        if (Object.keys(values).length > 0) clean[engineId] = values;
      }
      if (Object.keys(clean).length > 0) out.engineSetup = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLocalModelSettings(next: LocalModelSettings): void {
  fs.mkdirSync(path.dirname(localSettingsFile()), { recursive: true });
  fs.writeFileSync(localSettingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export type SettingsSource = 'setting' | 'env' | 'default';

/** Effective HuggingFace base URL (trailing slashes stripped). */
export function resolveHfEndpoint(): { url: string; source: SettingsSource } {
  const stored = readLocalModelSettings().hfEndpoint;
  if (stored) return { url: stored.replace(/\/+$/, ''), source: 'setting' };
  const env = process.env.HF_ENDPOINT?.trim() || process.env.OCR_HF_ENDPOINT?.trim();
  if (env) return { url: env.replace(/\/+$/, ''), source: 'env' };
  return { url: 'https://huggingface.co', source: 'default' };
}

/** Effective bearer token ('' when anonymous). */
export function resolveHfToken(): { token: string; source: 'setting' | 'env' | 'none' } {
  const stored = readLocalModelSettings().hfToken;
  if (stored) return { token: stored, source: 'setting' };
  const env = process.env.HF_TOKEN?.trim() || process.env.OCR_HF_TOKEN?.trim();
  if (env) return { token: env, source: 'env' };
  return { token: '', source: 'none' };
}

/** Effective GGUF storage directory. */
export function resolveModelsDir(): { dir: string; source: 'setting' | 'default' } {
  const stored = readLocalModelSettings().modelsDir;
  if (stored) return { dir: stored, source: 'setting' };
  return { dir: defaultModelsDir(), source: 'default' };
}
