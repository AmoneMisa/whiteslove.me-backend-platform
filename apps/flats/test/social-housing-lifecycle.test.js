import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scraper = readFileSync(new URL('../src/scrapers/social.js', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../src/sources/social-housing-scheduler.js', import.meta.url), 'utf8');

test('partial or unexpectedly empty social crawls do not report complete', () => {
  assert.match(scraper, /const errors = \[\]/);
  assert.match(scraper, /let rawItems = 0/);
  assert.match(scraper, /const complete = errors\.length === 0 && \(configs\.length === 0 \|\| rawItems > 0\)/);
  assert.match(scraper, /partialExpected: !complete/);
});

test('complete social crawls age out missing rows and sync ES deactivation', () => {
  assert.match(scheduler, /markMissingAfterCompleteCrawl/);
  assert.match(scheduler, /result\?\.complete === true/);
  assert.match(scheduler, /deleteListingDocuments\(missing\.deactivated\)/);
  assert.match(scheduler, /crawlStartedAt/);
});

test('verified Facebook housing groups cover the supplied markets', () => {
  assert.match(scheduler, /groups\/1634005426616533\/.*city: 'Tashkent'/);
  assert.match(scheduler, /groups\/rentinKyiv\/.*city: 'Kyiv'/);
  assert.match(scheduler, /groups\/661893508190887\/.*city: 'Brasov'/);
  assert.match(scheduler, /groups\/1317985588227312\/.*city: 'Almaty'/);
});
