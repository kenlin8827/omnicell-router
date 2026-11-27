import type { JsonDocumentMigrator } from '../migrator.js';
import {
  protocolsFromLegacyNode,
  stripLegacyProtocolKeys,
  normalizeProtocols,
} from '../../../providers/protocols-field.js';
import { currentPackageFor } from '../../provider-package.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Client / legacy package spellings → OCR protocol ids. */
function ocrProtocols(raw: Record<string, unknown>): string[] {
  const lifted = protocolsFromLegacyNode(raw) ?? normalizeProtocols(raw.protocols);
  return normalizeProtocols(lifted.map((p) => currentPackageFor(p)));
}

/** Lift provider + model protocol slots to `protocols[]`; drop npm/package/protocol. */
function migrateProviderNode(raw: Record<string, unknown>): Record<string, unknown> {
  let node = stripLegacyProtocolKeys({ ...raw });
  const protocols = ocrProtocols(raw);
  if (protocols.length > 0) node.protocols = protocols;
  else delete node.protocols;

  if (isRecord(raw.models)) {
    const models: Record<string, unknown> = {};
    for (const [mid, m] of Object.entries(raw.models)) {
      if (!isRecord(m)) {
        models[mid] = m;
        continue;
      }
      const model = { ...m };
      const provider = isRecord(m.provider) ? { ...m.provider } : undefined;
      if (provider) {
        const modelProtocols = ocrProtocols(provider);
        const cleaned = stripLegacyProtocolKeys(provider);
        if (modelProtocols.length > 0) cleaned.protocols = modelProtocols;
        else delete cleaned.protocols;
        if (Object.keys(cleaned).length > 0) model.provider = cleaned;
        else delete model.provider;
      }
      models[mid] = model;
    }
    node.models = models;
  }
  return node;
}

export class ProvidersV1ToV2Migrate implements JsonDocumentMigrator {
  readonly from = 1;
  readonly to = 2;

  migrate(doc: Record<string, unknown>): Record<string, unknown> {
    const providersIn = isRecord(doc.providers) ? doc.providers : {};
    const providers: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(providersIn)) {
      providers[id] = isRecord(node) ? migrateProviderNode(node) : node;
    }
    return {
      ...doc,
      version: 2,
      providers,
      updated: typeof doc.updated === 'number' ? doc.updated : Date.now(),
    };
  }
}
