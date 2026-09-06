import test from 'node:test';
import assert from 'node:assert/strict';

import { refineSourceCoordinateFromGeoCatalogResidentialComplex } from '../src/geo/geocode-persistent.js';

const country = { code: 'UZ', name: 'Uzbekistan', cities: ['Tashkent'] };

test('canonical primary residential complex replaces an unqualified broad source pin', () => {
  const listing = {
    id: 'assalom-source-pin',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.3122,
    lng: 69.2797,
    locationSource: 'coordinates',
    locationPrecision: 'broad',
    locationApproximate: true,
    residenceComplex: 'Assalom Sohil',
    street: "Farg'ona yo'li",
    locationEntities: [
      { type: 'residential_complex', name: 'Assalom Sohil', role: 'primary' },
      { type: 'residential_complex', name: 'Infinity', role: 'nearby' },
    ],
  };

  assert.equal(refineSourceCoordinateFromGeoCatalogResidentialComplex(listing, country), true);
  assert.equal(listing.locationSource, 'residentialComplex');
  assert.equal(listing.locationProvider, 'geoCatalog');
  assert.equal(listing.locationCanonical, 'Assalom Sohil');
  assert.equal(listing.locationRole, 'primary');
  assert.equal(listing.locationGeoEntityId, 'uz:tashkent:residential:assalom-sohil');
  assert.ok(Math.abs(listing.lat - 41.282995) < 0.000001);
  assert.ok(Math.abs(listing.lng - 69.308420) < 0.000001);
  assert.equal(listing.sourceCoordinateRefined, true);
  assert.ok(listing.sourceCoordinateDistanceM > 0);
});

test('nearby residential complex never replaces the source pin', () => {
  const listing = {
    id: 'nearby-only-complex',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.3122,
    lng: 69.2797,
    locationSource: 'coordinates',
    locationPrecision: 'broad',
    locationApproximate: true,
    locationEntities: [
      { type: 'residential_complex', name: 'Infinity', role: 'nearby' },
    ],
  };

  assert.equal(refineSourceCoordinateFromGeoCatalogResidentialComplex(listing, country), false);
  assert.equal(listing.lat, 41.3122);
  assert.equal(listing.lng, 69.2797);
  assert.equal(listing.locationSource, 'coordinates');
});

test('building-level source coordinates remain stronger than a complex centroid', () => {
  const listing = {
    id: 'exact-building-pin',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.2831,
    lng: 69.3086,
    locationSource: 'address',
    locationPrecision: 'building',
    locationApproximate: false,
    residenceComplex: 'Assalom Sohil',
    locationEntities: [
      { type: 'residential_complex', name: 'Assalom Sohil', role: 'primary' },
    ],
  };

  assert.equal(refineSourceCoordinateFromGeoCatalogResidentialComplex(listing, country), false);
  assert.equal(listing.lat, 41.2831);
  assert.equal(listing.lng, 69.3086);
  assert.equal(listing.locationSource, 'address');
});
