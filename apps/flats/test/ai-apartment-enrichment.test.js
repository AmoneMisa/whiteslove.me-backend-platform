import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APARTMENT_PARSER_VERSION,
  AI_FILLABLE_LISTING_FIELDS,
  aiRetryDue,
  apartmentAiInput,
  mergeApartmentAi,
  needsApartmentAi,
} from '../src/listing/ai-enrichment.js';
import {
  AMENITY_PASS_VERSION,
  buildAmenityBatchText,
  mergeAmenityItem,
  needsAmenityPass,
} from '../src/listing/amenity-batch.js';

function result(data, confidence = 0.9) {
  return { status: 'completed', confidence, data };
}

test('the deterministic parse is never overwritten by the model', () => {
  const listing = {
    source: 'olx',
    id: '1',
    city: 'Tashkent',
    rooms: 2,
    areaSqm: 46,
    condition: 'good',
  };

  const merged = mergeApartmentAi(listing, result({
    rooms: 5,
    areaM2: 120,
    condition: 'luxury',
  }), 'UZ');

  assert.equal(merged.rooms, 2);
  assert.equal(merged.areaSqm, 46);
  assert.equal(merged.condition, 'good');
  assert.deepEqual(merged.ai.derivedFields, []);
});

test('only fields the parser left empty are filled, and they are recorded', () => {
  const listing = { source: 'olx', id: '2', city: 'Tashkent', rooms: 2 };

  const merged = mergeApartmentAi(listing, result({
    rooms: 5,
    bathrooms: 1,
    elevator: true,
    parking: null,
  }), 'UZ');

  assert.equal(merged.rooms, 2);
  assert.equal(merged.bathrooms, 1);
  assert.equal(merged.elevator, true);
  assert.equal(merged.parking, undefined);
  assert.deepEqual(merged.ai.derivedFields, ['bathrooms', 'elevator']);
  assert.equal(merged.ai.parserVersion, APARTMENT_PARSER_VERSION);
});

test('a free-text district from the model is rejected', () => {
  const listing = { source: 'olx', id: '3', city: 'Tashkent' };

  const merged = mergeApartmentAi(listing, result({
    district: 'somewhere near the big park',
  }), 'UZ');

  assert.equal(merged.district, undefined);
  assert.equal(merged.ai.derivedFields.includes('district'), false);
});

test('a dictionary-backed district is accepted and canonicalized', () => {
  const listing = { source: 'olx', id: '4', city: 'Tashkent' };

  const merged = mergeApartmentAi(listing, result({
    district: 'Мирабадский район',
  }), 'UZ');

  assert.equal(merged.district, 'Mirobod');
  assert.equal(merged.ai.derivedFields.includes('district'), true);
});

test('a district belonging to another city is refused', () => {
  const listing = { source: 'olx', id: '5', city: 'Samarkand' };

  const merged = mergeApartmentAi(listing, result({
    district: 'Мирабадский район',
  }), 'UZ');

  assert.equal(merged.district, undefined);
});

test('the fingerprint changes when the deterministic facts change', () => {
  const base = {
    source: 'olx',
    id: '6',
    city: 'Tashkent',
    title: 'Продается квартира',
    description: 'ЖК Mavera Town',
  };

  const before = apartmentAiInput(base).fingerprint;
  const after = apartmentAiInput({ ...base, district: 'Yakkasaray' }).fingerprint;
  const sameAgain = apartmentAiInput({ ...base }).fingerprint;

  assert.notEqual(before, after);
  assert.equal(before, sameAgain);
});

test('a listing the parser fully covered is not sent for extraction', () => {
  const complete = {
    source: 'olx',
    id: '7',
    title: 'Квартира',
    description: 'текст',
  };
  for (const field of [
    'rooms', 'bedrooms', 'bathrooms', 'areaSqm', 'floor', 'totalFloors',
    'newBuilding', 'balcony', 'airConditioner', 'gas', 'furnished',
    'petsAllowed', 'childrenAllowed', 'communalSeparated', 'deposit',
    'depositAmount', 'commission', 'commissionPercent', 'negotiable',
    'parking', 'elevator', 'heating', 'hotWater', 'internet',
    'smokingAllowed', 'condition', 'dishwasher', 'terrace', 'privateYard', 'tv',
    'microwave', 'oven', 'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout',
  ]) complete[field] = 1;

  assert.equal(needsApartmentAi(complete), false);
  assert.equal(needsApartmentAi({ ...complete, rooms: null }), true);
});

test('listings without text and mock sources are never sent', () => {
  assert.equal(needsApartmentAi({ source: 'olx', id: '8' }), false);
  assert.equal(needsApartmentAi({ source: 'mock-uz', id: '9', title: 'Квартира' }), false);
});

// --- address / residence complex -------------------------------------------
//
// Both feed geocoding, where a confident wrong value is worse than a null: the
// pin moves to a real place that is not this flat. The prompt tells the model
// to leave landmark references alone; these cover the backstop that keeps a
// bad answer out of the listing anyway.

test('a catalogued residence complex is accepted, an invented one is not', () => {
  const listing = { source: 'olx', id: 'rc1', city: 'Tashkent' };

  const known = mergeApartmentAi(listing, result({ residenceComplex: 'Nest One' }), 'UZ');
  assert.equal(known.residenceComplex, 'Nest One');
  assert.ok(known.ai.derivedFields.includes('residenceComplex'));

  const invented = mergeApartmentAi(
    listing,
    result({ residenceComplex: 'ЖК Совершенно Выдуманный' }),
    'UZ',
  );
  assert.equal(invented.residenceComplex, undefined);
  assert.deepEqual(invented.ai.derivedFields, []);
});

test('a complex name keeps matching through its ZhK prefix', () => {
  const listing = { source: 'olx', id: 'rc2', city: 'Tashkent' };
  const merged = mergeApartmentAi(listing, result({ residenceComplex: 'ЖК Nest One' }), 'UZ');
  assert.equal(merged.residenceComplex, 'Nest One');
});

test('a parsed complex is never replaced by the model', () => {
  const listing = {
    source: 'olx',
    id: 'rc3',
    city: 'Tashkent',
    residenceComplex: 'Nest One',
  };
  const merged = mergeApartmentAi(listing, result({ residenceComplex: 'Boulevard' }), 'UZ');
  assert.equal(merged.residenceComplex, 'Nest One');
  assert.deepEqual(merged.ai.derivedFields, []);
});

test('a numbered address is kept and marked building-precise', () => {
  const listing = { source: 'olx', id: 'a1', city: 'Tashkent' };

  const merged = mergeApartmentAi(
    listing,
    result({ address: "Amir Temur ko'chasi 15" }),
    'UZ',
  );
  assert.equal(merged.address, "Amir Temur ko'chasi 15");
  assert.equal(merged.addressPrecision, 'building');
  assert.equal(merged.addressApproximate, false);
  assert.ok(merged.ai.derivedFields.includes('address'));
});

test('a thoroughfare with no house number is kept, at street precision', () => {
  // Listings state a bare street constantly, in every language the sources
  // arrive in, and a street is only one kind of thoroughfare -- avenues,
  // boulevards, highways and squares name an address just as well. Refusing
  // them threw away most real addresses; the geocoder already models a
  // street as approximate, so these are kept and labelled rather than
  // dropped.
  const listing = { source: 'olx', id: 'a1b', city: 'Tashkent' };

  const addresses = [
    // Russian
    'улица Мукимий', 'ул. Навои', 'проспект Амира Темура',
    'бульвар Мустакиллик', 'шоссе Каттакурганское', 'переулок Тихий',
    'набережная Анхор', 'площадь Независимости',
    // Ukrainian
    'вулиця Хрещатик', 'вул. Соборна', 'проспект Перемоги',
    'бульвар Шевченка', 'провулок Ботанічний', 'площа Ринок',
    // Uzbek (Cyrillic)
    'Амир Темур кўчаси', 'Мустақиллик хиёбони', 'Катта Халқа йўли',
    // Uzbek (Latin)
    "Amir Temur ko'chasi", 'Mustaqillik xiyoboni', "Katta Halqa yo'li",
    'Bunyodkor prospekti', 'Navoi bulvari',
    // Kazakh
    'Абай көшесі', 'Достық даңғылы', 'Республика алаңы',
    // Kyrgyz
    'Чүй проспектиси', 'Ala-Too көчөсү',
    // English
    'Metrostroiteley street', 'Independence Avenue', 'Green Boulevard',
    'Airport Highway', 'Rose Lane', 'Harbour Quay', 'Market Square',
    // Romanian
    'Strada Mihai Eminescu', 'Bulevardul Unirii', 'Calea Victoriei',
    'Aleea Teilor', 'Piata Romana',
  ];

  for (const address of addresses) {
    const merged = mergeApartmentAi(listing, result({ address }), 'UZ');
    assert.equal(merged.address, address, address);
    assert.equal(merged.addressPrecision, 'street', address);
    assert.equal(merged.addressApproximate, true, address);
  }
});

test('a bare place name is still not an address', () => {
  const listing = { source: 'olx', id: 'a1c', city: 'Tashkent' };
  // Neither numbered nor worded like a street: a district, a landmark or a
  // metro station name must not become the street line.
  for (const address of ['Chilonzor', 'Novza', 'Mirzo Ulugbek']) {
    const merged = mergeApartmentAi(listing, result({ address }), 'UZ');
    assert.equal(merged.address, undefined, address);
  }
});

test('a proximity phrase is a landmark, not this flat\'s address', () => {
  const listing = { source: 'olx', id: 'a2', city: 'Tashkent' };

  for (const address of [
    'рядом с метро Новза, дом 12',
    '5 минут от ТРЦ Compass, 3',
    'near Chorsu bazaar 14',
    'напротив школы 21',
  ]) {
    const merged = mergeApartmentAi(listing, result({ address }), 'UZ');
    assert.equal(merged.address, undefined, address);
  }
});

test('geography we already hold is not echoed back as a street line', () => {
  const listing = {
    source: 'olx',
    id: 'a3',
    city: 'Tashkent',
    district: 'Chilonzor',
  };
  const merged = mergeApartmentAi(listing, result({ address: 'Chilonzor' }), 'UZ');
  assert.equal(merged.address, undefined);
});

test('address and complex are handed to the model as known facts', () => {
  const input = apartmentAiInput({
    source: 'olx',
    id: 'a4',
    city: 'Tashkent',
    address: "Navoi 12",
    residenceComplex: 'Nest One',
    description: 'text',
  });
  assert.equal(input.knownFacts.address, 'Navoi 12');
  assert.equal(input.knownFacts.residenceComplex, 'Nest One');
});

test('a labelled price, floor or phone line is not an address', () => {
  const listing = { source: 'olx', id: 'a1d', city: 'Tashkent' };
  for (const address of ['Цена 500', 'Цена 500.', 'Narxi 400 $', '2 этаж из 4', 'Этаж: 2', 'Tel: 90 968 13 98', '93 968 13 98', '500 у.е.', '1 100 000 soʻm', 'Площадь 34 м2']) {
    const merged = mergeApartmentAi(listing, result({ address }), 'UZ');
    assert.equal(merged.address, undefined, address);
  }
  // Real numbered and labelled-looking street addresses still pass.
  for (const address of ["Amir Temur ko'chasi 15", 'площадь Независимости', 'Чиланзар 8 квартал, дом 12']) {
    assert.equal(mergeApartmentAi(listing, result({ address }), 'UZ').address, address, address);
  }
});

test('amenity flags the parser missed are filled from the model, parser values win', () => {
  const listing = { source: 'olx', id: 'amen', city: 'Tashkent', dishwasher: false };

  const merged = mergeApartmentAi(listing, result({
    dishwasher: true,
    microwave: true,
    oven: true,
    tv: true,
    bidet: true,
    walkInCloset: true,
    bathtub: true,
    shower: null,
    terrace: true,
    privateYard: true,
    euroLayout: true,
  }), 'UZ');

  assert.equal(merged.dishwasher, false);
  for (const field of ['microwave', 'oven', 'tv', 'bidet', 'walkInCloset', 'bathtub', 'terrace', 'privateYard', 'euroLayout']) {
    assert.equal(merged[field], true, field);
  }
  assert.equal(merged.shower, undefined);
});

test('only completed and low-confidence markers suppress a re-ask', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const marked = (status, minutes) => ({ ai: { status, updatedAt: ago(minutes) } });

  assert.equal(aiRetryDue(marked('completed', 9999), now), false);
  assert.equal(aiRetryDue(marked('low_confidence', 9999), now), false);
  // A stranded pending job (lost with the old process) is retried, but not
  // while it may still be in flight.
  assert.equal(aiRetryDue(marked('pending', 5), now), false);
  assert.equal(aiRetryDue(marked('pending', 20), now), true);
  assert.equal(aiRetryDue(marked('failed', 10), now), false);
  assert.equal(aiRetryDue(marked('failed', 45), now), true);
  assert.equal(aiRetryDue(marked('unavailable', 45), now), true);
  assert.equal(aiRetryDue({ ai: { status: 'pending' } }, now), true);
  assert.equal(aiRetryDue({}, now), true);
});

test('the backfill query covers every field the model may fill', () => {
  for (const field of ['dishwasher', 'tv', 'euroLayout', 'balcony', 'rooms']) {
    assert.ok(AI_FILLABLE_LISTING_FIELDS.includes(field), field);
  }
});

// --- batched amenity pass ---------------------------------------------------
const LONG_TEXT = 'Сдаётся уютная двухкомнатная квартира в центре города, рядом метро и парк.';

test('short, finished or already-passed listings are not put in an amenity batch', () => {
  const base = { source: 'olx', id: 'a1', title: 'Квартира', description: LONG_TEXT };
  assert.equal(needsAmenityPass(base), true);
  assert.equal(needsAmenityPass({ ...base, description: 'мало' }), false);
  assert.equal(needsAmenityPass({ ...base, ai: { amenityPass: AMENITY_PASS_VERSION } }), false);
  assert.equal(needsAmenityPass({ ...base, source: 'mock-1' }), false);
  const known = Object.fromEntries(
    ['balcony', 'airConditioner', 'gas', 'parking', 'internet', 'dishwasher', 'terrace', 'privateYard',
      'tv', 'microwave', 'oven', 'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout']
      .map((field) => [field, false]),
  );
  assert.equal(needsAmenityPass({ ...base, ...known }), false);
});

test('a batch is numbered from 1 in listing order', () => {
  const text = buildAmenityBatchText([
    { title: 'A', description: 'first' },
    { title: 'B', description: 'second' },
  ]);
  assert.equal(text, '[#1]\nA\nfirst\n\n[#2]\nB\nsecond');
});

test('amenity merge fills only unknown flags and records them', () => {
  const listing = { source: 'olx', id: 'm1', dishwasher: false, ai: { status: 'completed', parserVersion: 'x' } };
  const merged = mergeAmenityItem(listing, {
    id: 1, dishwasher: true, tv: true, oven: false, shower: null, confidence: 0.9,
  });
  assert.equal(merged.dishwasher, false);
  assert.equal(merged.tv, true);
  assert.equal(merged.oven, false);
  assert.equal(merged.shower, undefined);
  assert.deepEqual(merged.ai.derivedFields, ['oven', 'tv']);
  assert.equal(merged.ai.amenityPass, AMENITY_PASS_VERSION);
  assert.equal(merged.ai.status, 'completed');
  assert.equal(merged.ai.parserVersion, 'x');
});

test('a low-confidence amenity answer fills nothing but ends the pass', () => {
  const merged = mergeAmenityItem({ source: 'olx', id: 'm2' }, { id: 1, tv: true, confidence: 0.2 });
  assert.equal(merged.tv, undefined);
  assert.equal(merged.ai.amenityPass, AMENITY_PASS_VERSION);
});

test('the full enrichment merge keeps the amenity pass marker', () => {
  const merged = mergeApartmentAi(
    { source: 'olx', id: 'm3', city: 'Tashkent', ai: { amenityPass: AMENITY_PASS_VERSION } },
    result({ rooms: 2 }),
    'UZ',
  );
  assert.equal(merged.ai.amenityPass, AMENITY_PASS_VERSION);
});
