import {
  ADDRESS_TERMS,
  APPLIANCE_TERMS,
  DEAL_TYPES,
  DEPOSIT_TERMS,
  HOUSING_OCCUPANCY_TYPES,
  aliasesOf,
  canonicalAnyCity,
  canonicalCentralAsiaCity,
  canonicalCountryCode,
  canonicalRegion,
  canonicalUkraineCity,
  escapeRegex,
  findCanonical,
  normalizeUnicode,
  parseHousingContext,
  parseHousingStructured,
  resolveHousingIntent,
} from '@whiteslove/parsing-lexicon';

const values = (entry) => [entry?.canonical, ...aliasesOf(entry)].filter(Boolean);
const loosePart = (value) => escapeRegex(normalizeUnicode(value).trim())
  .replace(/[\s\-–—'’‘`ʻʼ]+/g, "[\\s\\-–—'’‘`ʻʼ]*");
const alternatives = (entries) => [...new Set(entries.flatMap(values))]
  .sort((a, b) => String(b).length - String(a).length)
  .map(loosePart)
  .join('|');

const addressLabelPart = alternatives([ADDRESS_TERMS.label]);
const streetMarkerPart = alternatives([ADDRESS_TERMS.street, ADDRESS_TERMS.avenue]);
const addressLabelRe = new RegExp(`(?:${addressLabelPart})\\s*[:\\-–—]\\s*([^\\n]{3,100})`, 'iu');
const markedStreetRe = new RegExp(
  `((?:${streetMarkerPart})\\.?[\\s\\u00a0]*[^\\n,;.]{2,70}(?:,?\\s*(?:${alternatives([ADDRESS_TERMS.house])})?\\.?\\s*\\d+[\\p{L}0-9/-]*)?)`,
  'iu',
);
const ADDRESS_NOISE_RE = /(?:поверх|этаж|підвал|подвал|цоколь|ремонт|площа|площад|кімнат|комнат)/iu;
const ADDRESS_PAREN_CONTEXT_RE = /\s*\((?:парк|park|школ|school|магазин|сільпо|silpo|рынок|ринок|базар|метро|metro)\b.*$/iu;

function cleanAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(ADDRESS_PAREN_CONTEXT_RE, '')
    .trim()
    .replace(/[.;,]+$/, '');
}

function plausibleAddress(value) {
  const cleaned = cleanAddress(value);
  if (!cleaned || cleaned.length < 3 || cleaned.length > 100) return null;
  if (ADDRESS_NOISE_RE.test(cleaned)) return null;
  return cleaned;
}

function parseUzbekMassifHouse(text) {
  const match = String(text || '').match(
    /(?:^|[^\p{L}\p{N}_])([\p{L}'’‘`ʻʼ.-]{3,32})\s+(\d{1,2})\s+(?:mavze|мавзе|massiv(?:i)?|массив(?:и)?)\s+(\d{1,4})\s*([\p{L}])?\s*(?:dom|дом|uy|уй)(?=$|[^\p{L}\p{N}_])/iu,
  );
  if (!match) return null;
  const suffix = match[4] ? String(match[4]).toUpperCase() : '';
  return `${match[1]} ${Number(match[2])} mavze, ${Number(match[3])}${suffix}`;
}

export function parseCanonicalCountryCode(value) {
  return canonicalCountryCode(value) || String(value || '').trim().toUpperCase() || null;
}

export function parseCanonicalCity(countryCode, value) {
  if (!value) return '';
  if (countryCode === 'UA') return canonicalUkraineCity(value) || String(value).trim();
  if (countryCode === 'KZ' || countryCode === 'UZ') {
    return canonicalCentralAsiaCity(value, countryCode) || String(value).trim();
  }
  return canonicalAnyCity(value, countryCode) || String(value).trim();
}

export function parseCanonicalRegion(countryCode, value) {
  if (!value) return null;
  return canonicalRegion(value, countryCode) || String(value).trim();
}

export function parseHousingIntent(text) { return resolveHousingIntent(text); }
export function parseHousingSemanticContext(text) { return parseHousingContext(text); }
export function parseHousingStructuredContext(text) { return parseHousingStructured(text); }

export function parseLexiconDealType(text) {
  return resolveHousingIntent(text)?.dealType
    || findCanonical(text, DEAL_TYPES, { partial: true })?.canonical
    || null;
}

export function parseHousingOccupancyType(text) {
  return findCanonical(text, HOUSING_OCCUPANCY_TYPES, { partial: true })?.canonical || null;
}

export function parseDepositKind(text) {
  if (!text) return null;
  for (const key of ['noDeposit', 'firstAndLastMonth', 'advance', 'refundable', 'deposit']) {
    const entry = DEPOSIT_TERMS[key];
    if (entry && findCanonical(text, [entry], { partial: true })) return entry.canonical;
  }
  return null;
}

export function parseAppliances(text) {
  if (!text) return [];
  const out = [];
  for (const entry of Object.values(APPLIANCE_TERMS)) {
    if (findCanonical(text, [entry], { partial: true })) out.push(entry.canonical);
  }
  return [...new Set(out)];
}

// Odesa listings routinely use Fountain stations as the practical address:
// "10 ст Б Фонтана", "10 станция Большого Фонтана", "10 ст. В. Фонтану".
// Keep this separate from generic street parsing because "станция" elsewhere
// is normally transit/rail context, not an address.
export function parseOdesaFontanStation(text) {
  if (!text) return null;
  const value = String(text);
  const station = value.match(/(?:^|[^\d])([1-9]|1[0-6])\s*(?:[-–—]?\s*(?:я|ая|а))?\s*(?:ст\.?|станци[яи]|станц(?:ія|ії))\s*(?:б\.?|в\.?|больш(?:ого|ой)|велик(?:ого|ий))?\s*фонтан(?:а|у)?(?=$|[^\p{L}\p{N}_])/iu);
  if (!station) return null;
  return `${Number(station[1])} станция Большого Фонтана`;
}

export function parseLexiconAddress(text, canonicalStreet = null) {
  if (!text) return plausibleAddress(canonicalStreet);

  const fountainStation = parseOdesaFontanStation(text);
  if (fountainStation) return fountainStation;

  const uzbekMassifHouse = parseUzbekMassifHouse(text);
  if (uzbekMassifHouse) return uzbekMassifHouse;

  const labeled = String(text).match(addressLabelRe);
  const labeledAddress = labeled ? plausibleAddress(labeled[1]) : null;
  if (labeledAddress) return labeledAddress;

  const marked = String(text).match(markedStreetRe);
  const markedAddress = marked ? plausibleAddress(marked[1]) : null;
  if (markedAddress) return markedAddress;

  const canonicalAddress = plausibleAddress(canonicalStreet);
  if (canonicalAddress) return canonicalAddress;

  const bare = String(text).match(
    /(?:^|[,;\n]\s*)([\p{L}][\p{L}'’‘`ʻʼ.-]*(?:\s+[\p{L}][\p{L}'’‘`ʻʼ.-]*){0,5}\s+\d+[\p{L}0-9/-]*)(?=\s*(?:[,.;\n]|$))/iu,
  );
  return bare ? plausibleAddress(bare[1]) : null;
}
