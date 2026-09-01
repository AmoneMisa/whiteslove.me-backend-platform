import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareListingLocations,
  hammingDistanceHex,
  isPropertyClusterMatch,
  scoreCloneRelationship,
} from '../src/photo-antifake.js';

function listing(overrides = {}) {
  return {
    source: 'olx',
    country: 'UZ',
    city: 'Tashkent',
    district: 'Yashnobod',
    metro: 'Dustlik',
    residenceComplex: 'Assalom Sohil',
    title: 'Assalom Sohil 3/4/10',
    price: 600,
    currency: 'USD',
    byAgency: false,
    rooms: 3,
    areaSqm: 80,
    createdAt: '2026-08-23T08:00:00Z',
    ...overrides,
  };
}

function stored(overrides = {}) {
  return {
    source: 'domza',
    country: 'UZ',
    city: 'Tashkent',
    district: 'Yashnobod',
    metro: 'Dustlik',
    residence_complex: 'Assalom Sohil',
    title: 'Assalom Sohil 3/4/10',
    price: 600,
    currency: 'USD',
    by_agency: false,
    rooms: 3,
    area_sqm: 80,
    created_at: '2026-08-23T08:00:00Z',
    ...overrides,
  };
}

test('perceptual hashes tolerate a small Hamming distance', () => {
  assert.equal(hammingDistanceHex('d06905494d434904', 'd06905494d434904'), 0);
  assert.equal(hammingDistanceHex('d06905494d434904', 'd06905494d434905'), 1);
  assert.equal(hammingDistanceHex('d06905494d434904', '0000000000000000') > 7, true);
});

test('later materially cheaper copy is suspicious without assuming cheaper always means fraud', () => {
  const result = scoreCloneRelationship(
    listing({ price: 450, createdAt: '2026-08-23T10:00:00Z' }),
    stored({ price: 600, created_at: '2026-08-23T08:00:00Z' }),
  );

  assert.equal(result.currentCopyCandidate, true);
  assert.equal(result.priceDirection, 'lower');
  assert.equal(result.reason, 'possible_low_price_copy');
  assert.ok(result.score >= 70);
});

test('later agency copy with markup is treated as possible broker repost', () => {
  const result = scoreCloneRelationship(
    listing({ price: 780, byAgency: true, createdAt: '2026-08-23T10:00:00Z' }),
    stored({ price: 600, by_agency: false, created_at: '2026-08-23T08:00:00Z' }),
  );

  assert.equal(result.currentCopyCandidate, true);
  assert.equal(result.sellerRelation, 'owner_to_agency');
  assert.equal(result.priceDirection, 'higher');
  assert.equal(result.reason, 'possible_broker_markup_copy');
  assert.ok(result.score >= 70);
});

test('older owner listing is not blamed when a newer agency copy exists', () => {
  const result = scoreCloneRelationship(
    listing({ price: 600, byAgency: false, createdAt: '2026-08-23T08:00:00Z' }),
    stored({ price: 780, by_agency: true, created_at: '2026-08-23T10:00:00Z' }),
  );

  assert.equal(result.currentCopyCandidate, false);
  assert.equal(result.matchedCopyCandidate, true);
  assert.equal(result.reason, 'matched_listing_may_be_copy');
});

test('same visual property advertised in incompatible districts is a strong identity conflict', () => {
  const current = listing({ district: 'Sergeli', metro: 'Sergeli' });
  const matched = stored({ source: 'birbir', district: 'Yashnobod', metro: 'Dustlik' });
  const location = compareListingLocations(current, matched);
  assert.equal(location.level, 'high');
  assert.deepEqual(location.conflicts.sort(), ['district', 'metro']);

  const relation = scoreCloneRelationship(current, matched, {
    matchType: 'perceptual',
    perceptualDistance: 2,
  });
  assert.equal(relation.reason, 'conflicting_duplicate_location');
  assert.ok(relation.reasonCodes.includes('photo_perceptual_match'));
  assert.ok(relation.reasonCodes.includes('location_district_conflict'));
  assert.ok(relation.reasonCodes.includes('location_metro_conflict'));
  assert.ok(relation.score >= 65);
});

test('same visual property advertised in different cities is very high conflict', () => {
  const location = compareListingLocations(
    listing({ city: 'Tashkent', district: 'Yashnobod' }),
    stored({ city: 'Samarkand', district: 'Registan' }),
  );
  assert.equal(location.level, 'very_high');
  assert.ok(location.reasonCodes.includes('location_city_conflict'));
});

test('multiple cross-source perceptual photo matches form a property cluster candidate', () => {
  const relation = scoreCloneRelationship(
    listing(),
    stored({ source: 'realting' }),
    { matchType: 'perceptual', perceptualDistance: 3 },
  );
  assert.equal(isPropertyClusterMatch({
    matchedPhotoCount: 2,
    exactPhotoCount: 0,
    perceptualPhotoCount: 2,
    relation,
  }), true);
});

test('one weak perceptual photo without consistent property facts does not force clustering', () => {
  const relation = scoreCloneRelationship(
    listing({ rooms: 2, areaSqm: 55, title: 'Sergeli cheap flat' }),
    stored({ rooms: 4, area_sqm: 110, title: 'Yunusobod apartment' }),
    { matchType: 'perceptual', perceptualDistance: 7 },
  );
  assert.equal(isPropertyClusterMatch({
    matchedPhotoCount: 1,
    exactPhotoCount: 0,
    perceptualPhotoCount: 1,
    relation,
  }), false);
});
