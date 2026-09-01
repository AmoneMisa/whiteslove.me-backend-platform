import {
  TASHKENT_METRO,
  canonicalTashkentMetro,
  tashkentMetroLabels,
} from '@whiteslove/parsing-lexicon/geo';

// parsing-lexicon intentionally exposes the canonical station catalog, but its
// internal name lookup Map is not part of the public package surface. Keep this
// compatibility index derived from the shared catalog instead of duplicating
// any metro data locally.
export const TASHKENT_METRO_BY_NAME = new Map(
  TASHKENT_METRO.map((station) => [station.name, station]),
);

export {
  TASHKENT_METRO,
  canonicalTashkentMetro,
  tashkentMetroLabels,
};
