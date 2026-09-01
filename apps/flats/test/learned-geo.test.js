import test from 'node:test';
import assert from 'node:assert/strict';

import { learnedGeoDescriptor } from '../src/learned-geo.js';
import { __learnedGeoExportTest } from '../src/learned-geo-export.js';

test('address descriptor requires structured street and house number', () => {
  const candidate = { source: 'address', q: 'Воробкевича 12, Chernivtsi, Ukraine', accuracyM: 40 };

  assert.equal(learnedGeoDescriptor({ country: 'UA', city: 'Chernivtsi', address: 'free form' }, { code: 'UA' }, candidate), null);

  const descriptor = learnedGeoDescriptor({
    country: 'UA',
    city: 'Chernivtsi',
    district: 'Any inferred district',
    street: 'Воробкевича',
    houseNumber: '12',
  }, { code: 'UA' }, candidate);

  assert.equal(descriptor.type, 'address');
  assert.equal(descriptor.canonicalName, 'Воробкевича 12');
  assert.equal(descriptor.lookupKey, 'v1|UA|address|chernivtsi|воробкевича|12|');
});

test('learned key stays stable when inferred district changes', () => {
  const candidate = { source: 'street', q: 'Shota Rustaveli, Tashkent, Uzbekistan', accuracyM: 180 };
  const a = learnedGeoDescriptor({ country: 'UZ', city: 'Tashkent', district: 'A', street: 'Shota Rustaveli' }, { code: 'UZ' }, candidate);
  const b = learnedGeoDescriptor({ country: 'UZ', city: 'Tashkent', district: 'B', street: 'Shota Rustaveli' }, { code: 'UZ' }, candidate);
  assert.equal(a.lookupKey, b.lookupKey);
});

test('daily exporter appends entities without rewriting existing lookup keys', () => {
  const current = `// Generated/append-only spatial anchors promoted from runtime geocoding.\nexport const LEARNED_ADDRESS_ENTITIES = Object.freeze([\n  {\n    "id": "learned:old",\n    "type": "address",\n    "country": "UA",\n    "canonicalName": "Old 1",\n    "lookupKey": "v1|UA|address|odesa|old|1|",\n    "center": { "lat": 46.4, "lng": 30.7 }\n  }\n]);\n`;

  const keys = __learnedGeoExportTest.existingLookupKeys(current);
  assert.equal(keys.has('v1|UA|address|odesa|old|1|'), true);

  const next = __learnedGeoExportTest.appendEntities(current, [{
    id: 'learned:new',
    type: 'address',
    country: 'UA',
    canonicalName: 'Воробкевича 12',
    lookupKey: 'v1|UA|address|chernivtsi|воробкевича|12|',
    center: { lat: 48.27, lng: 25.94 },
    accuracyM: 40,
    accuracy: 'building',
    source: 'osm',
  }]);

  assert.match(next, /learned:old/u);
  assert.match(next, /learned:new/u);
  assert.equal((next.match(/v1\|UA\|address\|odesa\|old\|1\|/gu) || []).length, 1);
});
