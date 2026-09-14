import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { externalHousingSources } from '../src/sources/external-housing-sources.js';
import { buildCrawlPlan } from '../src/scheduling/queuePlan.js';
import { extractKnownOwnerHtml } from '../src/scrapers/owner-html.js';

test('external housing registry keeps mixed and owner-filtered catalogues side by side', () => {
  const uz = externalHousingSources('UZ');
  assert.equal(uz.find((source) => source.key === 'uybor-uzbekistan-rent')?.ownerOnly, undefined);
  assert.equal(uz.find((source) => source.key === 'm2bomber-uzbekistan-rent')?.ownerOnly, undefined);

  const ua = externalHousingSources('UA');
  assert.equal(ua.find((source) => source.key === 'lun-kyiv-rent')?.ownerOnly, undefined);
  assert.equal(ua.find((source) => source.key === 'rieltor-kyiv-rent')?.ownerOnly, undefined);
  assert.equal(ua.find((source) => source.key === 'rieltor-kyiv-owner-rent')?.ownerOnly, true);
  assert.equal(ua.find((source) => source.key === 'm2bomber-ukraine-rent')?.ownerOnly, undefined);

  const kz = externalHousingSources('KZ');
  assert.equal(kz.find((source) => source.key === 'm2bomber-kazakhstan-rent')?.ownerOnly, undefined);

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
  assert.equal(ro.find((source) => source.key === 'm2bomber-romania-rent')?.ownerOnly, undefined);
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
  // uybor.uz's real cards have no stable CSS class (build-hashed CSS-in-JS
  // utility classes), only a stable /listings/<id> href — see HREF_CARD_HOSTS
  // in owner-html.js. Use that same href shape here so this fixture exercises
  // the actual extraction path instead of the generic <article> fallback.
  const html = [
    '<article>',
    '<a href="/listings/1"><h3>2-комнатная квартира</h3></a>',
    '<p>Аренда 2 комнаты 65 м² 700 USD/мес. Риелтор</p>',
    '</article>',
    '<article>',
    '<a href="/listings/2"><h3>2-комнатная квартира</h3></a>',
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

test('m2bomber div-based cards are split without matching their nested thumb wrapper', () => {
  const html = [
    '<div class="item-card-long">',
    '<div class="item-card-long-thumb"><a href="/obj/1/view/flat-rent/garsoniera">',
    '<img src="/img/1.jpg"></a></div>',
    '<h3>Garsoniera Navodari Tabara</h3>',
    '<p>Navodari, Constanta. Garsoniera, 1-cam, 38 m². 350 € lunar. de la agenție</p>',
    '</div>',
    '<div class="item-card-long">',
    '<div class="item-card-long-thumb"><a href="/obj/2/view/flat-rent/apartament">',
    '<img src="/img/2.jpg"></a></div>',
    '<h3>Apartament 2 camere Centru</h3>',
    '<p>Bucuresti, Sectorul 1. Apartament, 2-cam, 55 m². 500 € lunar. de la proprietar</p>',
    '</div>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.RO, 'https://ro.m2bomber.com/flat-rent');
  assert.equal(listings.length, 2);
  assert.equal(listings[0].url, 'https://ro.m2bomber.com/obj/1/view/flat-rent/garsoniera');
  assert.equal(listings[0].byAgency, true);
  assert.equal(listings[1].url, 'https://ro.m2bomber.com/obj/2/view/flat-rent/apartament');
  assert.equal(listings[1].byAgency, false);
});

test('m2bomber div-based cards work the same across every locale it runs, not just Romanian', () => {
  const html = [
    '<div class="item-card-long">',
    '<div class="item-card-long-thumb"><a href="/obj/1/view/flat-rent/kvartira">',
    '<img src="/img/1.jpg"></a></div>',
    '<a class="item-card-long-title">Сдам 2-х комн квартиру</a>',
    '<p>Алматы. 2 комнаты, 50 м². 180 000 тенге в месяц. От собственника</p>',
    '</div>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.KZ, 'https://kz.m2bomber.com/flat-rent');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Сдам 2-х комн квартиру');
  assert.equal(listings[0].url, 'https://kz.m2bomber.com/obj/1/view/flat-rent/kvartira');
});

test('x-estate.com cards are matched by their stable /offers/<id> href, not their build-hashed classes', () => {
  // x-estate.com's React catalogue (rendered by the housing-browser-fetcher
  // sidecar) uses styled-components classes like
  // "OfferItem__OfferItemContainerLink-sc-1h65yyr-1 fliOdX" that regenerate
  // every deploy — see HREF_CARD_HOSTS in owner-html.js.
  const html = [
    '<a role="listitem" class="OfferItem__OfferItemContainerLink-sc-1h65yyr-1 fliOdX" href="/offers/6a9bee14781fbf6bc30d5b5c">',
    '<div>33 562 грн</div><div>Оренда</div>',
    '<div>ЖК Панорама на Печерську, вул. Євгена Коновальця, 44-А</div>',
    '<div>Печерськ, Київ</div><div>3</div><div>85 м²</div>',
    '</a>',
    '<a role="listitem" class="OfferItem__OfferItemContainerLink-sc-1h65yyr-1 fliOdX" href="/offers/357870">',
    '<div>22 999 грн</div><div>Оренда</div>',
    '<div>вул. Старонаводницька, 8-Б</div>',
    '<div>Печерськ, Київ</div><div>1</div><div>50 м²</div>',
    '</a>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.UA, 'https://www.x-estate.com/offers?type=rent');
  assert.equal(listings.length, 2);
  assert.equal(listings[0].url, 'https://www.x-estate.com/offers/6a9bee14781fbf6bc30d5b5c');
  assert.equal(listings[1].url, 'https://www.x-estate.com/offers/357870');
});

test('blagovist.ua div cards strip the currency-toggle and object-code noise out of the price', () => {
  // blagovist.ua re-quotes every price in USD/EUR right next to the real UAH
  // amount ("1 200 $ (1$=44.81 грн.)") and prints an internal reference code
  // ("Код об'єкта: G-305826") after the description. Both are bare numbers
  // that can outrank the real price in the shared lexicon's fallback amount
  // picker once the regulatory "*" after the price breaks its normal
  // explicit-currency match — see CURRENCY_TOGGLE_RE / LISTING_CODE_RE.
  const html = [
    '<div class="search-item col-md-12 companyMarker1" data-object-code="G-305826">',
    '<a href="https://blagovist.ua/object/100969122">1 ком. квартира 64 м², ул. Банковая, 3, Киев</a>',
    '<div class="price col-md-12">',
    '<p class="h4">53 800* грн.</p>',
    '<div class="m-dollar"><span>1 200 $ (1$=44.81 грн.) </span></div>',
    '<div class="m-euro"><span>1 030 € (1€=52.07 грн.) </span></div>',
    '</div>',
    '<div class="col-md-12 info-text">',
    '<div class="col-md-9">Аренда квартиры в тихом центре</div>',
    '<div class="col-md-3">Код объекта: G-305826<a href="https://blagovist.ua/object/100969122">Подробнее</a></div>',
    '</div>',
    '</div>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.UA, 'https://blagovist.ua/search/apartment/rent/cur_3');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 53800);
  assert.equal(listings[0].currency, 'UAH');
  assert.equal(listings[0].areaSqm, 64);
});

test('rieltor.ua catalog-card divs are split so more than one card per page is read', () => {
  // rieltor.ua's real card is a bare <div class="catalog-card ...">, so
  // before the DIV_CARD_HOSTS entry existed the generic <article>/<li> scan
  // found nothing and the page fell through to the text-window fallback,
  // which only ever surfaced a single card.
  const html = [
    '<div class="catalog-card " data-catalog-item-id="1">',
    '<a href="https://rieltor.ua/flats-rent/view/1/" class="catalog-card-media"></a>',
    '<div class="catalog-card-content">Аренда 2 кімнати 50 м² 700 $/міс Київ, Печерський р-н Рієлтор</div>',
    '</div>',
    '<div class="catalog-card " data-catalog-item-id="2">',
    '<a href="https://rieltor.ua/flats-rent/view/2/" class="catalog-card-media"></a>',
    '<div class="catalog-card-content">Аренда 1 кімната 35 м² 500 $/міс Київ, Оболонський р-н Власник</div>',
    '</div>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.UA, 'https://rieltor.ua/flats-rent/');
  assert.equal(listings.length, 2);
  assert.equal(listings[0].url, 'https://rieltor.ua/flats-rent/view/1/');
  assert.equal(listings[1].url, 'https://rieltor.ua/flats-rent/view/2/');
});

test('owner route on a mixed host is enforced by the queue policy, not host assumptions', () => {
  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  const ownerTask = tasks.find((task) => task.segment === 'lalafo-kyrgyzstan-owner-long-rent');
  const mixedTask = tasks.find((task) => task.segment === 'lalafo-kyrgyzstan-rent');
  assert.equal(ownerTask?.ownerOnly, true);
  assert.equal(mixedTask?.ownerOnly, false);
});
