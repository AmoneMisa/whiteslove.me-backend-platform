import test from 'node:test';
import assert from 'node:assert/strict';
import {findProbableOriginal} from '../src/listing/probable-original.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const listing = (id, extra = {}) => ({id, source: 'olx', country: 'UA', source_id: String(id),
  price: 500, currency: 'USD', created_at: '2026-10-10T10:00:00Z',
  first_seen_at: '2026-10-25T10:00:00Z', active: true,
  data: {title: '2-room apartment', rooms: 2, areaSqm: 54, city: 'Kyiv',
    contact: '+380991234567', sellerType: 'owner', byAgency: false,
    photos: [`https://photos.example/${id}/a.jpg`, `https://photos.example/${id}/b.jpg`]}, ...extra});
const pair = () => {
  const owner = listing(1);
  const copy = listing(2, {price: 650, created_at: '2026-10-20T10:00:00Z'});
  copy.data = {...copy.data, contact: '+380991234568', sellerType: 'agency', byAgency: true};
  copy.data.antiFake = {matches: owner.data.photos.map((url, i) => ({
    hash: `hash-${i}`, perceptualHash: `visual-${i}`, matchType: 'exact',
    photoUrl: copy.data.photos[i], matchedPhotoUrl: url,
    matchedSource: owner.source, matchedCountry: owner.country, matchedListingId: owner.source_id,
  }))};
  return [owner, copy];
};
const find = (rows) => findProbableOriginal(rows, {now: NOW});

test('corroborated earlier photos, facts and different contacts yield an explained candidate', () => {
  const rows = pair();
  const result = find(rows);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidatePublicId, 1);
  assert.equal(result.confidence, 'moderate');
  assert.equal(result.ownershipVerified, false);
  assert.ok(result.evidence.includes('matching_photos'));
  assert.ok(result.evidence.includes('owner_to_agency'));
  assert.ok(result.evidence.includes('later_price_markup'));
  assert.deepEqual(result.comparedPublicIds, [2]);
});

test('an early observation, owner claim or matching title alone never establishes the original', () => {
  const rows = pair();
  delete rows[1].data.antiFake;
  assert.equal(find(rows).status, 'insufficient_evidence');
  rows[0].created_at = null;
  rows[0].first_seen_at = '2000-01-01T00:00:00Z';
  assert.equal(find(rows).candidatePublicId, null);
});

test('missing or identical contacts, one photo and duplicated resized photos are insufficient', () => {
  for (const change of [
    (rows) => {rows[1].data.contact = rows[0].data.contact;},
    (rows) => {delete rows[1].data.contact;},
    (rows) => {rows[1].data.antiFake.matches.pop();},
    (rows) => {rows[1].data.antiFake.matches[1].perceptualHash = rows[1].data.antiFake.matches[0].perceptualHash;},
  ]) {
    const rows = pair(); change(rows);
    assert.equal(find(rows).status, 'insufficient_evidence');
  }
});

test('replaced galleries, location conflicts, insufficient facts and future source dates suppress the finding', () => {
  for (const change of [
    (rows) => {rows[0].data.photos = ['https://photos.example/new.jpg'];},
    (rows) => {rows[1].data.city = 'Odesa';},
    (rows) => {delete rows[1].data.areaSqm;},
    (rows) => {rows[1].data.rooms = 4;},
    (rows) => {rows[0].created_at = '2027-01-01T00:00:00Z';},
  ]) {
    const rows = pair(); change(rows);
    assert.equal(find(rows).candidatePublicId, null);
  }
});

test('photo matches without corroborating seller or price contradictions do not imply copying', () => {
  const rows = pair();
  rows[1].data.byAgency = false;
  rows[1].data.sellerType = 'owner';
  rows[1].price = rows[0].price;
  assert.equal(find(rows).status, 'insufficient_evidence');
});

test('an earlier competing publisher is ambiguity, not an invitation to choose the best analysed row', () => {
  const rows = pair();
  const other = listing(3, {created_at: '2026-09-01T00:00:00Z'});
  other.data.contact = '+380991234569';
  assert.equal(find([...rows, other]).status, 'ambiguous');
});

test('the same evidence works when the worker analysed the original against the later copy', () => {
  const [owner, copy] = pair();
  owner.data.antiFake = {matches: copy.data.photos.map((url, i) => ({hash: `h-${i}`, matchType: 'exact',
    photoUrl: owner.data.photos[i], matchedPhotoUrl: url, matchedSource: copy.source,
    matchedCountry: copy.country, matchedListingId: copy.source_id}))};
  delete copy.data.antiFake;
  assert.equal(find([owner, copy]).candidatePublicId, 1);
});

test('independent plausible originals with different contacts produce ambiguity', () => {
  const rows = pair();
  const other = listing(3);
  other.data.contact = '+380991234569';
  const otherCopy = listing(4, {price: 650, created_at: '2026-10-21T10:00:00Z'});
  otherCopy.data = {...otherCopy.data, contact: '+380991234570', byAgency: true, sellerType: 'agency',
    antiFake: {matches: other.data.photos.map((url, i) => ({hash: `other-${i}`, matchType: 'exact',
      photoUrl: otherCopy.data.photos[i], matchedPhotoUrl: url,
      matchedSource: other.source, matchedCountry: other.country, matchedListingId: other.source_id}))}};
  assert.equal(find([...rows, other, otherCopy]).status, 'ambiguous');
});

test('a refreshed source date with no earlier publication history is not origin evidence', () => {
  const rows = pair();
  rows[0].first_seen_at = '2026-09-01T10:00:00Z';
  assert.equal(find(rows).status, 'insufficient_evidence');
});

test('a known earlier source date survives a later date refresh', () => {
  const rows = pair();
  rows[0].source_first_published_at = rows[0].created_at;
  rows[0].created_at = '2026-10-26T09:00:00Z';
  assert.equal(find(rows).candidatePublicId, 1);
});

test('default non-agency flags are not independent seller evidence', () => {
  const rows = pair();
  rows[1].price = rows[0].price;
  delete rows[0].data.sellerType;
  assert.equal(find(rows).status, 'insufficient_evidence');
  rows[0].data.sellerType = 'owner';
  assert.equal(find(rows).candidatePublicId, 1);
});
