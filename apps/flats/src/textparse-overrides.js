import { parseHousingListingFields } from '@whiteslove/parsing-lexicon/housing-listing-fields';
import {
  parseHousingAudience as baseClassifyAudience,
  parseHousingFloorFromText as baseParseFloor,
  parseHousingResidentialComplex as baseParseResidentialComplex,
  parseHousingRoomsFromText as baseParseRoomsFromText,
} from '@whiteslove/parsing-lexicon/housing-text';
import { parseHousingQuarterLabel as baseParseKvartal } from '@whiteslove/parsing-lexicon/housing-card-fields';

const baseClassifyChildren = (text) => parseHousingListingFields(text).childrenAllowed ?? null;
import {hasZeroCommissionSignal} from './seller-signals.js';

const COMMISSION_PERCENT_RE = [
  /(?:комисси[а-яёіїґ]*|комісі[а-яіїґ]*|commission|comision|komissiya|комиссия)\s*[:=\-]?\s*(\d{1,3})\s*%/iu,
  /(?:макл(?:ер[а-яё]*)?|makler|р[иі][еєэ]?лтор[а-яёіїґ]*|rieltor|realtor|broker|agent|vositachi|делдал)\s*(?:fee|haq(?:i)?|хак|ақы)?\s*[,;:]?\s*(\d{1,3})\s*%/iu,
  /(\d{1,3})\s*%\s*(?:комисси[а-яёіїґ]*|комісі[а-яіїґ]*|commission|comision|komissiya)/iu,
  /(?:^|[^\p{L}\p{N}_])[mм]\s*[:.\-]?\s*(\d{1,3})\s*%/iu,
];

const EXPLICIT_FEE_RE = /(?:агентск[а-яё]*\s+(?:комисси[а-яё]*|вознаграждени[а-яё]*)|комисси[а-яё]*\s+(?:есть|оплачива[а-яё]*|взима[а-яё]*|бер[её]тся|требу[а-яё]*)|комісі[а-яіїґ]*\s+(?:є|сплачу[а-яіїґ]*|оплачу[а-яіїґ]*)|agency\s+fee|broker\s+fee|realtor\s+fee|agent\s+fee|comision\s+(?:agen(?:ț|t)ie|intermediar)|komissiya\s+(?:bor|olinadi|to['’`]?lanadi)|makler\s+(?:haqi|xaqi|haq)|rieltor\s+(?:haqi|xaqi|haq)|vositachi\s+(?:haqi|xaqi|haq)|комиссия\s+(?:бар|алынады|төленеді)|делдал\s+(?:ақысы|ақы))/iu;
const BROKER_MENTION_RE = /(?:макл(?:ер[а-яё]*)?|makler|р[иі][еєэ]?лтор[а-яёіїґ]*|rieltor|realtor|broker|agent|агентств[а-яё]*|vositachi|делдал|agen(?:ț|t)ie|intermediar)/iu;
const RC_TRAILING_NO_BROKER_RE = /\s+(?:без\s+(?:макл(?:ер[а-яё]*)?|ри[еэ]?лтор[а-яё]*|посредник[а-яё]*|агент[а-яё]*)|no\s+(?:broker|realtor|agent|agency)|f(?:ă|a)r(?:ă|a)\s+(?:agen(?:ț|t)ie|intermediar\w*)|maklersiz|vositachisiz|egasidan|делдалсыз|иесінен)(?=$|[^\p{L}\p{N}_])[\s\S]*$/iu;
const RC_QUOTED_NAME_RE = /(?:жк|жм|ж\/к|residential complex|ansamblu(?: rezidential)?|turar[- ]?joy majmuasi)\s*[:;—–\-·•]*\s*[«"„“']\s*([^»"„“'\n]{2,60})\s*[»"“']?/iu;
const RC_TRAILING_ACTION_RE = /\s+(?:вільн[а-яіїґ]*|оренд[а-яіїґ]*|здач[а-яіїґ]*|зда[єе]ться|здам|продаж[а-яіїґ]*|прода[єе]ться|продам|аренд[а-яё]*|сдач[а-яё]*|сда[её]тся|сдам|продаж[а-яё]*|прода[её]тся)(?=$|[^\p{L}\p{N}_])[\s\S]*$/iu;
const EURO_ONE_ROOM_RE = /(?:^|[^\p{L}\p{N}_])(?:евро|євро)[-\s]?(?:двушк[а-яёіїґ]*|двокімнатн[а-яіїґ]*|2[-\s]?к(?:омн(?:атн[а-яё]*)?)?)(?=$|[^\p{L}\p{N}_])/iu;

const NON_RESIDENTIAL_COMPLEX_RE = /(?:^|\s)(?:pub|bar|cafe|café|coffee\s*shop|restaurant|restoran|hotel|hostel|market|bozor|bazaar|mall|shop|store|school|maktab|clinic|hospital|pharmacy|apteka)$/iu;
const STREET_LIKE_PLACE_RE = /(?:^|[^\p{L}\p{N}_])(?:ko['’`ʼʻ]?cha(?:si)?|кўча(?:си)?|yo['’`ʼʻ]?l(?:i)?|yoli|street|road|avenue|улица|вулиця|дорога|шоссе|проспект)(?=$|[^\p{L}\p{N}_])/iu;

function validResidentialComplexCandidate(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || !/[a-zA-Zа-яёіїґ]{2,}/i.test(cleaned)) return null;
  if (NON_RESIDENTIAL_COMPLEX_RE.test(cleaned) || STREET_LIKE_PLACE_RE.test(cleaned)) return null;
  return cleaned;
}

function parseUzbekColloquialRooms(text) {
  const match = String(text || '').match(/(?:^|[^\p{L}\p{N}_])([1-9])\s*(?:x|h)onali(?=$|[^\p{L}\p{N}_])/iu);
  return match ? Number(match[1]) : null;
}

function parseUzbekColloquialFloor(text) {
  const value = String(text || '');

  // A basement floor is written with an explicit minus sign ("-1 этаж
  // (подвал)"), which the plain positive-floor regex below would otherwise
  // swallow as its own "non-digit boundary" character and misread as floor 1.
  const basementMatch = value.match(/(-[1-9]\d?)[ \t]*(?:etaj|etazh|этаж)(?:da|да)?(?=$|[^\p{L}\p{N}_])/iu);
  if (basementMatch) return {floor: Number(basementMatch[1]), totalFloors: null};

  // [ \t]* (not \s*) so a number at the end of one line can't pair with an
  // unrelated "этаж"/"этажность" label that happens to start the next line
  // (e.g. "Комнат 2\nЭтаж 6" must not read floor as 2).
  const floorMatch = value.match(/(?:^|[^\d])([1-9]\d?)[ \t]*(?:etaj|etazh|этаж)(?:da|да)?(?=$|[^\p{L}\p{N}_])/iu);
  const totalMatch = value.match(/(?:^|[^\d])([1-9]\d?)[ \t]*(?:etashka|etajka|etazhka|этажка)(?=$|[^\p{L}\p{N}_])/iu);
  const floor = Number(floorMatch?.[1]);
  const totalFloors = Number(totalMatch?.[1]);
  if (!Number.isInteger(floor) || floor < 1 || floor > 40) return null;
  if (!Number.isInteger(totalFloors) || totalFloors < floor || totalFloors > 40) {
    return {floor, totalFloors: null};
  }
  return {floor, totalFloors};
}

export function parseCommission(text) {
  if (!text) return { has: null, percent: null };
  if (hasZeroCommissionSignal(text)) return { has: false, percent: 0 };
  for (const re of COMMISSION_PERCENT_RE) {
    const match = text.match(re);
    if (!match) continue;
    const percent = Number(match[1]);
    return { has: true, percent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null };
  }
  if (EXPLICIT_FEE_RE.test(text)) return { has: true, percent: null };
  if (BROKER_MENTION_RE.test(text)) return { has: null, percent: null };
  return { has: null, percent: null };
}

function validLayout(rooms, floor, totalFloors) {
  if (rooms < 1 || rooms > 10 || floor < 0 || floor > 40 || totalFloors < 1 || totalFloors > 40 || floor > totalFloors) return null;
  return {rooms, floor, totalFloors};
}

function structuredLayout(text) {
  if (!text) return null;
  const labelled = text.match(/(?:xonalari|xonalar(?:i)?|комнат(?:ы|а)?|rooms?)\s*[:\-]?\s*([1-9])\s*(?:[вv>]\s*([1-9]))?\s*\/\s*([0-9]{1,2})\s*\/\s*([0-9]{1,2})/iu);
  if (labelled) return validLayout(Number(labelled[2] || labelled[1]), Number(labelled[3]), Number(labelled[4]));
  const converted = text.match(/(?:^|[^\d])([1-9])\s*[вv>]\s*([1-9])\s*\/\s*([0-9]{1,2})\s*\/\s*([0-9]{1,2})(?!\d)/iu);
  if (converted) return validLayout(Number(converted[2]), Number(converted[3]), Number(converted[4]));
  const withArea = text.match(/(?:^|[^\d])([1-9])\s*\/\s*([0-9]{1,2})\s*\/\s*([0-9]{1,2})(?=\s+\d{1,4}\s*(?:кв(?:\.?\s*м)?|м²|m²|sqm)(?=$|[^\p{L}\p{N}_]))/iu);
  if (withArea) return validLayout(Number(withArea[1]), Number(withArea[2]), Number(withArea[3]));
  return null;
}

function ukrainianFloorPair(text) {
  if (!text) return null;
  const floorMatch = String(text).match(/([1-9]\d?)\s*-\s*(?:му|ому|м|й)\s+повер(?:с|х)[а-яіїґ]*/iu);
  if (!floorMatch) return null;
  const floor = Number(floorMatch[1]);
  const tailStart = (floorMatch.index ?? 0) + floorMatch[0].length;
  const tail = String(text).slice(tailStart, tailStart + 120);
  const totalMatch = tail.match(/([1-9]\d?)\s*-\s*поверхов[а-яіїґ]*/iu);
  if (!totalMatch) return null;
  const totalFloors = Number(totalMatch[1]);
  if (floor < 1 || floor > 40 || totalFloors < floor || totalFloors > 40) return null;
  return {floor, totalFloors};
}

function hasExplicitRoomCount(text) {
  return /(?:^|[^\p{L}\p{N}_])(?:[1-9]\s*[- ]?(?:комн|кімн)|(?:комнат|кімнат)\s*[:\-]?\s*[1-9])(?=$|[^\p{L}\p{N}_])/iu.test(String(text || ''));
}

export function parseRoomsFromText(text) {
  const structured = structuredLayout(text)?.rooms;
  if (structured != null) return structured;
  const uzbekColloquial = parseUzbekColloquialRooms(text);
  if (uzbekColloquial != null) return uzbekColloquial;
  if (EURO_ONE_ROOM_RE.test(String(text || '')) && !hasExplicitRoomCount(text)) return 1;
  return baseParseRoomsFromText(text);
}

export function parseFloor(text) {
  const explicitUkrainian = ukrainianFloorPair(text);
  if (explicitUkrainian) return explicitUkrainian;
  const structured = structuredLayout(text);
  if (structured) return { floor: structured.floor, totalFloors: structured.totalFloors };
  const uzbekColloquial = parseUzbekColloquialFloor(text);
  return uzbekColloquial ?? baseParseFloor(text);
}

export function classifyAudience(text) {
  if (!text) return null;
  const both = /(?:qiz(?:lar)?[^\r\n]{0,30}(?:yoki|va|\/|or)[^\r\n]{0,30}yigit(?:lar)?|yigit(?:lar)?[^\r\n]{0,30}(?:yoki|va|\/|or)[^\r\n]{0,30}qiz(?:lar)?|women?[^\r\n]{0,30}(?:or|and|\/)[^\r\n]{0,30}men|men[^\r\n]{0,30}(?:or|and|\/)[^\r\n]{0,30}women?|девушк[а-яё]*[^\r\n]{0,30}(?:или|и|\/)[^\r\n]{0,30}(?:парн|мужчин)|(?:парн|мужчин)[а-яё]*[^\r\n]{0,30}(?:или|и|\/)[^\r\n]{0,30}девушк)/iu;
  if (both.test(text)) return null;
  return baseClassifyAudience(text);
}

export function classifyChildren(text) {
  const parsed = baseClassifyChildren(text);
  if (parsed != null || !text) return parsed;
  const family = /(?:^|[^\p{L}\p{N}_])(?:oilaga|oila|оилага|оила)(?=$|[^\p{L}\p{N}_])/iu.test(text);
  const children = /(?:^|[^\p{L}\p{N}_])(?:bollar|боллар)(?=$|[^\p{L}\p{N}_])/iu.test(text);
  return family && children ? true : null;
}

export function parseKvartal(text) {
  const parsed = baseParseKvartal(text);
  if (parsed && !STREET_LIKE_PLACE_RE.test(parsed)) return parsed;
  if (!text) return null;
  const match = String(text).match(/(?:^|[^\d])([1-9]\d?)\s*(?:квартил|kvartil)(?=$|[^\p{L}\p{N}_])/iu);
  return match ? `${Number(match[1])} kvartal` : null;
}

export function parseCondition(text) {
  if (!text) return null;
  if (/(?:remont\s*dan\s+chiq{1,2}an|ремонт\s*дан\s+чи[кқ]{1,2}ан|ремонтдан\s+чи[кқ]{1,2}ан|после\s+(?:свежего\s+)?ремонт[а-яё]*)/iu.test(text)) return 'good';
  if (/(?:ремонт\s+(?:требуется|нужен)|требует\s+ремонт|needs?\s+renovation|ta['’`]?mir\s+kerak)/iu.test(text)) return 'needs_renovation';
  return null;
}

const PEARL_NUMERIC_RE = /(?:^|[^\p{L}\p{N}_])([1-9]\d?)\s*(?:[-–—]?\s*(?:я|ая|а|й|st|nd|rd|th))?\s*(?:жемчужин[а-яё]*|перлин[а-яіїґ]*)(?=$|[^\p{L}\p{N}_])/iu;
const PEARL_TENS = new Map([['двадцять',20],['тридцять',30],['сорок',40],['двадцать',20],['тридцать',30]]);
const PEARL_ONES = new Map([['перша',1],['друга',2],['третя',3],['четверта',4],["п'ята",5],['шоста',6],['сьома',7],['восьма',8],["дев'ята",9],['первая',1],['вторая',2],['третья',3],['четвертая',4],['пятая',5],['шестая',6],['седьмая',7],['восьмая',8],['девятая',9]]);
function normalizePearlToken(value){return String(value||'').toLowerCase().replace(/[’`ʼ]/g,"'").replace(/ё/g,'е');}
function parsePearlComplex(text){
  if(!text)return null;
  const numeric=String(text).match(PEARL_NUMERIC_RE); if(numeric)return `${Number(numeric[1])} Жемчужина`;
  const words=String(text).match(/(?:^|[^\p{L}\p{N}_])(?:жк\s*)?(двадцять|тридцять|сорок|двадцать|тридцать)\s+([\p{L}'’`ʼ-]+)\s+(?:перлин[а-яіїґ]*|жемчужин[а-яё]*)(?=$|[^\p{L}\p{N}_])/iu);
  if(words){const tens=PEARL_TENS.get(normalizePearlToken(words[1])); const ones=PEARL_ONES.get(normalizePearlToken(words[2])); if(tens&&ones)return `${tens+ones} Жемчужина`;}
  const single=String(text).match(/(?:^|[^\p{L}\p{N}_])(?:жк\s*)?([\p{L}'’`ʼ-]+)\s+(?:перлин[а-яіїґ]*|жемчужин[а-яё]*)(?=$|[^\p{L}\p{N}_])/iu);
  if(single){const value=PEARL_ONES.get(normalizePearlToken(single[1])); if(value)return `${value} Жемчужина`;}
  return null;
}

export function parseResidentialComplex(text) {
  const pearl = parsePearlComplex(text);
  if (pearl) return pearl;
  const quoted = validResidentialComplexCandidate(String(text || '').match(RC_QUOTED_NAME_RE)?.[1]);
  if (quoted) return quoted;
  const raw = baseParseResidentialComplex(text);
  if (!raw) return null;
  const cleaned = raw
    .replace(RC_TRAILING_NO_BROKER_RE, '')
    .replace(RC_TRAILING_ACTION_RE, '')
    .replace(/\s+[1-9]\s*(?:[вv>]\s*[1-9])?\s*\/\s*[0-9]{1,2}\s*\/\s*[0-9]{1,2}\b[\s\S]*$/iu, '')
    .replace(/\s+(?:глинка|glinka)\s*$/iu, '')
    .replace(/\s*[!|]+\s*$/g, '')
    .trim();
  return validResidentialComplexCandidate(cleaned);
}

const UZ_EXPLICIT_DISTRICTS = [
  ['Bektemir', /бектемирск[а-яё]*\s+район|bektemir\s+(?:tumani|district)/iu],
  ['Chilanzar', /чиланзарск[а-яё]*\s+район|чиланзар\s+туман[а-яё]*|chilonzor\s+(?:tumani|district)|chilanzar\s+district/iu],
  ['Yunusabad', /юнусабадск[а-яё]*\s+район|(?:^|[^\p{L}\p{N}_])(?:yunusobod|yunusabad|юнусобод|юнусабад)(?=$|[^\p{L}\p{N}_])(?:\s+(?:tumani|district|туман[а-яё]*|район))?/iu],
  ['Yakkasaray', /яккасарайск[а-яё]*\s+район|yakkasaroy\s+(?:tumani|district)|yakkasaray\s+district/iu],
  ['Mirzo Ulugbek', /мирзо[-\s]?улугбекск[а-яё]*\s+район|mirzo\s+ulug['’]?bek\s+(?:tumani|district)/iu],
  ['Mirobod', /мир[оа]б[оа]дск[а-яё]*\s+район|mirobod\s+(?:tumani|district)/iu],
  ['Almazar', /алмазарск[а-яё]*\s+район|олмазор\s+(?:tumani|district)|almazar\s+district/iu],
  ['Uchtepa', /учтепинск[а-яё]*\s+район|уч\s*теп[а-яё]*\s+район|uchtepa\s+(?:tumani|district)|(?:^|[^\p{L}\p{N}_])uch\s*tepa(?=\s+\d{1,3}\s*[-–]?\s*kvartal)/iu],
  ['Yashnobod', /яшнабадск[а-яё]*\s+район|(?:^|[^\p{L}\p{N}_])#?яшнабадск[а-яё]*(?=$|[^\p{L}\p{N}_])|yashnobod\s+(?:tumani|district)/iu],
  ['Shaykhantahur', /шайхантахурск[а-яё]*\s+район|shayxontohur\s+(?:tumani|district)/iu],
  ['Sergeli', /сергелийск[а-яё]*\s+район|serg(?:eli|ile|ele)\s+(?:tumani|district)/iu],
  ['Yangihayot', /янгиха[её]тск[а-яё]*\s+район|yangihayot\s+(?:tumani|district)/iu],
];

export function parseExplicitDistrict(text, countryCode) {
  if (countryCode !== 'UZ' || !text) return null;
  return UZ_EXPLICIT_DISTRICTS.find(([, re]) => re.test(text))?.[0] || null;
}
