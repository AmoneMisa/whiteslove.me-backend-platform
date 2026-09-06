import test from 'node:test';
import assert from 'node:assert/strict';

import {cleanItemKey, cleanSavedStateId} from '../src/mobile/mobile-saved-state.js';

test('saved-state ids accept the existing random device/preset id format', () => {
  const id = '4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';
  assert.equal(cleanSavedStateId(id), id);
  assert.equal(cleanSavedStateId('preset:abc_123.def'), 'preset:abc_123.def');
});

test('saved-state ids reject path/control injection and tiny identifiers', () => {
  assert.equal(cleanSavedStateId('../../etc/passwd'), null);
  assert.equal(cleanSavedStateId('short'), null);
  assert.equal(cleanSavedStateId('abc\n123456'), null);
});

test('listing identity keys may contain source separators but not controls', () => {
  assert.equal(cleanItemKey('telegram:UZ:12345'), 'telegram:UZ:12345');
  assert.equal(cleanItemKey('olx|KZ|abc-123'), 'olx|KZ|abc-123');
  assert.equal(cleanItemKey('bad\nkey'), null);
  assert.equal(cleanItemKey(''), null);
});
