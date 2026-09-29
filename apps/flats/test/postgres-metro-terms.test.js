import test from 'node:test';
import assert from 'node:assert/strict';
import {__postgresGeoFilterTest} from '../src/infrastructure/search/postgres-geo-filter.js';

function build(filters, idColumn) {
  const where = [];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  __postgresGeoFilterTest.appendMetroWhere({where, filters, alias: 'm', add, geometry: null, ...(idColumn ? {idColumn} : {})});
  return {sql: where.join(' AND '), params};
}

test('a metro name filter also matches any station the listing names, not only the primary', () => {
  const {sql, params} = build({metros: ['Novza']}, 'm.listing_id');
  assert.match(sql, /LOWER\(m\.metro\) = ANY\(\$1::text\[\]\)/u);
  assert.match(sql, /listing_location_terms metro_term/u);
  assert.match(sql, /metro_term\.listing_id = m\.listing_id/u);
  assert.match(sql, /metro_term\.term_type = 'listing_metro'/u);
  assert.deepEqual(params, [['novza']]);
});

test('the metro term join defaults to the listings primary key', () => {
  assert.match(build({metro: 'Chilonzor'}).sql, /metro_term\.listing_id = m\.id/u);
});
