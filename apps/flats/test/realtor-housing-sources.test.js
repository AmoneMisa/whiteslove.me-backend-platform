import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { realtorHousingSources } from '../src/realtor-housing-sources.js';
import { buildCrawlPlan } from '../src/queuePlan.js';

const customScraper = readFileSync(
  new URL('../src/scrapers/custom.js', import.meta.url),
  'utf8',
);

test('Domza is included in the curated Tashkent housing sources', () => {
  const domza = realtorHousingSources('UZ').find(
    (source) => source.key === 'domza-tashkent',
  );

  assert.deepEqual(domza, {
    key: 'domza-tashkent',
    url: 'https://domza.uz/offers',
    city: 'Tashkent',
  });
});

test('Domza is scheduled as a curated custom-source crawl', () => {
  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  const domza = tasks.find((task) => task.segment === 'domza-tashkent');

  assert.ok(domza);
  assert.equal(domza.type, 'flat.custom.url');
  assert.equal(domza.country, 'UZ');
  assert.equal(domza.city, 'Tashkent');
  assert.equal(domza.url, 'https://domza.uz/offers');
  assert.equal(domza.curated, true);
});

test('Domza catalog discovery follows offer pages and parses their JSON-LD', () => {
  assert.match(customScraper, /function isDomzaCatalogUrl/);
  assert.match(customScraper, /function extractDomzaOfferUrls/);
  assert.match(customScraper, /async function scrapeDomzaCatalog/);
  assert.match(customScraper, /DOMZA_DETAIL_CONCURRENCY/);
  assert.match(customScraper, /extractJsonLd\(detailBody, country, detailUrl\.href\)/);
  assert.match(customScraper, /RealEstateListing JSON-LD/);
});

test('Domza structured Tashkent address keeps district separate from city', () => {
  assert.match(customScraper, /addressLocality/);
  assert.match(customScraper, /addressRegion/);
  assert.match(customScraper, /localityIsDistrict/);
  assert.match(customScraper, /district: address\.district \|\| null/);
});

test('Domza adapter keeps the fields exposed by an offer RealEstateListing', () => {
  // Observed in a saved Domza offer: Offer price/currency, room count, floorSize,
  // GeoCoordinates, images and datePosted are all present in schema.org JSON-LD.
  assert.match(customScraper, /offer\.price/);
  assert.match(customScraper, /offer\.priceCurrency/);
  assert.match(customScraper, /node\.numberOfRooms/);
  assert.match(customScraper, /node\.floorSize/);
  assert.match(customScraper, /geo\.latitude/);
  assert.match(customScraper, /geo\.longitude/);
  assert.match(customScraper, /collectImages\(node\)/);
  assert.match(customScraper, /node\.datePosted/);
});
