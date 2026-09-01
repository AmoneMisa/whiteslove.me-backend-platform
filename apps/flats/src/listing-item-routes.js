import {COUNTRIES, COUNTRY_CODES} from './countries.js';
import {
  readFreshActiveListing,
  recordListingAvailability,
} from './availability.js';
import {fetchOlxOffer} from './scrapers/olx.js';
import {validateCustomSource} from './custom-source-queue.js';
import {checkRate} from './request-rate-limit.js';
import {pool} from './db.js';
import {
  mergeStoredFreshListing,
  preparePublicListing,
} from './listing-public.js';

async function readStoredListing({source, country, id}) {
  const result = await pool.query(`
    SELECT id, source, country, source_id, data
    FROM listings
    WHERE source = $1 AND country = $2 AND source_id = $3
    LIMIT 1
  `, [source, country, id]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...(row.data || {}),
    id: String(row.source_id || row.data?.id || id),
    source: row.source,
    country: row.country,
    publicId: Number(row.id),
  };
}

export function installListingItemRoutes(app) {
  // The listings.id BIGSERIAL is stamped onto every row's data->>'publicId' by
  // the listings_sync_public_id trigger (migration 018), so it is a stable,
  // source-independent way to look an advert back up from a short shared link
  // without needing its source/country/source_id triple.
  app.get('/api/listing/by-public-id/:publicId', async (req, res) => {
    const publicId = Number(req.params.publicId);
    if (!Number.isInteger(publicId) || publicId <= 0) {
      return res.status(400).json({error: 'Invalid public id'});
    }

    try {
      const result = await pool.query(`
        SELECT id, source, country, source_id, data
        FROM listings
        WHERE id = $1 AND active = TRUE
        LIMIT 1
      `, [publicId]);

      const row = result.rows[0];
      if (!row) return res.status(404).json({error: 'Listing not found'});

      let listing = {
        ...(row.data || {}),
        id: String(row.source_id || row.data?.id || ''),
        source: row.source,
        country: row.country,
        publicId: Number(row.id),
      };
      listing = await preparePublicListing(listing, COUNTRIES[row.country]);

      return res.json({
        listing,
        source: row.source,
        country: row.country,
        sourceId: row.source_id,
      });
    } catch (err) {
      return res.status(502).json({error: err.message});
    }
  });

  app.get('/api/listing/:source/:id', async (req, res) => {
    if (!checkRate(req, res, 'reloadOne', 1500)) return;

    const source = String(req.params.source).toLowerCase();
    const id = String(req.params.id);
    const code = String(req.query.country || '').toUpperCase();
    const country = COUNTRIES[code];

    if (!country) return res.status(400).json({error: 'Unknown country'});
    if (source !== 'olx') {
      return res.status(400).json({
        error: 'Reload not supported for this source',
      });
    }

    try {
      // A successful source check suppresses every further source request for
      // one hour. Inactive adverts never reach this branch again through the
      // feed: they are persisted inactive and removed from search results.
      const cached = await readFreshActiveListing({source, country: code, id});
      if (cached) {
        const listing = await preparePublicListing(cached.listing, country);
        return res.json({
          listing,
          availability: {status: 'active', checkedAt: cached.checkedAt, cached: true},
        });
      }

      // fetchOlxOffer is already a live source request. The previous path first
      // called /olx/check and then fetched the offer again, doubling latency and
      // WAF exposure for every click. One source fetch now serves as both the
      // availability check and the fresh listing reload.
      const fresh = await fetchOlxOffer(country, id);
      if (!fresh) {
        await recordListingAvailability({
          source,
          country: code,
          id,
          status: 'inactive',
          reason: 'offer_not_found',
        });
        return res.status(404).json({error: 'Listing no longer available'});
      }

      // A live OLX response is intentionally source-focused. Merge it over the
      // normalized DB snapshot so package-derived/vision/provenance fields do
      // not disappear, then rerun geo enrichment before transport. In
      // particular, geocodeListings stamps valid source coordinates with
      // locationAccuracyM, which makes geo-catalog bus/tram lookup eligible.
      const stored = await readStoredListing({source, country: code, id});
      let listing = mergeStoredFreshListing(stored, fresh);
      listing = await preparePublicListing(listing, country, {refreshGeo: true});

      const availability = await recordListingAvailability({
        source,
        country: code,
        id,
        status: 'active',
        reason: 'offer_reload',
      });
      return res.json({
        listing: {
          ...listing,
          ...(availability.publicId ? {publicId: availability.publicId} : {}),
        },
        availability: {status: 'active', checkedAt: availability.checkedAt, cached: false},
      });
    } catch (err) {
      return res.status(502).json({error: err.message});
    }
  });

  app.post('/api/sources/validate', async (req, res) => {
    if (!checkRate(req, res, 'customSourceValidate', 3000)) return;

    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ok: false, error: 'Missing url'});

    const code = String(req.body?.country || 'RO').toUpperCase();
    const country = COUNTRIES[code] ?? COUNTRIES[COUNTRY_CODES[0]];
    const result = await validateCustomSource(url, country.code);
    return res.json(result);
  });
}
