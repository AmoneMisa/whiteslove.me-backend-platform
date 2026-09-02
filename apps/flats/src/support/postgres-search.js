import {canonicalListingFilters} from '../listing/listing-filter-canonical.js';
import {
  buildSearchContext,
  searchPostgresListings as searchPostgresListingsCore,
} from '../infrastructure/search/postgres-search-core.js';
import {
  attachScopeToCursor,
  prepareCursorForScope,
  searchCursorScope,
} from './postgres-cursor-scope.js';

export {buildSearchContext};

export async function searchPostgresListings(args) {
  const filters = canonicalListingFilters(args?.filters || {});
  const scope = searchCursorScope(filters, args?.countries || []);
  const preparedCursor = prepareCursorForScope(filters.cursor, scope);
  const rejectedCursor = Boolean(filters.cursor) && !preparedCursor;
  const scopedFilters = {
    ...filters,
    cursor: preparedCursor,
    ...(rejectedCursor ? {offset: 0} : {}),
  };

  const result = await searchPostgresListingsCore({...args, filters: scopedFilters});
  return {
    ...result,
    nextCursor: attachScopeToCursor(result.nextCursor, scope),
  };
}
