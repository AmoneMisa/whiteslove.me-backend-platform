// Place names the labelling rules take from @whiteslove/parsing-lexicon instead of keeping their own
// lists (AGENTS.md: aliases and vocabulary belong to the lexicon). The listing database stores one
// canonical Latin spelling per station or district; the lexicon also knows the spellings people write
// ("Дружба Народов", "Ойбек", "Максим Горький"), so names a row does not store are still recognised.
import * as lexicon from '@whiteslove/parsing-lexicon';

const DISTRICT_TYPES = new Set(['district', 'microdistrict', 'local_area', 'suburb', 'mahalla', 'informal_area', 'settlement']);

const strings = (value) => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [])
  .flat(Infinity)
  .filter((x) => typeof x === 'string' && x.trim());

/** Every lexicon entry that has aliases and a type, found by walking the exported dictionaries. */
export function lexiconEntries(source = lexicon) {
  const seen = new Set();
  const found = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 8) return;
    seen.add(node);
    const type = node.entityType || node.type;
    if (!Array.isArray(node) && node.aliases && typeof type === 'string') {
      found.push({ type, country: node.country, city: node.city, names: [node.canonical, ...strings(node.aliases)].filter((x) => typeof x === 'string' && x.trim()) });
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  };
  for (const value of Object.values(source)) if (value && typeof value === 'object') walk(value, 0);
  return found;
}

export function lexiconPlaceNames(source = lexicon) {
  const metro = new Set();
  const districts = new Set();
  for (const { type, names } of lexiconEntries(source)) {
    if (type === 'metro') names.forEach((n) => metro.add(n));
    else if (DISTRICT_TYPES.has(type)) names.forEach((n) => districts.add(n));
  }
  return { metro: [...metro], districts: [...districts], metroGroups: lexiconEntries(source).filter((e) => e.type === 'metro').map((e) => e.names) };
}
