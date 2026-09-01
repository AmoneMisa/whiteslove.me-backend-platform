import {
  TASHKENT_METRO,
  canonicalTashkentMetro,
} from '@whiteslove/parsing-lexicon'

// Keep the package's public metro catalog immutable. This index is private to
// the presentation adapter and cannot mutate canonicalization for the process.
const TASHKENT_METRO_LABELS = new Map(
  TASHKENT_METRO.map((station) => [station.name, station.labels]),
)

export function metroLabel(value: string, locale = 'en'): string {
  const canonical = canonicalTashkentMetro(value) || value
  if (!locale.toLowerCase().startsWith('ru')) return canonical
  return TASHKENT_METRO_LABELS.get(canonical)?.ru || value
}

export function canonicalMetroValue(value: string): string {
  return canonicalTashkentMetro(value) || value
}
