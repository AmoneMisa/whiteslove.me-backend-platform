import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {countryByCode} from '@whiteslove/parsing-lexicon/countries';

// Per-country configuration.
//
// Each country aggregates independently crawled sources. Runtime ingestion is
// owned by the PostgreSQL worker queue; failed/empty sources stay explicit and
// production never substitutes generated demo listings.
//
// Sources:
//   olx      - OLX public listing pages through the dedicated sidecar
//   telegram - public Telegram channels via the separate MTProto worker
//
// KG has curated direct-owner web sources plus a strict owner-filtered Telegram
// feed. OLX is intentionally not enabled until a dedicated KG transport exists.

const SOURCE_COUNTRIES = {
  RO: {
    code: 'RO',
    callingCode: '+40',
    center: { lat: 44.4268, lng: 26.1025 }, // Bucharest
    sources: ['olx', 'telegram'],
    olxHost: 'https://www.olx.ro',
    realEstateRoot: 3,
    crawlCities: ['Bucharest', 'Cluj-Napoca', 'Timisoara', 'Iasi', 'Brasov', 'Constanta', 'Oradea'],
    telegramChannels: [
      'rent_bucharest', 'arenda_kvartir_bucharest', 'QwertyrRomania', 'arendavbuchareste',
      'apartaments_bucharest', 'rent_ro', 'armonie_agentie_imobiliare_ro',
    ],
  },
  UA: {
    code: 'UA',
    callingCode: '+380',
    center: { lat: 50.4501, lng: 30.5234 }, // Kyiv
    sources: ['olx', 'telegram'],
    olxHost: 'https://www.olx.ua',
    realEstateRoot: 1,
    crawlCities: [
      'Kyiv',
      'Kharkiv',
      'Odesa',
      'Dnipro',
      'Lviv',
      'Zaporizhzhia',
      'Vinnytsia',
      'Ivano-Frankivsk',
      'Chernivtsi',
      'Uzhhorod',
      'Mukachevo',
      'Lutsk',
      'Rivne',
      'Ternopil',
      'Khmelnytskyi',
      'Zhytomyr',
      'Cherkasy',
      'Poltava',
      'Chernihiv',
      'Sumy',
      'Mykolaiv',
      'Kherson',
      'Donetsk',
      'Luhansk',
      'Kropyvnytskyi',
    ],
    olxCities: [
      // Every oblast centre is deliberately listed: compose makes this whole
      // breadth set run every refresh, one recent page per deal segment.
      { city: 'Chernivtsi', slug: 'chernovtsy' },
      { city: 'Lutsk', slug: 'lutsk' },
      { city: 'Uzhhorod', slug: 'uzhgorod' },
      { city: 'Rivne', slug: 'rovno' },
      { city: 'Ternopil', slug: 'ternopol' },
      { city: 'Khmelnytskyi', slug: 'khmelnitskiy' },
      { city: 'Zhytomyr', slug: 'zhitomir' },
      { city: 'Cherkasy', slug: 'cherkassy' },
      { city: 'Poltava', slug: 'poltava' },
      { city: 'Chernihiv', slug: 'chernigov' },
      { city: 'Sumy', slug: 'sumy' },
      { city: 'Mykolaiv', slug: 'nikolaev' },
      { city: 'Kherson', slug: 'kherson' },
      { city: 'Donetsk', slug: 'donetsk' },
      { city: 'Luhansk', slug: 'lugansk' },
      { city: 'Kropyvnytskyi', slug: 'kropivnitskiy' },
      { city: 'Vinnytsia', slug: 'vinnitsa' },
      { city: 'Ivano-Frankivsk', slug: 'ivano-frankovsk' },
      { city: 'Zaporizhzhia', slug: 'zaporozhe' },
      { city: 'Lviv', slug: 'lvov' },
      { city: 'Kharkiv', slug: 'kharkov' },
      { city: 'Dnipro', slug: 'dnepr' },
      { city: 'Odesa', slug: 'odessa' },
      { city: 'Kyiv', slug: 'kiev' },

      // Useful non-oblast targets. Fontanka and Kryzhanivka have separate OLX
      // locality pages but belong to the Odesa search area for our users, so
      // their results are stored under Odesa while keeping their real GPS point.
      { city: 'Odesa', slug: 'fontanka' },
      { city: 'Odesa', slug: 'kryzhanovka' },
      { city: 'Mukachevo', slug: 'mukachevo' },
    ],
    telegramChannels: [
      // Kyiv
      { name: 'orenda_kyiv_city', city: 'Kyiv' },
      { name: 'orendaky', city: 'Kyiv' },
      { name: 'arenda_kvartiry_kiev', city: 'Kyiv' },
      { name: 'x_arenda_kyiv', city: 'Kyiv' },
      { name: 'orendakvartyr_kyiv', city: 'Kyiv' },
      // Davnich network
      { name: 'davnichK', city: 'Kyiv' },
      { name: 'davnich', city: 'Kharkiv' },

      // Продажа квартир, разные города
      { name: 'davnichprodaga', city: null, dealType: 'sale' },
      // Kharkiv
      { name: 'x_arenda_kharkov', city: 'Kharkiv' },
      { name: 'kharkov_apartment', city: 'Kharkiv' },

      // Odesa
      { name: 'x_orenda_odesa', city: 'Odesa' },
      { name: 'arenda_odessaa', city: 'Odesa' },
      { name: 'rentsodessa', city: 'Odesa' },
      { name: 'nedvizhimost_odessa', city: 'Odesa' },

      // Dnipro
      { name: 'x_orenda_dnipro', city: 'Dnipro' },
      { name: 'arenda_dnepr', city: 'Dnipro' },

      // Lviv
      { name: 'orendakvarturlviv', city: 'Lviv' },
      { name: 'orenda_Lviw', city: 'Lviv' },
      { name: 'rentalviv', city: 'Lviv' },
      { name: 'smartin_lviv', city: 'Lviv' },
      { name: 'davnichL', city: 'Lviv' },

      // Vinnytsia
      { name: 'vinnytsia_rent', city: 'Vinnytsia' },
      { name: 'vinnitsia_dom', city: 'Vinnytsia' },
      { name: 'okvinnytsya', city: 'Vinnytsia' },
      { name: 'rentin_vinnitsa', city: 'Vinnytsia' },

      // Ivano-Frankivsk
      { name: 'rent_frankivsk', city: 'Ivano-Frankivsk' },

      // Chernivtsi
      { name: 'direct_rent_cv', city: 'Chernivtsi' },
      { name: 'rentCV', city: 'Chernivtsi' },
      { name: 'RENTIN_CHERNIVTSI', city: 'Chernivtsi' },
      { name: 'neruhomistrus', city: 'Chernivtsi' },
      { name: 'orendari_chernivtsi', city: 'Chernivtsi' },

      // Zaporizhzhia
      { name: 'dreamservice_zp', city: 'Zaporizhzhia' },
      { name: 'RENTUA_ZAPORIZHZHIA', city: 'Zaporizhzhia' },

      // Poltava
      { name: 'okpoltava', city: 'Poltava' },
      { name: 'RENTIN_POLTAVA', city: 'Poltava' },

      // Cherkasy
      { name: 'arenda_che', city: 'Cherkasy' },
      { name: 'kvartiri_cherkasy', city: 'Cherkasy' },

      // Ternopil
      { name: 'orenda_ternopill', city: 'Ternopil' },
      { name: 'orenda_ternopil_ua', city: 'Ternopil' },

      // Lutsk
      { name: 'LUTSK_ORENDA', city: 'Lutsk' },

      // Khmelnytskyi
      { name: 'orenda_khmelnytsk', city: 'Khmelnytskyi' },
      { name: 'orendakm', city: 'Khmelnytskyi' },

      // Uzhhorod
      { name: 'smartin_uzhhorod', city: 'Uzhhorod' },
      { name: 'rentin_uzhhorod', city: 'Uzhhorod' },

      // Kropyvnytskyi
      { name: 'RENTIN_KROPYVNYTSKYI', city: 'Kropyvnytskyi' },

      // Mykolaiv
      { name: 'SMARTIN_MYKOLAYIV', city: 'Mykolaiv' },

      // Sumy
      { name: 'sumy_rent', city: 'Sumy' },
      { name: 'premiersumy', city: 'Sumy' },

      // Chernihiv
      { name: 'smartin_chernihiv', city: 'Chernihiv' },

      // Rivne
      { name: 'direct_rent_rivne', city: 'Rivne' },

      // Zhytomyr
      { name: 'RENTIN_ZHYTOMYR', city: 'Zhytomyr' },
    ],
  },
  KZ: {
    code: 'KZ',
    callingCode: '+7',
    center: { lat: 43.222, lng: 76.8512 }, // Almaty
    sources: ['olx', 'telegram'],
    olxHost: 'https://www.olx.kz',
    realEstateRoot: 1,
    crawlCities: ['Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Aktobe', 'Atyrau', 'Oral', 'Taraz'],
    telegramChannels: [
      'kvartiry2', 'arendakvartirastana2022', 'arendam0',
    ],
  },
  KG: {
    code: 'KG',
    callingCode: '+996',
    center: { lat: 42.8746, lng: 74.5698 }, // Bishkek
    currency: 'KGS',
    sources: ['telegram'],
    crawlCities: ['Bishkek', 'Osh'],
    telegramChannels: [],
  },
  UZ: {
    code: 'UZ',
    callingCode: '+998',
    center: { lat: 41.2995, lng: 69.2401 }, // Tashkent
    sources: ['olx', 'telegram'],
    olxHost: 'https://www.olx.uz',
    realEstateRoot: 1,
    crawlCities: ['Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Andijan', 'Fergana', 'Nukus'],
    telegramChannels: [
      'nedvizhimost_tashkent', 'arentash', 'kvartira_dom_arenda', 'arendatashkent_uz',
      'bez_makler_kvartira_arenda_ijara', 'TOSHKENT_IJARAGA_UYLAR_SERGELI',
      'kv_arenda_tashken_t', 'ArendaTashkentaa', 'arenduzb',
      'samkvartira', 'arenda_samarkand',
    ],
  },
};

export const COUNTRIES = Object.freeze(Object.fromEntries(
  Object.entries(SOURCE_COUNTRIES).map(([code, config]) => {
    const shared = countryByCode(code);
    return [
      code,
      Object.freeze({
        ...config,
        name: shared?.canonical ?? code,
        currency: shared?.currency ?? config.currency ?? null,
      }),
    ];
  }),
));

export function canonicalCityName(countryCode, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return canonicalCity(raw, countryCode) || raw;
}

export const COUNTRY_CODES = Object.keys(COUNTRIES);
