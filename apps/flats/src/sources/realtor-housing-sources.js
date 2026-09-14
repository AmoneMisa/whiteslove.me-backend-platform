// Public agency/realtor catalogues. Direct-owner platforms live in
// owner-housing-sources.js so their no-agent semantics can be enforced without
// applying them to these mixed/agency catalogues.

export const REALTOR_HOUSING_SOURCES = Object.freeze({
  UZ: Object.freeze([
    Object.freeze({
      key: 'hata-tashkent-rent',
      // hata.uz's TLS certificate has no SAN for the www subdomain, so
      // https://www.hata.uz/... fails hostname verification outright.
      url: 'https://hata.uz/listings/rent/tashkent',
      city: 'Tashkent',
    }),
    Object.freeze({
      key: 'realting-tashkent-rent',
      url: 'https://realting.uz/tashkent/property-to-rent/apartments',
      city: 'Tashkent',
    }),
    Object.freeze({
      key: 'domza-tashkent',
      url: 'https://domza.uz/offers',
      city: 'Tashkent',
    }),
  ]),
  UA: Object.freeze([
    Object.freeze({
      key: 'x-estate-ukraine-rent',
      // /orenduvaty-kvartyru is a marketing landing page with no listing
      // cards at all (confirmed via its own sitemap.xml, which lists no
      // catalogue path). /offers is the real client-rendered catalogue —
      // robots.txt disallows it for organic crawlers but explicitly allows
      // AdsBot, which is how it was found.
      url: 'https://www.x-estate.com/offers?type=rent',
      city: null,
    }),
    Object.freeze({
      key: 'park-lane-kyiv-rent',
      url: 'https://parklane.ua/uk/realty_search/apartment/rent',
      city: 'Kyiv',
    }),
    Object.freeze({
      key: 'blagovist-kyiv-rent',
      // The bare /rent URL only renders the filter form plus a handful of
      // "promo" teaser objects — the real SSR result grid only appears once
      // a filter path segment is present. cur_3 (currency=UAH) is the
      // lightest filter that still returns every room count.
      url: 'https://blagovist.ua/search/apartment/rent/cur_3',
      city: 'Kyiv',
    }),
    Object.freeze({
      key: 'atlanta-odesa-rent',
      url: 'https://www.atlanta.ua/uk/odessa/filters/arenda/kvartiry',
      city: 'Odesa',
    }),
  ]),
});

export function realtorHousingSources(countryCode) {
  return REALTOR_HOUSING_SOURCES[String(countryCode || '').toUpperCase()] || [];
}
