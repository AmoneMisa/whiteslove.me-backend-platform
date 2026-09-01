import assert from 'node:assert/strict';
import test from 'node:test';
import { allResultsSearch, parseSearchUrl } from '../src/feeds.mjs';

test('parses apartment search URL and drops item-only share params', () => {
  const parsed = parseSearchUrl('https://whiteslove.me/flat-finder?countries=UZ&city=Tashkent&dealType=longRent&flat=42&flatSource=olx');
  assert.equal(parsed.kind, 'flats');
  assert.deepEqual(parsed.filters, { countries: 'UZ', city: 'Tashkent', dealType: 'longRent' });
});

test('parses localized jobs URL and preserves locale for reopening the search', () => {
  const parsed = parseSearchUrl('https://whiteslove.me/en/jobs?country=UZ&workMode=remote&employment=full-time&maxExp=3&_tgEdit=secret');
  assert.equal(parsed.kind, 'jobs');
  assert.equal(parsed.filters.country, 'UZ');
  assert.equal(parsed.filters.workMode, 'remote');
  assert.equal(parsed.filters.employment, 'full-time');
  assert.equal(parsed.filters.maxExp, '3');
  assert.equal(parsed.filters._tgEdit, undefined);
  assert.equal(new URL(parsed.searchUrl).pathname, '/en/jobs');
});

test('rejects foreign hosts', () => {
  assert.throws(() => parseSearchUrl('https://example.com/jobs?country=UZ'));
});

test('builds empty candidate search', () => {
  const parsed = allResultsSearch('candidates');
  assert.equal(new URL(parsed.searchUrl).pathname, '/hiring');
  assert.deepEqual(parsed.filters, {});
});
