import { FULL_TASHKENT_AREAS, normalizeForMatch } from '@whiteslove/parsing-lexicon';
import {
  hasExplicitTashkentDistrict,
  hasTashkentAreaAlias,
  matchTashkentHousingLandmarks,
  matchTashkentNumberedArea,
} from '@whiteslove/parsing-lexicon/tashkent-housing-geography';

export const TASHKENT_AREAS = FULL_TASHKENT_AREAS;

const normalize = (value) => normalizeForMatch(value);
const phraseIn = (normalizedText, alias) => ` ${normalizedText} `.includes(` ${normalize(alias)} `);

const STATIC_MATCHERS = Object.entries(TASHKENT_AREAS)
  .flatMap(([district, entries]) => entries.flatMap((entry) =>
    entry.aliases.map((alias) => ({ district, area: entry.name, alias }))))
  .sort((a, b) => normalize(b.alias).length - normalize(a.alias).length);

const result = (areaName, district, confidence = 1, ambiguous = false) => ({
  area: areaName,
  district,
  confidence,
  ambiguous,
  requireExactAddress: ambiguous,
});

const latinSuffix = (value) => ({ А: 'A', Д: 'D' }[String(value || '').toUpperCase()] || String(value || '').toUpperCase());

// Housing landmarks parsing-lexicon deliberately keeps out of TASHKENT_AREAS
// (they're POIs, not residential areas) but each sits in exactly one district.
const LANDMARK_DISTRICTS = Object.freeze({
  'Sergeli Car Bazaar': 'Sergeli',
  Glinka: 'Yakkasaray',
});

export function resolveTashkentArea(value) {
  const text = normalize(value);
  if (!text) return null;

  let match = matchTashkentNumberedArea(value, 'Chilanzar');
  if (match) {
    const number = match.number;
    const suffix = latinSuffix(match.suffix);
    const district = ((number >= 11 && number <= 15) || (number >= 21 && number <= 25))
      ? 'Uchtepa'
      : ((number >= 1 && number <= 10) || (number >= 16 && number <= 20))
        ? 'Chilanzar'
        : null;
    return result(`Chilanzar-${number}${suffix}`, district, district ? 1 : 0.5, !district);
  }

  match = matchTashkentNumberedArea(value, 'Kuylyuk');
  if (match) {
    const number = match.number;
    const district = number >= 1 && number <= 4 ? 'Mirobod' : number >= 5 && number <= 7 ? 'Sergeli' : null;
    return result(`Kuylyuk-${number}`, district, district ? 1 : 0.5, !district);
  }

  match = matchTashkentNumberedArea(value, 'Sergeli');
  if (match) {
    const number = match.number;
    const suffix = latinSuffix(match.suffix);
    const legacyYangihayot = number === 1 || (suffix === 'A' && [3, 5, 7].includes(number));
    const knownSergeli = [2, 4, 5, 6, 7, 8].includes(number);
    const district = legacyYangihayot ? 'Yangihayot' : 'Sergeli';
    return result(`Sergeli-${number}${suffix}`, district, legacyYangihayot || knownSergeli ? 1 : 0.75, !(legacyYangihayot || knownSergeli));
  }

  for (const [canonical, max, district] of [
    ['Yunusabad', 22, 'Yunusabad'],
    ['Yangihayot', 6, 'Yangihayot'],
  ]) {
    match = matchTashkentNumberedArea(value, canonical);
    if (match) {
      const number = match.number;
      if (number >= 1 && number <= max) return result(`${canonical}-${number}`, district);
    }
  }

  for (const candidate of STATIC_MATCHERS) {
    if (phraseIn(text, candidate.alias)) return result(candidate.area, candidate.district);
  }

  // These street-scale housing landmarks each sit unambiguously in one
  // district, so their presence resolves the district the way an explicit
  // district suffix would, even though they aren't areas themselves.
  const landmarkMatch = matchTashkentHousingLandmarks(value)
    .find((entry) => LANDMARK_DISTRICTS[entry.name]);
  if (landmarkMatch) return result(landmarkMatch.name, LANDMARK_DISTRICTS[landmarkMatch.name]);

  if (hasExplicitTashkentDistrict(value, 'Sergeli')) return result('Sergeli', 'Sergeli');
  if (hasTashkentAreaAlias(value, 'Sergeli')) return result('Sergeli', null, 0.35, true);
  if (hasTashkentAreaAlias(value, 'Kuylyuk')) return result('Kuylyuk', null, 0.25, true);
  if (hasExplicitTashkentDistrict(value, 'Chilanzar')) return result('Chilanzar', 'Chilanzar');
  if (hasTashkentAreaAlias(value, 'Chilanzar')) return result('Chilanzar', null, 0.35, true);

  return null;
}
