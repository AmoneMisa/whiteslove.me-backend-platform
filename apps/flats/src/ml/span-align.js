// Finds where a listing's stored price, currency, address and metro sit in its
// text, so a token-tagging model can be trained to point at them.
//
// The database values are not span labels: an address column can hold a bare
// district or a truncated sentence, a metro station is often transliterated
// ("Saltivska" for "Салтівська"), a price may be converted. So positions are
// searched for in the text and the stored value is only used to confirm them.
//
// Each entity ends up in one of three states per listing:
//   found   -> spans: label those characters
//   ignore  -> the stored value (or the text) is not reliably alignable; the
//              entity must not be trained on for this row, not even as "O"
//   absent  -> nothing stored and nothing in the text suggests it; all "O"
// Precision beats recall: a missed span costs little, a wrong one teaches the
// model to point at the wrong words.

import { parseHousingAreaFromText, parseHousingFloorFromText, parseHousingRoomsFromText } from '@whiteslove/parsing-lexicon';
import { unicode } from './field-evidence.js';

export const ENTITIES = Object.freeze(['PRICE', 'CURRENCY', 'ADDRESS', 'METRO', 'DISTRICT', 'LANDMARK', 'COMPLEX', 'MICRODISTRICT', 'LOCALITY', 'DEPOSIT', 'UTILITIES', 'NEARBY', 'AREA', 'FLOOR', 'FLOORS_TOTAL', 'ROOMS', 'COMMISSION', 'PREPAYMENT']);
// What a person reads off the text to price a move-in: AREA ("56 м²", the number with its unit), ROOMS ("3-комнатная", the
// fragment that states the count), FLOOR and FLOORS_TOTAL (the numbers), COMMISSION (the realtor's fee as it is written:
// "50%", "300$", "1 месяц", or the statement "без комиссии") and PREPAYMENT (the months paid in advance: "2 месяца").
// LANDMARK is a specific place ("школа №33", "ТЦ Мега"); NEARBY is "what is around" said in general words
// ("школа", "магазины", "рынки"): it says what kind of places are close, not which.
// PRICE is the price of the flat itself (rent per month, or the sale price). DEPOSIT is the deposit (залог) and
// UTILITIES the utility payments (коммунальные) when a listing states them as amounts.
// DISTRICT is an administrative district ("Юнусабад", "Шевченківський район"); MICRODISTRICT a microdistrict,
// mahalla or numbered quarter ("мкр Тархова", "махалля Қорасарой"); LOCALITY a named place that is neither
// ("Глинка", "Гидропарк"). The three order the way a person narrows an address: district > microdistrict > locality.
export const DISTRICT_KINDS = Object.freeze(['DISTRICT', 'MICRODISTRICT', 'LOCALITY']);

// ---- currency -------------------------------------------------------------

const CURRENCY_MARKERS = [
  ['USD', /\$|\busd\b|долл(?:аров|\.|ар|ор)?|dollor|\bдол\b\.?|у\.\s?е\.?|\bu\.\s?e\.?|\by\.?e\.?\b/i],
  ['EUR', /€|\beur\b|\beuro\b|евро|євро/i],
  ['UAH', /₴|грн\.?|гривен|гривн|гривень|\buah\b|\bhrn\b/i],
  ['UZS', /\bсум(?:ов|а|ы)?\b|\bso['’`ʻ]?m\b|\buzs\b|сўм/i],
  ['KZT', /₸|тенге|\bтг\b\.?|\bkzt\b/i],
  ['RON', /\blei\b|\bлей\b|\bron\b/i],
  ['KGS', /\bсом(?:ов|а)?\b|\bkgs\b/i],
].map(([code, re]) => [code, unicode(re)]);

// Compiled once: this runs for every number in every listing.
const AFTER = CURRENCY_MARKERS.map(([code, re]) => [code, new RegExp(String.raw`^[\s ]{0,2}(?:${re.source})`, re.flags)]);
const BEFORE = CURRENCY_MARKERS.map(([code, re]) => [code, new RegExp(String.raw`(?:${re.source})[\s :]{0,2}$`, re.flags)]);

function markerAt(text, from, direction) {
  // Look a couple of characters past (or before) the number for a marker.
  if (direction === 'after') {
    const tail = text.slice(from, from + 14);
    for (const [code, re] of AFTER) {
      const m = re.exec(tail);
      if (m) {
        const lead = m[0].length - m[0].trimStart().length;
        return { code, start: from + lead, end: from + m[0].length };
      }
    }
  } else {
    const head = text.slice(Math.max(0, from - 14), from);
    const base = from - head.length;
    for (const [code, re] of BEFORE) {
      const m = re.exec(head);
      if (m) {
        const start = base + m.index;
        return { code, start, end: start + m[0].trimEnd().replace(/:$/, '').trimEnd().length };
      }
    }
  }
  return null;
}

// ---- price ----------------------------------------------------------------

const NUMBER = /(?<!\d)(?<!\d[.,])(?:[1-9]\d{0,2}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/gu;
const THOUSANDS_SUFFIX = /^[\s ]?(?:к|k|тыс\.?|тис\.?)(?![\p{L}])/iu;

function numberValue(raw) {
  const grouped = /^\d{1,3}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?$/.test(raw);
  if (grouped) {
    const decimal = /[.,]\d{1,2}$/.exec(raw);
    const head = decimal ? raw.slice(0, decimal.index) : raw;
    return Number(head.replace(/[   .,]/g, '')) + (decimal ? Number(`0.${decimal[0].slice(1)}`) : 0);
  }
  return Number(raw.replace(',', '.'));
}

// ---- deposit and utilities -------------------------------------------------
//
// A listing sometimes states other amounts beside the price: "залог 300$", "коммунальные 50$". They are not
// in any column, so they are found by the cue word right before the number ("залог: 300$"). A cue after the
// number is not used: "500$ залог не нужен" is a price, and "300$ + коммунальные 50$" puts the cue before its own
// amount. A negated cue ("без залога") and a cue with no amount next to it ("залог не нужен, 500$") label nothing.

const AMOUNT_CUES = [
  ['DEPOSIT', unicode(/(?:залог\p{L}*|депозит\p{L}*|deposit|гарантийн\p{L}*\s+(?:взнос|платеж\p{L}*|депозит)|застав\p{L}*|завдат\p{L}*|garan[țt]\p{L}*)/iu)],
  ['UTILITIES', unicode(/(?:коммунал\p{L}*|комунал\p{L}*|ком\.?\s?услуг\p{L}*|к\/у|utilit\p{L}*|komunal\p{L}*|kommunal\p{L}*|[iî]ntre[țt]inere|cheltuieli)/iu)],
  // the realtor's fee: "комиссия 50%", "комиссия 300$", "риелтору 1 месяц"
  ['COMMISSION', unicode(/(?:комисс\p{L}*|комісі\p{L}*|риелтор\p{L}*|риэлтор\p{L}*|рієлтор\p{L}*|агентск\p{L}*|comision\p{L}*|komissiya\p{L}*|komisyon\p{L}*|vositachi\p{L}*|makler\p{L}*\s+(?:haqqi|xizmat\p{L}*))/iu)],
  // months paid in advance: only a count of months is a prepayment here ("предоплата за 3 месяца", "2 месяца вперёд")
  ['PREPAYMENT', unicode(/(?:предоплат\p{L}*|предварительн\p{L}*\s+оплат\p{L}*|передоплат\p{L}*|оплат\p{L}*\s+(?:за\s+)?(?:вперед|вперёд|наперед|наперёд)|аванс\p{L}*|prepay\p{L}*|oldindan\p{L}*|avans\p{L}*)/iu)],
];
// the word after a count of months that makes it a prepayment, not a deposit: "2 месяца вперёд"
const FORWARD_WORD = /^[\s ]{0,2}(?:вперед|вперёд|наперед|наперёд|заранее|oldindan|[iî]n\s+avans|avans|ahead|in\s+advance)(?![\p{L}])/iu;
// No middleman means no fee: "без риелтора", "от владельца", "bez makler", "fără agent". Written as a regex source.
const NO_AGENT = String.raw`(?:без\s+(?:посредник\p{L}*|посередник\p{L}*|риелтор\p{L}*|риэлтор\p{L}*|рієлтор\p{L}*|агент\p{L}*)|(?:от|від)\s+(?:владельц\p{L}*|собственник\p{L}*|хозя\p{L}*|власник\p{L}*|господар\p{L}*)|maklersiz|vositachisiz|bez\s?makler|(?:makler|maklerlik\s+hizmati)\s+yo['ʻ’]q|(?:mulk\s+)?egasidan|f[aă]r[aă]\s+(?:agen[țt]\p{L}*|intermediar\p{L}*)|(?:direct\s+)?de\s+la\s+proprietar)`;
// "без комиссии", "комиссия не берётся": no fee. The span is the statement itself.
const NO_COMMISSION = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:без\s+(?:комисс\p{L}*|комісі\p{L}*|агентск\p{L}*\s+комисс\p{L}*)|(?:комисс\p{L}*|комісі\p{L}*)\s+(?:не\s+(?:берем|берём|берется|берётся|нужна|нужно|взимается|беремо|стягується)|нет|відсутня|отсутствует)|fără\s+comision\p{L}*|fara\s+comision\p{L}*|bez\s+komissiya\p{L}*|komissiyasiz|${NO_AGENT})(?![\p{L}\p{N}])`,
  'giu',
);
// a percentage after a number: "50%", "50 %", "50 процентов"
const PERCENT_AFTER = /^[\s ]?(?:%|проц\p{L}*|percent\p{L}*|foiz\p{L}*)/iu;
const CUE_THEN_AMOUNT = /^[^\n\d.,;!?]{0,24}$/u; // all that may stand between the cue and the number
const NOT_MONEY_AFTER = /^[\s ]{0,2}(?:%|mp(?![\p{L}])|m2|м2|м²|кв(?![\p{L}])|sqm|месяц|місяц|мес(?![\p{L}])|luni|lun[ăa](?![\p{L}])|дн|день|суток|сутки|ден(?![\p{L}]))/iu;
const NEGATED = /(?:^|[\s(])(?:без|нет|не|bez|fara|fără|yo['ʻ’]q)[\s ]+$/iu; // "без залога"
const NEGATION_AFTER = /(?:^|[\s ])(?:не|нет|нету|no|nu|yo['ʻ’]q)(?![\p{L}])/iu; // "залог не нужен"

// A deposit is often a number of months of rent, not a sum: "залог 2 месяца", "депозит — месячная оплата". The span
// is the count with its unit ("2 месяца"); turning it into money is arithmetic on the listing's price, done after
// the model, never by it.
const MONTH_UNIT = String.raw`(?:мес\p{L}*|місяц\p{L}*|luni|lun[ăa]|oy(?![\p{L}])|oylik)`;
const MONTH_COUNT = String.raw`(?:\d{1,2}|один|одна|одного|одну|два|двух|две|три|трёх|трех|четыре|пять|полтора|півтора|перв(?:ый|ого|ых|ые)|перш(?:ий|ого)|bir|ikki|uch|o|două|doua|trei)`;
// "без залога", "залог не нужен", "fără garanție": no deposit. The span is the statement itself.
const NO_DEPOSIT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:без\s+(?:залог\p{L}*|депозит\p{L}*|застав\p{L}*)|(?:залог\p{L}*|депозит\p{L}*|застав\p{L}*)\s+(?:не\s+(?:нужен|нужна|нужно|требуется|берется|берётся|надо)|нет|отсутствует)|fără\s+(?:garan[țt]\p{L}*|depozit\p{L}*)|fara\s+(?:garantie|depozit\p{L}*)|depozit\p{L}*\s+yo['ʻ’]q|depozitsiz)(?![\p{L}\p{N}])`,
  'giu',
);
const MONTHS_PHRASE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${MONTH_COUNT}[  ]?${MONTH_UNIT}|месячн\p{L}*(?:[  ]+арендн\p{L}*)?[  ]+(?:оплат|плат|аренд)\p{L}*)`, 'giu');

/** Amounts with a deposit / utilities cue: [{ kind, start, end, marker, months? }]; `mentioned` is true when a cue is in the text at all. */
export function findCuedAmounts(text) {
  const found = [];
  let mentioned = false;
  for (const [kind, re] of AMOUNT_CUES) {
    const cues = [...text.matchAll(new RegExp(re.source, 'giu'))];
    if (cues.length) mentioned = true;
    if (kind === 'PREPAYMENT') continue; // months only, below
    for (const match of text.matchAll(NUMBER)) {
      let end = match.index + match[0].length;
      let value = numberValue(match[0]);
      const suffix = THOUSANDS_SUFFIX.exec(text.slice(end));
      if (suffix) { value *= 1000; end += suffix[0].length; }
      if (value < 1) continue;
      if (text[match.index - 1] === '+' && /^[\s-]*[*\d(]/.test(text.slice(end, end + 4))) continue; // "+998 ** *** ****" is a phone
      const marker = markerAt(text, end, 'after') ?? markerAt(text, match.index, 'before');
      // a fee is often a percentage ("комиссия 50%"): the sign belongs to the span. For the others a % is no amount.
      const percent = kind === 'COMMISSION' ? PERCENT_AFTER.exec(text.slice(end, end + 12)) : null;
      if (percent) end += percent[0].length;
      else if (NOT_MONEY_AFTER.test(text.slice(end, end + 12))) continue; // "100%", "83 mp", "1 месяц"
      const cueBefore = cues.some((c) => {
        const gap = text.slice(c.index + c[0].length, match.index);
        return c.index < match.index && CUE_THEN_AMOUNT.test(gap) && !NEGATION_AFTER.test(gap)
          && !NEGATED.test(text.slice(Math.max(0, c.index - 8), c.index));
      });
      if (cueBefore) found.push({ kind, start: match.index, end, marker });
    }
  }
  // before a number of months "depozit" is a deposit (Uzbek, Romanian): a warehouse is never rented for "два месяца"
  const depositCues = [...text.matchAll(new RegExp(String.raw`${AMOUNT_CUES[0][1].source}|depozit\p{L}*`, 'giu'))];
  const commissionCues = [...text.matchAll(new RegExp(AMOUNT_CUES[2][1].source, 'giu'))];
  const prepayCues = [...text.matchAll(new RegExp(AMOUNT_CUES[3][1].source, 'giu'))];
  const gapOk = (c, at) => {
    const gap = text.slice(c.index + c[0].length, at);
    return c.index < at && CUE_THEN_AMOUNT.test(gap) && !NEGATION_AFTER.test(gap) && !NEGATED.test(text.slice(Math.max(0, c.index - 8), c.index));
  };
  // The closest cue before the months decides what they are: in "avans o luna plus garantia o luna" the first month is
  // paid in advance and the second is the deposit, though "avans" is before both.
  const nearestBefore = (at) => {
    let best = null;
    for (const [kind, cues] of [['DEPOSIT', depositCues], ['COMMISSION', commissionCues], ['PREPAYMENT', prepayCues]]) {
      for (const c of cues) if (gapOk(c, at) && (!best || c.index > best.index)) best = { kind, index: c.index };
    }
    return best?.kind ?? null;
  };
  // a word right after the months settles it: "2 месяца вперёд" is a prepayment, "1 luna garanție" a deposit
  const KIND_AFTER = [
    ['DEPOSIT', /^[\s ]{0,2}(?:залог\p{L}*|депозит\p{L}*|deposit|depozit\p{L}*|garan[țt]\p{L}*)/iu],
    ['COMMISSION', /^[\s ]{0,2}(?:комисс\p{L}*|комісі\p{L}*|comision\p{L}*)/iu],
  ];
  const inAdvance = new Set();
  for (const m of text.matchAll(MONTHS_PHRASE)) {
    const end = m.index + m[0].length;
    const tail = text.slice(end, end + 16);
    const kind = FORWARD_WORD.test(tail) ? 'PREPAYMENT' : KIND_AFTER.find(([, re]) => re.test(tail))?.[0] ?? nearestBefore(m.index);
    if (!kind) continue;
    found.push({ kind, start: m.index, end, marker: null, months: true });
    if (kind === 'PREPAYMENT') inAdvance.add(m.index);
  }
  // "месяц вперёд": one month, no count written
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])${MONTH_UNIT}(?=[\s ]{1,2}(?:вперед|вперёд|наперед|наперёд)(?![\p{L}]))`, 'giu'))) {
    if (!inAdvance.has(m.index) && !found.some((f) => f.start < m.index + m[0].length && m.index < f.end)) {
      found.push({ kind: 'PREPAYMENT', start: m.index, end: m.index + m[0].length, marker: null, months: true });
    }
  }
  for (const m of text.matchAll(NO_DEPOSIT)) found.push({ kind: 'DEPOSIT', start: m.index, end: m.index + m[0].length, marker: null, none: true });
  for (const m of text.matchAll(NO_COMMISSION)) found.push({ kind: 'COMMISSION', start: m.index, end: m.index + m[0].length, marker: null, none: true });
  // a number claimed by both kinds ("залог и коммунальные 100$") is ambiguous: neither
  const count = new Map();
  for (const f of found) count.set(f.start, (count.get(f.start) ?? 0) + 1);
  return { amounts: found.filter((f) => count.get(f.start) === 1), mentioned };
}

function alignPrice(text, price, currency, excluded = []) {
  if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0) return { state: 'ignore' };
  const target = Number(price);
  const withMarker = [];
  const bare = [];
  // Other amounts with a currency next to them (deposit, commission, a second
  // price): real money mentions, just not this listing's price. They are neither
  // positives nor negatives -- the loss skips them and they are not scored.
  const neutral = [];
  for (const match of text.matchAll(NUMBER)) {
    let end = match.index + match[0].length;
    let value = numberValue(match[0]);
    const suffix = THOUSANDS_SUFFIX.exec(text.slice(end));
    if (suffix) { value *= 1000; end += suffix[0].length; }
    if (excluded.some((e) => e.start < end && match.index < e.end)) continue; // a deposit, not the price
    const candidate = { start: match.index, end };
    const marker = markerAt(text, end, 'after') ?? markerAt(text, match.index, 'before');
    if (Math.abs(value - target) > 0.5) {
      if (marker && value >= 1) {
        neutral.push({ label: 'PRICE', ...candidate }, { label: 'CURRENCY', start: marker.start, end: marker.end });
      }
      continue;
    }
    if (marker) withMarker.push({ ...candidate, marker });
    else bare.push(candidate);
  }
  if (withMarker.length) {
    const wanted = String(currency || '').toUpperCase();
    const agree = withMarker.filter((c) => !wanted || c.marker.code === wanted);
    // A marker that contradicts the stored currency means the stored price was
    // converted or the number is something else: do not trust either.
    if (!agree.length) return { state: 'ignore' };
    return {
      state: 'found',
      prices: agree.map(({ start, end }) => ({ start, end })),
      markers: agree.map((c) => c.marker),
      neutral,
    };
  }
  const written = new Set(bare.map((c) => text.slice(c.start, c.end)));
  if (bare.length === 1 || (bare.length <= 3 && written.size === 1 && target >= 100)) {
    return { state: 'found', prices: bare, markers: [], neutral };
  }
  return { state: 'ignore' };
}

// ---- address --------------------------------------------------------------

// Street-type words. The left side needs a word boundary: without it the "пер"
// in "Су|пер" reads as "переулок" and the span starts mid-word.
const STREET_TYPES = String.raw`(?:улица|ул|вулиця|вул|проспект|просп|пр-т|пр-кт|пр|бульвар|бул|б-р|переулок|пер|проезд|шоссе|шосе|площадь|пл|микрорайон|мкр|strada|str|bulevardul|b-dul|bdul|bd|calea|șos)`;
const STREET_PREFIX = unicode(new RegExp(String.raw`\b${STREET_TYPES}\.?[  ]*$`, 'i'));
const OTHER_STREET = new RegExp(unicode(new RegExp(
  String.raw`\b${STREET_TYPES}\.?[  ]*\p{Lu}[\p{L}'’-]*(?:[  ]+\p{Lu}[\p{L}'’-]*){0,2}`, 'giu',
)).source, 'giu');
const HOUSE_AFTER = /^[  ]*,?[  ]*(?:дом\.?[  ]*|д\.?[  ]*|буд\.?[  ]*|№[  ]*|nr\.?[  ]*)?(\d{1,4}(?:[/-]\d{1,3})?(?:[  ]?[А-Яа-яA-Za-z](?![\p{L}\d]))?)(?![\d])/u;
const NOT_A_HOUSE = unicode(/^(?:-\p{L}|[\s ]*(?:к\b|комн|кімн|кім|rooms?|camere|хв|мин|min|эт|поверх|этаж|кв\b|м2|м²|кв\.?\s?м|sqm|mp\b|м\b|\$|грн|usd|eur|€|₴|тис|тыс|%|соток|сотк))/i);
const OPENING_HOURS = /^\d{1,2}\/7$/;
const STREET_LIKE = unicode(/(?:ул|вул|улица|вулиця|просп|пр-т|бульвар|бул|strada|str)\.?[\s ]*\p{Lu}/iu);
// With no stored address, a text that still looks like it names a place is not
// evidence of "no address": it may simply be one the database never captured.
const ADDRESS_HINT = unicode(/\b(?:адрес|адреса|адресу|manzil|manzili|adres|adresa|address)\b/i);
const NUMBERED_NOUN = unicode(/\b(?:этаж|площадь|комнат|комнаты|цена|ціна|поверх|кімнат|площа|rooms?|etaj|camere|xonalar|qavat|narxi|год|рік|года|тел|ID|№)\b/i);
const NAME_NUMBER = /\p{Lu}[\p{L}'’-]{3,}[  ,]+\d{1,3}(?:[/-]\d{1,3})?(?![\d\p{L}])/gu;

function looksLikeAddress(text) {
  if (STREET_LIKE.test(text) || ADDRESS_HINT.test(text)) return true;
  for (const m of text.matchAll(NAME_NUMBER)) if (!NUMBERED_NOUN.test(m[0])) return true;
  return false;
}

// Listing words that end up in the address column when its parser overran.
const NOT_A_STREET = unicode(/^(?:сдам|сдаю|сдаётся|сдается|продам|продаю|продаётся|продается|здам|здаю|продаж|оренда|аренда|квартира|кімната|комната|квартиру|кімнату|комнату|посуточно|добово|station|just|near|close|beautiful|located|apartment|flat|room|rooms|available|bedroom|the|for|with)\b/i);

export function streetKey(row) {
  const raw = row.street || row.address;
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;]|\s\d/)[0]
    .replace(/^(?:улица|ул|вулиця|вул|проспект|просп|пр-т|бульвар|бул|переулок|пер|проезд|шоссе|площадь|пл|strada|str)\.?\s*/iu, '')
    .split(/[.!?\n]/u)[0] // stored addresses sometimes run on into the next sentence
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ');
  if (cleaned.length < 4 || words.length > 4 || !/^\p{L}{3}/u.test(cleaned)) return null;
  if (NOT_A_STREET.test(cleaned)) return null;
  return cleaned;
}

function houseAfter(text, end) {
  const after = text.slice(end);
  const house = HOUSE_AFTER.exec(after);
  if (!house || NOT_A_HOUSE.test(after.slice(house[0].length)) || OPENING_HOURS.test(house[1])) return null;
  return house[0].length;
}

// "Адмиральском проспекте", "Люстдорфська дорога", "Sagdiana masjid ko'chasi": the type follows the name.
const STREET_SUFFIX = /^[  ]?(?:проспект\p{L}*|просп\.?|дорог\p{L}*|шосе|шоссе|вулиц\p{L}*|вул\.?|улиц\p{L}*|ул\.?|bulvar\p{L}*|бульвар\p{L}*|переул\p{L}*|пров\.?|kocha\p{L}*|ko['ʻ’`]cha\p{L}*|кўча\p{L}*|куча\p{L}*|strada|str\.)(?![\p{L}])/iu;
// a name of one to three capitalised words followed by such a type: another street in the text
const OTHER_STREET_SUFFIX = new RegExp(String.raw`\p{Lu}[\p{L}'’.-]*(?:[  ]+\p{Lu}[\p{L}'’.-]*){0,2}[  ]+(?:проспект\p{L}*|дорог\p{L}*|шосе|шоссе|bulvar\p{L}*|kocha\p{L}*|ko['ʻ’]cha\p{L}*)(?![\p{L}])`, 'gu');

function alignAddress(text, row) {
  const stored = Boolean(row.address || row.street);
  if (!stored) return looksLikeAddress(text) ? { state: 'ignore' } : { state: 'absent' };
  const key = streetKey(row);
  if (!key) return { state: 'ignore' };
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ \\u00a0]+'); // a street name never spans lines
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  const spans = [];
  for (const match of text.matchAll(re)) {
    let start = match.index;
    let end = start + match[0].length;
    const prefix = STREET_PREFIX.exec(text.slice(Math.max(0, start - 16), start));
    const suffix = STREET_SUFFIX.exec(text.slice(end, end + 16));
    if (suffix) end += suffix[0].length; // the type after the name belongs to the street
    // "пр. Героев Харькова (пр. Московский) 198/2": the note in brackets is part of the address when a house follows it
    const note = /^[  ]?\([^()\n]{1,40}\)/u.exec(text.slice(end));
    if (note && houseAfter(text, end + note[0].length)) end += note[0].length;
    const house = houseAfter(text, end);
    // A bare word may be a district or a name; unprefixed, it must at least be capitalised.
    if (!prefix && !suffix && !(house && /^\p{Lu}/u.test(match[0]))) continue;
    if (prefix) start -= prefix[0].length;
    if (house) end += house;
    spans.push({ start, end });
  }
  if (!spans.length) return { state: 'ignore' };
  // Other streets named in the same text are real addresses, just not the stored one.
  const neutral = [];
  for (const m of text.matchAll(OTHER_STREET)) {
    let end = m.index + m[0].length;
    const house = houseAfter(text, end);
    if (house) end += house;
    if (!spans.some((s) => s.start < end && m.index < s.end)) neutral.push({ label: 'ADDRESS', start: m.index, end });
  }
  for (const m of text.matchAll(OTHER_STREET_SUFFIX)) {
    let end = m.index + m[0].length;
    const house = houseAfter(text, end);
    if (house) end += house;
    if (!spans.some((s) => s.start < end && m.index < s.end) && !neutral.some((n) => n.start < end && m.index < n.end)) {
      neutral.push({ label: 'ADDRESS', start: m.index, end });
    }
  }
  return { state: 'found', spans, neutral };
}

// ---- metro ----------------------------------------------------------------

const METRO_WORD = unicode(/метро|metro|metrou|м\.\s*\p{Lu}/iu);
const WORD = /\p{L}[\p{L}'’ʻ`-]*(?<![-'’ʻ`])/gu; // no trailing hyphen or apostrophe

// Some stations are named after a city: "Toshkent" is a station of the Tashkent
// metro and is stored on thousands of listings. The same word in "Тошкент шахар"
// is the city, so such a name counts as a station only with a metro cue next to it.
const CITY_NAMED = ['Toshkent', 'Tashkent', 'Тошкент', 'Ташкент', 'Kyiv', 'Київ', 'Киев', 'Moskva', 'Москва', 'Bucuresti', 'București'];
let cityNamedSkeletons = null; // built lazily: skeleton() depends on tables defined further down
const isCityNamed = (sk) => (cityNamedSkeletons ??= new Set(CITY_NAMED.map((n) => skeleton(n)))).has(sk);
const CUE_BEFORE = /(?:метро|metro|metrou|станци[яи]|stansiya|bekat|бекат|м\.)[\s "«'‘ʻ:-]{0,6}$/iu;
const CUE_AFTER = /^[\s ]{0,2}(?:метро|metro|metrosi|metrou|станци)/iu;
function hasMetroCue(text, start, end) {
  return CUE_BEFORE.test(text.slice(Math.max(0, start - 30), start)) || CUE_AFTER.test(text.slice(end, end + 14));
}

// Words repeat endlessly across listings; skeletons are pure functions of the word.
const skeletonCache = new Map();
function wordSkeleton(word) {
  let s = skeletonCache.get(word);
  if (s === undefined) {
    s = skeleton(word);
    if (skeletonCache.size > 200_000) skeletonCache.clear();
    skeletonCache.set(word, s);
  }
  return s;
}

/** Windows of 1-3 words whose skeleton is a known station; used for neutral/ignore decisions. */
function stationMentions(text, stations, ambiguous) {
  const words = [...text.matchAll(WORD)];
  const sk = words.map((w) => wordSkeleton(w[0]));
  const found = [];
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
      if (n > 1) {
        const prev = words[i + n - 2];
        const gap = text.slice(prev.index + prev[0].length, words[i + n - 1].index);
        if (!/^[  -]+$/u.test(gap)) break;
      }
      joined = (joined + sk[i + n - 1]).replace(/(.)\1+/g, '$1');
      if (joined.length >= 4 && stations.has(joined)) {
        const last = words[i + n - 1];
        const mention = { skeleton: joined, start: words[i].index, end: last.index + last[0].length };
        // A city-named station without a metro cue is just the city; a station that is also a district
        // ("Чиланзар", "Алмазар") is a station only with one.
        const needsCue = isCityNamed(joined) || ambiguous?.has(loose(joined));
        if (!needsCue || hasMetroCue(text, mention.start, mention.end)) found.push(mention);
      }
    }
  }
  return found;
}

function alignMetro(text, row, stations, groups, ambiguous) {
  const name = row.metro && String(row.metro).replace(/\s+/g, ' ').trim();
  if (!name) {
    // A station name in a text with no stored station is as likely a district
    // ("Юнусабад", "Chilonzor") as a station: without a metro cue it is not evidence of "no station".
    // With one ("метро Ойбек", "на Ойбеке у метро") the person marks it, so it is labelled.
    const mentions = stations?.size ? stationMentions(text, stations, ambiguous) : [];
    if (mentions.length) {
      const cued = [];
      for (const m of mentions.sort((x, y) => x.start - y.start || y.end - x.end)) {
        if (cued.some((c) => c.start < m.end && m.start < c.end)) continue;
        if (hasMetroCue(text, m.start, m.end)) cued.push({ start: m.start, end: m.end });
      }
      return cued.length ? { state: 'found', spans: cued, neutral: [] } : { state: 'ignore' };
    }
    return METRO_WORD.test(text) ? { state: 'ignore' } : { state: 'absent' };
  }
  const target = skeleton(name);
  if (target.length < 4) return { state: 'ignore' };
  // The stored "Toshkent" is "Ташкент" in a Russian text: every spelling of a city name is one station.
  // The lexicon knows other spellings of the same station ("Дружба Народов" for Xalqlar Dostligi).
  const same = groups?.get(target);
  const accepts = isCityNamed(target) ? isCityNamed : (sk) => sk === target || same?.has(sk);
  const words = [...text.matchAll(WORD)];
  const spans = [];
  for (let i = 0; i < words.length; i += 1) {
    let hit = 0;
    for (let n = 1; n <= 4 && i + n <= words.length; n += 1) {
      if (n > 1) {
        const gap = text.slice(words[i + n - 2].index + words[i + n - 2][0].length, words[i + n - 1].index);
        if (!/^[  -]+$/u.test(gap)) break;
      }
      const joined = words.slice(i, i + n).map((w) => w[0]).join('');
      if (accepts(skeleton(joined))) hit = n;
    }
    if (hit) {
      const last = words[i + hit - 1];
      spans.push({ start: words[i].index, end: last.index + last[0].length });
      i += hit - 1;
    }
  }
  if (!spans.length) return { state: 'ignore' };
  const neutral = [];
  let positives = spans;
  if (isCityNamed(target) || ambiguous?.has(loose(target))) {
    // Mentions of the city itself, or of the district of the same name, are neither stations nor "no station": skip them in the loss.
    positives = spans.filter((s) => hasMetroCue(text, s.start, s.end));
    for (const s of spans) if (!positives.includes(s)) neutral.push({ label: 'METRO', start: s.start, end: s.end });
    if (!positives.length) return { state: 'ignore' };
  }
  if (stations?.size) {
    for (const m of stationMentions(text, stations, ambiguous)) {
      if (accepts(m.skeleton)) continue;
      if (!spans.some((s) => s.start < m.end && m.start < s.end)) neutral.push({ label: 'METRO', start: m.start, end: m.end });
    }
  }
  return { state: 'found', spans: positives, neutral };
}

// Stored station names are transliterated ("Saltivska") while the text uses the
// local script ("Салтівська"). Both are reduced to one rough phonetic alphabet
// and compared, so either spelling lines up with the other.
const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'h', д: 'd', е: 'e', є: 'e', ё: 'o', ж: 'z', з: 'z', и: 'i', і: 'i',
  ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a', ў: 'u', қ: 'k',
  ғ: 'h', ҳ: 'h',
};
const LATIN_RULES = [
  [/shch|sch/g, 's'], [/sh/g, 's'], [/ch/g, 'c'], [/zh/g, 'z'], [/kh/g, 'h'], [/ts/g, 'c'],
  [/y[aä]|j[aä]/g, 'a'], [/yu|ju/g, 'u'], [/ye|je/g, 'e'], [/yo|jo/g, 'o'], [/[yj]/g, 'i'],
  [/[gx]/g, 'h'], [/q/g, 'k'], [/w/g, 'v'], [/[șş]/g, 's'], [/[țţ]/g, 'c'], [/[ăâ]/g, 'a'], [/î/g, 'i'],
];

/**
 * Loose skeletons of names that are both a station and a district (Чиланзар, Алмазар): given the lexicon's
 * station alias groups and its district names. Such a name is a station only next to a metro cue.
 */
export function ambiguousStations(metroGroups, districtNames) {
  const districts = new Set(districtNames.map((n) => loose(skeleton(n))));
  const found = new Set();
  for (const names of metroGroups) {
    const sks = names.map((n) => loose(skeleton(n))).filter((x) => x.length >= 4);
    if (sks.some((x) => districts.has(x))) sks.forEach((x) => found.add(x));
  }
  return found;
}

/** Skeleton -> skeletons of every spelling of the same station, from groups of aliases (the lexicon's). */
export function stationGroups(groups) {
  const map = new Map();
  for (const names of groups) {
    const sks = new Set(names.map(skeleton).filter((x) => x.length >= 4));
    for (const sk of sks) map.set(sk, new Set([...(map.get(sk) ?? []), ...sks]));
  }
  return map;
}

/**
 * Skeletons of station names that recur across `names` (stored metro values).
 * A name seen once or twice is more likely a typo or a district than a station.
 */
export function stationSkeletons(names, minCount = 8, trusted = []) {
  const counts = new Map();
  for (const name of names) {
    const s = skeleton(name);
    if (s.length >= 4) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const found = new Set([...counts].filter(([, n]) => n >= minCount).map(([s]) => s));
  // names from the shared lexicon need no frequency threshold: it is the vetted list
  for (const name of trusted) {
    const s = skeleton(name);
    if (s.length >= 4) found.add(s);
  }
  return found;
}

export function skeleton(value) {
  let s = String(value).toLowerCase().replace(/[^\p{L}]/gu, '');
  s = [...s].map((ch) => (ch in CYRILLIC ? CYRILLIC[ch] : ch)).join('');
  for (const [re, to] of LATIN_RULES) s = s.replace(re, to);
  return s.replace(/(.)\1+/g, '$1');
}

// ---- district / locality ----------------------------------------------------
//
// A district, microdistrict or locality (Глинка, Гидропарк, "Шевченківський район") is labelled from
// the database columns district / area / kvartal. Those hold canonical Latin names ("Shevchenkivskyi")
// while texts write local script and decline them ("в Шевченківському районі"), so a name is matched
// by the same phonetic skeleton as stations, with room for a case ending. The generic noun next to a
// name ("район", "мкр", "массив") belongs to the span, as a person selecting it would include it.

const DISTRICT_NOUN = /^(?:район\p{L}*|р-н|р-он|мкр|мікрорайон\p{L}*|микрорайон\p{L}*|массив\p{L}*|квартал\p{L}*|махалл\p{L}*|махаля\p{L}*|mahall\p{L}*|мфй|місцевіст\p{L}*|местност\p{L}*|mavze\p{L}*|hudud\p{L}*|tuman\p{L}*|raion\p{L}*|sector\p{L}*|cartier\p{L}*)$/iu;
const isDistrictNoun = (word) => DISTRICT_NOUN.test(word);
// The noun next to a name says what kind of place it is.
const MICRO_NOUN = /^(?:мкр|мікрорайон\p{L}*|микрорайон\p{L}*|массив\p{L}*|квартал\p{L}*|махалл\p{L}*|махаля\p{L}*|mahall\p{L}*|мфй|cartier\p{L}*)$/iu;
const LOCALITY_NOUN = /^(?:місцевіст\p{L}*|местност\p{L}*|mavze\p{L}*|hudud\p{L}*)$/iu;
const nounKind = (word) => (MICRO_NOUN.test(word) ? 'MICRODISTRICT' : LOCALITY_NOUN.test(word) ? 'LOCALITY' : 'DISTRICT');
const isCapital = (word) => /^\p{Lu}/u.test(word);
const isCyrillic = (word) => /\p{Script=Cyrillic}/u.test(word);
const NAME_GAP = /^[ \u00a0.:\-–—«"“]{0,3}$/u; // between a generic noun and the name after it
const NAME_GAP_NO_DOT = new RegExp(NAME_GAP.source.replace('.', ''), 'u'); // after a whole word the dot ends the sentence
const ABBREVIATION = /^(?:мкр|р-н|р-он)$/iu;
const gapAfter = (noun) => (ABBREVIATION.test(noun) ? NAME_GAP : NAME_GAP_NO_DOT);
const WORD_GAP = /^[ \u00a0-]*$/u;

// The part of a skeleton that survives a case ending: "sevcenkivski" also matches "sevcenkivskomu".
const stemOf = (sk) => sk.slice(0, sk.length - (sk.length >= 9 ? 3 : sk.length >= 6 ? 1 : 0));

// Uzbek names are written both ways ("Yashnabod" / "Yashnabad", "Шайхантахур" / "Шайхантохур"); when
// matching a district, a and o count as the same letter.
const loose = (sk) => sk.replace(/a/g, 'o');
// Values of the district / area columns that are not a place at all (the column also holds landmarks).
const NOT_A_DISTRICT_NAME = /^(?:центр\p{L}*(?:\s+города)?|все|вокзал|жд\s+вокзал|универмаг|первая\s+аптека|аэропорт|аеропорт|старый\s+город|новый\s+город|остановка.*)$/iu;

// `district` holds administrative districts; `area` and `kvartal` hold everything smaller, microdistricts
// and named places mixed, which the lexicon (placeKinds) tells apart where it knows the name.
function districtTargets(row) {
  const targets = [];
  for (const [value, kind] of [[row.district, 'DISTRICT'], [row.area, 'LOCALITY'], [row.kvartal, 'LOCALITY']]) {
    const name = value && String(value).trim();
    if (!name || /\d/.test(name)) continue; // "2 kvartal" is a quarter number, not a name
    const sk = loose(skeleton(name));
    if (sk.length >= 5 && !targets.some((t) => t.sk === sk)) targets.push({ sk, stem: stemOf(sk), kind });
  }
  return targets;
}

/** Skeletons of the city names of a lexicon ({type, names} entries), to tell "районе Одессы" from a district. */
export function citySkeletons(entries) {
  const found = new Set();
  for (const { type, names } of entries) {
    if (type !== 'city') continue;
    for (const name of names) {
      const sk = skeleton(name);
      if (sk.length >= 5) found.add(sk);
    }
  }
  return [...found];
}

/**
 * Loose skeleton -> kind of place, from the lexicon's typed entries ({type, names}). A name the lexicon calls
 * a district is a DISTRICT even where the `area` column stores it; the most administrative type wins.
 */
export function placeKinds(entries) {
  const KIND = { district: 'DISTRICT', microdistrict: 'MICRODISTRICT', mahalla: 'MICRODISTRICT', local_area: 'LOCALITY', suburb: 'LOCALITY', informal_area: 'LOCALITY', settlement: 'LOCALITY', development_area: 'LOCALITY' };
  const rank = (kind) => DISTRICT_KINDS.indexOf(kind);
  const map = new Map();
  for (const { type, names } of entries) {
    const kind = KIND[type];
    if (!kind) continue;
    for (const name of names) {
      if (/\d/.test(name)) continue;
      const sk = loose(skeleton(name));
      if (sk.length >= 5 && (!map.has(sk) || rank(kind) < rank(map.get(sk)))) map.set(sk, kind);
    }
  }
  return map;
}

/**
 * Index of district names seen across the whole dataset (stored values), for rows that store none.
 * An item is a name or `{ name, kind }` (the kind of the column it came from); a name keeps the kind it was
 * stored under most often.
 */
export function districtIndex(names, minCount = 8, trusted = []) {
  const counts = new Map();
  const kinds = new Map();
  const add = (item, weight) => {
    const name = typeof item === 'string' ? item : item.name;
    const s = String(name).trim();
    if (!s || /\d/.test(s) || NOT_A_DISTRICT_NAME.test(s)) return;
    const sk = loose(skeleton(s));
    if (sk.length < 5) return;
    counts.set(sk, (counts.get(sk) ?? 0) + weight);
    const kind = (typeof item === 'string' ? null : item.kind) ?? 'LOCALITY';
    if (!kinds.has(sk)) kinds.set(sk, {});
    kinds.get(sk)[kind] = (kinds.get(sk)[kind] ?? 0) + weight;
  };
  for (const name of names) add(name, 1);
  for (const name of trusted) add(name, minCount); // the shared lexicon is vetted: no frequency threshold
  const index = new Map();
  for (const [sk, n] of counts) {
    if (n < minCount) continue;
    const key = sk.slice(0, 4);
    if (!index.has(key)) index.set(key, []);
    const [kind] = Object.entries(kinds.get(sk)).sort((a, b) => b[1] - a[1])[0];
    index.get(key).push({ sk, stem: stemOf(sk), kind });
  }
  return index;
}

function matchesTarget(joined, target) {
  return joined.startsWith(target.stem) && joined.length <= target.stem.length + 8; // "-ский" + a case ending
}

/** Windows of 1-3 words whose joined skeleton satisfies `test`; the longest window at each start wins. */
function findWindows(text, tokens, sks, test) {
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let best = 0;
    let joined = '';
    for (let n = 1; n <= 3 && i + n <= tokens.length; n += 1) {
      if (n > 1) {
        const prev = tokens[i + n - 2];
        if (!WORD_GAP.test(text.slice(prev.index + prev[0].length, tokens[i + n - 1].index))) break;
      }
      joined = (joined + sks[i + n - 1]).replace(/(.)\1+/g, '$1');
      if (test(joined)) { best = n; break; } // the shortest window: a longer one swallows the next words
    }
    if (best) { found.push({ i, n: best }); i += best - 1; }
  }
  return found;
}

/** The window plus the generic noun right next to it ("Староміський" + "район"). */
function withNoun(text, tokens, w) {
  let a = w.i;
  let b = w.i + w.n - 1;
  let noun = null; // a generic noun beside the name says what kind of place it is
  const prev = tokens[a - 1];
  const next = tokens[b + 1];
  if (prev && isDistrictNoun(prev[0]) && gapAfter(prev[0]).test(text.slice(prev.index + prev[0].length, tokens[a].index))) {
    noun = prev[0];
    if (isCyrillic(prev[0])) a -= 1;
  } else if (next && isDistrictNoun(next[0]) && NAME_GAP.test(text.slice(tokens[b].index + tokens[b][0].length, next.index))) {
    noun = next[0];
    if (isCyrillic(next[0])) b += 1;
  }
  return { start: tokens[a].index, end: tokens[b].index + tokens[b][0].length, kind: noun ? nounKind(noun) : null };
}

/** "район X", "мкр X Y", "X район": a district named in the text, stored or not. */
function districtPhrases(text, tokens) {
  const phrases = [];
  tokens.forEach((token, k) => {
    if (!isDistrictNoun(token[0])) return;
    if (/\d[\s .-]*$/.test(text.slice(Math.max(0, token.index - 6), token.index))) return; // "22 квартал"
    const withWord = isCyrillic(token[0]); // the noun belongs to the span only in Cyrillic
    const name = [];
    for (let j = k + 1; j < tokens.length && name.length < 3; j += 1) {
      const gap = text.slice(tokens[j - 1].index + tokens[j - 1][0].length, tokens[j].index);
      if (!(j === k + 1 ? gapAfter(token[0]) : WORD_GAP).test(gap) || !isCapital(tokens[j][0]) || isDistrictNoun(tokens[j][0])) break;
      name.push(j);
    }
    if (name.length) {
      const last = tokens[name[name.length - 1]];
      phrases.push({ start: withWord ? token.index : tokens[name[0]].index, end: last.index + last[0].length, kind: nounKind(token[0]) });
    } else if (k > 0 && isCapital(tokens[k - 1][0]) && WORD_GAP.test(text.slice(tokens[k - 1].index + tokens[k - 1][0].length, token.index))) {
      phrases.push({ start: tokens[k - 1].index, end: withWord ? token.index + token[0].length : tokens[k - 1].index + tokens[k - 1][0].length, kind: nounKind(token[0]) });
    }
  });
  return phrases;
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// A district is labelled wherever its name appears, not only where this row stores it: the names the
// row stores, any name seen often enough across the dataset (a person marks "Оболонь" or "Чиланзар"
// wherever it is written), and "район X" / "мкр X" phrases. Unlabelled where the column holds a name
// the text never writes: ignored, since the canonical form need not appear.
// A district is labelled wherever its name appears, not only where this row stores it: the names the
// row stores, any name seen often enough across the dataset (a person marks "Оболонь" or "Чиланзар"
// wherever it is written), and "район X" / "мкр X" phrases. Three guards, learned from hand labels:
//  * a name from the dataset-wide list must start with a capital ("manzarasi" is "view", "centrală" a boiler);
//  * four or more districts close together are an agency's list of where it offers flats, not where this one is;
//  * a name the column stores but the text never writes is ignored, since the canonical form need not appear.
// "Юнусабад-11", "Чиланзар-9": a district's name with the number of its microdistrict or quarter.
const NUMBERED_PLACE = /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’]{3,})[-–](\d{1,2})(?![\d])/gu;
// a district's name, a space and a number that ends the phrase: "Сергели 5", "Chilonzor 22 kvartal"
const NAME_SPACE_NUMBER = /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’]{3,})[  ](\d{1,2})(?:[  ](?:kvartal\p{L}*|квартал\p{L}*|кв\.?(?![\p{L}\p{N}])))?(?=\s*(?:$|[\n,.;)!?]))/gmu;
const NUMBER_THEN_NOUN = /(?<![\p{L}\p{N}])(\d{1,2})[-\s]?(?:й|м|го|ый|ом|ий|а|я)?[-\s]?(мкр\p{L}*|микрорайон\p{L}*|мікрорайон\p{L}*|mavze\p{L}*|мавзе\p{L}*)(?![\p{L}\p{N}])/giu;
// words that follow "район" in an advertisement, not a name
const NOT_A_PLACE_WORD = /(?:^|[\s-])(?:centrală|centrala|вигідно|выгодно|доступн\p{L}*|спальн\p{L}*|престижн\p{L}*|тих\p{L}*|зелен\p{L}*|окраинн\p{L}*|перспективн\p{L}*|популярн\p{L}*|красив\p{L}*)(?![\p{L}])/iu;
const REGION_AFTER = /^[  ]?(?:область|обл\.?|region|judet|județ|oblast)(?![\p{L}])/iu; // "Київська область" is not a district

function alignDistrict(text, row, districts, kinds, cities) {
  const tokens = [...text.matchAll(WORD)];
  const sks = tokens.map((w) => loose(wordSkeleton(w[0])));
  let spans = [];
  const add = (span) => { if (!spans.some((s) => overlaps(s, span))) spans.push(span); };
  const joinedOf = (w) => sks.slice(w.i, w.i + w.n).join('').replace(/(.)\1+/g, '$1');
  // the kind: the noun in the text, else what the lexicon calls the name, else the column it was stored in
  const kindFor = (span, joined, stored) => {
    if (span.kind) return span.kind;
    if (stored === 'DISTRICT') return 'DISTRICT';
    const typed = kinds && [...kinds].find(([sk]) => matchesTarget(joined, { stem: stemOf(sk), slack: 8 }));
    return typed ? typed[1] : stored;
  };

  const targets = districtTargets(row);
  const knownName = (sk) => targets.some((t) => matchesTarget(sk, t)) || (districts?.get(sk.slice(0, 4)) ?? []).some((t) => matchesTarget(sk, t));
  for (const m of text.matchAll(NUMBER_THEN_NOUN)) { // "22 мкрда": the number belongs to the name
    add({ start: m.index, end: m.index + m[0].length, kind: 'MICRODISTRICT', stored: true });
  }
  // "Сергели 5", "Юнусабад-11": the microdistrict with its number, and the district it belongs to, which a person
  // marks as well (spans of different kinds may overlap)
  const alongside = [];
  const districtOf = (sk) => targets.find((t) => matchesTarget(sk, t))?.kind ?? (districts?.get(sk.slice(0, 4)) ?? []).find((t) => matchesTarget(sk, t))?.kind;
  const numbered = (m) => {
    const sk = loose(wordSkeleton(m[1]));
    if (sk.length < 5 || !knownName(sk)) return;
    add({ start: m.index, end: m.index + m[0].length, kind: 'MICRODISTRICT', stored: true });
    if (districtOf(sk) === 'DISTRICT') alongside.push({ start: m.index, end: m.index + m[1].length, kind: 'DISTRICT', stored: true });
  };
  for (const m of text.matchAll(NAME_SPACE_NUMBER)) numbered(m);
  for (const m of text.matchAll(NUMBERED_PLACE)) numbered(m); // before the plain names, so the number stays in the span
  if (targets.length) {
    for (const w of findWindows(text, tokens, sks, (joined) => targets.some((t) => matchesTarget(joined, t)))) {
      const joined = joinedOf(w);
      const stored = targets.find((t) => matchesTarget(joined, t)).kind;
      const span = withNoun(text, tokens, w);
      add({ ...span, kind: kindFor(span, joined, stored), stored: true });
    }
  }
  if (districts?.size) {
    const find = (joined) => (districts.get(joined.slice(0, 4)) ?? []).find((t) => matchesTarget(joined, t));
    for (const w of findWindows(text, tokens, sks, (joined) => find(joined))) {
      if (!isCapital(tokens[w.i][0])) continue;
      const joined = joinedOf(w);
      const span = withNoun(text, tokens, w);
      add({ ...span, kind: kindFor(span, joined, find(joined).kind) });
    }
  }
  for (const phrase of districtPhrases(text, tokens)) add(phrase);

  spans.push(...alongside.filter((a) => !spans.some((x) => x.kind === 'DISTRICT' && overlaps(x, a))));
  // After "район" a city is not a district ("районе Одессы"), and advertising words are not a name
  // -- unless the row stores that very name.
  spans = spans.filter((span) => {
    if (span.stored) return true;
    const written = text.slice(span.start, span.end);
    if (NOT_A_PLACE_WORD.test(written) || REGION_AFTER.test(text.slice(span.end, span.end + 12))) return false;
    if (!cities?.length) return true;
    // only "район Одессы" (the noun first, then a city): "Франківський район" is a district, not the city
    const first = written.match(WORD)?.[0];
    if (!first || !isDistrictNoun(first)) return true;
    const name = [...written.matchAll(WORD)].filter((w) => !isDistrictNoun(w[0])).map((w) => wordSkeleton(w[0])).join('').replace(/(.)\1+/g, '$1');
    return !cities.some((c) => name.startsWith(c.slice(0, Math.max(4, c.length - 1))) && name.length <= c.length + 1);
  });

  spans.sort((a, b) => a.start - b.start);
  const kept = [];
  for (let i = 0; i < spans.length;) {
    let j = i + 1;
    while (j < spans.length && spans[j].start - spans[j - 1].end <= 80) j += 1;
    if (j - i < 4) kept.push(...spans.slice(i, j)); // a run of four or more is a list: left unlabelled
    i = j;
  }
  spans = kept;

  if (spans.length) return { state: 'found', spans, neutral: [] };
  const stored = [row.district, row.area, row.kvartal].some((v) => v && String(v).trim());
  return stored ? { state: 'ignore' } : { state: 'absent' };
}

// ---- landmarks --------------------------------------------------------------
//
// There is no database column for landmarks (a mall, a school, a stop), so they are labelled by the
// words that introduce them ("рядом с ...", "ориентир: ...", "lângă ..."): each item of the list that
// follows is one landmark. This is a rule, not a truth: it misses landmarks written without a cue and
// catches a few that are not. Where a text names a kind of landmark the rule did not cover, the row is
// not trained on for this entity at all (see alignLandmark).

const LANDMARK_CUE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:рядом\s+(?:с|со)|возле|около|напротив|недалеко\s+(?:от|від)|поблизости(?:\s+(?:от|с))?|ориентир(?:ы|а|ом)?|орієнтир(?:и|а|ом)?|біля|поряд\s+з|поруч\s+з|навпроти|неподалік\s+від|поруч|поблизу|близько|рядом|(?:хвилин\p{L}*|минут\p{L}*|хв\.?|мин\.?)\s+(?:пішки\s+|ходьби\s+|езды\s+)?(?:від|от|до)|инфраструктур\p{L}*|інфраструктур\p{L}*|(?:в\s+)?(?:шаговой|пешей)\s+доступности|lângă|langa|aproape\s+de|vis-a-vis\s+de|vizavi\s+de|în\s+apropiere\s+de|mo['ʻ’]?ljal|мўлжал|мульжал|yaqinida|yonida|oldida)(?![\p{L}\p{N}])[\s:\-–]*`,
  'giu',
);
const LANDMARK_TYPE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:тц|трц|торгов\p{L}*\s+центр|рынок|базар|универмаг|супермаркет|гипермаркет|школ\p{L}*|детск\p{L}*\s+сад|университет|институт|больниц\p{L}*|поликлиник\p{L}*|парк|сквер|мечеть|церковь|храм|стадион|вокзал|аэропорт|остановк\p{L}*|озер\p{L}*|аптек\p{L}*|ратуш\p{L}*|набережн\p{L}*|лісопарк|лесопарк|bazar|maktab|bogcha|kasalxona|mall|școal\p{L}*|spital|piața|piata|gradini[țt]\p{L}*)(?![\p{L}\p{N}])`,
  'giu',
);
// Kinds of place a listing names in general ("школа", "магазины", "рынки", "детский сад"): a NEARBY item.
const GENERIC_PLACE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:тц|трц|торгов\p{L}*\s+центр|рынк\p{L}*|базар\p{L}*|универмаг\p{L}*|супермаркет\p{L}*|гипермаркет\p{L}*|магазин\p{L}*|ресторан\p{L}*|кафе|кав['ʻ’]?ярн\p{L}*|школ\p{L}*|лице\p{L}*|ліце\p{L}*|озер\p{L}*|річк\p{L}*|реки|река|набережн\p{L}*|пляж\p{L}*|лісопарк\p{L}*|лесопарк\p{L}*|зон\p{L}*\s+(?:відпочинку|отдыха|відпочинков\p{L}*|отдыха)|відпочинков\p{L}*\s+зон\p{L}*|транспортн\p{L}*\s+(?:розв['ʻ’]?язк\p{L}*|развязк\p{L}*)|фітнес\p{L}*|фитнес\p{L}*|банкомат\p{L}*|детск\p{L}*\s+сад\p{L}*|дитяч\p{L}*\s+(?:садо\p{L}*|майданчик\p{L}*)|садик\p{L}*|садочк\p{L}*|университет\p{L}*|больниц\p{L}*|лікарн\p{L}*|поликлиник\p{L}*|аптек\p{L}*|банк\p{L}*|парк\p{L}*|сквер\p{L}*|мечет\p{L}*|церкв\p{L}*|стадион\p{L}*|вокзал\p{L}*|остановк\p{L}*|bazar\p{L}*|maktab\p{L}*|bogcha\p{L}*|kasalxona\p{L}*|do['ʻ’]kon\p{L}*|școal\p{L}*|spital\p{L}*|pia[țt]\p{L}*|farmaci\p{L}*)(?![\p{L}\p{N}])`,
  'iu',
);
// an item made only of such words ("школы", "детский сад"): the capital of a list's first word does not make it a name
const GENERIC_ONLY = new RegExp(String.raw`^(?:${GENERIC_PLACE.source})(?:[\s-]+(?:${GENERIC_PLACE.source}))?$`, 'iu');
const ITEM_BREAK = /[.!?\n;|•]/u;
const NOT_A_LANDMARK = /^(?:квартир|нерухомість|новобудов|продаж|оренд|ціна|цена|\d+-?(?:кімн|комн)|\d+\s*(?:мин|хв|min|м\b|метр|км|km)|пару\b|несколько\b|в\s+пешей|центр\p{L}*$|города?$|міста?$|района?$|метро\b|м\.|станци|транспорт|инфраструктур|все\b|всё\b|всего\b)/iu;
const LEADING_FILLER = /^(?:недалеко|рядом|возле|около|от|с|со|к|із|зі|з|біля|ви\s+знайдете|вы\s+найдете|расположены|находятся|розташовані|есть|є|de|la|на)[\s:]+/iu;

const SEPARATOR = /[,:]|(?<=\s)(?:и|та|і|și|va)(?=\s)/gu;
const METRO_WORD_IN_ITEM = /метро|метрополітен|станці|станци|stați|statii|metro\p{L}*/iu;
const METRO_BEFORE = /(?:метро|метрополітен|станци\p{L}*|stați\p{L}*|statii)[\s:«"]*$/iu;

// One item per list entry after a cue. Offsets come from the separators' real positions: a two-letter
// separator ("și", "та") is not one character, and counting it as one cut "Lidl" into "Lid".
function landmarkItems(text, stationSpans) {
  const items = [];
  for (const cue of text.matchAll(LANDMARK_CUE)) {
    const from = cue.index + cue[0].length;
    const tail = text.slice(from, from + 200);
    const stop = tail.search(ITEM_BREAK);
    const clause = stop < 0 ? tail : tail.slice(0, stop);
    const cutByWindow = stop < 0 && tail.length === 200; // the last item may be half a word
    const pieces = [];
    let begin = 0;
    for (const sep of clause.matchAll(SEPARATOR)) { pieces.push([begin, sep.index]); begin = sep.index + sep[0].length; }
    pieces.push([begin, clause.length]);
    if (cutByWindow) pieces.pop();
    let stationList = false; // once a list says "метро ...", the rest of it is stations too
    for (const [from0, to0] of pieces) {
      let a = from0;
      let b = to0;
      const lead = /^[\s(\[«"“—–\-:]+/u.exec(clause.slice(a, b));
      if (lead) a += lead[0].length;
      const trail = /[\s)\]»"”/\.!:\-–—]+$/u.exec(clause.slice(a, b));
      if (trail) b -= trail[0].length;
      const filler = LEADING_FILLER.exec(clause.slice(a, b));
      if (filler) a += filler[0].length;
      const piece = clause.slice(a, b);
      if (METRO_WORD_IN_ITEM.test(piece)) stationList = true;
      if (stationList) continue;
      if (!piece || (piece.match(/\p{L}/gu) ?? []).length < 3 || piece.length > 45 || piece.split(/\s+/).length > 4) continue;
      if (NOT_A_LANDMARK.test(piece)) continue;
      const qualified = piece.split(/\s+/).length >= 2 && new RegExp(LANDMARK_TYPE.source, 'iu').test(piece);
      let kind = 'LANDMARK';
      if (!/\p{Lu}|\d/u.test(piece.slice(1)) && GENERIC_ONLY.test(piece)) {
        kind = 'NEARBY';
      } else if (!/\p{Lu}|\d/u.test(piece)) { // nothing specific: "школа", "магазины" say what is near, not where
        if (!GENERIC_PLACE.test(piece)) continue;
        kind = 'NEARBY';
      }
      const start = from + a;
      const end = from + b;
      if (METRO_BEFORE.test(text.slice(Math.max(0, start - 25), start))) continue; // "станций метро Харківська, ..."
      if (stationSpans.some((s) => s.start < end && start < s.end)) continue; // a known station is a METRO
      items.push({ start, end, kind });
    }
  }
  // two cues can reach the same item ("Поруч вся інфраструктура: ..."): each item once
  return items.filter((x, i) => items.findIndex((y) => y.start === x.start && y.end === x.end) === i);
}

function alignLandmark(text, taken, stationSpans) {
  // An item that is mostly a district, complex, station or street is that, not a landmark; one that only
  // contains it ("Veolia Мирзо-Улугбекского района") is still a landmark.
  const withoutOthers = (item) => {
    let { start, end } = item;
    for (const t of taken) {
      if (t.end <= start || t.start >= end) continue;
      if (t.start <= start) start = Math.max(start, t.end); // the other entity opens the item
      else if (t.end >= end) end = Math.min(end, t.start); // it closes the item
      else return null; // it sits in the middle: not a landmark
    }
    while (start < end && /[\s,;:\-–]/.test(text[start])) start += 1;
    while (end > start && /[\s,;:\-–]/.test(text[end - 1])) end -= 1;
    return (text.slice(start, end).match(/\p{L}/gu) ?? []).length >= 3 ? { start, end, kind: item.kind } : null;
  };
  const spans = landmarkItems(text, stationSpans).map(withoutOthers).filter(Boolean);
  const uncovered = [...text.matchAll(LANDMARK_TYPE)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length }))
    .filter((m) => !spans.some((s) => overlaps(s, m)) && !taken.some((t) => overlaps(m, t)));
  const unsure = uncovered.flatMap((m) => [{ label: 'LANDMARK', ...m }, { label: 'NEARBY', ...m }]);
  if (spans.length) return { state: 'found', spans, neutral: unsure };
  return uncovered.length ? { state: 'ignore' } : { state: 'absent' };
}

// ---- residential complex (ЖК) -----------------------------------------------
//
// Labelled from the marker that introduces the name ("ЖК Дельмар", "ЖК «Срібна Вежа»", "Complexul
// Qualis 2"), not from the database: the residence_complex column holds a name on only ~30% of
// listings and is mixed with fragments of the description ("а підлоги", "омнатные двери",
// "NEW LIFE 4комн/10/10 Коробка 150м2"). The marker is part of the span, as a person selecting it
// would include it. A complex written without a marker is left unlabelled.

const COMPLEX_MARKER = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:ЖК|ЖР|Ж\.\s?К\.|жилой\s+комплекс|жилий\s+комплекс|житловий\s+комплекс|комплекс\p{L}*|Complexul|Complex|rezidența)(?![\p{L}\p{N}])[\s:\-–]*[«"“„']?`,
  'giu',
);
// Lowercase words that are part of a complex's name ("Тиара резиденс", "Park Lake city").
const COMPLEX_SUFFIX = new Set(['резиденс', 'резиденція', 'residence', 'tower', 'towers', 'сити', 'city', 'плаза', 'plaza', 'парк', 'park',
  'хаус', 'house', 'вежа', 'вілаж', 'village', 'гарден', 'garden', 'лайф', 'life', 'ривер', 'river']);
const NOT_A_COMPLEX_NAME = /^(?:квартир|продается|продаётся|сдается|сдаётся|сдам|продам|продаж|оренда|аренда|пропонується|цена|ціна|адрес|район|вторичка|новостройка|новобудова|комплекс)/iu;
const NAME_TOKEN = /[\p{L}\p{N}'’\-]+/uy;

// The name that starts at `from`: a capitalised first word, then up to three more that are
// capitalised, a short number ("Qualis 2") or a known suffix word. Returns its end, or -1.
function complexNameEnd(text, from) {
  let end = -1;
  let at = from;
  let firstShouts = false;
  for (let n = 0; n < 4; n += 1) {
    if (n > 0) {
      if (!/[ \u00a0]/.test(text[at] ?? '')) break; // one blank between words, no punctuation
      at += 1;
    }
    NAME_TOKEN.lastIndex = at;
    const token = NAME_TOKEN.exec(text);
    if (!token) break;
    const word = token[0];
    const shout = word.length >= 4 && word === word.toUpperCase() && /^\p{L}+$/u.test(word);
    if (n > 0 && shout && !firstShouts) break;
    if (n === 0) firstShouts = shout;
    const ok = n === 0 ? /^\p{Lu}/u.test(word)
      : /^\p{Lu}/u.test(word) || /^\d{1,3}$/.test(word) || COMPLEX_SUFFIX.has(word.toLowerCase()) || word.toLowerCase().startsWith('резиденс');
    if (!ok) break;
    at += word.length;
    end = at;
  }
  return end;
}

// "ЖК" is part of the span (a person selects "ЖК Дельмар"); the long markers are not ("жилой комплекс",
// "Complexul", "комплексі"): there only the name is. A name marked once is also found where it is
// repeated later in the text without a marker ("ParkStone").
const SHORT_MARKER = /^(?:ЖК|ЖР|Ж\.\s?К\.)$/iu;

function alignComplex(text, taken) {
  const spans = [];
  const names = new Set();
  const free = (span) => !taken.some((t) => overlaps(span, t)) && !spans.some((s) => overlaps(span, s));
  for (const marker of text.matchAll(COMPLEX_MARKER)) {
    const nameFrom = marker.index + marker[0].length;
    const nameTo = complexNameEnd(text, nameFrom);
    if (nameTo < 0 || NOT_A_COMPLEX_NAME.test(text.slice(nameFrom, nameTo))) continue;
    let end = nameTo;
    while (end > nameFrom && /[\s.,:;\-–]/.test(text[end - 1])) end -= 1; // no trailing punctuation
    const short = SHORT_MARKER.test(marker[0].replace(/[\s:\-–«"“„']+$/u, ''));
    let span;
    if (short) {
      const quoted = /[«"“„]/u.test(marker[0].slice(-1)) && /[»"”“]/u.test(text[end] ?? '');
      span = { start: marker.index, end: quoted ? end + 1 : end }; // "ЖК «Срібна Вежа»"
    } else {
      span = { start: nameFrom, end };
    }
    if (free(span)) {
      spans.push(span);
      names.add(text.slice(nameFrom, end).toLowerCase());
    }
  }
  for (const name of names) {
    const escaped = name.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ \\u00a0]+');
    for (const again of text.matchAll(new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu'))) {
      const span = { start: again.index, end: again.index + again[0].length };
      if (free(span)) spans.push(span);
    }
  }
  return spans.length ? { state: 'found', spans } : { state: 'absent' };
}

// ---- entry point ----------------------------------------------------------

/**
 * `text` is the exact string the model will see (already redacted).
 * Returns { spans: [{label,start,end}], ignore: [label,...], neutral: [{label,start,end}] }.
 * `neutral` ranges are real mentions of an entity that are not this listing's
 * value (a deposit amount next to a currency): masked from the loss and scoring.
 */
// ---- rooms, area, floor, number of floors --------------------------------------------------------------------------
//
// The database holds these (rooms, area_sqm, floor_number, total_floors). A mention is found by trying short windows of
// the text (one to three words) with the lexicon's own parsers and keeping those that read as the stored value: the
// vocabulary ("комн", "кв.м", "этаж", "xona") stays in @whiteslove/parsing-lexicon. The regular expressions below only
// decide which windows are worth asking about, to keep the cost down. A window the lexicon reads as a DIFFERENT value
// ("жилая 30" next to a total of 56) is neutral, not a negative.

const FACT_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}.,'’²³/%-]*/gu;
const FACT_GAP = /^[ \u00a0,;:()\-–—/]{0,3}$/u;
const NUMBER_WORD = /(?:одно|одн|двух|двох|трех|трёх|трьох|четырех|четырёх|чотир|пяти|п'яти)/iu;
const ROOMISH = /(?:комн|кімн|ком\b|ком\.|xona|хона|camer|room|студи|(?:^|[^\p{L}])к(?:[^\p{L}]|$)|\dк)/iu;
const PART_OF_AREA = /(?:жил\p{L}*|кухн\p{L}*|living|bucătări\p{L}*|bucatari\p{L}*|kitchen|utilă|construit\p{L}*|dormitor\p{L}*|balcon\p{L}*|спальн\p{L}*|гостин\p{L}*|санузел|ванн\p{L}*|хол\p{L}*|коридор\p{L}*|baie|hol)[^\d]{0,10}$/iu; // a part of the area is not the area
const ROOM_SLANG = /^(?:евро|євро)?-?(?:однушк|двушк|тр[её]шк|четыр[её]шк)\p{L}*$/iu;
const EURO_WORD = /^(?:евро|євро)/iu;
const AREAISH = /(?:м2|м²|м\s?2|кв|sqm|sq\.?\s?m|mp(?![\p{L}])|m2|m²|площ|maydon|area|suprafa)/iu;
const FLOORISH = /(?:этаж|эт\b|эт\.|поверх|qavat|etaj|\d\s?\/\s?\d)/iu;
const UNIT_AFTER = /^[ \u00a0]?(?:м2|м²|м\s?²|кв\.?\s?м\.?|кв\.?|квадрат\p{L}*|sq\.?\s?m\.?|sqm|m2|m²|mp|kv\.?\s?m)(?![\p{L}\p{N}])/iu;
const AREA_BREAKDOWN = /(?<![\d.,/\\])\d{2,3}(?:[.,]\d+)?(?:\s?[/\\]\s?\d{1,3}(?:[.,]\d+)?){1,2}(?![\d/\\])/gu;
const COMPACT_FLOORS =/^(\d)([¹²³⁴⁵⁶⁷⁸⁹])?\/(\d{1,2})\/(\d{1,2})$/u;

function factWindows(text) {
  const tokens = [...text.matchAll(FACT_TOKEN)];
  const windows = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let end = tokens[i].index + tokens[i][0].length;
    windows.push({ start: tokens[i].index, end, n: 1 });
    for (let n = 2; n <= 4 && i + n <= tokens.length; n += 1) {
      const next = tokens[i + n - 1];
      if (!FACT_GAP.test(text.slice(end, next.index))) break;
      end = next.index + next[0].length;
      windows.push({ start: tokens[i].index, end, n });
    }
  }
  return windows.sort((a, b) => a.n - b.n || a.start - b.start); // the shortest window that reads as the value wins
}

const close = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.06;
const stored = (value) => (value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

function alignFacts(text, row, taken) {
  const want = { rooms: stored(row.rooms), area: stored(row.area_sqm), floor: stored(row.floor), total: stored(row.total_floors) };
  const spans = [];
  const neutral = [];
  const seen = { ROOMS: false, AREA: false, FLOOR: false, FLOORS_TOTAL: false }; // the text states one, whatever it says
  const free = (start, end) => !taken.some((t) => t.start < end && start < t.end);
  const mine = (label, start, end) => spans.some((x) => x.label === label && x.start < end && start < x.end);
  const add = (label, start, end) => { if (!mine(label, start, end)) spans.push({ label, start, end }); };
  // Where the row stores nothing for a fact, a mention the lexicon reads is still a positive when the text says it one
  // way only (a single distinct value); two different values leave the fact unknown.
  const candidates = [];
  const put = (label, value, stored, start, end) => {
    if (stored != null) (close(value, stored) ? add : addNeutral)(label, start, end);
    else candidates.push({ label, value, start, end });
  };
  const addNeutral = (label, start, end) => { if (!neutral.some((x) => x.label === label && x.start === start && x.end === end)) neutral.push({ label, start, end }); };
  if (!/\d/.test(text) && !NUMBER_WORD.test(text) && !/(?:однушк|двушк|тр[её]шк|четыр[её]шк)/iu.test(text)) return { spans, neutral, seen, want };

  // "37/18/7 м2" is total / living / kitchen: the first number is the area, the others are parts of it, not rivals.
  const claimed = [];
  for (const m of text.matchAll(AREA_BREAKDOWN)) {
    const parts = [];
    for (const part of m[0].matchAll(/\d+(?:[.,]\d+)?/g)) parts.push({ value: numberValue(part[0]), start: m.index + part.index, end: m.index + part.index + part[0].length });
    const unit = UNIT_AFTER.exec(text.slice(m.index + m[0].length));
    if (!unit || parts.length < 2) continue;
    if (!parts.every((p, i) => i === 0 || p.value <= parts[i - 1].value) || parts[0].value === parts[1].value) continue;
    seen.AREA = true;
    // every number is an AREA span; the consumer adds them up. The stored value is the first number or their sum.
    const sum = parts.reduce((s, p) => s + p.value, 0);
    const matches = close(parts[0].value, want.area) || close(sum, want.area);
    if (want.area != null) for (const p of parts) (matches ? add : addNeutral)('AREA', p.start, p.end);
    claimed.push({ start: m.index, end: m.index + m[0].length + unit[0].length });
  }
  taken = [...taken, ...claimed];

  for (const w of factWindows(text)) {
    if (!free(w.start, w.end)) continue;
    const piece = text.slice(w.start, w.end);
    const digits = /\d/.test(piece);

    const slang = w.n === 1 && ROOM_SLANG.test(piece); // "двушка", "евротрёшка": the room count is in the word
    if (((digits || NUMBER_WORD.test(piece)) && ROOMISH.test(piece)) || slang) {
      const rooms = parseHousingRoomsFromText(piece);
      if (rooms != null) {
        seen.ROOMS = true;
        let start = w.start;
        let end = w.end;
        while (end > start && /[\s,.;:)(\-–—]/.test(text[end - 1])) end -= 1; // "2 camere," is "2 camere"
        while (start < end && /[\s,.;:)(\-–—]/.test(text[start])) start += 1;
        const label = /^[\p{L}.]+(?:\s+[\p{L}.]+)?\s*[:=\-–—]\s*(?=\d+$)/u.exec(text.slice(start, end)); // "Комнат - 2": the value only
        if (label) start += label[0].length;
        const runs = [...text.slice(start, end).matchAll(/\d+/g)]; // the span is the number, as a person marks it: "3" of "3-комнатная"
        if (runs.length === 1) { end = start + runs[0].index + runs[0][0].length; start += runs[0].index; }
        // listings often store the name of a euro flat ("евродвушка" = 2) where the lexicon counts rooms (1)
        const storedRooms = slang && EURO_WORD.test(piece) && close(rooms + 1, want.rooms) ? rooms : want.rooms;
        put('ROOMS', rooms, storedRooms, start, end);
      }
    }

    if (digits && AREAISH.test(piece)) {
      const area = parseHousingAreaFromText(piece);
      if (area != null) {
        seen.AREA = true;
        for (const m of piece.matchAll(NUMBER)) {
          if (!close(numberValue(m[0]), area)) continue;
          const start = w.start + m.index;
          let end = start + m[0].length;
          const unit = UNIT_AFTER.exec(text.slice(end, end + 14));
          if (unit) end += unit[0].length;
          // A person marks every area figure (total, living, kitchen, rooms); telling them apart is done after the model.
          // A figure that is neither the stored one nor a named part of the flat may belong to something else: neutral.
          if (PART_OF_AREA.test(text.slice(Math.max(0, start - 16), start)) || want.area == null) add('AREA', start, end);
          else put('AREA', area, want.area, start, end);
          break;
        }
      }
    }

    if (digits && FLOORISH.test(piece)) {
      const read = parseHousingFloorFromText(piece);
      const compact = w.n === 1 ? COMPACT_FLOORS.exec(piece) : null;
      if (read && (read.floor != null || read.totalFloors != null)) {
        const runs = [...piece.matchAll(/\d{1,3}/g)].map((m) => ({ value: Number(m[0]), start: w.start + m.index, end: w.start + m.index + m[0].length }));
        let floorRun = null;
        let totalRun = null;
        if (compact) { // rooms/floor/floors: the second and third numbers
          floorRun = runs[1] ?? null;
          totalRun = runs[2] ?? null;
        } else {
          floorRun = read.floor != null ? runs.find((r) => r.value === read.floor) ?? null : null;
          totalRun = read.totalFloors != null
            ? [...runs].reverse().find((r) => r.value === read.totalFloors && r !== floorRun) ?? null
            : null;
        }
        if (floorRun && read.floor != null) {
          seen.FLOOR = true;
          put('FLOOR', read.floor, want.floor, floorRun.start, floorRun.end);
        }
        if (totalRun && read.totalFloors != null) {
          seen.FLOORS_TOTAL = true;
          put('FLOORS_TOTAL', read.totalFloors, want.total, totalRun.start, totalRun.end);
        }
        if (compact && close(parseHousingRoomsFromText(piece), want.rooms)) { // "2/5/16": the first number is the room count
          seen.ROOMS = true;
          add('ROOMS', w.start, w.start + compact[1].length + (compact[2] ? compact[2].length : 0));
        }
      }
    }
  }
  for (const label of ['ROOMS', 'AREA', 'FLOOR', 'FLOORS_TOTAL']) {
    const mentions = candidates.filter((c) => c.label === label);
    if (mentions.length && mentions.every((c) => close(c.value, mentions[0].value))) for (const c of mentions) add(label, c.start, c.end);
  }
  return { spans, neutral, seen, want };
}

export function alignSpans(text, row, context = {}) {
  const spans = [];
  const ignore = [];

  const neutral = [];
  const cued = findCuedAmounts(text);
  const price = alignPrice(text, row.price, row.currency, cued.amounts);
  for (const kind of ['DEPOSIT', 'UTILITIES', 'COMMISSION', 'PREPAYMENT']) {
    const mine = cued.amounts.filter((a) => a.kind === kind);
    for (const a of mine) {
      spans.push({ label: kind, start: a.start, end: a.end });
      // the currency written next to it is not the price's currency: skipped, neither positive nor negative
      if (a.marker) neutral.push({ label: 'CURRENCY', start: a.marker.start, end: a.marker.end });
    }
    if (!mine.length && AMOUNT_CUES.find(([k]) => k === kind)[1].test(text)) ignore.push(kind); // a cue the rule could not turn into an amount
  }
  if (price.state === 'found') {
    neutral.push(...price.neutral);
    for (const s of price.prices) spans.push({ label: 'PRICE', ...s });
    // Currency is only trained where a marker sits next to the price.
    for (const marker of price.markers) spans.push({ label: 'CURRENCY', start: marker.start, end: marker.end });
    if (!price.markers.length) ignore.push('CURRENCY');
  } else {
    ignore.push('PRICE', 'CURRENCY');
  }

  const address = alignAddress(text, row);
  if (address.state === 'found') {
    for (const s of address.spans) spans.push({ label: 'ADDRESS', ...s });
    neutral.push(...address.neutral);
  } else if (address.state === 'ignore') ignore.push('ADDRESS');

  // `context.stations`: skeletons of station names seen across the whole dataset
  // (see stationSkeletons), so a station the row does not store can still be recognised.
  const metro = alignMetro(text, row, context.stations, context.stationGroups, context.ambiguousStations);
  if (metro.state === 'found') {
    for (const s of metro.spans) spans.push({ label: 'METRO', ...s });
    neutral.push(...metro.neutral);
  } else if (metro.state === 'ignore') ignore.push('METRO');

  // `context.districts`: district names seen across the dataset (districtIndex), for rows that store none.
  const district = alignDistrict(text, row, context.districts, context.placeKinds, context.cities);
  // A station name with a number glued to it ("Перемога-1") is a numbered microdistrict, not the station.
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const m = spans[i];
    if (m.label !== 'METRO') continue;
    const glued = /^[-–](\d{1,2})(?![\d\p{L}])/u.exec(text.slice(m.end, m.end + 4));
    if (glued && !hasMetroCue(text, m.start, m.end + glued[0].length)) {
      spans.splice(i, 1);
      if (district.state !== 'found') { district.state = 'found'; district.spans = []; district.neutral = []; }
      district.spans.push({ start: m.start, end: m.end + glued[0].length, kind: 'MICRODISTRICT' });
    }
  }
  if (district.state === 'found') { // a name next to "метро" is the station, not the district
    const stations = spans.filter((s) => s.label === 'METRO');
    district.spans = district.spans.filter((d) => !stations.some((m) => overlaps(d, m)) && !hasMetroCue(text, d.start, d.end));
    if (!district.spans.length) district.state = 'ignore';
  }
  if (district.state === 'found') {
    for (const { kind, stored, ...s } of district.spans) spans.push({ label: kind ?? 'LOCALITY', ...s });
    neutral.push(...district.neutral);
  } else if (district.state === 'ignore') ignore.push(...DISTRICT_KINDS);

  // A residential complex ("ЖК ...", and later mentions of the same name).
  const complex = alignComplex(text, spans.filter((s) => s.label === 'METRO' || s.label === 'ADDRESS'));
  if (complex.state === 'found') for (const s of complex.spans) spans.push({ label: 'COMPLEX', ...s });

  // A landmark is never the district, complex, station or street already found in the same text.
  const stationSpans = context.stations?.size ? stationMentions(text, context.stations, context.ambiguousStations).map((m) => ({ start: m.start, end: m.end })) : [];
  const facts = alignFacts(text, row, spans.filter((s) => !['ROOMS', 'AREA', 'FLOOR', 'FLOORS_TOTAL', 'LANDMARK', 'NEARBY', 'DISTRICT', 'MICRODISTRICT', 'LOCALITY'].includes(s.label)));
  for (const label of ['ROOMS', 'AREA', 'FLOOR', 'FLOORS_TOTAL']) {
    const value = { ROOMS: facts.want.rooms, AREA: facts.want.area, FLOOR: facts.want.floor, FLOORS_TOTAL: facts.want.total }[label];
    const found = facts.spans.filter((x) => x.label === label);
    spans.push(...found);
    if (value != null && !found.length) ignore.push(label); // stored but not written the way the lexicon reads it
    else if (value == null && !found.length && facts.seen[label]) ignore.push(label); // written, nothing stored, and the text is not unambiguous
  }
  neutral.push(...facts.neutral);
  const landmark = alignLandmark(text, spans.filter((s) => !['PRICE', 'CURRENCY', 'ROOMS', 'AREA', 'FLOOR', 'FLOORS_TOTAL'].includes(s.label)), stationSpans);
  if (landmark.state === 'found') {
    for (const { kind, ...s } of landmark.spans) spans.push({ label: kind === 'NEARBY' ? 'NEARBY' : 'LANDMARK', ...s });
    neutral.push(...landmark.neutral);
  } else if (landmark.state === 'ignore') ignore.push('LANDMARK', 'NEARBY');

  return { spans, ignore, neutral };
}

/**
 * Re-expresses span offsets from UTF-16 code units (what JS string indices
 * count) as Unicode code points (what Python, and HF tokenizer offsets, count).
 * They differ after every emoji, which listings are full of: a "💰" is two
 * units but one code point, so unconverted offsets drift further off with each.
 */
export function toCodePointOffsets(text, spans) {
  const astral = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { astral.push(i); i += 1; }
  }
  if (!astral.length) return spans;
  // Each astral pair is one code point for two units; count the pairs wholly before `index`.
  const convert = (index) => index - astral.filter((position) => position + 2 <= index).length;
  return spans.map((span) => ({ ...span, start: convert(span.start), end: convert(span.end) }));
}
