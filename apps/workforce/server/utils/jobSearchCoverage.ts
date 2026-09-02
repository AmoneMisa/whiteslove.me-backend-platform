import { UZ_CITY_CATALOG, KZ_CITY_CATALOG } from '@whiteslove/parsing-lexicon/central-asia'
import { CITIES_BY_COUNTRY } from '@whiteslove/parsing-lexicon/geography'

export type SearchPlace = {
  country: 'UZ' | 'KZ' | 'UA' | 'RO'
  location: string
  label: string
  city?: string
  region?: string
}

export const UKRAINE_OBLASTS: SearchPlace[] = [
  ['Vinnytsia Oblast', 'Вінницька область'],
  ['Volyn Oblast', 'Волинська область'],
  ['Dnipropetrovsk Oblast', 'Дніпропетровська область'],
  ['Donetsk Oblast', 'Донецька область'],
  ['Zhytomyr Oblast', 'Житомирська область'],
  ['Zakarpattia Oblast', 'Закарпатська область'],
  ['Zaporizhzhia Oblast', 'Запорізька область'],
  ['Ivano-Frankivsk Oblast', 'Івано-Франківська область'],
  ['Kyiv Oblast', 'Київська область'],
  ['Kirovohrad Oblast', 'Кіровоградська область'],
  ['Luhansk Oblast', 'Луганська область'],
  ['Lviv Oblast', 'Львівська область'],
  ['Mykolaiv Oblast', 'Миколаївська область'],
  ['Odesa Oblast', 'Одеська область'],
  ['Poltava Oblast', 'Полтавська область'],
  ['Rivne Oblast', 'Рівненська область'],
  ['Sumy Oblast', 'Сумська область'],
  ['Ternopil Oblast', 'Тернопільська область'],
  ['Kharkiv Oblast', 'Харківська область'],
  ['Kherson Oblast', 'Херсонська область'],
  ['Khmelnytskyi Oblast', 'Хмельницька область'],
  ['Cherkasy Oblast', 'Черкаська область'],
  ['Chernivtsi Oblast', 'Чернівецька область'],
  ['Chernihiv Oblast', 'Чернігівська область'],
].map(([location, label]) => ({ country: 'UA' as const, location, label, region: label }))

// Canonical names + local-language labels come from parsing-lexicon's city
// catalog so this list can't drift from the shared geography data.
function majorCitiesFor(country: 'UZ' | 'KZ' | 'RO', catalog: readonly { canonical: string; aliases: Record<string, readonly string[]> }[], names: readonly string[], labelLang: string): SearchPlace[] {
  return names.map((location) => {
    const entry = catalog.find((city) => city.canonical === location)
    const label = entry?.aliases[labelLang]?.[0] ?? location
    return { country, location, label, city: location }
  })
}

const MAJOR_CITIES: SearchPlace[] = [
  ...majorCitiesFor('UZ', UZ_CITY_CATALOG, [
    'Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Andijan', 'Fergana',
    'Qarshi', 'Nukus', 'Jizzakh', 'Urgench',
  ], 'ru'),
  ...majorCitiesFor('KZ', KZ_CITY_CATALOG, [
    'Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Aktobe', 'Atyrau',
    'Pavlodar', 'Kostanay', 'Aktau', 'Oskemen',
  ], 'ru'),
  ...majorCitiesFor('RO', CITIES_BY_COUNTRY.RO, [
    'Bucharest', 'Cluj-Napoca', 'Timisoara', 'Iasi', 'Brasov', 'Constanta',
    'Craiova', 'Sibiu', 'Oradea', 'Ploiesti',
  ], 'ro'),
]

export const COUNTRY_LOCATIONS: SearchPlace[] = [
  { country: 'UZ', location: 'Uzbekistan', label: 'Узбекистан' },
  { country: 'KZ', location: 'Kazakhstan', label: 'Казахстан' },
  { country: 'UA', location: 'Ukraine', label: 'Україна' },
  { country: 'RO', location: 'Romania', label: 'România' },
]

export function linkedinLocationCoverage(): SearchPlace[] {
  return [...COUNTRY_LOCATIONS, ...MAJOR_CITIES, ...UKRAINE_OBLASTS]
}

export type ThreadsJobTarget = SearchPlace & {
  key: string
  query: string
}

function slug(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
}

export function threadsJobCoverage(): ThreadsJobTarget[] {
  const result: ThreadsJobTarget[] = [
    { country: 'UZ', location: 'Uzbekistan', label: 'Узбекистан', query: 'Работа Узбекистан', key: 'threads-uz-country-work' },
    { country: 'UZ', location: 'Uzbekistan', label: 'Узбекистан', query: 'Вакансии Узбекистан', key: 'threads-uz-country-vacancies' },
    { country: 'KZ', location: 'Kazakhstan', label: 'Казахстан', query: 'Работа Казахстан', key: 'threads-kz-country-work' },
    { country: 'KZ', location: 'Kazakhstan', label: 'Казахстан', query: 'Вакансии Казахстан', key: 'threads-kz-country-vacancies' },
    { country: 'UA', location: 'Ukraine', label: 'Україна', query: 'Робота Україна', key: 'threads-ua-country-work' },
    { country: 'UA', location: 'Ukraine', label: 'Україна', query: 'Вакансії Україна', key: 'threads-ua-country-vacancies' },
    { country: 'RO', location: 'Romania', label: 'România', query: 'Locuri de muncă România', key: 'threads-ro-country-work' },
    { country: 'RO', location: 'Romania', label: 'România', query: 'Angajări România', key: 'threads-ro-country-hiring' },
  ]

  for (const place of MAJOR_CITIES) {
    const queries = place.country === 'RO'
      ? [`Job ${place.label}`, `Angajări ${place.label}`, `Locuri de muncă ${place.label}`]
      : place.country === 'UZ'
        ? [`Работа ${place.label}`, `Вакансии ${place.label}`, `Ish ${place.location}`, `Vakansiya ${place.location}`]
        : [`Работа ${place.label}`, `Вакансии ${place.label}`, `Жұмыс ${place.label}`]
    for (const query of queries) result.push({ ...place, query, key: `threads-${place.country.toLowerCase()}-${slug(query)}` })
  }

  for (const place of UKRAINE_OBLASTS) {
    for (const query of [`Робота ${place.label}`, `Вакансії ${place.label}`]) {
      result.push({ ...place, query, key: `threads-ua-${slug(place.location)}-${slug(query)}` })
    }
  }

  return result
}

export const REMOTE_JOB_QUERIES = [
  'remote worldwide',
  'global remote jobs',
  'work from anywhere',
  'remote Europe',
  'remote EMEA',
  'удаленная работа',
  'віддалена робота',
  'masofaviy ish',
  'қашықтан жұмыс',
]

export const USA_RELOCATION_QUERIES = [
  'relocation to USA',
  'USA relocation provided',
  'US visa sponsorship',
  'H1B sponsorship',
  'H-1B sponsorship',
  'visa sponsorship software engineer USA',
  'frontend relocation USA',
  'developer relocation USA',
]

export function rotatingSlice<T>(items: T[], maxPerCycle: number, slotMinutes = 30): T[] {
  if (items.length <= maxPerCycle) return items
  const size = Math.max(1, maxPerCycle)
  const slot = Math.floor(Date.now() / (Math.max(1, slotMinutes) * 60_000))
  const offset = (slot * size) % items.length
  return Array.from({ length: size }, (_, index) => items[(offset + index) % items.length]!)
}
