/**
 * Listing lineage (§26), expressed in the plan's vocabulary.
 *
 * This is an adapter, not a second scorer. photo-antifake.js already compares
 * two listings that share photos and returns chronology, seller relation, price
 * direction, property-fact consistency and location conflicts. That analysis
 * stays authoritative; what was missing is naming the resulting relationship
 * and persisting it as an edge.
 *
 * The rule that governs the mapping is §26's: **an earlier timestamp alone does
 * not prove authorship.** Crawl timing is not publication timing -- we see a
 * listing when we happen to crawl its source, and a site we poll hourly will
 * always look "earlier" than one we poll daily. So being first is necessary for
 * `possible_original` and nowhere near sufficient: it also needs corroborating
 * evidence, and in its absence the pair stays `undetermined`, which is an
 * honest answer.
 */

export const LINEAGE_RELATIONS = Object.freeze([
  'possible_original',
  'likely_derived',
  'cross_post',
  'repost',
  'undetermined',
]);

/** Conflicts that mean the two listings cannot both be describing the same
 * offer honestly. */
const CONFLICT_CODES = new Set(['price_conflict', 'seller_type_conflict']);

const isConflictingLocation = (level) => level === 'high' || level === 'very_high';

/**
 * @param current  the listing being ingested
 * @param matched  the listing it shares photos with
 * @param relation the result of scoreCloneRelationship(current, matched)
 * @param context  optional `{ sameContact, sameSource }` when the caller knows
 *                 whether the two listings share an actor or a source
 */
export function classifyLineage(current, matched, relation, context = {}) {
  if (!relation) return undetermined('no_relation_analysis');

  const sameSource = context.sameSource
    ?? (Boolean(current?.source) && String(current.source).toLowerCase() === String(matched?.source ?? '').toLowerCase());
  const sameContact = context.sameContact ?? null;

  const conflicts = (relation.reasonCodes ?? []).filter((code) => CONFLICT_CODES.has(code));
  const locationConflict = isConflictingLocation(relation.locationConflict?.level);
  const contradicted = conflicts.length > 0 || locationConflict;

  // Same advertiser, same site, same flat: the advert was republished rather
  // than copied. Checked first, because a repost would otherwise look like a
  // derivation of itself.
  if (sameSource && sameContact === true && !contradicted) {
    return edge('repost', relation, {
      evidence: ['same_source', 'same_contact', ...(relation.propertyFactsConsistent ? ['property_facts_consistent'] : [])],
    });
  }

  // Same advertiser, different site: a cross-post, which is ordinary behaviour
  // and must not be reported as a clone.
  if (!sameSource && sameContact === true && !contradicted) {
    return edge('cross_post', relation, { evidence: ['different_source', 'same_contact'] });
  }

  // A copy is claimed only when something actually contradicts a shared
  // authorship: a different seller type, a materially different price, or a
  // location that cannot be true of both.
  if (relation.currentCopyCandidate && contradicted) {
    return edge('likely_derived', relation, {
      evidence: [...conflicts, ...(locationConflict ? ['location_conflict'] : [])],
      markup: relation.priceDirection === 'higher' && relation.sellerRelation === 'owner_to_agency',
    });
  }

  // The mirror case: the *other* listing is the later copy, so this one may be
  // the original -- but only with corroboration beyond chronology.
  if (relation.matchedCopyCandidate && contradicted) {
    const corroborated = relation.propertyFactsConsistent
      || relation.sellerRelation === 'agency_to_owner'
      || sameContact === true;
    if (!corroborated) return undetermined('earlier_but_uncorroborated', relation);
    return edge('possible_original', relation, {
      evidence: ['counterpart_is_later_copy', ...(relation.propertyFactsConsistent ? ['property_facts_consistent'] : [])],
    });
  }

  // Shared photos with nothing to separate the two. Not a finding.
  return undetermined(contradicted ? 'conflicting_but_chronology_unclear' : 'insufficient_evidence', relation);
}

function edge(relationName, relation, extra = {}) {
  const reasonCodes = new Set(relation.reasonCodes ?? []);
  if (extra.markup) reasonCodes.add('derived_listing_price_markup');
  if (relationName === 'likely_derived') reasonCodes.add('likely_cloned_listing');
  return Object.freeze({
    relation: relationName,
    confidence: Number(relation.score ?? 0),
    evidence: Object.freeze(extra.evidence ?? []),
    reasonCodes: Object.freeze([...reasonCodes]),
    chronology: relation.chronology ?? 'unknown',
    priceDeltaPct: relation.priceDeltaPct ?? null,
    evidenceOnly: true,
  });
}

function undetermined(reason, relation = null) {
  return Object.freeze({
    relation: 'undetermined',
    confidence: Number(relation?.score ?? 0),
    evidence: Object.freeze([]),
    reasonCodes: Object.freeze(relation?.reasonCodes ?? []),
    chronology: relation?.chronology ?? 'unknown',
    priceDeltaPct: relation?.priceDeltaPct ?? null,
    undeterminedReason: reason,
    evidenceOnly: true,
  });
}

/**
 * §27's post_copy_original_disappearance.
 *
 * The pattern: a listing is copied, and shortly afterwards the original is
 * removed while the copy stays up. Reported only when the removal follows the
 * copy -- an original removed *before* the copy appeared is just a flat that
 * rented, which is the innocent explanation and by far the common one.
 */
export function detectOriginalDisappearance({ derivedFirstSeenAt, originalRemovedAt, derivedStillActive } = {}, options = {}) {
  const windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const copiedAt = timeOf(derivedFirstSeenAt);
  const removedAt = timeOf(originalRemovedAt);
  if (copiedAt === null || removedAt === null) return { detected: false, reason: 'insufficient_history' };
  if (removedAt < copiedAt) return { detected: false, reason: 'original_removed_before_copy' };
  if (removedAt - copiedAt > windowMs) return { detected: false, reason: 'removal_too_late_to_relate' };
  if (derivedStillActive === false) return { detected: false, reason: 'copy_also_gone' };
  return {
    detected: true,
    reasonCode: 'post_copy_original_disappearance',
    gapMs: removedAt - copiedAt,
    evidenceOnly: true,
  };
}

/**
 * §27's multiple_concurrent_rental_claims: one property advertised as available
 * by several unrelated actors at the same time.
 *
 * Counts distinct actors, not listings. One actor cross-posting the same flat
 * to four sites is not four claims.
 */
export function detectConcurrentRentalClaims(activeListings, options = {}) {
  const minimum = options.minimumActors ?? 3;
  const actors = new Set();
  for (const listing of activeListings ?? []) {
    if (listing?.active === false) continue;
    const actor = listing?.actorId ?? listing?.contactPointId;
    if (actor === null || actor === undefined) continue;
    actors.add(String(actor));
  }
  return {
    detected: actors.size >= minimum,
    distinctActors: actors.size,
    ...(actors.size >= minimum ? { reasonCode: 'multiple_concurrent_rental_claims' } : {}),
    evidenceOnly: true,
  };
}

function timeOf(value) {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
