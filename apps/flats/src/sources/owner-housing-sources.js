// Curated public housing sources that explicitly advertise direct-owner inventory.
// These are kept separate from realtor/agency sources so the queue can enforce
// owner semantics (no commission, no agency flag) without weakening generic
// source classification. OLX owner search is intentionally not here: OLX uses
// its dedicated curl_cffi sidecar because ordinary server fetches are WAF-blocked.
// Each URL below was checked as a current public catalogue before being enabled.

export const OWNER_HOUSING_SOURCES = Object.freeze({
  UZ: Object.freeze([
    Object.freeze({
      key: 'rentli-tashkent-owner-rent',
      url: 'https://rentli.uz/en/listings',
      city: 'Tashkent',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'ostona-tashkent-owner-rent',
      url: 'https://ostona.app/en',
      city: 'Tashkent',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'turar-tashkent-owner-daily',
      url: 'https://turar.uz/ru/tashkent',
      city: 'Tashkent',
      dealType: 'shortRent',
    }),
  ]),
  UA: Object.freeze([
    Object.freeze({
      key: 'easyhouse-ukraine-owner-rent',
      url: 'https://easy-house.in.ua/search/',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kvarto-ukraine-owner-rent',
      url: 'https://kvarto.app/uk',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'norieltor-ukraine-owner-rent',
      url: 'https://www.norieltor.com.ua/',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'dimria-ukraine-owner-rent',
      url: 'https://dom.ria.com/uk/arenda-kvartir/bez-rieltora/',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'bezmakler-odesa-owner-rent',
      url: 'https://bezmakler.com.ua/',
      city: 'Odesa',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'dobalux-ukraine-owner-daily',
      url: 'https://dobalux.com/uk/',
      city: null,
      dealType: 'shortRent',
    }),
  ]),
  KZ: Object.freeze([
    Object.freeze({
      key: 'krisha-kazakhstan-owner-rent',
      url: 'https://krisha.kz/arenda/kvartiry/kazakhstan/?das%5Bwho%5D=1',
      city: null,
      dealType: 'longRent',
      ownerMarkers: Object.freeze(['хозяин недвижимости']),
    }),
    Object.freeze({
      key: 'krisha-kazakhstan-owner-daily',
      url: 'https://krisha.kz/arenda/kvartiry-posutochno/kazakhstan/?das%5Bwho%5D=1',
      city: null,
      dealType: 'shortRent',
      ownerMarkers: Object.freeze(['хозяин недвижимости']),
    }),
    Object.freeze({
      key: 'kn-almaty-owner-rent',
      url: 'https://www.kn.kz/almaty/arenda-kvartir-bez-posrednikov-s-foto',
      city: 'Almaty',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-almaty-owner-daily',
      url: 'https://www.kn.kz/almaty/arenda-kvartir-posutochno-bez-posrednikov',
      city: 'Almaty',
      dealType: 'shortRent',
    }),
    Object.freeze({
      key: 'kn-astana-owner-rent',
      url: 'https://www.kn.kz/astana/arenda-kvartir-bez-posrednikov',
      city: 'Astana',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-astana-owner-daily',
      url: 'https://www.kn.kz/astana/arenda-kvartir-posutochno-bez-posrednikov',
      city: 'Astana',
      dealType: 'shortRent',
    }),
    Object.freeze({
      key: 'kn-karaganda-owner-rent',
      url: 'https://www.kn.kz/karaganda/arenda-kvartir-bez-posrednikov',
      city: 'Karaganda',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-karaganda-owner-daily',
      url: 'https://www.kn.kz/karaganda/arenda-kvartir-posutochno-bez-posrednikov',
      city: 'Karaganda',
      dealType: 'shortRent',
    }),
    Object.freeze({
      key: 'kn-aktobe-owner-rent',
      url: 'https://www.kn.kz/aktobe/arenda-kvartir-bez-posrednikov',
      city: 'Aktobe',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-atyrau-owner-rent',
      url: 'https://www.kn.kz/atyrau/arenda-kvartir-bez-posrednikov',
      city: 'Atyrau',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-oral-owner-rent',
      url: 'https://www.kn.kz/uralsk/arenda-kvartir-bez-posrednikov',
      city: 'Oral',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'kn-taraz-owner-rent',
      url: 'https://www.kn.kz/taraz/arenda-kvartir-bez-posrednikov',
      city: 'Taraz',
      dealType: 'longRent',
    }),
  ]),
  RO: Object.freeze([
    Object.freeze({
      key: 'proprietari-pe-bune-bucharest-owner-rent',
      url: 'https://www.proprietaripebune.ro/chirii/bucuresti',
      city: 'Bucharest',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'proprietar-direct-romania-owner-rent',
      url: 'https://proprietar-direct.ro/categorii-anunturi/oferte-de-inchiriat/',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'direct-fara-comision-romania-owner-rent',
      url: 'https://www.directfaracomision.ro/anunturi?tip_proprietate=apartment&tip_tranzactie=inchiriere',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'garsoniera-romania-owner-rent',
      url: 'https://garsoniera.ro/anunturi/inchiriere',
      city: null,
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'publi24-romania-owner-rent',
      url: 'https://www.publi24.ro/anunturi/imobiliare/de-inchiriat/?commercial=false&q=proprietari',
      city: null,
      dealType: 'longRent',
      ownerMarkers: Object.freeze([
        'direct proprietar',
        'de la proprietar',
        'proprietar',
        'fără comision',
        'fara comision',
      ]),
    }),
  ]),
  KG: Object.freeze([
    Object.freeze({
      key: 'arendator-bishkek-owner-rent',
      url: 'https://arendator.kg/',
      city: 'Bishkek',
      dealType: 'longRent',
    }),
    Object.freeze({
      key: 'myhouse-kyrgyzstan-owner-rent',
      url: 'https://myhouse.kg/rent/apartment/',
      city: null,
      dealType: 'longRent',
      ownerMarkers: Object.freeze([
        'собственник',
        'частное лицо',
        'не являюсь риэлтором',
        'без посредников',
        'от собственника',
      ]),
    }),
    Object.freeze({
      key: 'sutochno-bishkek-owner-daily',
      url: 'https://sutochno.kg/bishkek/',
      city: 'Bishkek',
      dealType: 'shortRent',
    }),
    Object.freeze({
      key: 'sutochno-osh-owner-daily',
      url: 'https://sutochno.kg/osh/',
      city: 'Osh',
      dealType: 'shortRent',
    }),
  ]),
});

export function ownerHousingSources(countryCode) {
  return OWNER_HOUSING_SOURCES[String(countryCode || '').toUpperCase()] || [];
}
