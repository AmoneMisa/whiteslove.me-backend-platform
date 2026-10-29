// Whether a listing's text actually says a feature is absent.
//
// Stored `false` flags are not trustworthy as "the text says no": for amenity
// fields the share of `false` rows whose text even mentions the feature equals
// the share among rows with no value at all (bidet 0%, microwave 1%, euroLayout
// 14% vs 14%). Those falses are a model or parser default, not a statement.
// Training the encoder on them would teach "silence means no", the opposite of
// the rule in the apartment prompt, so a `no` label is kept only with evidence.

// JS `\b` only knows ASCII word characters, so /без\b/ never matches Cyrillic.
// Every `\b` below is swapped for a Unicode-aware word boundary.
const WORD_BOUNDARY = String.raw`(?:(?<![\p{L}\p{N}])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?![\p{L}\p{N}]))`;
export const unicode = (re) => new RegExp(re.source.replaceAll(String.raw`\b`, WORD_BOUNDARY), [...new Set(`${re.flags.replace('g', '')}u`)].join(''));

/** Multilingual (ru/uk/ro/uz/en) stems that name each field's feature. */
const KEYWORD_SOURCES = {
  newBuilding: /новострой|новобуд|new\s*build|bloc nou|yangi\s*qurilish/i,
  balcony: /балкон|лоджи|balcon|balkon|loggia/i,
  airConditioner: /кондиц|кондер|сплит|aer condi|konditsioner|air.?cond/i,
  gas: /газ|gaz\b|\bgas\b/i,
  dishwasher: /посудом|ПММ|dishwasher|spalat vase|idish/i,
  terrace: /террас|терас|terasa|teras/i,
  privateYard: /двор|дворик|подвір|\byard|hovli|curte/i,
  tv: /телевиз|телевіз|\bТВ\b|\btv\b|televizor/i,
  microwave: /микроволн|мікрохвил|СВЧ|microunde|mikroto|microwave/i,
  oven: /духов|cuptor|\boven\b|dukhovk/i,
  bidet: /биде|bidet/i,
  walkInCloset: /гардероб|garderob|dressing|wardrobe|walk.?in/i,
  bathtub: /ванн|\bbath|\bcada\b/i,
  shower: /душ|\bdus\b|duș|shower/i,
  euroLayout: /евро|euro(?!\s*\/|\s*\d)|єв/i,
  furnished: /мебл|меблі|mobilat|mebel|furnish/i,
  petsAllowed: /животн|тварин|питом|собак|кошк|\bкот\b|кішк|animale|\bpets?\b|hayvon/i,
  childrenAllowed: /дет(ьми|и)\b|діт|copii|children|kids|bolalar/i,
  communalSeparated: /коммунал|комунал|utilit|intretinere|kommunal|счетчик|лічильник/i,
  parking: /парк|стоянк|гараж|parcare|garaj|паркінг/i,
  elevator: /лифт|ліфт|\blift\b|elevator/i,
  heating: /отоплен|опален|тёплый пол|теплий пол|incalzire|centrala|heating|автономн|котел|котёл/i,
  hotWater: /горяч|гаряч|apa calda|hot water|boiler|бойлер/i,
  internet: /интернет|інтернет|wi-?fi|вай-?фай|internet/i,
  smokingAllowed: /курить|курен|палить|куріння|\bfum|smok/i,
  condition: /ремонт|renov|reparati|состоян|стан\b/i,
};

export const FIELD_KEYWORDS = Object.freeze(
  Object.fromEntries(Object.entries(KEYWORD_SOURCES).map(([field, re]) => [field, unicode(re)])),
);

const NEGATION = unicode(
  /\bне\b|нет\b|нету|без\b|нельзя|запрещ|заборон|не\s*допуск|fără|fara\b|\bno\b|\bnot\b|without|yo['’`]?q|mumkin emas/i,
);
const WINDOW = 40;

/** True when a negation word sits within a short window of the field's keyword. */
export function hasNegatedMention(text, field) {
  const keyword = FIELD_KEYWORDS[field];
  if (!keyword || !text) return false;
  const re = new RegExp(keyword.source, `${keyword.flags}g`);
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const around = text.slice(Math.max(0, match.index - WINDOW), match.index + match[0].length + WINDOW);
    if (NEGATION.test(around)) return true;
  }
  return false;
}
