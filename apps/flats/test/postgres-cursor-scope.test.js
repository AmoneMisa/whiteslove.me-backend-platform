import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachScopeToCursor,
  prepareCursorForScope,
  searchCursorScope,
} from '../src/postgres-cursor-scope.js';

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

test('cursor scope is stable for equivalent normalized filter sets', () => {
  const first = searchCursorScope({
    city: 'Tashkent',
    sources: ['telegram', 'olx'],
    priceMin: 500,
    limit: 20,
    offset: 40,
    cursor: 'ignored',
    includeStats: false,
  }, ['UZ', 'UA']);
  const second = searchCursorScope({
    includeStats: true,
    offset: 0,
    limit: 60,
    priceMin: 500,
    sources: ['olx', 'telegram'],
    city: 'Tashkent',
  }, ['UA', 'UZ', 'UZ']);

  assert.equal(first, second);
});

test('cursor scope changes with semantic filters or countries', () => {
  const base = searchCursorScope({city: 'Tashkent', sort: 'newest'}, ['UZ']);
  assert.notEqual(base, searchCursorScope({city: 'Samarkand', sort: 'newest'}, ['UZ']));
  assert.notEqual(base, searchCursorScope({city: 'Tashkent', sort: 'newest'}, ['UA']));
  assert.notEqual(base, searchCursorScope({city: 'Tashkent', sort: 'oldest'}, ['UZ']));
});

test('legacy cursor keeps position but loses unscoped carried count', () => {
  const legacy = encodeCursor({
    v: 1,
    sort: 'newest',
    t: '2026-08-30T12:00:00.000Z',
    id: '123',
    c: 999,
  });
  const prepared = prepareCursorForScope(legacy, 'scope-a');
  const parsed = decodeCursor(prepared);

  assert.equal(parsed.id, '123');
  assert.equal(parsed.sort, 'newest');
  assert.equal(parsed.t, '2026-08-30T12:00:00.000Z');
  assert.equal('c' in parsed, false);
  assert.equal('s' in parsed, false);
});

test('scoped cursor is accepted only for its exact query scope', () => {
  const coreCursor = encodeCursor({v: 1, sort: 'newest', t: null, id: '123', c: 7});
  const scoped = attachScopeToCursor(coreCursor, 'scope-a');

  assert.equal(prepareCursorForScope(scoped, 'scope-a'), scoped);
  assert.equal(prepareCursorForScope(scoped, 'scope-b'), '');
  assert.equal(decodeCursor(scoped).s, 'scope-a');
  assert.equal(decodeCursor(scoped).c, 7);
});

test('price cursor preserves its converted price position and scope', () => {
  const coreCursor = encodeCursor({
    v: 1,
    sort: 'priceAsc',
    p: 123.45,
    id: '123',
    c: 7,
  });
  const scoped = attachScopeToCursor(coreCursor, 'scope-a');
  const parsed = decodeCursor(prepareCursorForScope(scoped, 'scope-a'));

  assert.equal(parsed.sort, 'priceAsc');
  assert.equal(parsed.p, 123.45);
  assert.equal(parsed.id, '123');
  assert.equal(parsed.c, 7);
  assert.equal(parsed.s, 'scope-a');
  assert.equal(prepareCursorForScope(scoped, 'scope-b'), '');
});

test('invalid cursors are rejected instead of reaching SQL builders', () => {
  assert.equal(prepareCursorForScope('not-a-cursor', 'scope-a'), '');
  assert.equal(prepareCursorForScope('a'.repeat(1025), 'scope-a'), '');
  assert.equal(attachScopeToCursor(null, 'scope-a'), null);

  for (const cursor of [
    {v: 1, sort: 'newest', t: null, id: 'not-a-bigint', c: 3, s: 'scope-a'},
    {v: 1, sort: 'newest', t: null, id: '-1', c: 3, s: 'scope-a'},
    {v: 1, sort: 'newest', t: null, id: '9223372036854775808', c: 3, s: 'scope-a'},
    {v: 1, sort: 'newest', t: 'not-a-date', id: '123', c: 3, s: 'scope-a'},
    {v: 1, sort: 'priceAsc', p: 'not-a-price', id: '123', c: 3, s: 'scope-a'},
  ]) {
    assert.equal(prepareCursorForScope(encodeCursor(cursor), 'scope-a'), '');
  }
});

test('invalid carried count keeps a valid scoped position but forces recount', () => {
  const scoped = encodeCursor({
    v: 1,
    sort: 'newest',
    t: '2026-08-30T12:00:00Z',
    id: '123',
    c: 'not-a-count',
    s: 'scope-a',
  });
  const prepared = decodeCursor(prepareCursorForScope(scoped, 'scope-a'));

  assert.equal(prepared.id, '123');
  assert.equal(prepared.t, '2026-08-30T12:00:00.000Z');
  assert.equal(prepared.s, 'scope-a');
  assert.equal('c' in prepared, false);
});
