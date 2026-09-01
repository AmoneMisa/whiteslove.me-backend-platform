import assert from 'node:assert/strict';
import test from 'node:test';

import { generateMock } from '../src/mock.js';

function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;

  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test('generateMock never returns synthetic listings in production', () => {
  withNodeEnv('production', () => {
    assert.deepEqual(generateMock('RO', 2), []);
  });
});

test('generateMock remains available for tests and local development', () => {
  withNodeEnv('test', () => {
    const listings = generateMock('RO', 2);
    assert.equal(listings.length, 2);
    assert.ok(listings.every((listing) => listing.source === 'mock'));
  });
});
