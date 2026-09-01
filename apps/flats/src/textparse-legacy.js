// Best-effort extraction of price / rooms / area from free-text posts
// (Reddit, Telegram, Threads) where there is no structured field.

export {parseHousingPrice as parsePriceFromText} from '@whiteslove/parsing-lexicon/housing-money';

// Classify a listing's deal type from its text. Returns one of
// 'sale' | 'longRent' | 'shortRent' | null (unknown). Short-term is checked
// first because those posts almost always also contain generic rent words.
export function classifyDealType(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Short-term: RO/RU/UA + UZ (sutkaga/kunlik/kecha) + KZ (тәулік/сағаттық).
  // "суточн" covers both "посуточная" and the bare adjective "суточная
  // квартира"; the (?<!кругло) lookbehind keeps "круглосуточная охрана/
  // видеонаблюдение" (24-hour security, common in sale/long-term posts) from
  // being misread as short-term.
  if (/(regim hotelier|in regim|posutoc|подобов|подобно|(?<!кругло)суточн|почасов|(?:за|на)\s+сутки|сутка(?:ми)?|per (night|day)|daily rent|short[\s-]?term|nightly|sutkaga|kunlik|kecha[- ]?kunduz|тәулік|тәулiк|сағаттық)/i.test(t))
    return 'shortRent';
  // Sale: RO/RU/UA/EN + UZ (sotiladi/sotuv/sotaman) + KZ (сатылады/сату).
  // Checked BEFORE long-term rent because sale posts routinely pitch rental
  // income ("подойдёт для сдачи в аренду"), which would otherwise be misread as
  // a rental. A negation guard avoids "не продаётся" flipping a rental to sale.
  const sale =
    /(de v[aâ]nzare|v[aâ]nzare|прода[жёе]|продам|на продаж|for sale|\bsale\b|купит|kupit|to buy|sotiladi|sotuv|sotaman|sotib|сатылады|сату|сатамын)/i.test(t) &&
    !/не\s+прода/i.test(t);
  if (sale) return 'sale';
  // Long-term rent: RO/RU/UA/EN + UZ (ijara/arenda) + KZ (жалға/жалдау/аренда).
  if (/(inchiri|închiri|de închiriat|оренд|аренд|rent\b|for rent|сдам|сдаю|сдаётся|сдается|здам|найм|долгосроч|довгостро|ijara|ijaraga|ижара|arenda|жалға|жалдау|жалга|жал\b|sherik(?:ka|lik)|шерик(?:ка|лик)|oila(?:ga)?\s+qo['’`]?yiladi|oila(?:ga)?\s+quyiladi|(?:хонали|квартир)[^\r\n]{0,100}турибди[^\r\n]{0,30}\d+\s*\$|квартира\s+бор)/i.test(t))
    return 'longRent';
  return null;
}

// Target-audience restriction stated in the post, or null. Family is checked
// first so "for a family with girls" resolves to family.
export function classifyAudience(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Families and single tenants are both accepted: this is not a restriction.
  if (/(?:семейн|сімейн|для семь|для сім)[^.\n]{0,80}(?:одиноч|мужчин|женщин|чоловік|жінок)|(?:одиноч|мужчин|женщин|чоловік|жінок)[^.\n]{0,80}(?:семейн|сімейн|для семь|для сім)/.test(t))
    return null;
  if (/(для семь|семейн|сімейн|для сім|для родин|for famil|families?|pentru famil|oila(?:ga| uchun|\s+qo['’`]?yiladi|\s+quyiladi)|оила|отбасы)/.test(t))
    return 'family';
  if (/(девуш|девоч|для дівч|дівчат|for girls|for women|only girls|doar fete|\bfete\b|qiz(?:lar|la)?(?:ga| uchun)?|(?:қ|к)из(?:лар|ла)?|қыздар)/.test(t))
    return 'women';
  if (/(парн(ей|ям)|для мужчин|мужчинам|для хлопц|for men\b|for boys|doar b[aă]ie[țt]i|yigit(lar)?(ga| uchun)?|(?:ў|у)гил\s*бол|жігіт|ер адам)/.test(t))
    return 'men';
  return null;
}

// Best-effort seller contact: an international phone (leading +), a local phone
// introduced by a phone keyword, or an @handle. Kept conservative so it does not
// mistake large prices (e.g. UZS amounts) for phone numbers.
export function parseContact(text) {
  if (!text) return null;

  const intl = text.match(/\+\d[\d\s().-]{7,}\d/);
  if (intl) {
    const digits = intl[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
  }

  const kw = text.match(
    /(?:tel|тел|phone|моб|whats?app|viber|telegram|звонит|звоніть|aloqa|byla|contact)[^\d+]{0,8}(\+?\d[\d\s().-]{6,}\d)/i,
  );
  if (kw) {
    const digits = kw[1].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) return kw[1].trim();
  }

  // Some Telegram posts put the marker after a local number: `771443473 tel`.
  const trailingKw = text.match(
    /(\+?\d[\d\s().-]{6,}\d)\s*(?:tel|тел(?:ефон)?|phone|моб|whats?app|viber|telegram|aloqa|contact)(?=$|[^\p{L}\p{N}_])/iu,
  );
  if (trailingKw) {
    const digits = trailingKw[1].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) return trailingKw[1].trim();
  }

  const handle = text.match(/@[A-Za-z0-9_]{4,32}/);
  if (handle) return handle[0];

  return null;
}

export function looksRoomOnly(text) {
  if (!text) {
    return false;
  }

  return /подселени|підселен|комнату\s+в|кімнату\s+в|сда[её]тся\s+комната|сдается\s+комната|сдам\s+комнату|здам\s+кімнат|room\s+in\s+a\s+(?:shared\s+)?flat|room\s+for\s+rent|shared\s+(?:flat|apartment|room)|roommate|flatmate|xona\s+ijaraga|xona\s+beriladi|sherik(?:ka|lik)|шерик(?:ка|лик)|(?:1|бир)\s*та\s*(?:бола|киши|қиз|киз)\s*керак|1\s*хонага[^\r\n]{0,40}(?:киши|одам)\s*турилади|бөлме\s+жалға|închiriez\s+camer[ăa]|ищу[^\r\n]{0,60}сосед|ищем[^\r\n]{0,60}сосед|нужен[^\r\n]{0,60}сосед|нужна[^\r\n]{0,60}сосед|шукаю[^\r\n]{0,60}сусід|шукаємо[^\r\n]{0,60}сусід|потрібен[^\r\n]{0,60}сусід|потрібна[^\r\n]{0,60}сусід|співмешкан|співжител|соседк|сусідк/i.test(
      text,
  );
}

/**
 * Demand-side housing post:
 *
 *   "ищу квартиру"
 *   "ищем 2-комнатную квартиру"
 *   "сниму квартиру"
 *   "нужна квартира"
 *   "шукаю квартиру в оренду"
 *   "шукаємо 2-кімнатну квартиру"
 *   "потрібна квартира"
 *
 * Roommate / shared-flat posts are deliberately NOT classified
 * as wanted housing and remain in Flat Finder.
 */
export function looksHousingWanted(text) {
  if (!text) {
    return false;
  }

  const value =
      String(text)
          .replace(/\s+/g, ' ')
          .trim();

  if (!value) {
    return false;
  }

  /*
   * Explicit exception:
   *
   * "ищу на подселение"
   * "ищу соседку"
   * "шукаю співмешканця"
   */
  if (looksRoomOnly(value)) {
    return false;
  }

  const seeker =
      /ищу|ищем|ищет|ищут|шукаю|шукаємо|шукає|шукають|сниму|снимем|снимет|зніму|знімемо|зніме|хочу\s+снять|хотим\s+снять|хочемо\s+зняти|хочу\s+зняти|хочу\s+орендувати|хочемо\s+орендувати|потрібн(?:а|е|ий)|нужн(?:а|о|ы|ен)/iu;

  const housing =
      /квартир[\p{L}-]*|кімнат[\p{L}-]*|комнат[\p{L}-]*|будин[\p{L}-]*|житл[\p{L}-]*|жиль[\p{L}-]*|апартамент[\p{L}-]*|студи[\p{L}-]*|однушк[\p{L}-]*|двушк[\p{L}-]*|тр[её]шк[\p{L}-]*|коттедж[\p{L}-]*|\d+\s*[-–]?\s*(?:к|кк|кімнатн[\p{L}-]*|комнатн[\p{L}-]*)/iu;

  if (
      seeker.test(value) &&
      housing.test(value)
  ) {
    return true;
  }

  /*
   * Частые объявления без слова
   * "квартира":
   *
   * "сниму 2к"
   * "шукаю 1к"
   */
  return /(?:ищу|ищем|шукаю|шукаємо|сниму|зніму)[\s\S]{0,50}\d+\s*[-–]?\s*[кk](?:\s|$|[,.])/iu.test(
      value,
  );
}

// Security deposit required? true/false/null. Also returns the amount when the
// post states one (e.g. "залог 500$").
export function parseDeposit(text) {
  if (!text) return { required: null, amount: null };
  const t = text.toLowerCase();
  const KW = '(?:залог|заклад|депозит|deposit|garan[țt]ie|kaus|kafolat|кепіл)';
  if (!new RegExp(KW, 'i').test(t)) return { required: null, amount: null };
  if (/(без ?залог|без ?депозит|no deposit|fara garantie|депозит ?не ?требует)/i.test(t))
    return { required: false, amount: null };

  // Amounts must be on the same line as the deposit marker. Previously `\s`
  // crossed into the next line and turned a following +998 phone number into a
  // huge deposit. Strip phone-shaped runs first in case contact data is written
  // on the same line, then accept a grouped amount or a bounded plain integer.
  const tail = t.match(new RegExp(`${KW}([^\\r\\n]{0,80})`, 'i'))?.[1] || '';
  const withoutPhones = tail.replace(/\+?\d[\d\s().-]{7,}\d/g, (segment) =>
    segment.replace(/\D/g, '').length >= 9 ? ' ' : segment,
  );
  const m = withoutPhones.match(/(?:^|[^\d])(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d{2,8})(?!\d)/);
  const amount = m ? Number(m[1].replace(/[\s.,]/g, '')) : null;
  // A deposit is often quoted in a different currency from the rent (e.g. rent
  // in UZS but "\u0414\u0435\u043f\u043e\u0437\u0438\u0442 1000USD"). Capture the currency written next to the
  // amount so the UI stops mislabelling it with the listing's currency.
  let currency = null;
  if (m) {
    const near = withoutPhones.slice(Math.max(0, m.index), m.index + m[0].length + 12);
    if (/\$|usd|\u0434\u043e\u043b\u043b\u0430\u0440|\u0443\.?\u0435\.?|\b\u0443\u0435\b/i.test(near)) currency = 'USD';
    else if (/\u20ac|eur|\u0435\u0432\u0440\u043e/i.test(near)) currency = 'EUR';
    else if (/\u0441\u0443\u043c|so'?m|uzs/i.test(near)) currency = 'UZS';
    else if (/\u0442\u0433|\u20b8|kzt|\u0442\u0435\u043d\u0433\u0435/i.test(near)) currency = 'KZT';
    else if (/\u0433\u0440\u043d|\u20b4|uah|\u0433\u0440\u0438\u0432\u043d/i.test(near)) currency = 'UAH';
    else if (/lei|ron/i.test(near)) currency = 'RON';
  }
  return {
    required: true,
    amount: amount && amount >= 10 ? amount : null,
    currency: amount && amount >= 10 ? currency : null,
  };
}

// Agency commission. Returns { has: bool|null, percent: number|null } — percent
// is filled when the post states one (e.g. "комиссия 50%").
export function parseCommission(text) {
  if (!text) return { has: null, percent: null };
  const t = text.toLowerCase();
  // Uzbek Telegram realtor shorthand: `M50%` / Cyrillic `М50%` means
  // makler commission 50%, even when the word makler is omitted.
  const shorthand = t.match(/(?:^|[^\p{L}\p{N}_])[mм]\s*[:.\-]?\s*(\d{1,3})\s*%/iu);
  if (shorthand) {
    const percent = Number(shorthand[1]);
    return { has: true, percent: percent <= 100 ? percent : null };
  }
  const KW = '(?:комисси|комісі|commission|comision|komissiya|комиссионн|ри[еэ]?лтор|ри[еэ]?лтер|услуг[аи]?\\s*ри[еэ]?лтор|маклер|makler|rieltor|vositachi)';
  if (/(без ?комисси|без ?комісі|no commission|fara comision|fără comision|без ?комиссионн)/i.test(t))
    return { has: false, percent: 0 };
  if (!new RegExp(KW, 'i').test(t)) return { has: null, percent: null };
  const m = t.match(new RegExp(`${KW}[^\\d]{0,15}(\\d{1,3})\\s*%`, 'i'));
  const percent = m ? Number(m[1]) : null;
  return { has: true, percent: percent != null && percent <= 100 ? percent : null };
}

// Whether a post was placed by a realtor / broker / agency rather than the
// owner. Telegram posts have no structured business flag (unlike OLX), so we
// infer it from the text: an explicit realtor/broker/agency word, or a stated
// "realtor fee / agency service" charge. Returns true when such a signal is
// present and not negated ("без посредников", "vositachisiz"), otherwise false.
const AGENCY_RE =
  /(ри[еэ]л?тор|реал?тор|макл[её]р|агентств|агент\s+по\s+недвиж|услуги\s+агентств|реал?тор\s*хак|макл[её]р\s*хак|rieltor|makler|vositachi(?!siz)|agentlik|realtor|real\s*estate\s*agen|broker|брокер|(?:^|[^\p{L}\p{N}_])[mм]\s*\d{1,3}\s*%)/iu;
const NO_AGENCY_RE =
  /(без\s+посредник|без\s+ри[еэ]л?тор|без\s+макл|без\s+агент|no\s+agency|fara\s+intermediari|vositachisiz|egasidan|иесінен)/i;

export function classifyAgency(text) {
  if (!text) return false;
  if (NO_AGENCY_RE.test(text)) return false;
  return AGENCY_RE.test(text);
}

export function guessPropertyType(text) {
  if (!text) return 'flat';
  // Prefer an explicit apartment word. Real-estate copy often says
  // "квартира в новом доме"; checking the generic house word first used to
  // misclassify those rows as houses.
  if (/(apartment|apartament|квартир|kvartira|пәтер|квартиралар|xonadon)/i.test(text)) {
    return 'flat';
  }
  // house (EN), casa (RO), dom/дом (RU), будин (UA), коттедж/villa/вілл/вилл,
  // hovli (UZ), үй (KZ). Do not treat Uzbek "uy" alone as a detached house:
  // it commonly means home/apartment in phrases such as "uy yangi remontdan
  // chiqqan" and was misclassifying ordinary Tashkent flats.
  return /(?:\b(?:house|casa|dom|villa|hovli)\b|будин|коттедж|вілл|вилл|(?:^|[^\p{L}\p{N}_])(?:дом|үй)(?=$|[^\p{L}\p{N}_]))/iu.test(text)
    ? 'house'
    : 'flat';
}

// UZ/Central-Asian "kvartal" / massiv / micro-district, e.g. "Chilonzor 8
// kvartal", "Юнусабад 19 квартал", "мкр 4". Returns a short "N kvartal" label
// (used later to place the map pin more precisely), or null.
export function parseKvartal(text) {
  if (!text) return null;
  // Named Tashkent microdistricts are commonly written without an explicit
  // `микрорайон` label. Keep them in the same field as numbered kvartals so
  // they appear in the UI's "Quarter / microdistrict" row.
  if (/(?:^|[^\p{L}\p{N}_])(?:глинк[аи]?|glinka)(?:$|[^\p{L}\p{N}_])/iu.test(text)) return 'Glinka';
  const m =
    text.match(/(\d{1,3})\s*(?:-?\s*(?:chi|чи))?\s*[-\s]?\s*(?:квартал|кв-?л\b|kvartal(?:i)?|мкр\b|микрорайон|массив|massiv|daha(?:si|dan)?|hudud|худуд)/i) ||
    text.match(/(?:квартал|kvartal(?:i)?|мкр|микрорайон|массив|massiv|daha(?:si|dan)?|hudud|худуд)\s*[-№#]?\s*(\d{1,3})/i) ||
    // Tashkent shorthand omits the word "kvartal": "Chilonzor 12" means
    // Chilanzar district, 12th kvartal (not metro Chilonzor + building 12).
    text.match(/(?:чиланзар|chilonzor|chilanzar)\s*[-№#]?\s*(\d{1,2})(?!\d)/i);
  if (m) return `${m[1]} kvartal`;
  const centralBlock = text.match(/(?:^|[^\p{L}\p{N}_])(?:ц|c)\s*[-–]?\s*(\d{1,2})(?:$|[^\p{L}\p{N}_])/iu);
  return centralBlock ? `C-${centralBlock[1]}` : null;
}

// Features that do not have a dedicated normalized boolean are rendered in
// the UI's "Other amenities" row.
export function parseAmenities(text) {
  if (!text) return [];
  const amenities = [];
  if (/(?:посудомо|посудомийн|dishwasher|idish\s*yuvish|idishyuvg|ma[șs]ina de sp[ăa]lat vase)/i.test(text)) {
    amenities.push('Dishwasher');
  }
  if (/(?:комнат[а-яё]*\s+раздельн|изолированн[а-яё]*\s+комнат|separate\s+rooms?)/i.test(text)) {
    amenities.push('Separate rooms');
  }
  if (/(?:стиральн[а-яё]*\s+машин|washing\s+machine|kir\s*yuvish\s*mashin|kirmoshina)/i.test(text)) {
    amenities.push('Washing machine');
  }
  if (/(?:телевизор|телевизион|televizor|television|\btv\b)/i.test(text)) amenities.push('Television');
  if (/(?:постельн[а-яё]*\s+бель|bed\s*linen|toza\s+choyshab|yostiq\s+jild)/i.test(text)) amenities.push('Bed linen');
  if (/(?:полотенц|towels?|sochiq)/i.test(text)) amenities.push('Towels');
  return amenities;
}

// Named retail chains / malls mentioned (proximity signal). Deduped canonical
// names. Guards ("metro cash&carry" not the subway; "small" the shop).
const SHOP_CHAINS = [
  ['Korzinka', /korzinka|корзинка/i],
  ['Makro', /\bmakro\b|макро/i],
  ['Havas', /\b[хxh]avas\b|хавас/i],
  ['Carrefour', /carrefour|карфур/i],
  ['ATB', /\bатб\b|\batb\b/i],
  ['Klass', /\bklass\b|\bкласс\b/i],
  ['Magnum', /magnum|магнум/i],
  ['Bravo', /\bbravo\b|браво/i],
  ['Metro C&C', /\bmetro\s*(?:cash|c\s*&\s*c|market)|метро\s*кэш/i],
];
// Named civic/landmark places a post lists as orientation points ("рядом ЗАГС
// Чиланзарского района, рынок Катартал"). These are the "nearby landmarks" the
// LOCATIONS dictionary can't cover, because the names are local and open-ended.
// Each rule captures the following proper name when there is one, so the label
// stays informative ("Рынок Катартал") rather than a bare category.
const PLACE_KINDS = [
  ['Рынок', /(?:рынок|базар|bozor)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24})/u],
  // No \b before Cyrillic: JS word boundaries only understand ASCII letters.
  ['ЗАГС', /(?:^|[^A-Za-zА-Яа-яЁё])ЗАГС(?:\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24}(?:\s+район[а-яё]*)?))?/u],
  ['Парк', /(?:парк)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24})/u],
  ['Школа', /(?:школа)\s*(№\s*\d{1,4})/iu],
  ['Клиника', /(?:клиника|поликлиника|больница)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24})/u],
  ['Стадион', /(?:стадион)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24})/u],
  ['Университет', /(?:университет|институт)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё'’-]{2,24})/u],
];

// Posts routinely spell out their surroundings — "Рядом есть: Миллий Бог,
// Ташкент сити, NRG U-Tower, Узбекфильм…" — and that list is worth more than
// the generic kinds below, which only ever recorded that *a* mosque exists.
const NEARBY_BLOCK_RE =
  /(?:^|\n)[^\n]{0,30}?(?:что\s+(?:есть|находится)\s+р[яa]дом|р[яa]дом(?:\s+(?:есть|находятся|расположены|с\s+домом))?|непода[лл][её]ку|поблизости|в\s+шаговой\s+доступности|окружени[ие]|ориентир(?:ы|ами)?|yaqinida|atrofida|yonida|nearby|landmarks?)\s*[:—-]?\s*([^\n]{4,500})/iu;

// Words that describe the flat rather than name a place, plus the filler that
// survives a comma split.
const NEARBY_NOISE_RE =
  /^(?:и|а|в|на|у|до|от|все|вс[её]|есть|рядом|близко|недалеко|минут\p{L}*|пешком|транспорт|остановк\p{L}*|магазин|магазины|аптека|аптеки|садик|садики|всё\s+необходимое|развит\p{L}*)$/iu;

// Phrases that promise surroundings without naming any: keep them out however
// they are worded ("вся инфраструктура города", "находится вся инфраструктура").
const NEARBY_FILLER_RE =
  /(?:инфраструктур\p{L}*|все\s+необходимо|вс[её]\s+рядом|шаговой\s+доступност|развитый\s+район)/iu;

/** Named places from an explicit "рядом" enumeration, in the order written. */
function enumeratedNearby(text) {
  // A post often carries both a short "Ориентир: X" line and a full
  // "Рядом есть: ..." list; the first match alone threw the longer one away.
  const blocks = [...text.matchAll(new RegExp(NEARBY_BLOCK_RE.source, NEARBY_BLOCK_RE.flags + 'g'))]
    .map((match) => match[1])
    .filter(Boolean);
  if (!blocks.length) return [];

  // Case-insensitive dedup: one post writes the same landmark both ways
  // ("Ориентир: Дружба Нородов" in the header, "Дружба нородов" in the list).
  const seen = new Set();
  const items = [];

  for (const item of blocks
    .join(', ')
    .split(/[,;•·|]+/)
    .map((part) =>
      part
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—.]+|[\s\-–—.!]+$/g, '')
        .trim(),
    )) {
    if (item.length < 3 || item.length > 45) continue;
    if (NEARBY_NOISE_RE.test(item) || NEARBY_FILLER_RE.test(item)) continue;
    // Needs at least one real word; "5 мин" and "2" are not places.
    if (!/\p{L}{3,}/u.test(item)) continue;

    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 14) break;
  }

  return items;
}

export function parseNearbyPlaces(text) {
  if (!text) return [];
  const out = enumeratedNearby(text);
  for (const [kind, re] of PLACE_KINDS) {
    const m = text.match(re);
    if (!m) continue;
    const label = m[1] ? `${kind} ${m[1].trim()}` : kind;
    // A generic "Мечеть" adds nothing when the post already named one.
    if (out.some((item) => item.toLowerCase().includes(kind.toLowerCase()))) continue;
    if (!out.includes(label)) out.push(label);
  }
  return out.slice(0, 16);
}

export function parseNearbyShops(text) {
  if (!text) return [];
  const out = [];
  for (const [name, re] of SHOP_CHAINS) if (re.test(text) && !out.includes(name)) out.push(name);
  // Named malls: "High Town Mall", "Compass Mall", "Samarqand moll". Name words
  // are Latin (mall brands almost always are), so we don't trip over Cyrillic
  // word boundaries (JS \w skips Cyrillic).
  const named = text.match(/([A-Za-z][A-Za-z'’.&-]*(?:\s+[A-Za-z][A-Za-z'’.&-]*){0,3}\s+(?:mall|moll|молл))/i);
  if (named && !out.includes(named[1].trim())) out.push(named[1].trim());
  const trc = text.match(/(?:трц|тц)\s+([A-Za-z0-9'’.-]{2,25}|[А-Яа-яЁё0-9'’.-]{2,25})/i);
  if (trc) { const n = 'ТРЦ ' + trc[1].trim(); if (!out.includes(n)) out.push(n); }
  return out;
}
