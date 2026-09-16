import test from 'node:test';
import assert from 'node:assert/strict';
import {makeListing} from '../src/listing/normalize.js';

// makeListing() resolves free text against @whiteslove/parsing-lexicon's geo
// catalog (tens of thousands of street/district/landmark entries per
// country). Each catalog entry lazily compiles its own Unicode-mode alias
// regex the first time a listing's text happens to reach it; that regex is
// then cached forever on the entry. A listing whose text is novel enough to
// reach previously-untouched catalog entries therefore grows the process's
// V8 code space, while a repeated/identical description does not (it only
// ever touches already-cached entries). Distinct, varied descriptions are
// what earlier crashed the crawler with "JavaScript heap out of memory" —
// this guards against that regressing further, without asserting on an
// implementation detail (compiled regex count) this test cannot see.
const DISTINCT_DESCRIPTIONS = [
  'Сдаётся уютная 2-комнатная квартира в центре города, свежий ремонт, вся мебель и техника, рядом метро, 15000 грн в месяц, торг уместен.',
  'Продається 3-кімнатна квартира на 5 поверсі 9-поверхового будинку, євроремонт, автономне опалення, ціна 45000 доларів.',
  'Ijaraga 2 xonali kvartira beriladi, yangi ta’mir, barcha mebel bilan, metro yaqinida, oyiga 3000000 sum.',
  'Продам квартиру в новостройке, 60 кв.м, 2 спальни, парковка, лифт, кондиционер, цена 55000$.',
  'Здається однокімнатна квартира подобово, з меблями, wifi, поруч центр, 800 грн за добу.',
  'Sotiladi 4 xonali uy, hovlisi katta, garaj bor, narxi kelishiladi, Toshkent shahrida joylashgan.',
  'Сдам комнату в общежитии, без мебели, недалеко от университета, 3000 сом в месяц.',
  'Продается дом с участком 10 соток, кирпичный, 2 этажа, баня, гараж, цена договорная.',
  'Здам будинок в передмісті, великий двір, гараж на 2 машини, меблі часткові, 12000 грн.',
  'Ijara uchun studiya, markazda, barcha narsa bor, oyiga 2500000 som, kafolat puli kerak.',
];
const COUNTRIES = ['UA', 'UZ', 'RU', 'KZ'];

function heapMB() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// Each call below touches previously-uncompiled catalog entries and is
// unavoidably slow (multiple seconds) by the nature of the issue this test
// guards against; kept short so the suite stays usable while still catching
// a true runaway regression.
//
// Rather than assert an absolute heap ceiling (fragile across Node/V8
// versions and catalog growth), this asserts the *shape* of the growth: a
// bounded, cache-then-plateau curve adds less heap in its second half of
// calls than its first (each call increasingly hits already-compiled
// catalog entries), whereas a genuine per-call leak would keep adding
// roughly the same amount indefinitely.
test('makeListing() on varied descriptions does not runaway-grow the heap', {timeout: 120_000}, () => {
  const half = Math.floor((DISTINCT_DESCRIPTIONS.length - 1) / 2);

  makeListing({title: 'Warmup', description: DISTINCT_DESCRIPTIONS[0], country: COUNTRIES[0]});
  const start = heapMB();

  for (let i = 1; i <= half; i += 1) {
    makeListing({title: `Listing ${i}`, description: DISTINCT_DESCRIPTIONS[i], country: COUNTRIES[i % COUNTRIES.length]});
  }
  const afterFirstHalf = heapMB();

  for (let i = half + 1; i < DISTINCT_DESCRIPTIONS.length; i += 1) {
    makeListing({title: `Listing ${i}`, description: DISTINCT_DESCRIPTIONS[i], country: COUNTRIES[i % COUNTRIES.length]});
  }
  const afterSecondHalf = heapMB();

  const firstHalfGrowth = afterFirstHalf - start;
  const secondHalfGrowth = afterSecondHalf - afterFirstHalf;

  // A generous 1.5x slack absorbs noise (GC timing, which new entries a
  // batch happens to touch) without letting a true runaway (unbounded,
  // roughly constant-per-call growth) pass.
  assert.ok(
    secondHalfGrowth < firstHalfGrowth * 1.5,
    `heap growth did not decelerate across equal-sized batches of varied listings `
      + `(first half +${firstHalfGrowth.toFixed(1)}MB, second half +${secondHalfGrowth.toFixed(1)}MB); `
      + 'expected the second batch to mostly hit already-compiled catalog entries',
  );
});
