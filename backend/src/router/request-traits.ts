import type { CanonicalRequest } from '../ir/types.js';

/** A declared JSON contract, not merely a request that happens to mention JSON. */
export function declaresJsonContract(request: CanonicalRequest): boolean {
  return request.text?.format?.type === 'json_object' || request.text?.format?.type === 'json_schema';
}

export function hasToolsOrSchema(request: CanonicalRequest): boolean {
  return declaresJsonContract(request) || Boolean(request.tools?.length);
}
