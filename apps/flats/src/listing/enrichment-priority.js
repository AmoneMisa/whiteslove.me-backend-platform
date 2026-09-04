/**
 * Ordering for AI enrichment candidates.
 *
 * Enrichment capacity is far smaller than the backlog -- the free provider
 * quotas allow tens of listings an hour against hundreds of thousands waiting
 * -- so which listings get analysed first matters more than the rate. A fresh
 * advert is the one a searcher is about to open; a stale one may not even be
 * available any more.
 *
 * Callers hand over whatever order the source page returned, which carries no
 * guarantee about recency.
 */

/**
 * When a listing was published, as a timestamp.
 *
 * `createdAt` is the advert's own publication date and the thing we actually
 * care about. `firstSeenAt` is when we first crawled it, which is a decent
 * stand-in. A listing with neither sorts last rather than jumping the queue on
 * an accidental NaN.
 */
export function listingRecency(listing) {
  for (const field of ['createdAt', 'firstSeenAt', 'lastSeenAt']) {
    const raw = listing?.[field];
    if (!raw) continue;
    const at = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    if (Number.isFinite(at)) return at;
  }
  return Number.NEGATIVE_INFINITY;
}

/** A copy of `listings`, newest advert first. Never mutates the input. */
export function newestFirst(listings) {
  if (!Array.isArray(listings)) return [];
  return [...listings].sort((a, b) => listingRecency(b) - listingRecency(a));
}
