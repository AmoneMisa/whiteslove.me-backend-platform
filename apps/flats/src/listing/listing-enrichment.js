import { parseHousingListingEnrichment } from '@whiteslove/parsing-lexicon/housing-listing-enrichment';

function locationName(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = locationName(item);
      if (name) return name;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['name', 'canonicalName', 'label', 'station', 'value']) {
      const name = locationName(value[key]);
      if (name) return name;
    }
    return null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const decoded = JSON.parse(text);
      const name = locationName(decoded);
      if (name) return name;
    } catch (_) {}
  }
  return text;
}

function boundedCount(value, max = 20) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : null;
}

// Uzbek classifieds shorthand not covered by the shared lexicon: a double
// slash separates rooms/floor/totalFloors in one run, e.g. "22кв 3//4//4//".
// The lexicon's own floor-fraction parser only accepts a single "/".
function parseCompactLayout(text) {
  if (!text) return null;
  const match = String(text).match(/(?:^|[^\d])(\d{1,2})\s*[\/\\]{1,2}\s*(\d{1,2})\s*[\/\\]{1,2}\s*(\d{1,2})(?=\s*[\/\\]*[^\d]|$)/u);
  if (!match) return null;
  const rooms = boundedCount(match[1], 12);
  const floor = Number(match[2]);
  const totalFloors = Number(match[3]);
  if (rooms == null || !Number.isInteger(floor) || !Number.isInteger(totalFloors)) return null;
  if (floor < 0 || totalFloors < 1 || floor > totalFloors || totalFloors > 40) return null;
  return {rooms, floor, totalFloors};
}

// Bare "NNкв"/"NNkv" shorthand with no "м²"/"m2" unit suffix, common in
// compact Uzbek/Russian classifieds; the shared lexicon's area parser only
// recognizes the full area-unit forms.
function parseAreaShorthand(text) {
  if (!text) return null;
  const shorthand = String(text).match(/(?:^|[^\d])(\d{2,3})\s*(?:кв|kv)(?=$|[\s,.;:\/\\])/iu);
  const area = Number(shorthand?.[1]);
  return Number.isFinite(area) && area >= 15 && area <= 500 ? area : null;
}

// The shared lexicon detects commission as a boolean; it does not extract an
// explicit numeric percentage (e.g. "Комиссия 50%", "Риелтор 50/50").
function parseCommissionPercent(text) {
  if (!text) return null;
  const value = String(text);
  const broker = '(?:комисси[а-яёіїґ]*|комісі[а-яіїґ]*|commission|comision|komissiya|макл(?:ер[а-яё]*)?|makler|ри[еэ]лтор[а-яё]*|рієлтор[а-яіїґ]*|rieltor|realtor|broker|agent|агентств[а-яё]*|vositachi|делдал)';
  const patterns = [
    new RegExp(`${broker}[^\\d%\\r\\n]{0,24}(\\d{1,3})\\s*%`, 'iu'),
    new RegExp(`(\\d{1,3})\\s*%[^\\r\\n]{0,24}${broker}`, 'iu'),
    /(?:^|[^\p{L}\p{N}_])[mм]\s*[:=.-]?\s*(\d{1,3})\s*%/iu,
    new RegExp(`${broker}[^\\d\\r\\n]{0,24}(\\d{1,3})\\s*[/\\\\]\\s*(?:50|100)(?=$|[^\\d])`, 'iu'),
    new RegExp(`${broker}\\s*[:=\\-–—]?\\s*(\\d{1,3})(?=\\s*(?:$|[;,|\\r\\n]))`, 'iu'),
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const percent = Number(match[1]);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) return percent;
  }
  return null;
}

// Cadastral-document availability is a country-specific legal detail the
// shared housing lexicon does not model.
function parseCadastral(text) {
  if (!text || !/(?:кадастр|кадастров|kadastr|cadastr)/iu.test(text)) return null;
  if (/(?:без\s+кадастр|кадастр(?:а|овый\s+документ)?\s*(?:нет|отсутств)|kadastr\s*yo['’`]?q|fara\s+cadastr)/iu.test(text)) return false;
  return true;
}

// Backend-local supplement: catches "Сдаётся впервые" (word order reversed
// from the lexicon's "впервые сдаётся"). Used only when the lexicon's own
// firstRental field comes back null.
function parseFirstRental(text) {
  if (!text) return null;
  if (/(?:не\s+первая\s+сдача|не\s+впервые\s+сда[её]тся|not\s+first\s+(?:rent|rental))/iu.test(text)) return false;
  if (/(?:первая\s+сдача|впервые\s+сда[её]тся|сда[её]тся\s+впервые|перв(?:ая|ый)\s+аренд[а-яё]*|first\s+(?:rent|rental)|first\s+time\s+(?:for\s+)?rent|birinchi\s+(?:marta\s+)?ijara|ilk\s+ijara)/iu.test(text)) return true;
  return null;
}

function titleCaseWords(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Market-name landmarks specific to this product's sourced ads; the shared
// lexicon's POI catalog covers named landmarks, not these generic
// "<name> car/farmers market" constructions.
function parseNearbyLandmarks(text) {
  if (!text) return [];
  const value = String(text).replace(/\s+/g, ' ').trim();
  const out = [];
  const push = (label) => {
    const clean = String(label || '').replace(/\s+/g, ' ').trim();
    if (!clean || out.some((item) => item.toLocaleLowerCase() === clean.toLocaleLowerCase())) return;
    out.push(clean);
  };

  for (const match of value.matchAll(/([\p{L}'’.-]{2,24})\s+moshina\s+bozor(?:i|iga|ga)?/giu)) {
    push(`${titleCaseWords(match[1])} Car Market`);
  }
  for (const match of value.matchAll(/([\p{L}'’.-]{2,24})\s+dehqon\s+bozor(?:i|iga|ga)?/giu)) {
    push(`${titleCaseWords(match[1])} Farmers Market`);
  }
  for (const match of value.matchAll(/\byaqin\s+([\p{L}'’.-]{2,24}\s+avto)\b/giu)) {
    push(titleCaseWords(match[1]));
  }

  return out.slice(0, 8);
}

function isLowRoomPrice(listing) {
  const price = Number(listing?.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  const currency = String(listing?.currency || '').toUpperCase();
  const thresholds = {
    USD: 120,
    EUR: 110,
    UZS: 1_500_000,
    KZT: 55_000,
    UAH: 4_500,
    RON: 500,
  };
  const threshold = thresholds[currency];
  return threshold != null && price <= threshold;
}

function explicitlyOneWoman(text) {
  if (!text) return false;
  const value = String(text);
  return /(?:только|нужн[а-яё]*|ищ[еу][а-яё]*|подсел[а-яё]*|возьм[её]м)[^\r\n.!?]{0,24}(?:одн(?:а|ой|у)|1)\s+(?:девушк[а-яё]*|женщин[а-яё]*)|(?:одн(?:а|ой|у)|1)\s+(?:девушк[а-яё]*|женщин[а-яё]*)[^\r\n.!?]{0,24}(?:только|нужн[а-яё]*|ищ[еу][а-яё]*|подсел[а-яё]*)|(?:faqat\s+)?(?:1|bitta)\s*(?:ta\s*)?(?:qiz|ayol)[^\r\n.!?]{0,18}(?:ijarachi\s*)?(?:kerak|kere|uchun)?|(?:фақат\s+)?(?:1|битта)\s*(?:та\s*)?(?:қиз|аёл)[^\r\n.!?]{0,18}(?:ижарачи\s*)?(?:керак|учун)?/iu.test(value);
}

// commissionPercent filtering (e.g. "commission under 30%") should still find
// listings where the agency quoted a fixed fee instead of a rate -- compute
// the equivalent percent from price when both are known. Only when the fee
// and the listing price share a currency (or the fee's currency is unstated):
// converting across currencies here would need a live FX rate this parse-only
// step doesn't have, and a wrong-currency percent is worse than a missing one.
function effectiveCommissionPercent(commissionAmount, price, currency) {
  const amount = Number(commissionAmount?.amount);
  const basePrice = Number(price);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(basePrice) || basePrice <= 0) return null;
  if (commissionAmount.currency && currency && commissionAmount.currency !== currency) return null;
  const percent = (amount / basePrice) * 100;
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? Math.round(percent * 10) / 10 : null;
}

function classifyPotentiallyUnsafe(listing, text, roomOnly) {
  return roomOnly === true && explicitlyOneWoman(text) && isLowRoomPrice(listing);
}

export function enrichListingDetails(listing) {
  const source = listing && typeof listing === 'object' ? listing : {};
  const text = `${source.title || ''}\n${source.description || ''}`.trim();
  const country = String(source.country || '').toUpperCase();
  const enrichment = parseHousingListingEnrichment(text, { country });
  const compactLayout = parseCompactLayout(text);

  const commissionPercent = parseCommissionPercent(text);
  const roomOnly = source.roomOnly === true || enrichment.roomOnly === true;

  const parsedNearby = [
    ...(Array.isArray(enrichment.nearby) ? enrichment.nearby : []),
    ...parseNearbyLandmarks(text),
  ];
  const nearby = [...new Set([
    ...(Array.isArray(source.nearby) ? source.nearby.filter(Boolean) : []),
    ...parsedNearby,
  ])];

  const enriched = {
    ...source,
    rooms: boundedCount(source.rooms, 12) ?? enrichment.rooms ?? compactLayout?.rooms ?? null,
    // Explicit structured area in the description ("общая площадь 35") is
    // trusted over a source site's own (sometimes stale) metadata field.
    areaSqm: enrichment.areaSqm ?? (source.areaSqm != null ? Number(source.areaSqm) : parseAreaShorthand(text)),
    bedrooms: boundedCount(source.bedrooms, 12) ?? enrichment.bedrooms ?? null,
    bathrooms: boundedCount(source.bathrooms, 12) ?? enrichment.bathrooms ?? null,
    floor: source.floor != null ? Number(source.floor) : (enrichment.floor ?? compactLayout?.floor ?? null),
    totalFloors: source.totalFloors != null ? Number(source.totalFloors) : (enrichment.totalFloors ?? compactLayout?.totalFloors ?? null),
    address: source.address ?? enrichment.address ?? null,
    addressStreet: enrichment.addressStreet ?? null,
    addressHouseNumber: enrichment.addressHouseNumber ?? null,
    addressBuilding: enrichment.addressBuilding ?? null,
    commission: source.commission ?? enrichment.commission ?? null,
    commissionPercent: commissionPercent ?? source.commissionPercent ?? enrichment.commissionPercent
      ?? effectiveCommissionPercent(enrichment.commissionAmount, source.price, source.currency),
    commissionAmount: enrichment.commissionAmount ?? null,
    cadastral: source.cadastral ?? parseCadastral(text),
    firstRental: source.firstRental ?? enrichment.firstRental ?? parseFirstRental(text),
    roomOnly,
    audience: source.audience ?? enrichment.audience ?? null,
    audienceAlternatives: enrichment.audienceAlternatives ?? [],
    studentTarget: enrichment.studentTarget ?? false,
    landlordPresent: enrichment.landlordPresent ?? false,
    priceScope: enrichment.priceScope ?? null,
    perPersonPrice: enrichment.perPersonPrice ?? null,
    transitRoutes: enrichment.transitRoutes ?? [],
    utilitiesAmount: enrichment.utilitiesAmount ?? null,
    nearby,
    district: locationName(source.district) ?? enrichment.district ?? null,
    metro: locationName(source.metro) ?? enrichment.metro ?? null,
  };
  enriched.potentiallyUnsafe = source.potentiallyUnsafe === true || classifyPotentiallyUnsafe(enriched, text, roomOnly);
  return enriched;
}

export const __listingEnrichmentTest = {
  parseCompactLayout,
  parseAreaShorthand,
  parseCommissionPercent,
  parseCadastral,
  parseFirstRental,
  parseNearbyLandmarks,
  explicitlyOneWoman,
  classifyPotentiallyUnsafe,
};
