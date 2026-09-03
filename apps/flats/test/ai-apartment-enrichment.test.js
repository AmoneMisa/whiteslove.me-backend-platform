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
