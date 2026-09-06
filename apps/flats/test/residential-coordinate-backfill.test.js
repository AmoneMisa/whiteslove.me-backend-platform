import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResidentialCoordinateBackfillPatch,
  hydrateResidentialCoordinateBackfillListing,
} from '../src/geo/residential-coordinate-backfill.js';
import { mapListingToRow } from '../src/infrastructure/database/listingMapper.js';

test('backfill hydrates canonical listing fields from PostgreSQL columns when JSON is sparse', () => {
  const listing = hydrateResidentialCoordinateBackfillListing({
    db_id: '101',
    source: 'olx',
    country: 'uz',
    source_id: 'abc',
    city: 'Tashkent',
    residence_complex: 'Assalom Sohil',
    lat: 41.3122,
    lng: 69.2797,
    data: { title: 'Apartment' },
  });

  assert.equal(listing.id, 'abc');
  assert.equal(listing.source, 'olx');
  assert.equal(listing.country, 'UZ');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.residenceComplex, 'Assalom Sohil');
  assert.equal(listing.lat, 41.3122);
  assert.equal(listing.lng, 69.2797);
});

test('backfill patch moves a broad Assalom Sohil pin to the canonical complex anchor', () => {
  const patch = buildResidentialCoordinateBackfillPatch({
    db_id: '102',
    source: 'olx',
    country: 'UZ',
    source_id: 'assalom',
    city: 'Tashkent',
    residence_complex: 'Assalom Sohil',
    lat: 41.3122,
    lng: 69.2797,
    data: {
      locationSource: 'coordinates',
      locationPrecision: 'broad',
      locationApproximate: true,
      locationEntities: [
        { type: 'residential_complex', name: 'Assalom Sohil', role: 'primary' },
        { type: 'residential_complex', name: 'Infinity', role: 'nearby' },
      ],
    },
  });

  assert.ok(patch);
  assert.ok(Math.abs(patch.lat - 41.282995) < 0.000001);
  assert.ok(Math.abs(patch.lng - 69.308420) < 0.000001);
  assert.equal(patch.locationCanonical, 'Assalom Sohil');
  assert.equal(patch.locationRole, 'primary');
  assert.equal(patch.locationProvider, 'geoCatalog');
  assert.equal(patch.locationGeoEntityId, 'uz:tashkent:residential:assalom-sohil');
  assert.equal(patch.sourceCoordinateRefined, true);
});

test('backfill produces no patch for an already exact building-level coordinate', () => {
  const patch = buildResidentialCoordinateBackfillPatch({
    db_id: '103',
    source: 'olx',
    country: 'UZ',
    source_id: 'exact',
    city: 'Tashkent',
    residence_complex: 'Assalom Sohil',
    lat: 41.2831,
    lng: 69.3086,
    data: {
      locationSource: 'address',
      locationPrecision: 'building',
      locationApproximate: false,
    },
  });

  assert.equal(patch, null);
});

test('backfill never persists unrelated listing fields', () => {
  const patch = buildResidentialCoordinateBackfillPatch({
    db_id: '104',
    source: 'olx',
    country: 'UZ',
    source_id: 'safe-patch',
    city: 'Tashkent',
    residence_complex: 'Assalom Sohil',
    lat: 41.3122,
    lng: 69.2797,
    data: {
      title: 'Must not be rewritten by backfill',
      description: 'Keep source payload untouched',
      price: 123,
      locationSource: 'coordinates',
      locationApproximate: true,
    },
  });

  assert.ok(patch);
  assert.equal(Object.hasOwn(patch, 'title'), false);
  assert.equal(Object.hasOwn(patch, 'description'), false);
  assert.equal(Object.hasOwn(patch, 'price'), false);
});

test('persistence mapper also refines a late-enriched canonical residential complex', () => {
  const row = mapListingToRow({
    id: 'late-ai-assalom',
    source: 'olx',
    country: 'UZ',
    city: 'Tashkent',
    title: 'Apartment in Assalom Sohil',
    description: '',
    residenceComplex: 'Assalom Sohil',
    lat: 41.3122,
    lng: 69.2797,
    locationSource: 'coordinates',
    locationPrecision: 'broad',
    locationApproximate: true,
    ai: {
      status: 'completed',
      derivedFields: ['residenceComplex'],
    },
  });

  assert.ok(Math.abs(row.data.lat - 41.282995) < 0.000001);
  assert.ok(Math.abs(row.data.lng - 69.308420) < 0.000001);
  assert.equal(row.data.locationSource, 'residentialComplex');
  assert.equal(row.data.locationProvider, 'geoCatalog');
  assert.equal(row.data.locationCanonical, 'Assalom Sohil');
  assert.equal(row.data.locationGeoEntityId, 'uz:tashkent:residential:assalom-sohil');
});
