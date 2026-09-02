import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation, cityLocations } from '../src/geo/locations.js';
import { makeListing } from '../src/listing/normalize.js';
import { matchUkraineRegion, matchUkraineSecondaryCity } from '../src/geo/location-dictionaries-ua-regions.js';

test('Tashkent microdistrict + ЖК + metro aliases', () => {
  const loc = parseLocation('Юнусабад 19, ЖК Хон Сарой, рядом метро Шахристан', 'UZ');
  assert.equal(loc.city, 'Tashkent');
  assert.equal(loc.microdistrict, 'Yunusabad-19');
  assert.equal(loc.residentialComplex, 'Xon Saroy');
  assert.equal(loc.metro, 'Shahriston');
});

test('Almaty Kazakh metro alias is normalized', () => {
  const loc = parseLocation('Алматы, квартира возле метро Жібек жолы', 'KZ');
  assert.equal(loc.city, 'Almaty');
  assert.equal(loc.metro, 'Zhibek Zholy');
});

test('Bucharest Romanian diacritics are accepted', () => {
  const loc = parseLocation('Apartament Aviației, aproape de Piața Victoriei', 'RO');
  assert.equal(loc.city, 'Bucharest');
  assert.equal(loc.microdistrict, 'Aviatiei');
  assert.equal(loc.metro, 'Piata Victoriei');
});

test('Ukraine oblast alias is recognized', () => {
  assert.equal(matchUkraineRegion('Одеська область, оренда квартири')?.name, 'Odesa Oblast');
  assert.equal(matchUkraineRegion('Одесская область, квартира')?.name, 'Odesa Oblast');
});

test('Chornomorsk legacy name resolves to current city', () => {
  const city = matchUkraineSecondaryCity('Продам квартиру, Ильичевск, возле моря');
  assert.equal(city?.city, 'Chornomorsk');
});

test('Izmail is recognized as a secondary Ukrainian city', () => {
  const loc = parseLocation('Измаил, район БАМ, сдам 2-комнатную квартиру', 'UA');
  assert.equal(loc.city, 'Izmail');
  assert.equal(loc.microdistrict, 'BAM');
});

test('Mukachevo multilingual city alias works', () => {
  const loc = parseLocation('Мукачево, Росвигово, оренда квартири', 'UA');
  assert.equal(loc.city, 'Mukachevo');
  assert.equal(loc.microdistrict, 'Rosvyhovo');
});

test('Kharkiv Russian microdistrict alias works', () => {
  const loc = parseLocation('Харьков, Алексеевка, метро Победа', 'UA');
  assert.equal(loc.city, 'Kharkiv');
  assert.equal(loc.microdistrict, 'Oleksiivka');
  assert.equal(loc.metro, 'Peremoha');
});

test('normalized listing exposes region/microdistrict/residentialComplex', () => {
  const listing = makeListing({
    id: 'test-1', source: 'telegram', country: 'UA',
    title: 'Оренда квартири',
    description: 'Київська область, Ірпінь, Річ Таун, 2 кімнати, 18000 грн',
    price: 18000, currency: 'UAH',
  });
  assert.equal(listing.region, 'Kyiv Oblast');
  assert.equal(listing.city, 'Irpin');
  assert.equal(listing.microdistrict, 'Rich Town area');
});

test('cityLocations exposes extended UI dictionaries', () => {
  const uz = cityLocations('UZ');
  assert.ok(uz.Tashkent.microdistricts.includes('Yunusabad-19'));
  assert.ok(uz.Tashkent.residentialComplexes.includes('Xon Saroy'));
  const ua = cityLocations('UA');
  assert.ok(ua.Kharkiv.microdistricts.includes('Saltivka'));
});
