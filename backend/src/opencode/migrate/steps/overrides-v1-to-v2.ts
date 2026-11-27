import type { JsonDocumentMigrator } from '../migrator.js';
import {
  protocolsFromLegacyNode,
  stripLegacyProtocolKeys,
  normalizeProtocols,
} from '../../../providers/protocols-field.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export class OverridesV1ToV2Migrate implements JsonDocumentMigrator {
  readonly from = 1;
  readonly to = 2;

  migrate(doc: Record<string, unknown>): Record<string, unknown> {
    const modelsIn = isRecord(doc.models) ? doc.models : {};
    const models: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(modelsIn)) {
      if (!isRecord(entry)) {
        models[key] = entry;
        continue;
      }
      const next = stripLegacyProtocolKeys({ ...entry });
      const protocols = protocolsFromLegacyNode(entry) ?? normalizeProtocols(entry.protocols);
      if (protocols.length > 0) next.protocols = protocols;
      else delete next.protocols;
      models[key] = next;
    }
    return {
      ...doc,
      version: 2,
      models,
      updated: typeof doc.updated === 'number' ? doc.updated : Date.now(),
    };
  }
}
