import test from 'node:test';
import assert from 'node:assert/strict';

import {
  customSourceUrlsForDomains,
  isKnownCustomSiteDomain,
  listCustomSiteDomains,
} from '../src/sources/custom-site-domains.js';

test('collapses per-catalogue keys down to one entry per domain', () => {
  const domains = listCustomSiteDomains();
  const knKz = domains.find((site) => site.domain === 'kn.kz');
  assert.ok(knKz, 'kn.kz should appear exactly once despite multiple catalogue keys');
  assert.deepEqual(
    [...new Set(domains.map((site) => site.domain))].length,
    domains.length,
    'domains must be unique',
  );
});

test('reports which countries a domain is covered in', () => {
  const domains = listCustomSiteDomains();
  const krisha = domains.find((site) => site.domain === 'krisha.kz');
  assert.deepEqual(krisha.countries, ['KZ']);
});

test('isKnownCustomSiteDomain rejects domains outside the registries', () => {
  assert.equal(isKnownCustomSiteDomain('krisha.kz'), true);
  assert.equal(isKnownCustomSiteDomain('olx.pl'), false);
  assert.equal(isKnownCustomSiteDomain(''), false);
});

test('customSourceUrlsForDomains resolves every catalogue URL under a domain', () => {
  const urls = customSourceUrlsForDomains(['kn.kz']);
  assert.ok(urls.length >= 8, 'kn.kz has one catalogue per city/dealType');
  assert.ok(urls.every((url) => new URL(url).hostname.replace(/^www\./, '') === 'kn.kz'));
});

test('customSourceUrlsForDomains ignores unknown domains', () => {
  assert.deepEqual(customSourceUrlsForDomains(['not-a-real-site.example']), []);
});
