import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDictionaryEntities } from '../src/location-dictionary-resolver.js';

const cases = [
  ['Квартира Юнусабад 19, рядом метро', 'UZ', 'Tashkent', 'microdistrict', 'Yunusabad-19'],
  ['ЖК Хон Сарой, Ташкент', 'UZ', 'Tashkent', 'residentialComplex', 'Xon Saroy'],
  ['Buyuk Ipak Yo‘li metro', 'UZ', 'Tashkent', 'metro', 'Buyuk Ipak Yoli'],
  ['Согдиана, Самарканд', 'UZ', 'Samarkand', 'microdistrict', 'Sogdiana'],
  ['Самал 2, Алматы', 'KZ', 'Almaty', 'microdistrict', 'Samal-2'],
  ['метро Жібек жолы', 'KZ', 'Almaty', 'metro', 'Zhibek Zholy'],
  ['Хайвилл, Астана', 'KZ', 'Astana', 'residentialComplex', 'Highvill'],
  ['Сарайшық ауданы', 'KZ', 'Astana', 'district', 'Saraishyk'],
  ['Piața Victoriei, București', 'RO', 'Bucharest', 'metro', 'Piata Victoriei'],
  ['apartament Coresi Avantgarden Brașov', 'RO', 'Brasov', 'residentialComplex', 'Coresi Avantgarden'],
  ['оренда на Троєщині', 'UA', 'Kyiv', 'microdistrict', 'Troyeshchyna'],
  ['Новопечерские Липки', 'UA', 'Kyiv', 'residentialComplex', 'Novopecherski Lypky'],
  ['Салтівський район Харків', 'UA', 'Kharkiv', 'district', 'Saltivskyi'],
  ['метро Олексіївська', 'UA', 'Kharkiv', 'metro', 'Oleksiivska'],
  ['квартира в Аркадии', 'UA', 'Odesa', 'microdistrict', 'Arkadia'],
  ['Сихів, Львів', 'UA', 'Lviv', 'microdistrict', 'Sykhiv'],
];

for (const [text, country, city, field, name] of cases) {
  test(`${country}/${city}: ${text}`, () => {
    const result = matchDictionaryEntities(text, country, city);
    assert.equal(result.city, city);
    assert.equal(result[field], name);
  });
}

test('does not substring-match short aliases inside unrelated words', () => {
  const result = matchDictionaryEntities('ordinary apartment description', 'KZ', 'Astana');
  assert.equal(result.district, null);
  assert.equal(result.microdistrict, null);
  assert.equal(result.metro, null);
  assert.equal(result.residentialComplex, null);
});
