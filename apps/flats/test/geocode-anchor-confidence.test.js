import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGeoCatalogExactAnchor,
  applyGeoCatalogNearbyAnchor,
} from '../src/geo/geo-catalog.js';
import { geocodeCandidates } from '../src/geo/geocode.js';
import { applyReverseGeo } from '../src/geo/reverse-geo.js';
import { applyStructuredAddressFields } from '../src/geo/structured-address.js';

const UZ = {
  code: 'UZ',
  name: 'Uzbekistan',
  cities: ['Tashkent', 'Samarkand'],
};

test('canonical Assalom Sohil resolves from geo-catalog with package accuracy/provenance', () => {
  const listing = {
    id: 'assalom-sohil',
    city: 'Tashkent',
    residenceComplex: 'Assalom Sohil',
    locationEntities: [
      { type: 'residential_complex', name: 'Assalom Sohil', role: 'primary' },
    ],
  };

  assert.equal(applyGeoCatalogExactAnchor(listing, UZ), true);
  assert.equal(listing.locationSource, 'residentialComplex');
  assert.equal(listing.locationProvider, 'geoCatalog');
  assert.equal(listing.locationCanonical, 'Assalom Sohil');
  assert.equal(listing.locationPrecision, 'complex');
  assert.equal(listing.locationApproximate, true);
  assert.equal(listing.locationRole, 'primary');
  assert.equal(listing.locationAccuracyM, 140);
  assert.ok(Math.abs(listing.lat - 41.282995) < 1e-9);
  assert.ok(Math.abs(listing.lng - 69.30842) < 1e-9);
});

test('a nearby residential complex is not accepted as the listing exact anchor', () => {
  const listing = {
    id: 'near-infinity',
    city: 'Tashkent',
    residenceComplex: 'Infinity',
    locationEntities: [
      { type: 'residential_complex', name: 'Infinity', role: 'nearby' },
    ],
  };

  assert.equal(applyGeoCatalogExactAnchor(listing, UZ), false);
  assert.equal(listing.lat, undefined);
  assert.equal(listing.lng, undefined);

  assert.equal(applyGeoCatalogNearbyAnchor(listing, UZ), true);
  assert.equal(listing.locationSource, 'nearby');
  assert.equal(listing.locationProvider, 'geoCatalog');
  assert.equal(listing.locationCanonical, 'Infinity');
  assert.equal(listing.locationRole, 'nearby');
  assert.equal(listing.locationApproximate, true);
  assert.ok(listing.locationAccuracyM >= 900);
});

test('geocode candidates preserve nearby role so a reference cannot masquerade as primary', () => {
  const candidates = geocodeCandidates({
    city: 'Tashkent',
    residenceComplex: 'Infinity',
    microdistrict: 'Mirobod local area',
    locationEntities: [
      { type: 'residential_complex', name: 'Infinity', role: 'nearby' },
      { type: 'microdistrict', name: 'Mirobod local area', role: 'primary' },
    ],
  }, UZ);

  const complex = candidates.find((item) => item.source === 'residentialComplex');
  const area = candidates.find((item) => item.source === 'microdistrict');
  assert.equal(complex?.role, 'nearby');
  assert.equal(complex?.approximate, true);
  assert.equal(area?.role, 'primary');
});

test('a source-provided address keeps source provenance and building precision', () => {
  const listing = { address: 'ул. Шота Руставели 10' };
  applyStructuredAddressFields(listing);

  assert.equal(listing.addressSource, 'source');
  assert.equal(listing.addressPrecision, 'building');
  assert.equal(listing.addressApproximate, false);
  assert.equal(listing.houseNumber, '10');
});

test('reverse geocoding an approximate complex does not invent a house number', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      address: {
        road: 'Fargona Yoli Street',
        house_number: '99',
        city: 'Tashkent',
        country_code: 'uz',
      },
    }),
  });

  const listing = {
    id: 'reverse-complex-address',
    lat: 41.282995,
    lng: 69.30842,
    city: 'Tashkent',
    country: 'UZ',
    district: 'Mirobod',
    microdistrict: 'Assalom Sohil',
    locationSource: 'residentialComplex',
    locationProvider: 'geoCatalog',
    locationCanonical: 'Assalom Sohil',
    locationPrecision: 'complex',
    locationAccuracyM: 140,
    locationApproximate: true,
  };

  try {
    await applyReverseGeo([listing], UZ);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(listing.address, 'Fargona Yoli Street');
  assert.equal(listing.addressSource, 'reverseGeocode');
  assert.equal(listing.addressApproximate, true);
  assert.equal(listing.addressPrecision, 'street');
});

test('reverse validation rejects a Nominatim point in another known city', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      address: {
        road: 'Registan Street',
        city: 'Samarkand',
        country_code: 'uz',
      },
    }),
  });

  const listing = {
    id: 'cross-city-generated-point',
    lat: 39.654321,
    lng: 66.987654,
    city: 'Tashkent',
    country: 'UZ',
    locationSource: 'street',
    locationProvider: 'nominatim',
    locationCanonical: 'Ambiguous Street',
    locationPrecision: 'street',
    locationAccuracyM: 300,
    locationApproximate: true,
  };

  try {
    await applyReverseGeo([listing], UZ);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(listing.lat, null);
  assert.equal(listing.lng, null);
  assert.equal(listing.locationRejected, 'city-mismatch');
  assert.equal(listing.locationApproximate, true);
});
