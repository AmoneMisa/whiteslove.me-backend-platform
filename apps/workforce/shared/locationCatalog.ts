import {
  CITIES,
  KZ_CITY_CATALOG,
  UA_CITY_CATALOG,
  UZ_CITY_CATALOG,
  aliasesOf,
  canonicalCentralAsiaCity,
  canonicalCity,
  canonicalUkraineCity,
} from '@whiteslove/parsing-lexicon'
import { geographyDisplayName } from '@whiteslove/parsing-lexicon/geography-display'
import { HIRING_COUNTRIES } from './hiring/hiringMarkets'

export function normalizeCityValue(value: string): string {
  return value.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е')
}

// Extended market catalogs remain useful for aliases not present in the base city catalog.
// Canonical cross-country ownership itself belongs to parsing-lexicon CITIES/canonicalCity.
const PARSING_CITIES = [
  ...CITIES.filter((city) => !['UA', 'KZ', 'UZ'].includes(city.country || '')),
  ...KZ_CITY_CATALOG,
  ...UZ_CITY_CATALOG,
  ...UA_CITY_CATALOG,
]
const PARSING_CITY_BY_KEY = new Map(
  PARSING_CITIES.map((city) => [normalizeCityValue(city.canonical), city] as const),
)
const CITY_CANONICAL_BY_KEY = new Map(
  [
    ...HIRING_COUNTRIES.flatMap((country) => country.cities || []),
    ...PARSING_CITIES.map((city) => city.canonical),
  ].map((city) => [normalizeCityValue(city), city] as const),
)

function sharedCanonicalCity(value: string): string | null {
  return canonicalUkraineCity(value) || canonicalCentralAsiaCity(value) || canonicalCity(value)
}

export function canonicalCityKey(value: string): string {
  const shared = sharedCanonicalCity(value)
  return normalizeCityValue(shared || value)
}

export function cityAliases(value: string): string[] {
  const key = canonicalCityKey(value)
  const entity = PARSING_CITY_BY_KEY.get(key)
  return entity ? [...new Set([entity.canonical, ...aliasesOf(entity)])] : [value]
}

export function canonicalCityValue(value: string): string {
  const shared = sharedCanonicalCity(value)
  if (shared) return shared
  return CITY_CANONICAL_BY_KEY.get(normalizeCityValue(value)) || value.trim()
}

export function cityDisplayLabel(value: string, locale: string): string {
  return geographyDisplayName(canonicalCityValue(value), locale, 'city')
}
