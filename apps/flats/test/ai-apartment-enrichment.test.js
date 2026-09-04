import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APARTMENT_PARSER_VERSION,
  apartmentAiInput,
  mergeApartmentAi,
  needsApartmentAi,
} from '../src/listing/ai-enrichment.js';

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
    'smokingAllowed', 'condition',
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

test('an address needs a house number to be worth keeping', () => {
  const listing = { source: 'olx', id: 'a1', city: 'Tashkent' };

  const withNumber = mergeApartmentAi(
    listing,
    result({ address: "Amir Temur ko'chasi 15" }),
    'UZ',
  );
  assert.equal(withNumber.address, "Amir Temur ko'chasi 15");
  assert.ok(withNumber.ai.derivedFields.includes('address'));

  // A street alone is what the geocoder already derives for itself; accepting
  // it here would only dress it up as a precise source address.
  const streetOnly = mergeApartmentAi(
    listing,
    result({ address: "Amir Temur ko'chasi" }),
    'UZ',
  );
  assert.equal(streetOnly.address, undefined);
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
