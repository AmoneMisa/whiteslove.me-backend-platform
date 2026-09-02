import test from 'node:test';
import assert from 'node:assert/strict';
import { makeListing } from '../src/listing/normalize.js';
import { applyListingFilters } from '../src/legacy/legacy-listing-filter.js';
import { coordinateInsideBbox } from '../src/geo/coordinate-validation.js';
import { sortListings } from '../src/legacy/listing-sort.js';

test('bare street plus house number is retained as an address', () => {
  const listing = makeListing({
    id: 'odesa-address',
    source: 'olx',
    country: 'UA',
    title: 'Долгосрочно район Аркадии',
    description: 'Одесса, район Аркадии, Балтиморская 9, 160 кв.м, парковка',
  });

  assert.equal(listing.address, 'Балтиморская 9');
});

test('requested quick amenities are normalized from listing text', () => {
  const listing = makeListing({
    id: 'amenities',
    source: 'telegram',
    country: 'UA',
    title: 'Квартира',
    description: 'Посудомоечная машина, кондиционер, своё парковочное место, Wi-Fi, газ, балкон, терраса, личный двор.',
  });

  for (const field of [
    'dishwasher',
    'airConditioner',
    'parking',
    'internet',
    'gas',
    'balcony',
    'terrace',
    'privateYard',
  ]) {
    assert.equal(listing[field], true, field);
  }
});

test('amenity filters require explicit positive signals', () => {
  const withAll = makeListing({
    id: 'all',
    source: 'telegram',
    country: 'UA',
    title: 'Квартира',
    description: 'dishwasher air conditioner parking wifi газ балкон terrace private yard',
  });
  const plain = makeListing({
    id: 'plain',
    source: 'telegram',
    country: 'UA',
    title: 'Квартира',
    description: 'Обычная квартира',
  });

  const result = applyListingFilters([plain, withAll], {
    propertyType: 'any',
    agency: 'any',
    dealType: 'any',
    audience: 'any',
    dishwasher: true,
    airConditioner: true,
    parking: true,
    internet: true,
    gas: true,
    balcony: true,
    terrace: true,
    privateYard: true,
  });

  assert.deepEqual(result.map((item) => item.id), ['all']);
});

test('coordinate bbox guard rejects an offshore/out-of-city point', () => {
  const odesaLike = [46.35, 30.60, 46.60, 30.85];
  assert.equal(coordinateInsideBbox(46.46, 30.74, odesaLike, 0.02), true);
  assert.equal(coordinateInsideBbox(46.20, 31.05, odesaLike, 0.02), false);
});

test('sorting covers dates, common-currency price and alphabetic directions', () => {
  const rows = [
    { id: 'b', title: 'Бета', price: 4150, currency: 'UAH', createdAt: '2026-08-20T00:00:00Z' },
    { id: 'a', title: 'Альфа', price: 200, currency: 'USD', createdAt: '2026-08-21T00:00:00Z' },
    { id: 'z', title: 'Ялта', price: null, currency: 'UAH', createdAt: '2026-08-19T00:00:00Z' },
  ];
  const rates = { USD: 1, UAH: 41.5 };

  assert.deepEqual(sortListings([...rows], 'newest', rates).map((x) => x.id), ['a', 'b', 'z']);
  assert.deepEqual(sortListings([...rows], 'oldest', rates).map((x) => x.id), ['z', 'b', 'a']);
  assert.deepEqual(sortListings([...rows], 'priceAsc', rates).map((x) => x.id), ['b', 'a', 'z']);
  assert.deepEqual(sortListings([...rows], 'priceDesc', rates).map((x) => x.id), ['a', 'b', 'z']);
  assert.deepEqual(sortListings([...rows], 'titleAsc', rates).map((x) => x.id), ['a', 'b', 'z']);
  assert.deepEqual(sortListings([...rows], 'titleDesc', rates).map((x) => x.id), ['z', 'b', 'a']);
});
