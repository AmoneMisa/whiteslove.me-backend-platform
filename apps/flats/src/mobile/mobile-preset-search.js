// Turns a stored mobile preset's filter snapshot into the same query shape
// the web search routes use, so mobile and web share one filter parser.
import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {COUNTRY_CODES} from '../geo/countries.js';
import {parseListingFilters} from '../routes/listing-routes.js';

function snapshotQuery(snapshot) {
  const query = {};
  for (const [key, value] of Object.entries(snapshot || {})) {
    if (value == null || value === '') continue;
    if (key === 'countries' || key === 'amenities' || key === 'sort') continue;
    if (key === 'sources' || key === 'customSources') {
      query[key] = Array.isArray(value) ? value.join(',') : String(value);
      continue;
    }
    query[key] = typeof value === 'boolean' ? (value ? 'true' : '') : value;
  }
  for (const amenity of Array.isArray(snapshot?.amenities) ? snapshot.amenities : []) {
    const key = String(amenity || '').trim();
    if (key) query[key] = 'true';
  }
  query.sort = 'newest';
  query.limit = '60';
  query.offset = '0';
  return query;
}

export function mobilePresetSearch(snapshot) {
  const requestedCountries = Array.isArray(snapshot?.countries)
    ? snapshot.countries
    : String(snapshot?.countries || '').split(',');
  const countries = [...new Set(requestedCountries
    .map((value) => String(value).trim().toUpperCase())
    .filter((value) => COUNTRY_CODES.includes(value)))];
  const codes = countries.length ? countries : COUNTRY_CODES;
  const filters = parseListingFilters(snapshotQuery(snapshot));
  if (filters.city) {
    const country = codes.length === 1 ? codes[0] : undefined;
    filters.city = canonicalCity(filters.city, country) || filters.city;
  }
  return {filters, countries: codes};
}
