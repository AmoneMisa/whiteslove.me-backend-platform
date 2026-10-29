import test from 'node:test';
import assert from 'node:assert/strict';
import { DISTRICT_KINDS, alignSpans, citySkeletons, placeKinds, ambiguousStations, districtIndex, stationGroups, stationSkeletons, toCodePointOffsets } from '../src/ml/span-align.js';

const NL = String.fromCharCode(10);

const cut = (text, spans, label) => spans.filter((s) => s.label === label).map((s) => text.slice(s.start, s.end));
// every district-like place in the order it is written, whatever its kind
const placesOf = (text, spans) => spans.filter((s) => DISTRICT_KINDS.includes(s.label)).sort((x, y) => x.start - y.start).map((s) => text.slice(s.start, s.end));

test('price with currency marker: both spans, any side of the number', () => {
  const t = 'Сдаётся 2к. Ціна: 15 000 грн. Залог 500$';
  const r = alignSpans(t, { price: 15000, currency: 'UAH' });
  assert.deepEqual(cut(t, r.spans, 'PRICE'), ['15 000']);
  assert.deepEqual(cut(t, r.spans, 'CURRENCY'), ['грн.']);
  const d = '$500 в месяц';
  const r2 = alignSpans(d, { price: 500, currency: 'USD' });
  assert.deepEqual(cut(d, r2.spans, 'PRICE'), ['500']);
  assert.deepEqual(cut(d, r2.spans, 'CURRENCY'), ['$']);
});

test('thousands suffix and decimal comma', () => {
  const t = 'Цена 15к грн';
  assert.deepEqual(cut(t, alignSpans(t, { price: 15000, currency: 'UAH' }).spans, 'PRICE'), ['15к']);
});

test('a marker that contradicts the stored currency makes price and currency ignored', () => {
  const t = 'Цена 500 € в месяц';
  const r = alignSpans(t, { price: 500, currency: 'USD' });
  assert.equal(r.spans.some((s) => s.label === 'PRICE'), false);
  assert.ok(r.ignore.includes('PRICE') && r.ignore.includes('CURRENCY'));
});

test('a bare number is used when it is the single candidate, or one price written the same way each time', () => {
  // two different writings of the same value: nothing says which is the price
  assert.ok(alignSpans('Этаж 15 000 и цена 15000', { price: 15000, currency: 'USD' }).ignore.includes('PRICE'));
  // the price repeated as written (title and body): one price
  const t = 'Цена 168.000, звоните. Итого 168.000';
  assert.deepEqual(cut(t, alignSpans(t, { price: 168000, currency: 'USD' }).spans, 'PRICE'), ['168.000', '168.000']);
  const r = alignSpans('Цена 500 в месяц', { price: 500, currency: 'USD' });
  assert.equal(r.spans.filter((s) => s.label === 'PRICE').length, 1);
  assert.ok(r.ignore.includes('CURRENCY'), 'no marker, currency not trained');
  const u = '164 995 u.e. всего';
  assert.deepEqual(cut(u, alignSpans(u, { price: 164995, currency: 'USD' }).spans, 'CURRENCY'), ['u.e.']);
});

test('address: prefix + street + house number; bare district words are not addresses', () => {
  const t = 'Моря. ЖК Родос. ул. Генуэзская 22, этаж 5';
  const r = alignSpans(t, { address: 'ул. Генуэзская 22', price: null });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), ['ул. Генуэзская 22']);
  const d = 'Район: Мирзо- Улугбекский Комнат: 3';
  assert.ok(alignSpans(d, { address: 'Улугбекский' }).ignore.includes('ADDRESS'));
});

test('"22 этаж" is a floor, not a house number', () => {
  const t = 'Моря. ул. Генуэзская 22 этаж Площадь';
  assert.deepEqual(cut(t, alignSpans(t, { address: 'ул. Генуэзская 22' }).spans, 'ADDRESS'), ['ул. Генуэзская']);
});

test('house number is not taken from a room count', () => {
  const t = 'Сдам на Рогатинская 3 комнатная квартира';
  const r = alignSpans(t, { address: 'Рогатинская' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), []);
  assert.ok(r.ignore.includes('ADDRESS'));
});

test('metro: found by name in either script, ignored when missing or unnamed, absent otherwise', () => {
  const t = 'Рядом метро Дристор 1, тихо';
  assert.deepEqual(cut(t, alignSpans(t, { metro: 'Дристор' }).spans, 'METRO'), ['Дристор']);
  assert.deepEqual(cut(t, alignSpans(t, { metro: 'Dristor' }).spans, 'METRO'), ['Дристор'], 'transliterated name lines up');
  const u = 'Салтівська, 5 хвилин';
  assert.deepEqual(cut(u, alignSpans(u, { metro: 'Saltivska' }).spans, 'METRO'), ['Салтівська']);
  const w = 'рядом Амир Темур хиёбони метро';
  assert.deepEqual(cut(w, alignSpans(w, { metro: 'Amir Temur Xiyoboni' }).spans, 'METRO'), ['Амир Темур хиёбони']);
  assert.ok(alignSpans('метро Лукьяновская', { metro: 'Saltivska' }).ignore.includes('METRO'), 'stored station absent from the text');
  assert.ok(alignSpans('10 минут до метро', { metro: null }).ignore.includes('METRO'));
  assert.equal(alignSpans('Тихий двор', { metro: null }).ignore.includes('METRO'), false);
});

test('address ignores a stored value that runs on into the next sentence and sentence verbs', () => {
  const t = 'ул. Независимой Украины.' + NL + 'Продается 1-комнатная';
  const r = alignSpans(t, { address: 'ул. Независимой Украины.' + NL + 'Продается 1-комнатная квартира' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), ['ул. Независимой Украины']);
  assert.ok(alignSpans('Сдам 1-комнатную квартиру', { address: 'Сдам 1-комнатную квартиру' }).ignore.includes('ADDRESS'));
});

test('code point offsets: emoji before a span no longer shift it', () => {
  const t = '💰💰 Цена 15 000 грн';
  const r = alignSpans(t, { price: 15000, currency: 'UAH' });
  const [price] = toCodePointOffsets(t, r.spans.filter((s) => s.label === 'PRICE'));
  // Python/HF see each emoji as one character, so slice by code points.
  const points = [...t];
  assert.equal(points.slice(price.start, price.end).join(''), '15 000');
  assert.notEqual(t.slice(price.start, price.end), '15 000', 'raw UTF-16 offsets would point elsewhere');
});

test('an address never runs across a line break', () => {
  const t = 'вул. Мазепи' + NL + 'Продається простора квартира';
  const r = alignSpans(t, { address: 'вул. Мазепи Продається простора' });
  assert.equal(r.spans.some((s) => s.label === 'ADDRESS'), false);
  const u = 'вул. Мазепи' + NL + '5 поверх';
  assert.deepEqual(cut(u, alignSpans(u, { address: 'вул. Мазепи' }).spans, 'ADDRESS'), ['вул. Мазепи']);
});

test('other amounts with a currency are neutral, not negatives', () => {
  const t = 'Цена 500 € в месяц, залог 400 €, комиссия 250 €';
  const r = alignSpans(t, { price: 500, currency: 'EUR' });
  assert.deepEqual(cut(t, r.spans, 'PRICE'), ['500']);
  assert.deepEqual(cut(t, r.spans, 'DEPOSIT'), ['400'], 'the deposit is its own kind of price now');
  assert.deepEqual(cut(t, r.spans, 'COMMISSION'), ['250'], 'the commission is its own kind of amount now');
  assert.deepEqual(cut(t, r.neutral, 'PRICE'), []);
  assert.deepEqual(cut(t, r.neutral, 'CURRENCY'), ['€', '€'], "the deposit's and the commission's currencies are skipped");
});

test('deposit and utilities: the cue word right before the amount; negations, later cues and counts do not label', () => {
  const kinds = (t, row) => alignSpans(t, row).spans.filter((x) => ['PRICE', 'DEPOSIT', 'UTILITIES'].includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(kinds('Аренда 400$ + коммунальные 60$ в месяц. Депозит: 400 долларов', { price: 400, currency: 'USD' }),
    ['DEPOSIT:400', 'UTILITIES:60', 'PRICE:400']);
  assert.deepEqual(kinds('Залог 300$, коммунальные 50$ отдельно. Цена 300$', { price: 300, currency: 'USD' }), ['DEPOSIT:300', 'UTILITIES:50', 'PRICE:300']);
  assert.deepEqual(kinds('Prețul 350 euro, garanție 350 euro, utilități 40 euro', { price: 350, currency: 'EUR' }), ['DEPOSIT:350', 'UTILITIES:40', 'PRICE:350']);
  // "залог не нужен", "без залога": the cue is there but no amount belongs to it: masked, not a negative
  // "no deposit" is a statement about the deposit: the phrase is the span, whatever the amount that follows
  for (const [t, phrase] of [['Цена 500$ залог не нужен', 'залог не нужен'], ['Квартира без залога, 500$', 'без залога'], ['Залог не нужен, 500$', 'Залог не нужен']]) {
    assert.deepEqual(kinds(t, { price: 500, currency: 'USD' }), [`DEPOSIT:${phrase}`, 'PRICE:500'], t);
  }
  // a percentage, an area and a duration are not money; the Romanian "depozit" is a warehouse
  for (const t of ['Залог 100% + коммунальные + 50% комиссия', 'depozit atelier 83 mp, pret 500 euro', 'Ремонт 2 месяца назад, оплата за 2 месяца вперёд']) {
    assert.deepEqual(alignSpans(t, {}).spans.filter((x) => ['DEPOSIT', 'UTILITIES'].includes(x.label)), [], t);
  }
  // a deposit of so many months is a deposit too: the span is the count with its unit, money is worked out later
  const months = (t) => alignSpans(t, { price: 600, currency: 'USD' }).spans.filter((x) => x.label === 'DEPOSIT').map((x) => t.slice(x.start, x.end));
  assert.deepEqual(months('Аренда 600 долларов, залог 2 месяца'), ['2 месяца']);
  assert.deepEqual(months('Залог: в размере одного месяца'), ['одного месяца']);
  assert.deepEqual(months('Депозит — месячная оплата'), ['месячная оплата']);
  assert.deepEqual(months('Застава: 1 місяць оренди'), ['1 місяць']);
  assert.deepEqual(months('Narxi 500$, depozit ikki oy'), ['ikki oy']);
  assert.deepEqual(months('Ремонт 2 месяца назад, залог 300$'), ['300'], 'only the cued count is a deposit');
  // no cue at all: the kinds are absent, which is a real negative
  assert.equal(alignSpans('Цена 500$', { price: 500, currency: 'USD' }).ignore.includes('DEPOSIT'), false);
});

test('a bare number elsewhere is not neutral (it may be a floor or an area)', () => {
  const t = 'Цена 500 € , этаж 3, площадь 45';
  assert.deepEqual(alignSpans(t, { price: 500, currency: 'EUR' }).neutral, []);
});

test('a street-type word at the end of a line is not a prefix of the next line', () => {
  const t = 'Бульвар.' + NL + NL + 'Адрес Шайхантахурский район';
  const r = alignSpans(t, { address: 'Шайхантахурский' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), []);
});

test('"пер" inside a word is not a street-type prefix', () => {
  const t = 'Супер предложение, центр';
  const r = alignSpans(t, { address: 'предложение' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), []);
});

test('lowercase unprefixed words and opening hours are not addresses', () => {
  const t = 'горячая вода 24/7, свет';
  assert.deepEqual(cut(t, alignSpans(t, { address: 'горячая вода 24/7' }).spans, 'ADDRESS'), []);
  const u = 'Краснова 67, тихо';
  assert.deepEqual(cut(u, alignSpans(u, { address: 'Краснова' }).spans, 'ADDRESS'), ['Краснова 67'], 'capitalised + house number is fine');
});

test('another street in the same text is neutral, not a negative', () => {
  const t = 'ул. Абая 5, рядом с пр. Достык 20';
  const r = alignSpans(t, { address: 'ул. Абая 5' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), ['ул. Абая 5']);
  assert.deepEqual(cut(t, r.neutral, 'ADDRESS'), ['пр. Достык 20']);
});

test('no stored address: a text that still names a place is ignored, a clean one is absent', () => {
  assert.ok(alignSpans('Тихий район, Краснова, 67, свежий ремонт', {}).ignore.includes('ADDRESS'));
  assert.ok(alignSpans('Адрес: уточняйте по телефону', {}).ignore.includes('ADDRESS'));
  const clean = alignSpans('Тихий район, свежий ремонт, этаж 5', {});
  assert.equal(clean.ignore.includes('ADDRESS'), false);
});

test('stations: others in the text are neutral; with no stored station a known name is ignored', () => {
  const stations = stationSkeletons(Array(10).fill('Chorsu').concat(Array(10).fill('Tinchlik')), 8);
  const t = 'рядом метро Тинчлик и Чорсу';
  const r = alignSpans(t, { metro: 'Tinchlik' }, { stations });
  assert.deepEqual(cut(t, r.spans, 'METRO'), ['Тинчлик']);
  assert.deepEqual(cut(t, r.neutral, 'METRO'), ['Чорсу']);
  assert.ok(alignSpans('Квартира у Чорсу', {}, { stations }).ignore.includes('METRO'));
  assert.equal(alignSpans('Квартира в тихом дворе', {}, { stations }).ignore.includes('METRO'), false);
});

test('a price glued to the previous word by a full stop is still found', () => {
  const t = 'Шунинг учун арзон.350 доллор.реалтир хизмати бор.';
  const r = alignSpans(t, { price: 350, currency: 'USD' });
  assert.deepEqual(cut(t, r.spans, 'PRICE'), ['350']);
  assert.deepEqual(cut(t, r.spans, 'CURRENCY'), ['доллор']);
});

test('decimals and thousands separators are not split by the relaxed lookbehind', () => {
  const t = 'Цена 0.350 $ в сутки';
  assert.deepEqual(cut(t, alignSpans(t, { price: 350, currency: 'USD' }).spans, 'PRICE'), [], '0.350 is not 350');
  const u = 'Цена 1,200 $ в месяц';
  assert.deepEqual(cut(u, alignSpans(u, { price: 1200, currency: 'USD' }).spans, 'PRICE'), ['1,200']);
});

test('a station named after the city counts only with a metro cue', () => {
  const stations = stationSkeletons(Array(10).fill('Toshkent'), 8);
  const cued = 'Рядом метро Ташкент, 5 минут пешком';
  assert.deepEqual(cut(cued, alignSpans(cued, { metro: 'Toshkent' }, { stations }).spans, 'METRO'), ['Ташкент']);

  const city = 'Тошкент шахар, Чилонзор тумани';
  const r = alignSpans(city, { metro: 'Toshkent' }, { stations });
  assert.ok(r.ignore.includes('METRO'), 'only the city is mentioned: no reliable station label');

  const both = 'Тошкент шахар. Станция метро Тошкент рядом';
  const b = alignSpans(both, { metro: 'Toshkent' }, { stations });
  assert.deepEqual(cut(both, b.spans, 'METRO'), ['Тошкент'], 'the cued one only');
  assert.equal(b.spans.length, 1);
  assert.equal(b.neutral.filter((n) => n.label === 'METRO').length, 1, 'the city mention is neutral');
});

test('with no stored station, the bare city name is not a reason to ignore the row', () => {
  const stations = stationSkeletons(Array(10).fill('Toshkent'), 8);
  assert.equal(alignSpans('Квартира в Тошкент шахар, тихий двор', {}, { stations }).ignore.includes('METRO'), false);
  const cued = alignSpans('Квартира у метро Тошкент', {}, { stations });
  assert.deepEqual(cut('Квартира у метро Тошкент', cued.spans, 'METRO'), ['Тошкент'], 'a known station next to "метро" is labelled even when the row stores none');
});

test('a station that is also a district counts only next to a metro cue; a stored alias is the same station', () => {
  const groups = stationGroups([['Chilonzor', 'Чиланзар'], ['Xalqlar Dostligi', 'Дружба Народов']]);
  const ambiguous = ambiguousStations([['Chilonzor', 'Чиланзар'], ['Xalqlar Dostligi', 'Дружба Народов']], ['Chilanzar', 'Чиланзар']);
  const stations = stationSkeletons(['Chilonzor', 'Xalqlar Dostligi'], 0, ['Чиланзар', 'Дружба Народов']);
  const context = { stations, stationGroups: groups, ambiguousStations: ambiguous };
  const t = 'Суточная квартира на Чиланзаре, рядом метро Чиланзар';
  const r = alignSpans(t, { metro: 'Chilonzor' }, context);
  assert.deepEqual(cut(t, r.spans, 'METRO'), ['Чиланзар'], 'only the cued mention');
  const u = 'Квартира, до метро Дружба Народов 5 минут';
  assert.deepEqual(cut(u, alignSpans(u, { metro: 'Xalqlar Dostligi' }, context).spans, 'METRO'), ['Дружба Народов']);
});

test('district: a canonical Latin name is found in a declined local-script phrase, with its generic noun', () => {
  const t = 'Сдаётся в Шевченківському районі, рядом парк';
  const r = alignSpans(t, { district: 'Shevchenkivskyi' });
  assert.deepEqual(placesOf(t, r.spans), ['Шевченківському районі']);
  const u = 'Мирзо-Улугбекский район, 3 комнаты';
  assert.deepEqual(placesOf(u, alignSpans(u, { district: 'Mirzo Ulugbek' }).spans), ['Мирзо-Улугбекский район']);
});

test('district: a locality from the area column, with a case ending', () => {
  const t = 'Ташкент, на Глинке, 3 комнаты';
  assert.deepEqual(placesOf(t, alignSpans(t, { area: 'Glinka' }).spans), ['Глинке']);
});

test('district: stored but never written, or only a quarter number, is ignored rather than "none"', () => {
  assert.ok(alignSpans('Квартира в центре', { district: 'Yunusabad' }).ignore.includes('DISTRICT'));
  assert.ok(alignSpans('Квартира у метро', { area: '2 kvartal' }).ignore.includes('DISTRICT'));
});

test('district: every district named in the text is labelled, "мкр X" and "район X" phrases included', () => {
  const t = 'Глинка, мкр. Нурсат, 3 комнаты';
  const r = alignSpans(t, { area: 'Glinka' });
  assert.deepEqual(placesOf(t, r.spans), ['Глинка', 'мкр. Нурсат']);
});

test('district: a and o are one letter, so "Яшнабадский" matches the stored "Yashnobod"', () => {
  const t = 'Яшнабадский район, 3 комнаты';
  assert.deepEqual(placesOf(t, alignSpans(t, { district: 'Yashnobod' }).spans), ['Яшнабадский район']);
});

test('district: a name known from the whole dataset is labelled even where this row stores another', () => {
  const index = districtIndex(Array(400).fill('Obolon'), 300);
  const t = 'Квартира на Оболоні, 3 комнаты';
  assert.deepEqual(placesOf(t, alignSpans(t, { district: 'Pecherskyi' }, { districts: index }).spans), ['Оболоні']);
});

test('district: nothing stored: one named in the text is labelled, a clean text has none', () => {
  const t = 'Продаётся в районе Староміський';
  assert.deepEqual(placesOf(t, alignSpans(t, {}).spans), ['районе Староміський']);
  const clean = alignSpans('Тихий двор, свежий ремонт', {});
  assert.equal(clean.ignore.includes('DISTRICT'), false);
  assert.deepEqual(placesOf('x', clean.spans), []);
});

test('landmarks: every item after a cue word, and not the station already found', () => {
  const t = 'Ориентиры: Тийин Маркет, Буз Базар, Veolia Мирзо-Улугбекского района, недалеко 71 школа, институт Дипломатии';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'LANDMARK'),
    ['Тийин Маркет', 'Буз Базар', 'Veolia', '71 школа', 'институт Дипломатии'], 'the district inside "Veolia ... района" is cut off');
  const m = 'Рядом с метро Минор, тихо';
  assert.deepEqual(cut(m, alignSpans(m, { metro: 'Minor' }).spans, 'LANDMARK'), [], 'a station is a METRO, not a landmark');
});

test('landmarks: a plain clause or a distance is not one; a kind of landmark the rule missed makes the row ignored', () => {
  assert.deepEqual(cut('рядом с центром города', alignSpans('рядом с центром города', {}).spans, 'LANDMARK'), []);
  assert.ok(alignSpans('Есть школа и парк во дворе', {}).ignore.includes('LANDMARK'));
  assert.equal(alignSpans('Тихий двор, свежий ремонт', {}).ignore.includes('LANDMARK'), false);
});

test('district: the shortest matching window; the words after it are not swallowed', () => {
  const t = 'Панорамний вид на Печерськ та Taryan Towers';
  assert.deepEqual(placesOf(t, alignSpans(t, { district: 'Pechersk' }).spans), ['Печерськ']);
  const u = 'Аренда квартир сергели сокин макон';
  assert.deepEqual(placesOf(u, alignSpans(u, { district: 'Sergeli' }).spans), ['сергели']);
});

test('district: a name written after "метро" is the station, not the district', () => {
  const stations = stationSkeletons(Array(10).fill('Minor'), 8);
  const t = 'Ориентир: метро минор, 3 комнаты';
  const r = alignSpans(t, { metro: 'Minor', area: 'Minor' }, { stations });
  assert.deepEqual(cut(t, r.spans, 'METRO'), ['минор']);
  assert.deepEqual(placesOf(t, r.spans), []);
});

test('landmarks: offsets stay exact across two-letter separators ("și", "та")', () => {
  const t = 'Locuință lângă Lidl și Kaufland, parter';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'LANDMARK'), ['Lidl', 'Kaufland']);
  const u = 'поруч магазини АТБ, Новус та ФОРА, школа';
  assert.deepEqual(cut(u, alignSpans(u, {}).spans, 'LANDMARK'), ['магазини АТБ', 'Новус', 'ФОРА']);
  const v = 'біля ТРЦ Ocean Plaza та Лісової';
  assert.deepEqual(cut(v, alignSpans(v, {}).spans, 'LANDMARK'), ['ТРЦ Ocean Plaza', 'Лісової']);
});

test('landmarks: a lowercase kind of place with a qualifier says what is near; a number makes it a landmark', () => {
  const t = 'недалеко від міського озера, перша аптека та школи №23';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'LANDMARK'), ['школи №23']);
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'NEARBY'), ['міського озера', 'перша аптека']);
});

test('landmarks: a station list is METRO territory, a bare "школа" is not a landmark, stray punctuation is trimmed', () => {
  const stations = stationSkeletons(Array(10).fill('Kharkivska').concat(Array(10).fill('Vyrlytsia')), 8);
  const t = 'біля станцій метро Харківська, Вирлиця. Ориентир: ЖК Казахстан ////';
  const r = alignSpans(t, {}, { stations });
  assert.deepEqual(cut(t, r.spans, 'LANDMARK'), [], 'the station list, and a complex, are not landmarks');
  assert.deepEqual(cut(t, r.spans, 'COMPLEX'), ['ЖК Казахстан']);
  assert.deepEqual(cut('рядом с школа, садик', alignSpans('рядом с школа, садик', {}).spans, 'LANDMARK'), []);
});

test('complex: "ЖК" belongs to the span, a long marker does not, as a person selects them', () => {
  const a = 'ЖК Дельмар, вул. Драгомирова 14а';
  assert.deepEqual(cut(a, alignSpans(a, { address: 'Драгомирова 14а' }).spans, 'COMPLEX'), ['ЖК Дельмар']);
  const b = 'Продам в ЖК «Срібна Вежа». Поруч парк';
  assert.deepEqual(cut(b, alignSpans(b, {}).spans, 'COMPLEX'), ['ЖК «Срібна Вежа»']);
  const c = 'situat in Complexul Qualis 2, vis-a-vis de Coresi Mall';
  assert.deepEqual(cut(c, alignSpans(c, {}).spans, 'COMPLEX'), ['Qualis 2'], 'only the name after "Complexul"');
  const d = 'Квартира в ЖК Тиара Резиденс на 5 этаже';
  assert.deepEqual(cut(d, alignSpans(d, {}).spans, 'COMPLEX'), ['ЖК Тиара Резиденс']);
  const e = 'Жилой комплекс : U-tower, Ташкент';
  assert.deepEqual(cut(e, alignSpans(e, {}).spans, 'COMPLEX'), ['U-tower']);
});

test('complex: a name marked once is labelled where it is repeated without the marker', () => {
  const t = 'ЖК ParkStone, 2 кімнати. Продаж у ParkStone, поруч парк. Про комплексі ParkStone детальніше';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'COMPLEX'), ['ЖК ParkStone', 'ParkStone', 'ParkStone']);
});

test('complex: a lowercase word, a listing word, or an unmarked name is not one', () => {
  assert.deepEqual(cut('в комплексе есть парковка', alignSpans('в комплексе есть парковка', {}).spans, 'COMPLEX'), []);
  assert.deepEqual(cut('ЖК Продается 2 комнатная', alignSpans('ЖК Продается 2 комнатная', {}).spans, 'COMPLEX'), []);
  assert.deepEqual(cut('Живу в Nest One давно', alignSpans('Живу в Nest One давно', {}).spans, 'COMPLEX'), [], 'no marker, no label');
});

test('district: "Метро Чиланзар" is the station even when only the district column knows the name', () => {
  const t = 'Рядом Есть: Метро Чиланзар 16 Городской';
  assert.deepEqual(placesOf(t, alignSpans(t, { area: 'Chilanzar' }).spans), []);
});

test('landmarks: the last item of a window-cut clause is dropped, and a name is at most four words', () => {
  const long = 'ориентир: ' + 'Алмазар, '.repeat(40) + 'Herman Oberth, Olga Gudynn';
  const spans = alignSpans(long, {}).spans.filter((s) => s.label === 'LANDMARK');
  assert.ok(spans.length > 0);
  for (const s of spans) assert.equal(long.slice(s.start, s.end), 'Алмазар', 'no half word at the end');
  const t = 'ориентир Анжир миллий таомлар С мебелью и техникой';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'LANDMARK'), []);
});

test('complex: the name stops before an ALL-CAPS listing word', () => {
  const t = 'ЖК Nikitina Residence НОВОСТРОЙКА — 2/6/9';
  assert.deepEqual(cut(t, alignSpans(t, {}).spans, 'COMPLEX'), ['ЖК Nikitina Residence']);
  const u = 'ЖК MEGA DOM, 4/6/8';
  assert.deepEqual(cut(u, alignSpans(u, {}).spans, 'COMPLEX'), ['ЖК MEGA DOM']);
});

test('district: four or more districts close together are an agency list, not this flat\'s district', () => {
  const index = districtIndex(['Mirobod', 'Yashnobod', 'Yunusabad', 'Chilanzar', 'Sergeli'].flatMap((n) => Array(400).fill(n)), 300);
  const list = 'Variantlar: Mirobod, Yashnobod, Yunusobod, Chilonzor, Sergeli. Qolganini so\'rang';
  assert.deepEqual(placesOf(list, alignSpans(list, {}, { districts: index }).spans), []);
  const one = 'Kvartira Chilonzor tumanida, 3 xona';
  assert.deepEqual(placesOf(one, alignSpans(one, {}, { districts: index }).spans), ['Chilonzor']);
});

test('district: a name from the dataset-wide list needs a capital ("manzarasi" is "view")', () => {
  const index = districtIndex(Array(400).fill('Manzara'), 300);
  assert.deepEqual(placesOf('Tashkent City manzarasi, 2 xona', alignSpans('Tashkent City manzarasi, 2 xona', {}, { districts: index }).spans), []);
  assert.deepEqual(placesOf('Manzara mavzesi, 2 xona', alignSpans('Manzara mavzesi, 2 xona', {}, { districts: index }).spans), ['Manzara']);
});

test('district: the generic noun is in the span only when written in Cyrillic', () => {
  const ro = 'cartierul Mănăștur, vedere frumoasă';
  assert.deepEqual(placesOf(ro, alignSpans(ro, {}).spans), ['Mănăștur']);
  const ru = 'Шайхантохурский район, Ц-2';
  assert.deepEqual(placesOf(ru, alignSpans(ru, { district: 'Shaykhantahur' }).spans), ['Шайхантохурский район']);
  const zona = 'zona Edgar Quinet, etaj 1';
  assert.deepEqual(placesOf(zona, alignSpans(zona, {}).spans), [], '"zona X" is as often a street as a district');
});

test('district kinds: the noun next to a name, then the lexicon, then the column decide whether it is a district, a microdistrict or a locality', () => {
  const kinds = (t, row, context) => alignSpans(t, row, context).spans.filter((x) => DISTRICT_KINDS.includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(kinds('Квартира в Юнусабадском районе', { district: 'Yunusabad' }), ['DISTRICT:Юнусабадском районе']);
  assert.deepEqual(kinds('Сдаётся в мкр. Нурсат, 2 комнаты', {}), ['MICRODISTRICT:мкр. Нурсат']);
  assert.deepEqual(kinds('махалля Қорасарой, 3 хона', {}), ['MICRODISTRICT:махалля Қорасарой']);
  assert.deepEqual(kinds('Ташкент, на Глинке, 3 комнаты', { area: 'Glinka' }), ['LOCALITY:Глинке']);
  // the area column mixes kinds: the lexicon says which name is a microdistrict, and which is a district
  const typed = placeKinds([{ type: 'microdistrict', names: ['Glinka'] }, { type: 'district', names: ['Chilanzar', 'Чиланзар'] }]);
  assert.deepEqual(kinds('Ташкент, на Глинке', { area: 'Glinka' }, { placeKinds: typed }), ['MICRODISTRICT:Глинке']);
  assert.deepEqual(kinds('Ташкент, Чиланзар, 3 комнаты', { area: 'Chilanzar' }, { placeKinds: typed }), ['DISTRICT:Чиланзар']);
  // no place in the text: all three kinds are ignored together when a column stores one the text never writes
  assert.deepEqual(DISTRICT_KINDS.filter((k) => alignSpans('Квартира в центре', { district: 'Yunusabad' }).ignore.includes(k)), [...DISTRICT_KINDS]);
});

test('place kinds: a numbered quarter and a sentence-ending noun name nothing; "Оз Махал" is not a mahalla', () => {
  const kinds = (t) => alignSpans(t, {}).spans.filter((x) => DISTRICT_KINDS.includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(kinds('Чиланзар 22 квартал. Новая квартира никто не жил'), []);
  assert.deepEqual(kinds('ЖК Оз Махал, 3 комнаты'), []);
  assert.deepEqual(kinds('Яккасарайский район. Новая квартира'), ['DISTRICT:Яккасарайский район']);
  assert.deepEqual(kinds('Продам в мкр. Нурсат, 2 комнаты'), ['MICRODISTRICT:мкр. Нурсат']);
});

test('"Юнусабад-11" is a microdistrict; a city after "район" and advertising words are no district', () => {
  const index = districtIndex([...Array(300).fill('Yunusabad'), ...Array(300).fill('Kharkivskyi')], 300);
  const cities = citySkeletons([{ type: 'city', names: ['Odesa', 'Одесса', 'Almaty', 'Алматы'] }]);
  const places = (t, row = {}) => alignSpans(t, row, { districts: index, cities }).spans
    .filter((x) => DISTRICT_KINDS.includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(places('Продается в Юнусабад-11 квартал, 3 комнаты', { district: 'Yunusabad' }), ['MICRODISTRICT:Юнусабад-11', 'DISTRICT:Юнусабад']);
  assert.deepEqual(places('Сдам в районе Одессы, новый дом'), []);
  assert.deepEqual(places('Харківський район, р-н ВИГІДНО Доступна, Centrală'), ['DISTRICT:Харківський район'], 'a district named like a city adjective stays');
});

test('address: the type of the street may follow its name; another street written that way is neutral', () => {
  const t = 'Квартира на Адмиральском проспекте 5, рядом Люстдорфська дорога';
  const r = alignSpans(t, { street: 'Адмиральском' });
  assert.deepEqual(cut(t, r.spans, 'ADDRESS'), ['Адмиральском проспекте 5']);
  assert.deepEqual(cut(t, r.neutral, 'ADDRESS'), ['Люстдорфська дорога']);
});

test('nearby: general words are what is around, a name or a number makes a landmark', () => {
  const near = (t) => alignSpans(t, {}).spans.filter((x) => ['LANDMARK', 'NEARBY'].includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(near('Рядом школа №33, ТЦ Мега, магазины, рынки, детский сад'),
    ['LANDMARK:школа №33', 'LANDMARK:ТЦ Мега', 'NEARBY:магазины', 'NEARBY:рынки', 'NEARBY:детский сад']);
  assert.deepEqual(near('Инфраструктура: школа, садик, супермаркеты, парк'), ['NEARBY:школа', 'NEARBY:садик', 'NEARBY:супермаркеты', 'NEARBY:парк']);
  assert.deepEqual(near('Поблизости Дитячі садочки, школи, аптеки'), ['NEARBY:Дитячі садочки', 'NEARBY:школи', 'NEARBY:аптеки']);
});

test('microdistrict written with the number first; "без депозита" is a deposit statement', () => {
  const places = (t) => alignSpans(t, {}).spans.filter((x) => x.label === 'MICRODISTRICT').map((x) => t.slice(x.start, x.end));
  assert.deepEqual(places('Продам в 22 мкрда, 20-м микрорайоне, 2-мавзе'), ['22 мкрда', '20-м микрорайоне', '2-мавзе']);
});

test('rule refinements from hand review: districts, microdistricts and addresses', () => {
  const index = districtIndex([...Array(300).fill({ name: 'Sergeli', kind: 'DISTRICT' }), ...Array(300).fill({ name: 'Chilanzar', kind: 'DISTRICT' })], 300);
  const places = (t, row = {}) => alignSpans(t, row, { districts: index }).spans
    .filter((x) => DISTRICT_KINDS.includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(places('Спальный район, тихо. Престижний район з інфраструктурою'), [], 'advertising adjectives are not a name');
  assert.deepEqual(places('Київська область, Київ'), [], '"область" is a region');
  assert.deepEqual(places('Продаю 5 комнатную квартиру Сергели 5\nОтличная локация'), ['MICRODISTRICT:Сергели 5', 'DISTRICT:Сергели']);
  assert.deepEqual(places('Manzil: Chilanzar 22 kvartal\nMoljal: Uchtepa'), ['MICRODISTRICT:Chilanzar 22 kvartal', 'DISTRICT:Chilanzar']);
  assert.deepEqual(places('Квартира Сергели 5 комнат, этаж 3'), ['DISTRICT:Сергели'], 'a room count is not a microdistrict number');
  const stations = stationSkeletons(Array(10).fill('Peremoha'), 8);
  const t = 'Соборний р-н, Перемога-1. Квартира';
  assert.deepEqual(alignSpans(t, { metro: 'Peremoha' }, { stations }).spans.filter((x) => x.label === 'MICRODISTRICT').map((x) => t.slice(x.start, x.end)), ['Перемога-1']);
  assert.equal(alignSpans(t, { metro: 'Peremoha' }, { stations }).spans.some((x) => x.label === 'METRO'), false, 'the station is the number-less name only');
  const a = 'Продажа 1 ком. квартиры, пр. Героев Харькова (пр. Московский) 198/2';
  assert.deepEqual(cut(a, alignSpans(a, { street: 'Героев Харькова' }).spans, 'ADDRESS'), ['пр. Героев Харькова (пр. Московский) 198/2']);
});

test('nearby: introductions such as "ви знайдете" and a Ukrainian "інфраструктура" open a list too', () => {
  const near = (t) => alignSpans(t, {}).spans.filter((x) => x.label === 'NEARBY').map((x) => t.slice(x.start, x.end));
  assert.deepEqual(near('Поруч ви знайдете магазини, кафе, фітнес-клуб'), ['магазини', 'кафе', 'фітнес-клуб']);
  assert.deepEqual(near('Поруч вся інфраструктура: школа, ліцей, садочки'), ['школа', 'ліцей', 'садочки']);
});

test('facts read off the text: rooms, area, floor and number of floors, checked against the stored values', () => {
  const t = 'Сдаётся 3-комнатная квартира, 78 кв.м, 5/9 этаж, ул. Абая 5';
  const r = alignSpans(t, { rooms: 3, area_sqm: 78, floor: 5, total_floors: 9, address: 'ул. Абая 5', street: 'Абая' });
  assert.deepEqual(cut(t, r.spans, 'ROOMS'), ['3']);
  assert.deepEqual(cut(t, r.spans, 'AREA'), ['78 кв.м'], 'the number with its unit');
  assert.deepEqual(cut(t, r.spans, 'FLOOR'), ['5']);
  assert.deepEqual(cut(t, r.spans, 'FLOORS_TOTAL'), ['9']);
  const compact = '2/5/16 56м2 новостройка';
  const c = alignSpans(compact, { rooms: 2, area_sqm: 56, floor: 5, total_floors: 16 });
  assert.deepEqual(['ROOMS', 'FLOOR', 'FLOORS_TOTAL', 'AREA'].map((l) => cut(compact, c.spans, l)[0]), ['2', '5', '16', '56м2'], 'rooms/floor/floors in one token');
});

test('facts: in "total/living/kitchen" the first number is the area and the parts are neutral', () => {
  const t = 'Площадь квартиры 37/18/7 м2, 4/9 ет.';
  const r = alignSpans(t, { area_sqm: 37, floor: 4, total_floors: 9 });
  assert.deepEqual(cut(t, r.spans, 'AREA'), ['37', '18', '7']);
  assert.deepEqual(cut(t, alignSpans(t, { area_sqm: 62 }).spans, 'AREA'), ['37', '18', '7'], 'the stored value may be their sum');
  assert.deepEqual([cut(t, r.spans, 'FLOOR'), cut(t, r.spans, 'FLOORS_TOTAL')], [['4'], ['9']]);
  const two = 'Площадь 60 / 40 кв.м';
  assert.deepEqual(cut(two, alignSpans(two, { area_sqm: 60 }).spans, 'AREA'), ['60', '40']);
  const other = alignSpans(t, { area_sqm: 18 });
  assert.deepEqual(cut(t, other.spans, 'AREA'), [], 'a stored value that is only a part is not marked as the total');
});

test('commission: no realtor and "from the owner" state that there is no fee', () => {
  const cases = [
    ['Квартира без риелтора, центр', 'без риелтора'],
    ['Здаю від власника, без посередників.', ['від власника', 'без посередників']],
    ['Сдаётся от владельца', 'от владельца'],
    ['BezXazayka BezMakler 🔰', 'BezMakler'],
    ['Maklerlik hizmati yoʻq', 'Maklerlik hizmati yoʻq'],
    ['❌ Maklersiz', 'Maklersiz'],
    ['Apartament direct de la proprietar, fără agenție', ['direct de la proprietar', 'fără agenție']],
  ];
  for (const [text, want] of cases) {
    const got = cut(text, alignSpans(text, {}).spans, 'COMMISSION');
    assert.deepEqual(got.map((s) => s.toLowerCase()), [].concat(want).map((s) => s.toLowerCase()), text);
  }
  const plain = 'Квартира агентство риелторов не нужно звонить';
  assert.deepEqual(cut(plain, alignSpans(plain, {}).spans, 'COMMISSION'), []);
});

test('facts: in a "label - value" line the span is the value, not the label', () => {
  const t = '• Комнат - 2\n• Площадь - 60кв.м\n• Кол-во комнат: 3';
  assert.deepEqual(cut(t, alignSpans(t, { rooms: 2, area_sqm: 60 }).spans, 'ROOMS'), ['2']);
  assert.deepEqual(cut(t, alignSpans(t, { rooms: 3 }).spans, 'ROOMS'), ['3']);
});

test('facts: another area is neutral, a stored value the lexicon cannot read is unknown, nothing stored and nothing written is absent', () => {
  const t = 'Квартира 45 м², жилая 30 м², 2-комнатная';
  const r = alignSpans(t, { area_sqm: 45, rooms: 2 });
  assert.deepEqual(cut(t, r.spans, 'AREA'), ['45 м²', '30 м²']);
  assert.deepEqual(cut(t, r.neutral, 'AREA'), [], 'every area figure is marked, the living area included');
  assert.equal(r.ignore.includes('AREA'), false);
  const unread = alignSpans('Продам 3к', { rooms: 3 });
  assert.ok(unread.ignore.includes('ROOMS'), 'stored, but not in a form the lexicon reads: masked, not a negative');
  const clean = alignSpans('Просто текст без цифр', {});
  for (const label of ['ROOMS', 'AREA', 'FLOOR', 'FLOORS_TOTAL']) assert.equal(clean.ignore.includes(label), false, label);
  const unchecked = alignSpans('Сдаётся 3-комнатная', {});
  assert.deepEqual(cut('Сдаётся 3-комнатная', unchecked.spans, 'ROOMS'), ['3'], 'the span is the number alone; nothing stored, the text is enough');
  assert.equal(unchecked.ignore.includes('ROOMS'), false);
});

test('commission in a number, a percentage or months, and the months paid in advance', () => {
  const kinds = (t, row = {}) => alignSpans(t, row).spans.filter((x) => ['COMMISSION', 'PREPAYMENT', 'DEPOSIT'].includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(kinds('Комиссия 50% от месячной аренды'), ['COMMISSION:50%']);
  assert.deepEqual(kinds('Комиссия риелтора — 300$, залог 400$', { price: 500, currency: 'USD' }), ['DEPOSIT:400', 'COMMISSION:300']);
  assert.deepEqual(kinds('Комиссия агента 1 месяц'), ['COMMISSION:1 месяц']);
  assert.deepEqual(kinds('Без комиссии, от хозяина'), ['COMMISSION:Без комиссии', 'COMMISSION:от хозяина'], '"from the owner" is a no-fee statement too');
  assert.deepEqual(kinds('Комиссия не берётся'), ['COMMISSION:Комиссия не берётся']);
  assert.deepEqual(kinds('Оплата за 2 месяца вперёд'), ['PREPAYMENT:2 месяца']);
  assert.deepEqual(kinds('Предоплата за 3 месяца, залог 1 месяц'), ['DEPOSIT:1 месяц', 'PREPAYMENT:3 месяца']);
  assert.deepEqual(kinds('Месяц вперёд'), ['PREPAYMENT:Месяц']);
  assert.deepEqual(kinds('Залог 2 месяца'), ['DEPOSIT:2 месяца'], 'without "вперёд" a count of months after "залог" is the deposit');
  assert.deepEqual(kinds('Ремонт 2 месяца назад'), [], 'a duration with no cue is neither');
});

test('months: the closest cue decides; a word after them settles it; a masked phone is no amount', () => {
  const kinds = (t) => alignSpans(t, {}).spans.filter((x) => ['COMMISSION', 'PREPAYMENT', 'DEPOSIT'].includes(x.label)).map((x) => `${x.label}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(kinds('Avans o luna plus garantia o luna'), ['DEPOSIT:o luna', 'PREPAYMENT:o luna'], 'one month each, the first one in advance');
  assert.deepEqual(kinds('prima plata 1 luna avans+1 luna garantie'), ['DEPOSIT:1 luna', 'PREPAYMENT:1 luna']);
  assert.deepEqual(kinds('2 месяца залог'), ['DEPOSIT:2 месяца']);
  assert.deepEqual(kinds('Риелтор Написать автору +998 ** *** ****'), []);
  assert.deepEqual(kinds('Риелтору 50%'), ['COMMISSION:50%']);
});

test('facts: nothing stored: what the text says is marked, every area figure included', () => {
  const ro = 'Apartament 2 camere, 70 mp, etajul 5 din 8';
  const r = alignSpans(ro, {});
  assert.deepEqual([cut(ro, r.spans, 'ROOMS'), cut(ro, r.spans, 'AREA'), cut(ro, r.spans, 'FLOOR')], [['2'], ['70 mp'], ['5']]);
  assert.equal(r.ignore.includes('AREA'), false);
  const two = 'Suprafață 70 mp sau 84 mp';
  const t = alignSpans(two, {});
  assert.deepEqual(cut(two, t.spans, 'AREA'), ['70 mp', '84 mp']);
  assert.equal(t.ignore.includes('AREA'), false, 'every figure is marked');
  const part = 'Жилая 30 м², общая 45 м²';
  assert.deepEqual(cut(part, alignSpans(part, {}).spans, 'AREA'), ['30 м²', '45 м²'], 'the living area is an area figure too');
});

test('facts: slang room words are rooms; a euro flat has one room fewer than its name, and a studio has none', () => {
  const cases = [['Сдаю двушку в центре', 'двушку', { rooms: 2 }], ['Евродвушка 40 м2', 'Евродвушка', { rooms: 1 }], ['Евротрёшка у метро', 'Евротрёшка', { rooms: 2 }], ['Евродвушка 40 м2', 'Евродвушка', { rooms: 2 }]];
  for (const [text, word, row] of cases) assert.deepEqual(cut(text, alignSpans(text, row).spans, 'ROOMS'), [word], text + JSON.stringify(row));
  const studio = 'Студия 25 м2';
  assert.deepEqual(cut(studio, alignSpans(studio, {}).spans, 'ROOMS'), []);
});
