import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLocation } from '../src/geo/locations.js';

test('Chernivtsi named park does not become a current district', () => {
  const location = parseLocation(
    'Поруч є садочки та школи, супермаркети, парк Жовтневий, зручна транспортна розв’язка.',
    'UA',
    'Chernivtsi',
  );

  assert.equal(location.district, null);
  assert.ok(location.locationEntities.some((entity) =>
    entity?.type === 'historicalDistrict' &&
    entity?.name === 'Shevchenkivskyi' &&
    entity?.relatedTo === 'Парк Жовтневий'
  ));
});

test('district wording outside a named park is not rewritten as POI history', () => {
  const location = parseLocation(
    'Квартира у Жовтневому районі, поруч парк.',
    'UA',
    'Chernivtsi',
  );

  assert.equal(
    location.locationEntities.some((entity) => entity?.type === 'historicalDistrict'),
    false,
  );
});
