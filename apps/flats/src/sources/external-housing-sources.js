// Additional live public housing catalogues. Mixed catalogues deliberately stay
// mixed so owner and realtor inventory coexist; ownerOnly is reserved for a
// dedicated source-side owner/direct filter that does not replace the general
// catalogue.

export const EXTERNAL_HOUSING_SOURCES = Object.freeze({
  UZ: Object.freeze([
    Object.freeze({
      key: 'uybor-uzbekistan-rent',
      url: 'https://uybor.uz/listings?category__eq=7&operationType__eq=rent',
      city: null,
      dealType: 'longRent',
    }),
    // m2bomber runs one nationwide catalogue per locale (no stable per-city
    // URL), mixing owners and agencies — stays unfiltered like uybor above.
    Object.freeze({
      key: 'm2bomber-uzbekistan-rent',
      url: 'https://uz.m2bomber.com/flat-rent',
      city: null,
      dealType: 'longRent',
    }),
  ]),
  UA: Object.freeze([
    Object.freeze({
      key: 'lun-kyiv-rent',
      url: 'https://lun.ua/rent/kyiv/flats',
      city: 'Kyiv',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'rieltor-kyiv-rent',
      url: 'https://rieltor.ua/flats-rent/',
      city: 'Kyiv',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'rieltor-kyiv-owner-rent',
      url: 'https://rieltor.ua/flats-rent/?f-owners=1',
      city: 'Kyiv',
      dealType: 'longRent',
      ownerOnly: true,
    }),
    Object.freeze({
      key: 'm2bomber-ukraine-rent',
      url: 'https://ua.m2bomber.com/flat-rent',
      city: null,
      dealType: 'longRent',
    }),
  ]),
  KZ: Object.freeze([
    Object.freeze({
      key: 'm2bomber-kazakhstan-rent',
      url: 'https://kz.m2bomber.com/flat-rent',
      city: null,
      dealType: 'longRent',
    }),
  ]),
  RO: Object.freeze([
    Object.freeze({
      key: 'imobiliare-bucharest-rent',
      url: 'https://www.imobiliare.ro/inchirieri-apartamente/bucuresti',
      city: 'Bucharest',
      dealType: 'longRent',
    }),
    // This page mixes direct owners with developers/agencies offering 0%
    // commission, so it must NOT be treated as owner-only.
    Object.freeze({
      key: 'imobiliare-bucharest-zero-commission-rent',
      url: 'https://www.imobiliare.ro/tip/inchirieri-apartamente-comision-0-bucuresti',
      city: 'Bucharest',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'lajumate-bucharest-rent',
      url: 'https://lajumate.ro/anunturi/imobiliare/apartamente-de-inchiriat/in/bucuresti-ilfov/bucuresti',
      city: 'Bucharest',
      dealType: 'longRent',
    }),
    // Anuntul exposes separate stable owner/particular catalogue URLs by room
    // count. The URL itself is the source-side owner contract; requiring every
    // card to repeat "proprietar" would incorrectly discard valid inventory.
    Object.freeze({
      key: 'anuntul-bucharest-owner-studio-rent',
      url: 'https://www.anuntul.ro/inchirieri-garsoniere-particular-bucuresti/',
      city: 'Bucharest',
      dealType: 'longRent',
      ownerOnly: true,
    }),
    Object.freeze({
      key: 'anuntul-bucharest-owner-2-room-rent',
      url: 'https://www.anuntul.ro/inchirieri-apartamente-2-camere-particular-bucuresti/',
      city: 'Bucharest',
      dealType: 'longRent',
      ownerOnly: true,
    }),
    Object.freeze({
      key: 'anuntul-bucharest-owner-3-room-rent',
      url: 'https://www.anuntul.ro/inchirieri-apartamente-3-camere-particular-bucuresti/',
      city: 'Bucharest',
      dealType: 'longRent',
      ownerOnly: true,
    }),
    Object.freeze({
      key: 'imobiliare-anunturi-bucharest-owner-rent',
      url: 'https://www.imobiliare-anunturi.ro/inchirieri-apartamente/bucuresti/proprietar',
      city: 'Bucharest',
      dealType: 'longRent',
      ownerOnly: true,
    }),
    // m2bomber aggregates listings nationwide (not filterable to one city via a
    // stable URL), mixing owners and agencies, so it stays unfiltered like
    // uybor/house.kg below.
    Object.freeze({
      key: 'm2bomber-romania-rent',
      url: 'https://ro.m2bomber.com/flat-rent',
      city: null,
      dealType: 'longRent',
    }),
  ]),
  KG: Object.freeze([
    Object.freeze({
      key: 'house-kyrgyzstan-rent',
      url: 'https://www.house.kg/snyat-kvartiru',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'lalafo-kyrgyzstan-rent',
      url: 'https://lalafo.kg/kyrgyzstan/kvartiry/arenda-kvartir',
      city: null,
      dealType: null,
    }),
    Object.freeze({
      key: 'lalafo-kyrgyzstan-owner-long-rent',
      url: 'https://lalafo.kg/kyrgyzstan/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir/owner',
      city: null,
      dealType: 'longRent',
      ownerOnly: true,
    }),
  ]),
});

export function externalHousingSources(countryCode) {
  return EXTERNAL_HOUSING_SOURCES[String(countryCode || '').toUpperCase()] || [];
}
