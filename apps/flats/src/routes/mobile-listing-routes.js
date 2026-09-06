import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';

import {COUNTRY_CODES} from '../geo/countries.js';
import {attachResolvedSearchGeometry} from '../geo/search-filter-geometry.js';
import {applyPostgresGeoGate, withoutLegacyGeoFilters} from '../infrastructure/search/postgres-geo-gate.js';
import {getRates} from '../support/fx.js';
import {parseListingFilters} from './listing-routes.js';
import {attachMarketComparisons} from '../geo/market-comparison.js';
import {searchPostgresListings} from '../support/postgres-search-fast.js';

function resolveCountries(query) {
  const requested = String(query.countries || COUNTRY_CODES.join(','))
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((country) => COUNTRY_CODES.includes(country));
  return requested.length ? requested : COUNTRY_CODES;
}

function canonicalizeCityFilter(filters, codes) {
  if (!filters.city) return;
  const country = codes.length === 1 ? codes[0] : undefined;
  filters.city = canonicalCity(filters.city, country) || filters.city;
}

function comparisonInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = String(raw.source || '').trim().toLowerCase();
  const country = String(raw.country || '').trim().toUpperCase();
  const id = String(raw.id || '').trim();
  if (!source || !country || !id) return null;
  return {
    id,
    source,
    country,
    price: raw.price == null ? null : Number(raw.price),
    currency: raw.currency == null ? null : String(raw.currency),
    rooms: raw.rooms == null ? null : Number(raw.rooms),
    areaSqm: raw.areaSqm == null ? null : Number(raw.areaSqm),
    city: raw.city == null ? '' : String(raw.city),
    district: raw.district == null ? null : String(raw.district),
    propertyType: raw.propertyType == null ? '' : String(raw.propertyType),
    dealType: raw.dealType == null ? null : String(raw.dealType),
    roomOnly: raw.roomOnly === true,
  };
}

export function installMobileListingRoutes(app) {
  // Structured Flutter searches use this endpoint so the first card paint is
  // never blocked by market-median enrichment. Free-text/custom/forced refresh
  // requests stay on the full compatibility route in listing-routes.js.
  app.get('/api/mobile/listings', async (req, res) => {
    const filters = parseListingFilters(req.query);
    const codes = resolveCountries(req.query);
    canonicalizeCityFilter(filters, codes);
    attachResolvedSearchGeometry(filters, codes);

    if (filters.query || filters.customSources.length || filters.includeStats || filters.statsOnly || filters.mapOnly) {
      return res.status(400).json({error: 'mobile structured feed only'});
    }

    let fxRates = null;
    try {
      fxRates = (await getRates()).rates;
    } catch {}

    try {
      const searchMatches = await applyPostgresGeoGate({
        filters,
        countries: codes,
        searchMatches: null,
      });
      const databaseFilters = withoutLegacyGeoFilters(filters);
      const result = await searchPostgresListings({
        filters: databaseFilters,
        countries: codes,
        rates: fxRates,
        searchMatches,
      });
      return res.json({
        count: result.count,
        degradedCountries: [],
        sourceCounts: {},
        sourceErrors: [],
        warming: false,
        filters,
        searchEngine: 'postgres',
        queryMs: result.queryMs,
        countMs: result.countMs ?? null,
        pageMs: result.pageMs ?? null,
        marketComparisonMs: 0,
        searchPath: result.searchPath ?? null,
        nextCursor: result.nextCursor,
        listings: result.listings,
      });
    } catch (err) {
      const error = err?.message ?? String(err);
      console.error('[mobile-search] structured search unavailable:', error);
      return res.status(503).json({
        error: 'Listing search temporarily unavailable',
        degraded: true,
        sourceErrors: [{source: 'postgres', error}],
        searchEngine: 'postgres',
        filters,
        count: 0,
        listings: [],
      });
    }
  });

  // Market comparisons are deliberately a second, best-effort batch. The app
  // renders the page immediately, then merges these values into already-visible
  // cards without making filter interaction wait for percentile aggregation.
  app.post('/api/mobile/market-comparisons', async (req, res) => {
    const requested = Array.isArray(req.body?.listings)
      ? req.body.listings.slice(0, 60).map(comparisonInput).filter(Boolean)
      : [];
    if (!requested.length) return res.json({comparisons: []});

    let rates = null;
    try {
      rates = (await getRates()).rates;
    } catch {
      return res.json({comparisons: []});
    }

    try {
      const enriched = await attachMarketComparisons(requested, rates);
      return res.json({
        comparisons: enriched.map((listing) => ({
          key: `${String(listing.source || '').toLowerCase()}:${String(listing.country || '').toUpperCase()}:${String(listing.id || '')}`,
          marketComparison: listing.marketComparison ?? null,
        })),
      });
    } catch (err) {
      console.warn('[mobile-search] market comparison batch failed:', err?.message ?? err);
      return res.json({comparisons: []});
    }
  });
}
