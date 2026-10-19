/**
 * Catalog-wide runtime constants (single source of truth — the catalog modules
 * import from here; never re-declare these values inline).
 */

/** User-Agent sent on ALL outbound catalog HTTP traffic (source pulls, logo
 *  fetches, aggregation refreshes) so remote endpoints see one consistent
 *  product identity. */
export const CATALOG_USER_AGENT = 'OneCastRouter/1.0';
