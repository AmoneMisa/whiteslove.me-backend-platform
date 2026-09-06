import test from 'node:test';
import assert from 'node:assert/strict';
import {parseListingFilters} from '../src/routes/listing-routes.js';
import {__postgresGeoFilterTest} from '../src/infrastructure/search/postgres-geo-filter.js';
import {buildSearchContext} from '../src/infrastructure/search/postgres-search-core.js';
import {buildMemberWhere} from '../src/infrastructure/search/postgres-search-fast-core.js';
import {canonicalListingFilters} from '../src/listing/listing-filter-canonical.js';
import {searchCursorScope} from '../src/support/postgres-cursor-scope.js';

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

function withResolvedGeometry(filters) {
  Object.defineProperty(filters, '_resolvedSearchGeometry', {
    enumerable: false,
    configurable: true,
    value: Object.freeze({
      country: 'UZ',
      city: 'Tashkent',
      district: {
        id: 'district:chilanzar',
        canonicalName: 'Chilanzar',
        boundary: {
          type: 'Polygon',
          coordinates: [[[69, 41], [70, 41], [70, 42], [69, 42], [69, 41]]],
        },
      },
      metros: Object.freeze([
        {requested: 'Novza', canonicalName: 'Novza', center: {lat: 41.292, lng: 69.223}},
        {requested: 'Chilonzor', canonicalName: 'Chilonzor', center: {lat: 41.275, lng: 69.204}},
      ]),
      unresolvedMetros: Object.freeze([]),
    }),
  });
  return filters;
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

test('general listing count/page/map context applies geo predicates directly in SQL', () => {
  const filters = withResolvedGeometry({
    city: 'Tashkent',
    district: 'Chilanzar',
    metro: 'Novza,Chilonzor',
    metros: ['Novza', 'Chilonzor'],
    metroMaxM: 800,
    metroArc: {from: 340, to: 20},
  });
  const context = buildSearchContext({filters, countries: ['UZ'], rates: null, searchMatches: null});
  const sql = context.where.join('\n');
  assert.match(sql, /point\(l\.lng, l\.lat\)/);
  assert.match(sql, /ACOS/);
  assert.match(sql, /ATAN2/);
  assert.match(sql, /NOT \(l\.lat IS NOT NULL[\s\S]*LOWER\(l\.district\) =/);
  assert.doesNotMatch(sql, /LOWER\(l\.metro\) =/);
});

test('canonical feed applies the same geo predicates before count and pagination', () => {
  const filters = withResolvedGeometry({
    city: 'Tashkent',
    district: 'Chilanzar',
    metro: 'Novza,Chilonzor',
    metros: ['Novza', 'Chilonzor'],
    metroMaxM: 800,
    metroArc: {from: 340, to: 20},
  });
  const context = buildMemberWhere({filters, countries: ['UZ'], maxAgeDays: 14, rates: null});
  const sql = context.where;
  assert.match(sql, /point\(m\.lng, m\.lat\)/);
  assert.match(sql, /ACOS/);
  assert.match(sql, /ATAN2/);
  assert.match(sql, /NOT \(m\.lat IS NOT NULL[\s\S]*LOWER\(m\.district\) =/);
  assert.doesNotMatch(sql, /LOWER\(m\.metro\) =/);
});

test('resolved geometry survives canonical filter copies', () => {
  const filters = withResolvedGeometry({
    dealType: 'longRent',
    roomOnly: true,
    district: 'Chilanzar',
  });
  const canonical = canonicalListingFilters(filters);
  assert.equal(canonical.dealType, 'roomRent');
  assert.equal(canonical._resolvedSearchGeometry, filters._resolvedSearchGeometry);
});

test('cursor scope changes when geographic membership changes', () => {
  const base = {
    city: 'Tashkent',
    district: 'Chilanzar',
    metro: 'Novza',
    metros: ['Novza'],
    metroMaxM: 800,
    metroArc: {from: 340, to: 20},
    sort: 'newest',
  };
  const novza = searchCursorScope(base, ['UZ']);
  const chilonzor = searchCursorScope({...base, metro: 'Chilonzor', metros: ['Chilonzor']}, ['UZ']);
  const largerRadius = searchCursorScope({...base, metroMaxM: 1200}, ['UZ']);
  assert.notEqual(novza, chilonzor);
  assert.notEqual(novza, largerRadius);
});
