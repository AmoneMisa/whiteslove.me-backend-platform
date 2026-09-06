import test from 'node:test';
import assert from 'node:assert/strict';

import { mapListingToRow } from '../src/infrastructure/database/listingMapper.js';
import { canonicalizeListingLocations } from '../src/listing/location-canonicalization.js';

function rawTashkentListing(overrides = {}) {
  return {
    id: 'canonical-locations',
    source: 'test',
    country: 'uz',
    city: 'Ташкент',
    district: 'Чиланзар',
    microdistrict: 'Сергели 3А',
    metro: 'Новза',
    street: 'улица Шифокорлар',
    residenceComplex: 'Янги Сергели',
    localAreas: ['Янги Сергели'],
    nearby: ['Новза'],
    locationEntities: [
      { type: 'district', name: 'Чиланзар' },
      { type: 'metro', name: 'Новза' },
      { type: 'residential_complex', name: 'Янги Сергели' },
    ],
    lat: 41.2267118,
    lng: 69.2082553,
    ...overrides,
  };
}

test('canonicalizes every recognized persisted location field and preserves source spellings', () => {
  const listing = canonicalizeListingLocations(rawTashkentListing());

  assert.equal(listing.country, 'UZ');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Chilanzar');
  assert.equal(listing.microdistrict, 'Sergeli-3A');
  assert.equal(listing.metro, 'Novza');
  assert.equal(listing.street, 'Shifokorlar Street');
  assert.equal(listing.residenceComplex, 'Yangi Sergeli');
  assert.deepEqual(listing.localAreas, ['Yangi Sergeli']);
  assert.deepEqual(listing.nearby, ['Novza']);

  assert.equal(listing.sourceCountry, 'uz');
  assert.equal(listing.sourceCity, 'Ташкент');
  assert.equal(listing.sourceDistrict, 'Чиланзар');
  assert.equal(listing.sourceMicrodistrict, 'Сергели 3А');
  assert.equal(listing.sourceMetro, 'Новза');
  assert.equal(listing.sourceStreet, 'улица Шифокорлар');
  assert.equal(listing.sourceResidenceComplex, 'Янги Сергели');
  assert.deepEqual(listing.sourceLocalAreas, ['Янги Сергели']);

  assert.deepEqual(
    listing.locationEntities.map(({ type, name }) => ({ type, name })),
    [
      { type: 'district', name: 'Chilanzar' },
      { type: 'metro', name: 'Novza' },
      { type: 'residential_complex', name: 'Yangi Sergeli' },
    ],
  );
  assert.equal(
    listing.locationEntities[2].geoEntityId,
    'uz:tashkent:residential:yangi-sergeli',
  );
});

test('canonicalization is idempotent and does not invent a canonical for unknown source geography', () => {
  const once = canonicalizeListingLocations(rawTashkentListing());
  const twice = canonicalizeListingLocations(once);
  assert.deepEqual(twice, once);

  const unknown = canonicalizeListingLocations({
    country: 'UZ',
    city: 'Tashkent',
    district: 'Totally Unknown District',
    residenceComplex: 'Unknown Towers 999',
  });
  assert.equal(unknown.district, 'Totally Unknown District');
  assert.equal(unknown.residenceComplex, 'Unknown Towers 999');
  assert.equal(unknown.sourceDistrict, undefined);
  assert.equal(unknown.sourceResidenceComplex, undefined);
});

test('database mapper persists canonical Yangi Sergeli and refines its broad source point', () => {
  const row = mapListingToRow(rawTashkentListing({
    title: 'Квартира в ЖК Янги Сергели',
    description: 'Ташкент, Сергели',
  }));

  assert.equal(row.country, 'UZ');
  assert.equal(row.city, 'Tashkent');
  assert.equal(row.district, 'Chilanzar');
  assert.equal(row.metro, 'Novza');
  assert.equal(row.residence_complex, 'Yangi Sergeli');

  assert.equal(row.data.residenceComplex, 'Yangi Sergeli');
  assert.equal(row.data.sourceResidenceComplex, 'Янги Сергели');
  assert.equal(row.data.lat, 41.222096);
  assert.equal(row.data.lng, 69.224966);
  assert.equal(row.data.locationCanonical, 'Yangi Sergeli');
  assert.equal(row.data.locationGeoEntityId, 'uz:tashkent:residential:yangi-sergeli');
});
