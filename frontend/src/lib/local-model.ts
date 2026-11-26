/**
 * Display identity of one installed local model (ADR-0038 §7) — the SINGLE
 * place the console answers "what do we call this row". The operator-chosen
 * `name` wins everywhere (picker labels, run lists, the gateway-id chip); the
 * filename stem is the fallback (several quants of one family share the GGUF
 * header name, so the stem — not `meta.name` — is the unique default).
 */
import type { LocalInstalledModel } from './api';

/** The file stem (`Qwen3-32B-Q4_K_M`), the pre-naming display identity. */
export function localModelStem(model: Pick<LocalInstalledModel, 'filename'>): string {
  return model.filename.replace(/\.gguf$/i, '');
}

/** Display name: the operator's name when set, else the file stem. */
export function localModelDisplayName(model: Pick<LocalInstalledModel, 'filename' | 'name'>): string {
  const name = model.name?.trim();
  return name || localModelStem(model);
}

/** The gateway-visible registration id (`local/<name ?? repo/file>`) — what a
 *  client puts in `model:` and what tier rules / combos pin. */
export function localModelGatewayId(model: Pick<LocalInstalledModel, 'id' | 'name'>): string {
  const name = model.name?.trim();
  return `local/${name || model.id}`;
}
