import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFirstEntry } from '@whiteslove/parsing-lexicon/alias-prefilter';
import { parseLocation, cityLocations } from '../src/geo/locations.js';
import { makeListing } from '../src/listing/normalize.js';

// The dictionary guards below reject a hit through matchFirstEntry's accept
// predicate. A lexicon that predates that parameter ignores it silently — the
// guards simply stop running and listings quietly resolve to the wrong city
// again. Assert the contract directly so a stale dependency says so, instead
// of surfacing as a confusing behavioural failure.
test('the installed lexicon supports the accept predicate', () => {
  const entries = [
    Object.freeze({ name: 'Alpha Street', aliases: ['Alpha Street'], re: /(?:^|[^\p{L}\p{N}_])alpha street(?:$|[^\p{L}\p{N}_])/iu }),
  ];
  assert.equal(matchFirstEntry(entries, 'on Alpha Street today')?.name, 'Alpha Street');
  assert.equal(matchFirstEntry(entries, 'on Alpha Street today', () => false), undefined);
});

test('parseLocation propagates multiple shared dictionary entity types', () => {
  const loc = parseLocation('Юнусабад 19, ЖК Хон Сарой, рядом метро Шахристан', 'UZ');
  assert.ok(loc.city);
  assert.ok(loc.microdistrict);
  assert.ok(loc.residentialComplex);
  assert.ok(loc.metro);
});

test('normalized listing exposes shared location fields', () => {
  const listing = makeListing({
    id: 'test-1', source: 'telegram', country: 'UA',
    title: 'Оренда квартири',
    description: 'Київська область, Ірпінь, Річ Таун, 2 кімнати, 18000 грн',
    price: 18000, currency: 'UAH',
  });
  assert.ok(listing.region);
  assert.ok(listing.city);
  assert.ok(listing.microdistrict);
});

// Imported alias lists carry a street's namesake city as a bare alias — Kyiv's
// "Чернівецька вулиця" lists "Чернівці" — and stub aliases of one or two
// letters. Scanning every city and letting the first hit win turned both into
// anchors, so a post that only stated its city acquired a street somewhere else
// and was placed in that city.
test('a bare city name in the text never anchors a street elsewhere', () => {
  const loc = parseLocation('Продаж 2х кім кварт(по плану) Чернівці, центр', 'UA');
  assert.equal(loc.street, null);
});

test('a two-letter stub alias does not anchor a street', () => {
  // "По" is an alias of Lviv's "Поперечна вулиця"; "по плану" is not an address.
  const loc = parseLocation('Продаж 2х кім кварт (по плану), 42м2', 'UA');
  assert.equal(loc.street, null);
});

test('a stated city scopes the dictionary instead of ranking it', () => {
  // Chornovola streets exist in many Ukrainian cities; the catalogue happens to
  // hold Kalush's. A Chernivtsi listing must not borrow it.
  const loc = parseLocation(
    'ЖК «Кришталеве озеро» Вул.Чорновола, р-н Руської',
    'UA',
    'Chernivtsi',
  );
  assert.notEqual(loc.city, 'Kalush');
});

test('cityLocations exposes shared dictionaries in the backend UI shape', () => {
  const uz = cityLocations('UZ');
  assert.ok(Array.isArray(uz.Tashkent?.microdistricts));
  assert.ok(Array.isArray(uz.Tashkent?.residentialComplexes));

  const ua = cityLocations('UA');
  assert.ok(Array.isArray(ua.Kharkiv?.microdistricts));
});
