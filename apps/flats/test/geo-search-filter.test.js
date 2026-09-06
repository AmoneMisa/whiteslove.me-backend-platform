import test from 'node:test';
import assert from 'node:assert/strict';
import {parseListingFilters} from '../src/routes/listing-routes.js';
import {__postgresGeoFilterTest} from '../src/infrastructure/search/postgres-geo-filter.js';
import {withoutLegacyGeoFilters} from '../src/infrastructure/search/postgres-geo-gate.js';

function collector() {
  const params = [];
  return {
    params,
    add(value) {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

test('listing filter parser preserves multi-metro union and directional arc', () => {
  const filters = parseListingFilters({
    metro: 'Novza, Chilonzor,Novza',
    metroMaxM: '800',
    metroArc: '340,20',
  });
  assert.deepEqual(filters.metros, ['Novza', 'Chilonzor']);
  assert.equal(filters.metro, 'Novza,Chilonzor');
  assert.equal(filters.metroMaxM, 800);
  assert.deepEqual(filters.metroArc, {from: 340, to: 20});
});

test('district boundary SQL uses polygon containment and subtracts GeoJSON holes', () => {
  const {params, add} = collector();
  const boundary = {
    type: 'Polygon',
    coordinates: [
      [[69, 41], [70, 41], [70, 42], [69, 42], [69, 41]],
      [[69.4, 41.4], [69.6, 41.4], [69.6, 41.6], [69.4, 41.6], [69.4, 41.4]],
    ],
  };
  const sql = __postgresGeoFilterTest.boundaryPredicate('l', boundary, add);
  assert.match(sql, /point\(l\.lng, l\.lat\) <@ \$1::polygon/);
  assert.match(sql, /NOT \(point\(l\.lng, l\.lat\) <@ \$2::polygon\)/);
  assert.equal(params.length, 2);
});

test('metro spatial SQL is selected-station Haversine plus wrap-safe bearing arc', () => {
  const {params, add} = collector();
  const sql = __postgresGeoFilterTest.stationSpatialPredicate(
    'l',
    {center: {lat: 41.3, lng: 69.2}},
    {metroMaxM: 750, metroArc: {from: 340, to: 20}},
    add,
  );
  assert.match(sql, /ACOS/);
  assert.match(sql, /ATAN2/);
  assert.match(sql, />=/);
  assert.match(sql, / OR /);
  assert.match(sql, /<=/);
  assert.ok(params.includes(750));
  assert.ok(params.includes(340));
  assert.ok(params.includes(20));
});

test('legacy district/metro clauses are removed after database geo membership is gated', () => {
  const original = {
    city: 'Tashkent',
    district: 'Chilanzar',
    metro: 'Novza,Chilonzor',
    metros: ['Novza', 'Chilonzor'],
    metroMaxM: 500,
    metroArc: {from: 270, to: 90},
    priceMax: 500,
  };
  const stripped = withoutLegacyGeoFilters(original);
  assert.equal(stripped.district, '');
  assert.equal(stripped.metro, '');
  assert.deepEqual(stripped.metros, []);
  assert.equal(stripped.metroMaxM, null);
  assert.equal(stripped.metroArc, null);
  assert.equal(stripped.city, 'Tashkent');
  assert.equal(stripped.priceMax, 500);
});
