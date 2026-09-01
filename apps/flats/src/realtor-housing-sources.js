// Public agency/realtor catalogues. Direct-owner platforms live in
// owner-housing-sources.js so their no-agent semantics can be enforced without
// applying them to these mixed/agency catalogues.

export const REALTOR_HOUSING_SOURCES = Object.freeze({
  UZ: Object.freeze([
    Object.freeze({
      key: 'hata-tashkent-rent',
      url: 'https://www.hata.uz/listings/rent/tashkent',
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
      url: 'https://www.x-estate.com/orenduvaty-kvartyru',
      city: null,
    }),
    Object.freeze({
      key: 'park-lane-kyiv-rent',
      url: 'https://parklane.ua/uk/realty_search/apartment/rent',
      city: 'Kyiv',
    }),
    Object.freeze({
      key: 'blagovist-kyiv-rent',
      url: 'https://blagovist.ua/search/apartment/rent',
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
