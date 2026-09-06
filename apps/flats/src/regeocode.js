import { COUNTRIES } from './geo/countries.js';
import { rejectOutOfAreaCoordinates } from './geo/coordinate-validation.js';
import { geocodeListingsPersistent } from './geo/geocode-persistent.js';
import {
  closeDb,
  getActiveListingsBatch,
  pool,
} from './infrastructure/database/listingRepository.js';
import { mapListingToRow } from './infrastructure/database/listingMapper.js';
import {
  closeElasticsearch,
  indexListings,
} from './infrastructure/search/elasticsearch.js';
import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';

const BATCH_SIZE = Math.max(
  1,
  Math.min(Number(process.env.GEO_REGEOCODE_BATCH_SIZE) || 100, 500),
);
const ONLY_COUNTRY = String(process.env.GEO_REGEOCODE_COUNTRY || '').trim().toUpperCase();

function listingFromRow(row) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const listing = {
    ...data,
    id: String(row.source_id),
    source: String(row.source || data.source || '').toLowerCase(),
    country: String(row.country || data.country || '').toUpperCase(),
  };

  const hasCoordinates = listing.lat != null
    && listing.lng != null
    && Number.isFinite(Number(listing.lat))
    && Number.isFinite(Number(listing.lng));
  if (hasCoordinates && !listing.locationSource) {
    listing.locationSource = 'sourceCoordinates';
    listing.locationProvider = listing.source || null;
    listing.locationPrecision = 'broad';
    listing.locationAccuracyM = null;
    listing.locationApproximate = true;
  }
  return listing;
}

async function persistGeoOnly(listings) {
  if (!Array.isArray(listings) || !listings.length) return 0;
  const rows = listings.map(mapListingToRow);
  const result = await pool.query(`
    UPDATE listings AS l
    SET
      city = input.city,
      district = input.district,
      area = input.area,
      metro = input.metro,
      address = input.address,
      residence_complex = input.residence_complex,
      data = l.data || input.data,
      updated_at = NOW()
    FROM jsonb_to_recordset($1::jsonb) AS input (
      source TEXT,
      country TEXT,
      source_id TEXT,
      city TEXT,
      district TEXT,
      area TEXT,
      metro TEXT,
      address TEXT,
      residence_complex TEXT,
      data JSONB
    )
    WHERE l.source = input.source
      AND l.country = input.country
      AND l.source_id = input.source_id
      AND l.active = TRUE
  `, [JSON.stringify(rows)]);
  return result.rowCount;
}

async function processCountry(listings, countryCode) {
  const config = COUNTRIES[countryCode];
  if (!config || !listings.length) return { updated: 0, indexed: 0 };

  // Re-run the same validation + persistent resolver used by fresh crawl data.
  // This is intentionally not an UPSERT: a maintenance pass must never refresh
  // last_seen_at, clear missed_runs or otherwise pretend an old ad was crawled.
  await rejectOutOfAreaCoordinates(listings, config);
  await geocodeListingsPersistent(listings, config);
  const updated = await persistGeoOnly(listings);

  let indexed = 0;
  try {
    indexed = await indexListings(listings);
  } catch (error) {
    console.warn(`[regeocode] ${countryCode}: Elasticsearch update failed:`, error?.message || error);
  }
  return { updated, indexed };
}

async function main() {
  await assertDatabaseReady();

  let afterId = 0;
  let scanned = 0;
  let updated = 0;
  let indexed = 0;

  for (;;) {
    const rows = await getActiveListingsBatch(afterId, BATCH_SIZE);
    if (!rows.length) break;
    afterId = Number(rows.at(-1)?.db_id || afterId);
    scanned += rows.length;

    const groups = new Map();
    for (const row of rows) {
      const listing = listingFromRow(row);
      if (ONLY_COUNTRY && listing.country !== ONLY_COUNTRY) continue;
      if (!COUNTRIES[listing.country]) continue;
      if (!groups.has(listing.country)) groups.set(listing.country, []);
      groups.get(listing.country).push(listing);
    }

    for (const [countryCode, listings] of groups) {
      const result = await processCountry(listings, countryCode);
      updated += result.updated;
      indexed += result.indexed;
    }

    console.log(`[regeocode] scanned=${scanned} updated=${updated} indexed=${indexed} afterId=${afterId}`);
  }

  console.log(`[regeocode] complete scanned=${scanned} updated=${updated} indexed=${indexed}`);
}

main()
  .then(async () => {
    await Promise.allSettled([closeElasticsearch(), closeDb()]);
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[regeocode] failed:', error);
    await Promise.allSettled([closeElasticsearch(), closeDb()]);
    process.exit(1);
  });
