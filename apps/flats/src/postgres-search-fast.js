import {canonicalListingFilters} from './listing-filter-canonical.js';
import {
  canUseFastListingPath,
  searchPostgresListings as searchPostgresListingsCore,
} from './postgres-search-fast-core.js';
import {
  canUseCanonicalFeedPath,
  searchCanonicalFeed,
} from './postgres-canonical-feed.js';
import {
  attachScopeToCursor,
  prepareCursorForScope,
  searchCursorScope,
} from './postgres-cursor-scope.js';

export {canUseFastListingPath};

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

  const scopedArgs = {...args, filters: scopedFilters};
  const result = canUseCanonicalFeedPath(scopedFilters, args?.searchMatches)
    ? await searchCanonicalFeed(scopedArgs)
    : await searchPostgresListingsCore(scopedArgs);
  return {
    ...result,
    nextCursor: attachScopeToCursor(result.nextCursor, scope),
  };
}
