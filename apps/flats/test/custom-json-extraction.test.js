import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { extractJsonLd, extractNextData } from '../src/scrapers/custom.js';

test('parklane.ua per-unit offers nested inside a single page-level RealEstateListing are each read as their own listing', () => {
  // parklane.ua marks up its whole search-results page as ONE
  // RealEstateListing whose mainEntity is an ItemList wrapping a single
  // Product, and that Product's offers is an AggregateOffer whose own
  // `offers` array holds the real per-unit Offer/Apartment nodes. Before
  // flattenLd followed mainEntity/offers.offers, this either found 0 listings
  // (itemListElement wasn't an array so it was never descended into) or 1
  // bogus listing (the page-level wrapper's own lowPrice summary).
  const ld = {
    '@context': 'http://schema.org',
    '@type': 'RealEstateListing',
    name: 'Довгострокова оренда квартир в Києві',
    url: 'https://parklane.ua/uk/realty_search/apartment/rent',
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: {
        '@type': 'Product',
        name: 'Довгострокова оренда квартир в Києві',
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '350',
          highPrice: '100000',
          priceCurrency: 'USD',
          offerCount: 2,
          offers: [
            {
              '@type': ['Offer', 'Apartment'],
              url: 'https://parklane.ua/uk/object/101387058',
              description: '3-кімнатна квартира, 90 м²',
              price: '2500',
              priceCurrency: 'USD',
            },
            {
              '@type': ['Offer', 'Apartment'],
              url: 'https://parklane.ua/uk/object/285213297',
              description: '1-кімнатна квартира, 40 м²',
              price: '800',
              priceCurrency: 'USD',
            },
          ],
        },
      },
    },
  };
  const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;

  const listings = extractJsonLd(html, COUNTRIES.UA, 'https://parklane.ua/uk/realty_search/apartment/rent', null);
  assert.equal(listings.length, 2);
  assert.equal(listings[0].price, 2500);
  assert.equal(listings[0].url, 'https://parklane.ua/uk/object/101387058');
  assert.equal(listings[1].price, 800);
  assert.equal(listings[1].url, 'https://parklane.ua/uk/object/285213297');
});

test('atlanta.ua listings are read from the Next.js __NEXT_DATA__ payload, not JSON-LD or SSR cards', () => {
  // atlanta.ua's catalogue never renders a listing card server-side and
  // carries no schema.org JSON-LD for individual units — the whole result
  // page (getServerSideProps) ships as a single <script id="__NEXT_DATA__">
  // JSON blob under props.pageProps.realtyList.data.
  const nextData = {
    props: {
      pageProps: {
        realtyList: {
          data: [
            {
              id: 498090,
              url: '/odessa/object/3komnatnye/498090',
              title: '3-к квартира на вулиці Генуезька в Аркадії',
              price: { sellPrice: '0', rentPrice: '600' },
              preview: {
                square_total: { value: '75 м²' },
                floors: { value: '19/24' },
                rooms_count: { value: '3-к квартира' },
                address: { value: 'вул. Генуезька, Приморський, Одеса' },
              },
              shortDescription: 'Оренда з вересня, панорамний вид',
              galleryDataAll: ['https://cdn2.atlanta.ua/site/images/objects/1.jpg'],
              coords: { coord_x: '46.486390', coord_y: '30.728002' },
            },
            {
              id: 357870,
              url: '/odessa/object/3komnatnye/357870',
              title: '3-к квартира на Таирова',
              price: { sellPrice: '0', rentPrice: '445' },
              preview: {
                square_total: { value: '79 м²' },
                floors: { value: '1/9' },
                rooms_count: { value: '3-к квартира' },
                address: { value: 'вул. Шелухіна Сергія, Київський, Одеса' },
              },
              shortDescription: 'Три окремі кімнати',
              galleryDataAll: [],
              coords: { coord_x: '46.412342', coord_y: '30.733753' },
            },
          ],
          total: 264,
        },
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

  const listings = extractNextData(html, COUNTRIES.UA, 'https://www.atlanta.ua/uk/odessa/filters/arenda/kvartiry', null);
  assert.equal(listings.length, 2);
  assert.equal(listings[0].price, 600);
  assert.equal(listings[0].currency, 'USD');
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 75);
  assert.equal(listings[0].url, 'https://www.atlanta.ua/odessa/object/3komnatnye/498090');
  assert.equal(listings[1].price, 445);
});

test('atlanta.ua skips items with no rent price instead of surfacing sale-only noise', () => {
  const nextData = {
    props: {
      pageProps: {
        realtyList: {
          data: [
            {
              id: 1,
              url: '/odessa/object/sale/1',
              title: 'For sale, not rent',
              price: { sellPrice: '85000', rentPrice: '0' },
              preview: {},
            },
          ],
        },
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

  const listings = extractNextData(html, COUNTRIES.UA, 'https://www.atlanta.ua/uk/odessa/filters/arenda/kvartiry', null);
  assert.equal(listings.length, 0);
});

test('extractNextData is a no-op for hosts it does not know about', () => {
  const html = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"realtyList":{"data":[{"id":1}]}}}}</script>';
  assert.deepEqual(
    extractNextData(html, COUNTRIES.UA, 'https://example.com/listings', null),
    [],
  );
});
