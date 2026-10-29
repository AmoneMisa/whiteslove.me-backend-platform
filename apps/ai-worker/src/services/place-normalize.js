// Names and currencies the way the lexicon spells them, so the encoder's raw text can be compared with another source
// and shown in a stable form: "Юнусабадский район" and "Yunusobod tumani" are the district Yunusabad, "грн." is UAH.
// The vocabulary stays in @whiteslove/parsing-lexicon (AGENTS.md); this module only looks names up in it.
//
// The lexicon is loaded once when this module is imported (about a second and a few hundred MB). If it cannot be
// loaded, every function answers "unknown" and callers fall back to the text as written.
let locations = null;
let currency = null;
try {
  [locations, currency] = await Promise.all([
    import('@whiteslove/parsing-lexicon/locations'),
    import('@whiteslove/parsing-lexicon/currency'),
  ]);
} catch {
  locations = null;
  currency = null;
}

const PLACE_COLLECTIONS = ['districts', 'microdistricts', 'mahallas', 'localAreas'];
// The generic noun that follows or precedes a district name: not part of the name.
const NOUN = /(?:^|\s)(?:район\p{L}*|р-н|р-он|tumani|tuman|туман\p{L}*|district|raion|rayon|округ\p{L}*|mahalla\p{L}*|махалл\p{L}*)(?=\s|$)/giu;

const fold = (value) => String(value).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const bare = (value) => fold(String(value).replace(NOUN, ' '));
const isCyrillic = (value) => /\p{Script=Cyrillic}/u.test(value);

let index = null;
function placeIndex() {
  if (index) return index;
  index = new Map(); // folded name -> entries
  if (!locations?.LOCATION_DICTIONARIES) return index;
  for (const cities of Object.values(locations.LOCATION_DICTIONARIES)) {
    for (const city of Object.values(cities)) {
      for (const collection of PLACE_COLLECTIONS) {
        for (const entry of city[collection] ?? []) {
          const names = [entry.canonical, entry.name, ...(entry.aliases ?? [])].filter((n) => typeof n === 'string' && n.trim());
          for (const name of new Set(names.flatMap((n) => [fold(n), bare(n)]))) {
            if (!name) continue;
            if (!index.has(name)) index.set(name, new Set());
            index.get(name).add(entry);
          }
        }
      }
    }
  }
  return index;
}

/** Lexicon entries named by `text` ("Юнусабадский район", "Yunusobod tumani"), possibly several for a shared name. */
export function placeEntries(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const known = placeIndex();
  return [...(known.get(fold(text)) ?? known.get(bare(text)) ?? [])];
}

/** The place's name in the nominative, in the script the text was written in: "Юнусабадский район" -> "Юнусабад". */
export function placeNominative(text) {
  const [entry] = placeEntries(text);
  if (!entry) return null;
  const names = [entry.canonical, ...(entry.aliases ?? [])].filter((n) => typeof n === 'string' && n.trim());
  const wanted = isCyrillic(text);
  const plain = (n) => isCyrillic(n) === wanted && bare(n) === fold(n);
  // The aliases list the spellings of one language next to each other: the plain name closest to the written one
  // (before it first: "Алмазар" precedes "Алмазарский район") is the same language's nominative.
  const at = names.findIndex((n) => fold(n) === fold(text) || bare(n) === bare(text));
  if (at >= 0) {
    let before = at;
    while (before >= 0 && !plain(names[before])) before -= 1;
    let after = at + 1;
    while (after < names.length && !plain(names[after])) after += 1;
    const nearBefore = before >= 0 ? at - before : Infinity;
    const nearAfter = after < names.length ? after - at : Infinity;
    if (nearBefore !== Infinity || nearAfter !== Infinity) return names[nearBefore <= nearAfter ? before : after];
  }
  return names.find(plain) ?? entry.canonical;
}

/** Whether two spellings name the same place; null when the lexicon knows neither. */
export function samePlace(a, b) {
  const x = placeEntries(a);
  const y = placeEntries(b);
  if (!x.length || !y.length) return null;
  return x.some((entry) => y.includes(entry));
}

/** ISO code of a currency written as a symbol, a word or a code ("грн.", "$", "у.е." -> UAH, USD, USD); null if unknown. */
export function currencyCode(text) {
  if (typeof text !== 'string' || !text.trim() || !currency?.moneyCurrencyFromText) return null;
  return currency.moneyCurrencyFromText(text.trim()) ?? null;
}

/** The text without the generic noun ("район Жилой" -> "Жилой"); for a name the lexicon does not know. */
export function withoutNoun(text) {
  const cut = String(text ?? '').replace(NOUN, ' ').replace(/\s{2,}/g, ' ').trim();
  return cut || null;
}
