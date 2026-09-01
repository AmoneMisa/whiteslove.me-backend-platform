import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/countries.js';
import { externalHousingSources } from '../src/external-housing-sources.js';
import { buildCrawlPlan } from '../src/queuePlan.js';
import { extractKnownOwnerHtml } from '../src/scrapers/owner-html.js';

test('external housing registry keeps mixed and owner-filtered catalogues side by side', () => {
  const uz = externalHousingSources('UZ');
  assert.equal(uz.find((source) => source.key === 'uybor-uzbekistan-rent')?.ownerOnly, undefined);

  const ua = externalHousingSources('UA');
  assert.equal(ua.find((source) => source.key === 'lun-kyiv-rent')?.ownerOnly, undefined);
  assert.equal(ua.find((source) => source.key === 'rieltor-kyiv-rent')?.ownerOnly, undefined);
  assert.equal(ua.find((source) => source.key === 'rieltor-kyiv-owner-rent')?.ownerOnly, true);

  const kg = externalHousingSources('KG');
  assert.equal(kg.find((source) => source.key === 'house-kyrgyzstan-rent')?.ownerOnly, undefined);
  assert.equal(kg.find((source) => source.key === 'lalafo-kyrgyzstan-rent')?.ownerOnly, undefined);
  assert.equal(kg.find((source) => source.key === 'lalafo-kyrgyzstan-owner-long-rent')?.ownerOnly, true);

  const ro = externalHousingSources('RO');
  assert.equal(ro.find((source) => source.key === 'imobiliare-bucharest-rent')?.ownerOnly, undefined);
  assert.equal(ro.find((source) => source.key === 'imobiliare-bucharest-zero-commission-rent')?.ownerOnly, undefined);
  assert.equal(ro.find((source) => source.key === 'lajumate-bucharest-rent')?.ownerOnly, undefined);
  assert.equal(ro.find((source) => source.key === 'anuntul-bucharest-owner-2-room-rent')?.ownerOnly, true);
  assert.equal(ro.find((source) => source.key === 'imobiliare-anunturi-bucharest-owner-rent')?.ownerOnly, true);
});

test('crawl plan queues every external source with its seller policy intact', () => {
  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  const external = Object.keys(COUNTRIES).flatMap((country) =>
    externalHousingSources(country).map((source) => ({ country, source })),
  );

  for (const { country, source } of external) {
    const task = tasks.find((candidate) =>
      candidate.type === 'flat.custom.url'
      && candidate.country === country
      && candidate.segment === source.key,
    );
    assert.ok(task, source.key);
    assert.equal(task.url, source.url, source.key);
    assert.equal(task.ownerOnly, source.ownerOnly === true, source.key);
    assert.equal(task.dealType, source.dealType || null, source.key);
  }
});

test('known mixed SSR catalogues preserve explicit realtor signals', () => {
  const html = [
    '<article>',
    '<a href="/listing/1"><h3>2-комнатная квартира</h3></a>',
    '<p>Аренда 2 комнаты 65 м² 700 USD/мес. Риелтор</p>',
    '</article>',
    '<article>',
    '<a href="/listing/2"><h3>2-комнатная квартира</h3></a>',
    '<p>Аренда 2 комнаты 55 м² 600 USD/мес. Частник</p>',
    '</article>',
  ].join('');

  const listings = extractKnownOwnerHtml(
    html,
    COUNTRIES.UZ,
    'https://uybor.uz/listings?category__eq=7&operationType__eq=rent',
  );
  assert.equal(listings.length, 2);
  assert.equal(listings[0].byAgency, true);
  assert.equal(listings[1].byAgency, false);
});

test('mixed House.kg cards can retain agency inventory', () => {
  const html = [
    '<article>',
    '<a href="/details/123"><h3>2-комн. квартира, Бишкек</h3></a>',
    '<p>Аренда квартира 2 комнаты 70 м² 60 000 сом/мес. Агентство недвижимости</p>',
    '</article>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.KG, 'https://www.house.kg/snyat-kvartiru');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].byAgency, true);
});

test('owner route on a mixed host is enforced by the queue policy, not host assumptions', () => {
  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  const ownerTask = tasks.find((task) => task.segment === 'lalafo-kyrgyzstan-owner-long-rent');
  const mixedTask = tasks.find((task) => task.segment === 'lalafo-kyrgyzstan-rent');
  assert.equal(ownerTask?.ownerOnly, true);
  assert.equal(mixedTask?.ownerOnly, false);
});
