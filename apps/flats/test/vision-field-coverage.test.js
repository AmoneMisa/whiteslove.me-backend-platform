import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeVision } from '../src/listing/vision-enrichment.js';

function item(value, confidence = 0.95) {
  return { value, confidence, evidence: ['photo_1'] };
}

test('vision fills supported image-observable listing fields without overwriting source truth', () => {
  const listing = {
    source: 'telegram',
    id: 'vision-coverage',
    balcony: false,
    rooms: null,
    terrace: null,
    privateYard: null,
    dishwasher: null,
    tv: null,
    microwave: null,
    oven: null,
    bidet: null,
    walkInCloset: null,
    bathtub: null,
    shower: null,
    gas: null,
    heating: null,
    hotWater: null,
    internet: null,
    euroLayout: null,
    newBuilding: null,
    condition: null,
    amenities: [],
  };

  const merged = mergeVision(listing, {
    provider: 'freellmapi',
    data: {
      roomsVisible: item(3),
      balcony: item(true),
      terrace: item(true),
      privateYard: item(true),
      dishwasherVisible: item(true),
      tvVisible: item(true),
      microwaveVisible: item(true),
      ovenVisible: item(true),
      bidetVisible: item(true),
      walkInClosetVisible: item(true),
      bathtubVisible: item(true),
      showerVisible: item(true),
      gasVisible: item(true),
      heatingVisible: item(true),
      hotWaterVisible: item(true),
      internetEquipmentVisible: item(true, 0.92),
      euroLayoutVisible: item(true, 0.9),
      newBuildingVisible: item(true, 0.95),
      renovationLevel: item('modern'),
      kitchenVisible: item(true),
      washingMachineVisible: item(true),
    },
  });

  assert.equal(merged.rooms, 3);
  assert.equal(merged.balcony, false, 'trusted existing source value must win');
  assert.equal(merged.terrace, true);
  assert.equal(merged.privateYard, true);
  assert.equal(merged.dishwasher, true);
  assert.equal(merged.tv, true);
  assert.equal(merged.microwave, true);
  assert.equal(merged.oven, true);
  assert.equal(merged.bidet, true);
  assert.equal(merged.walkInCloset, true);
  assert.equal(merged.bathtub, true);
  assert.equal(merged.shower, true);
  assert.equal(merged.gas, true);
  assert.equal(merged.heating, true);
  assert.equal(merged.hotWater, true);
  assert.equal(merged.internet, true);
  assert.equal(merged.euroLayout, true);
  assert.equal(merged.newBuilding, true);
  assert.equal(merged.condition, 'modern');
  assert.ok(merged.amenities.includes('kitchen'));
  assert.ok(merged.amenities.includes('washing_machine'));
  assert.ok(merged.amenities.includes('dishwasher'));
  assert.ok(merged.vision.derivedFields.includes('rooms'));
  assert.ok(!merged.vision.derivedFields.includes('balcony'));
});

test('vision uses stricter confidence for internet/new-building/layout fields', () => {
  const merged = mergeVision({
    source: 'olx',
    id: 'thresholds',
    internet: null,
    euroLayout: null,
    newBuilding: null,
    amenities: [],
  }, {
    data: {
      internetEquipmentVisible: item(true, 0.85),
      euroLayoutVisible: item(true, 0.8),
      newBuildingVisible: item(true, 0.85),
    },
  });

  assert.equal(merged.internet, null);
  assert.equal(merged.euroLayout, null);
  assert.equal(merged.newBuilding, null);
});

test('visible water/gas equipment can prove corresponding utility capability', () => {
  const merged = mergeVision({
    source: 'telegram',
    id: 'utilities',
    gas: null,
    hotWater: null,
    amenities: [],
  }, {
    data: {
      gasWaterHeaterVisible: item(true),
      waterBoilerVisible: item(true),
    },
  });

  assert.equal(merged.gas, true);
  assert.equal(merged.hotWater, true);
  assert.ok(merged.amenities.includes('gas_water_heater'));
  assert.ok(merged.amenities.includes('water_boiler'));
});
