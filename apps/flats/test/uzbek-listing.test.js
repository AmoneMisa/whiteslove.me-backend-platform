import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/listing/normalize.js';
import { applyListingFilters } from '../src/legacy/legacy-listing-filter.js';
import { resolveTashkentArea } from '../src/geo/tashkent-areas.js';

test('backend normalization consumes structured Uzbek parser output', () => {
  const listing = makeListing({
    id: 'uzbek-integration-smoke',
    source: 'telegram',
    country: 'UZ',
    title: 'Uchtepa tumani 25 daha',
    description: '2 xonali uy ijaraga beriladi. 2-qavat / 14-qavatli uy.',
  });

  assert.equal(listing.id, 'uzbek-integration-smoke');
  assert.equal(listing.source, 'telegram');
  assert.equal(typeof listing.rooms, 'number');
  assert.equal(typeof listing.floor, 'number');
  assert.ok(listing.city);
  assert.ok(listing.district);
});

test('finds one shared listing by exact id outside normal pagination', () => {
  const rows = [
    { id: 'first', source: 'telegram', commercial: false },
    { id: 'shared-row', source: 'telegram', commercial: false },
  ];
  assert.deepEqual(
    applyListingFilters(rows, { listingId: 'shared-row', sources: ['telegram'] }).map(({ id }) => id),
    ['shared-row'],
  );
});

test('maps numbered Chilanzar areas to backend district policy', () => {
  assert.deepEqual(resolveTashkentArea('Чиланзар-7'), {
    area: 'Chilanzar-7', district: 'Chilanzar', confidence: 1, ambiguous: false, requireExactAddress: false,
  });
  assert.deepEqual(resolveTashkentArea('13 квартал Чиланзара'), {
    area: 'Chilanzar-13', district: 'Uchtepa', confidence: 1, ambiguous: false, requireExactAddress: false,
  });
});

test('resolves Kuylyuk ranges and preserves a bare ambiguous area', () => {
  assert.equal(resolveTashkentArea('Куйлюк-2').district, 'Mirobod');
  assert.equal(resolveTashkentArea('Куйлюк 6 квартал').district, 'Sergeli');
  assert.equal(resolveTashkentArea('Куйлюк-Центр').district, 'Yashnobod');
  assert.deepEqual(resolveTashkentArea('Ориентир рынок Куйлюк'), {
    area: 'Kuylyuk', district: null, confidence: 0.25, ambiguous: true, requireExactAddress: true,
  });
});

test('resolves Sergeli legacy areas without guessing a bare massif', () => {
  assert.equal(resolveTashkentArea('Сергели-1').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Сергели-5А').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Сергели-6А').district, 'Sergeli');
  assert.deepEqual(resolveTashkentArea('Сергели, квартира рядом с рынком'), {
    area: 'Sergeli', district: null, confidence: 0.35, ambiguous: true, requireExactAddress: true,
  });
});

test('maps legacy C-codes and backend-owned landmark district policy', () => {
  assert.equal(resolveTashkentArea('Лабзак Ц-13').district, 'Shaykhantahur');
  assert.equal(resolveTashkentArea('Кашгар Ц-4').district, 'Yunusabad');
  assert.equal(resolveTashkentArea('Алайский Ц-2').district, 'Mirzo Ulugbek');
  assert.equal(resolveTashkentArea('Авиасозлар-3').district, 'Yashnobod');
  assert.equal(resolveTashkentArea('Янги Чоштепа').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Глинка').district, 'Yakkasaray');
});
