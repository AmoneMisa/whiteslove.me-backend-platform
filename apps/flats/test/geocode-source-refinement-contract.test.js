import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/geocode-persistent.js', import.meta.url), 'utf8');

test('source coordinate refinement requires an exact address candidate', () => {
  assert.match(source, /listing\?\.street/);
  assert.match(source, /listing\?\.houseNumber/);
  assert.match(source, /item\.source === 'address'/);
});
