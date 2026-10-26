import {scoreCloneRelationship} from './photo-antifake.js';
import {classifyLineage} from './listing-lineage.js';

const timeOf = (value) => value == null ? null : Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
const contactOf = (row) => {
  const contact = String(row.data?.contact || '').trim();
  return /^\+[1-9]\d{6,14}$/u.test(contact) ? contact
    : /^@[a-z0-9_]{5,32}$/iu.test(contact) ? contact.toLowerCase() : null;
};
const identity = (row) => `${row.source}:${row.country}:${row.source_id}`;
const photosOf = (row) => new Set([row.data?.photo, ...(Array.isArray(row.data?.photos) ? row.data.photos : [])]
  .map((photo) => typeof photo === 'string' ? photo : photo?.url || photo?.link || photo?.src).filter(Boolean));
const publicationOf = (row) => {
  const value = row.source_first_published_at ?? row.created_at;
  const date = timeOf(value);
  const seen = timeOf(row.first_seen_at);
  // If we already saw it before the only known source date, that date is a
  // refresh, not evidence of when this posting originally appeared.
  return date != null && (seen == null || seen >= date) ? value : null;
};
const asListing = (row) => ({...row.data, source: row.source, country: row.country,
  createdAt: publicationOf(row), price: row.price, currency: row.currency});
const noFinding = (status = 'insufficient_evidence') => ({status, candidatePublicId: null,
  confidence: null, evidence: [], comparedPublicIds: [], ownershipVerified: false});

/**
 * Read-time presentation of the existing photo scorer + lineage classifier.
 * No new similarity model, percentage, or ownership verdict. Observation order
 * never substitutes for publication dates, and unknown contacts stay unknown.
 */
export function findProbableOriginal(rows, {now = new Date()} = {}) {
  if (rows.length < 2) return noFinding();
  const nowMs = timeOf(now);
  const byIdentity = new Map(rows.map((row) => [identity(row), row]));
  const findings = new Map();
  const incoming = new Set();
  for (const row of rows) {
    const matches = Array.isArray(row.data?.antiFake?.matches) ? row.data.antiFake.matches : [];
    const grouped = new Map();
    const ownPhotos = photosOf(row);
    for (const match of matches) {
      const other = byIdentity.get(`${match.matchedSource}:${match.matchedCountry}:${match.matchedListingId}`);
      if (!other || Number(other.id) === Number(row.id)) continue;
      // Both galleries must still contain the images analysed by the worker.
      // A stale antiFake result cannot endorse a replaced gallery.
      if (!ownPhotos.has(match.photoUrl) || !photosOf(other).has(match.matchedPhotoUrl)) continue;
      const key = identity(other);
      if (!grouped.has(key)) grouped.set(key, {other, matches: []});
      grouped.get(key).matches.push(match);
    }
    for (const {other, matches: pair} of grouped.values()) {
      const ownContact = contactOf(row);
      const otherContact = contactOf(other);
      if (!ownContact || !otherContact || ownContact === otherContact) continue;
      const ownDate = timeOf(publicationOf(row));
      const otherDate = timeOf(publicationOf(other));
      if (ownDate == null || otherDate == null || ownDate > nowMs || otherDate > nowMs) continue;
      // Require independent images, not multiple resized URLs for one photo.
      const photoKeys = new Set(pair.map((match) => match.perceptualHash || match.hash).filter(Boolean));
      const counterpartPhotos = new Set(pair.map((match) => match.matchedPhotoUrl));
      if (photoKeys.size < 2 || counterpartPhotos.size < 2) continue;
      const exact = pair.some((match) => match.matchType === 'exact');
      const distances = pair.map((match) => match.perceptualDistance).filter(Number.isFinite);
      const relation = scoreCloneRelationship(asListing(row), asListing(other), {
        matchType: exact ? 'exact' : 'perceptual',
        perceptualDistance: distances.length ? Math.min(...distances) : undefined,
      });
      if (!relation.propertyFactsConsistent || relation.propertyFacts?.roomsAgree !== true
        || relation.propertyFacts?.areaAgree !== true || relation.locationConflict?.conflicts?.length
        || relation.locationConflict?.countryConflict) continue;
      const explicitSellerConflict = (row.data?.sellerType === 'owner'
        && (other.data?.sellerType === 'agency' || other.data?.byAgency === true))
        || (other.data?.sellerType === 'owner' && (row.data?.sellerType === 'agency' || row.data?.byAgency === true));
      // Normalization defaults byAgency to false for unknown sellers. That
      // default cannot serve as an independent claim of owner-to-agency copying.
      if (!explicitSellerConflict && !relation.reasonCodes.includes('price_conflict')) continue;
      const lineage = classifyLineage(asListing(row), asListing(other), relation, {sameContact: false});
      const original = lineage.relation === 'possible_original' ? row
        : lineage.relation === 'likely_derived' ? other : null;
      if (!original) continue;
      const later = original === row ? other : row;
      if (timeOf(publicationOf(original)) >= timeOf(publicationOf(later))) continue;
      const id = Number(original.id);
      incoming.add(Number(later.id));
      if (!findings.has(id)) findings.set(id, {row: original,
        evidence: new Set(['matching_photos', 'matching_property_facts', 'earlier_source_date', 'different_contacts']),
        compared: new Set()});
      const finding = findings.get(id);
      finding.compared.add(Number(later.id));
      if (original.data?.sellerType === 'owner' && (later.data?.sellerType === 'agency' || later.data?.byAgency === true)) {
        finding.evidence.add('owner_to_agency');
      }
      if (original.currency && original.currency === later.currency && original.price > 0
        && later.price / original.price >= 1.15) finding.evidence.add('later_price_markup');
    }
  }
  const roots = [...findings.values()].filter((finding) => !incoming.has(Number(finding.row.id)));
  if (!roots.length) return noFinding();
  const contacts = new Set(roots.map((finding) => contactOf(finding.row)));
  if (contacts.size > 1) return noFinding('ambiguous');
  roots.sort((a, b) => timeOf(publicationOf(a.row)) - timeOf(publicationOf(b.row)));
  const candidate = roots[0];
  // An earlier, unrelated publisher with no supporting analysis leaves the
  // origin unresolved; don't silently prefer the best analysed later listing.
  if (rows.some((row) => contactOf(row) !== contactOf(candidate.row)
    && timeOf(publicationOf(row)) != null && timeOf(publicationOf(row)) < timeOf(publicationOf(candidate.row)))) {
    return noFinding('ambiguous');
  }
  return {status: 'candidate', candidatePublicId: Number(candidate.row.id), confidence: 'moderate',
    evidence: [...candidate.evidence], comparedPublicIds: [...candidate.compared], ownershipVerified: false};
}
