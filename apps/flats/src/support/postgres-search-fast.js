import {canonicalListingFilters} from '../listing/listing-filter-canonical.js';
import {copyResolvedSearchGeometry} from '../geo/search-filter-geometry.js';
import {
  canUseFastListingPath,
  searchPostgresListings as searchPostgresListingsCore,
} from '../infrastructure/search/postgres-search-fast-core.js';
import {
  canUseCanonicalFeedPath,
  canUseMemberStatsPath,
  computeMemberStatistics,
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
  const scopedFilters = copyResolvedSearchGeometry(filters, {
    ...filters,
    cursor: preparedCursor,
    ...(rejectedCursor ? {offset: 0} : {}),
  });

  const scopedArgs = {...args, filters: scopedFilters};
  // includeStats+statsOnly needs no page at all -- route it at the aggregate
  // read model straight away, ahead of the canonical-feed/general branch
  // below (that branch's own statsOnly handling stays for every other
  // includeStats/statsOnly combination, which still needs a listings page).
  let result;
  if (
    scopedFilters.includeStats && scopedFilters.statsOnly
    && canUseMemberStatsPath(scopedFilters, args?.searchMatches)
  ) {
    result = await computeMemberStatistics(scopedArgs);
  } else if (canUseCanonicalFeedPath(scopedFilters, args?.searchMatches)) {
    result = await searchCanonicalFeed(scopedArgs);
  } else {
    result = await searchPostgresListingsCore(scopedArgs);
  }
  return {
    ...result,
    nextCursor: attachScopeToCursor(result.nextCursor, scope),
  };
}
