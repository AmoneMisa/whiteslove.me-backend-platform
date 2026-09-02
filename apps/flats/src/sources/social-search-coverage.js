import { countryByCode } from '@whiteslove/parsing-lexicon/countries';
import { CITIES } from '@whiteslove/parsing-lexicon/geography';
import { PROPERTY_TYPES } from '@whiteslove/parsing-lexicon/housing';
import { HOUSING_DEAL_TYPES } from '@whiteslove/parsing-lexicon/housing-intent';

export const UKRAINE_OBLASTS = [
  { region: 'Vinnytsia Oblast', ua: 'Вінницька область' },
  { region: 'Volyn Oblast', ua: 'Волинська область' },
  { region: 'Dnipropetrovsk Oblast', ua: 'Дніпропетровська область' },
  { region: 'Donetsk Oblast', ua: 'Донецька область' },
  { region: 'Zhytomyr Oblast', ua: 'Житомирська область' },
  { region: 'Zakarpattia Oblast', ua: 'Закарпатська область' },
  { region: 'Zaporizhzhia Oblast', ua: 'Запорізька область' },
  { region: 'Ivano-Frankivsk Oblast', ua: 'Івано-Франківська область' },
  { region: 'Kyiv Oblast', ua: 'Київська область' },
  { region: 'Kirovohrad Oblast', ua: 'Кіровоградська область' },
  { region: 'Luhansk Oblast', ua: 'Луганська область' },
  { region: 'Lviv Oblast', ua: 'Львівська область' },
  { region: 'Mykolaiv Oblast', ua: 'Миколаївська область' },
  { region: 'Odesa Oblast', ua: 'Одеська область' },
  { region: 'Poltava Oblast', ua: 'Полтавська область' },
  { region: 'Rivne Oblast', ua: 'Рівненська область' },
  { region: 'Sumy Oblast', ua: 'Сумська область' },
  { region: 'Ternopil Oblast', ua: 'Тернопільська область' },
  { region: 'Kharkiv Oblast', ua: 'Харківська область' },
  { region: 'Kherson Oblast', ua: 'Херсонська область' },
  { region: 'Khmelnytskyi Oblast', ua: 'Хмельницька область' },
  { region: 'Cherkasy Oblast', ua: 'Черкаська область' },
  { region: 'Chernivtsi Oblast', ua: 'Чернівецька область' },
  { region: 'Chernihiv Oblast', ua: 'Чернігівська область' },
];

export const SOCIAL_HOUSING_COUNTRIES = Object.freeze({
  UZ: Object.freeze({
    languages: Object.freeze(['ru', 'uzLatn', 'uzCyrl']),
    crawlCities: Object.freeze([
      'Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Andijan', 'Fergana',
      'Qarshi', 'Nukus', 'Jizzakh', 'Urgench',
    ]),
    expandedCities: Object.freeze(['Tashkent']),
  }),
  KZ: Object.freeze({
    languages: Object.freeze(['ru', 'kk']),
    crawlCities: Object.freeze([
      'Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Aktobe', 'Atyrau',
      'Pavlodar', 'Kostanay', 'Aktau', 'Oskemen',
    ]),
    expandedCities: Object.freeze(['Almaty', 'Astana']),
  }),
  RO: Object.freeze({
    languages: Object.freeze(['ro']),
    crawlCities: Object.freeze([
      'Bucharest', 'Cluj-Napoca', 'Timisoara', 'Iasi', 'Brasov', 'Constanta',
      'Craiova', 'Sibiu', 'Oradea', 'Ploiesti',
    ]),
    expandedCities: Object.freeze(['Bucharest']),
  }),
});

const SEARCH_TOPIC_ENTITIES = Object.freeze([
  { entity: HOUSING_DEAL_TYPES.find((item) => item.canonical === 'longRent'), limit: 3 },
  { entity: HOUSING_DEAL_TYPES.find((item) => item.canonical === 'shortRent'), limit: 3 },
  { entity: PROPERTY_TYPES.find((item) => item.canonical === 'flat'), limit: 1 },
  { entity: PROPERTY_TYPES.find((item) => item.canonical === 'house'), limit: 1 },
].filter((item) => item.entity));

// Social search benefits from wording people actually put into posts. Keep the
// package aliases as fallback vocabulary, but lead with a bounded set of
// high-signal offer/short-stay phrases so generic aliases cannot crowd them out.
const CURATED_SEARCH_ALIASES = Object.freeze({
  longRent: Object.freeze({
    ru: Object.freeze(['аренда', 'сдам', 'сдаю']),
    uk: Object.freeze(['оренда', 'здам', 'здаю']),
    uzLatn: Object.freeze(['ijara', 'ijaraga beriladi', 'kvartira ijaraga']),
    uzCyrl: Object.freeze(['ижара', 'ижарага берилади', 'квартира ижарага']),
    kk: Object.freeze(['жалдау', 'жалға беріледі', 'пәтер жалға']),
    ro: Object.freeze(['închiriere', 'închiriez', 'apartament de închiriat']),
  }),
  shortRent: Object.freeze({
    ru: Object.freeze(['посуточно', 'на сутки', 'посуточная аренда']),
    uk: Object.freeze(['подобово', 'погодинно', 'подобова оренда']),
    uzLatn: Object.freeze(['kunlik ijara', 'sutkalik ijara', 'kunlik kvartira']),
    uzCyrl: Object.freeze(['кунлик ижара', 'суткалик ижара', 'кунлик квартира']),
    kk: Object.freeze(['тәуліктік жалға', 'тәулікке пәтер', 'тәуліктік пәтер']),
    ro: Object.freeze(['regim hotelier', 'pe noapte', 'închiriere pe termen scurt']),
  }),
});

function preferredAlias(entity, language) {
  return entity?.aliases?.[language]?.[0] || entity?.canonical || null;
}

function topicAliases(descriptor, language) {
  const { entity, limit } = descriptor;
  const packageAliases = Array.isArray(entity?.aliases?.[language])
    ? entity.aliases[language]
    : [];
  const curatedAliases = CURATED_SEARCH_ALIASES[entity?.canonical]?.[language] || [];
  const fallback = entity?.canonical ? [entity.canonical] : [];
  return [...new Set([...curatedAliases, ...packageAliases, ...fallback].filter(Boolean))].slice(0, limit);
}

function allTopics(language) {
  return SEARCH_TOPIC_ENTITIES.flatMap((descriptor) => topicAliases(descriptor, language));
}

function compactTopics(language) {
  return SEARCH_TOPIC_ENTITIES.flatMap((descriptor) => topicAliases(descriptor, language).slice(0, 1));
}

function cityByCanonical(country, canonical) {
  return CITIES.find((item) => item.country === country && item.canonical === canonical) || null;
}

function countryName(country, language) {
  return preferredAlias(countryByCode(country), language);
}

function add(targets, country, target, city = null, region = null) {
  targets.push({ country, target, ...(city ? { city } : {}), ...(region ? { region } : {}) });
}

export function buildThreadsHousingCoverage() {
  const targets = [];

  for (const [country, config] of Object.entries(SOCIAL_HOUSING_COUNTRIES)) {
    for (const language of config.languages) {
      const localCountry = countryName(country, language);
      if (!localCountry) continue;

      // Country-wide queries carry the full synonym set. For the highest-volume
      // cities we also use the full set; all other cities use one query per topic
      // to keep rotation bounded instead of multiplying every synonym by every city.
      for (const topic of allTopics(language)) add(targets, country, `${topic} ${localCountry}`);

      for (const city of config.crawlCities) {
        const localName = preferredAlias(cityByCanonical(country, city), language) || city;
        const expanded = config.expandedCities.includes(city);
        const topics = expanded ? allTopics(language) : compactTopics(language);
        for (const topic of topics) add(targets, country, `${topic} ${localName}`, city);
      }
    }
  }

  const uaCountry = countryName('UA', 'uk');
  for (const topic of allTopics('uk')) add(targets, 'UA', `${topic} ${uaCountry}`);
  for (const oblast of UKRAINE_OBLASTS) {
    // Oblast-wide searches must not be stamped with the regional centre as the
    // listing city; the post itself/normalizer can resolve a real city later.
    for (const topic of compactTopics('uk')) add(targets, 'UA', `${topic} ${oblast.ua}`, null, oblast.region);
  }

  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.country}|${target.city || ''}|${target.region || ''}|${target.target}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rotatingCoverage(targets, { maxPerCycle = 12, slotMinutes = 30 } = {}) {
  if (!Array.isArray(targets) || targets.length <= maxPerCycle) return targets || [];
  const slot = Math.floor(Date.now() / (Math.max(1, slotMinutes) * 60_000));
  const offset = (slot * maxPerCycle) % targets.length;
  return Array.from({ length: maxPerCycle }, (_, index) => targets[(offset + index) % targets.length]);
}
