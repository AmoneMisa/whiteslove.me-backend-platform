import { pool } from '../database/pool.js';

const MAX_AGE_DAYS = 21;
const CURSOR_VERSION = 1;
const EARTH_RADIUS_M = 6_371_000;

function safeRateEntries(rates) {
  return Object.entries(rates || {})
    .map(([currency, rate]) => [String(currency).toUpperCase(), Number(rate)])
    .filter(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0);
}

function priceToUsd(value, currency, rates) {
  if (value == null) return null;
  const rate = Number(rates?.[String(currency || '').toUpperCase()]);
  return Number.isFinite(rate) && rate > 0 ? Number(value) / rate : null;
}




function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed?.v === CURSOR_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMatchRows(searchMatches) {
  if (!searchMatches?.rank?.size) return [];
  const rows = [];
  for (const [key, rank] of searchMatches.rank) {
    const parts = String(key).split(':');
    if (parts.length < 3) continue;
    const source = parts.shift();
    const country = parts.shift();
    const sourceId = parts.join(':');
    if (!source || !country || !sourceId) continue;
    rows.push({ source, country, source_id: sourceId, rank: Number(rank) || 0 });
  }
  return rows;
}

export function buildSearchContext({ filters, countries, rates, searchMatches }) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const matchRows = normalizeMatchRows(searchMatches);
  const elasticsearchAuthoritative = searchMatches != null;
  let from = 'FROM listings l';
  let rankSelect = 'NULL::integer AS search_rank';
  if (matchRows.length) {
    const p = add(JSON.stringify(matchRows));
    from += `\nJOIN jsonb_to_recordset(${p}::jsonb) AS m(source text, country text, source_id text, rank integer)\n  ON m.source = l.source AND m.country = l.country AND m.source_id = l.source_id`;
    rankSelect = 'm.rank AS search_rank';
  }

  const where = [
    'l.active = TRUE',
    `l.listing_kind <> 'propertyWanted'`,
    `l.listing_status NOT IN ('sold', 'rented', 'closed', 'outdated')`,
  ];
  if (elasticsearchAuthoritative && matchRows.length === 0) where.push('FALSE');

  const countryValues = [...new Set((countries || []).map((v) => String(v).toUpperCase()).filter(Boolean))];
  if (countryValues.length) where.push(`l.country = ANY(${add(countryValues)}::text[])`);

  if (filters.sources?.length) where.push(`l.source = ANY(${add(filters.sources.map((v) => String(v).toLowerCase()))}::text[])`);

  const customSources = [...new Set((filters.customSources || []).map(String).filter(Boolean))];
  if (customSources.length) where.push(`(l.source <> 'custom' OR l.data->>'customSourceUrl' = ANY(${add(customSources)}::text[]))`);
  else where.push(`l.source <> 'custom'`);

  if (filters.listingId) where.push(`l.source_id = ${add(String(filters.listingId))}`);

  where.push(`NOT l.commercial`);

  const ageDays = filters.maxAgeDays != null && filters.maxAgeDays > 0
    ? Math.min(Number(filters.maxAgeDays), MAX_AGE_DAYS)
    : MAX_AGE_DAYS;
  where.push(`(l.created_at IS NULL OR l.created_at >= NOW() - (${add(ageDays)}::double precision * INTERVAL '1 day'))`);

  if (filters.propertyType && filters.propertyType !== 'any') where.push(`l.property_type = ${add(filters.propertyType)}`);
  if (filters.dealType && filters.dealType !== 'any') {
    where.push(`l.deal_type = ${add(filters.dealType)}`);
    // Room shares are stored as longRent + roomOnly. A normal long-term rent
    // query means the whole property; room-only is an explicit separate mode.
    if (filters.dealType === 'longRent' && filters.roomOnly !== true) {
      where.push(`NOT l.room_only`);
    }
  }
  if (filters.agency === 'agency') where.push('l.by_agency = TRUE');
  if (filters.agency === 'owner') where.push('l.by_agency = FALSE');

  const effectiveMax = filters.priceMax != null ? Number(filters.priceMax) + Number(filters.priceTolerance || 0) : null;
  const rateEntries = safeRateEntries(rates);
  const convertPrices = rateEntries.length > 0 && filters.priceCurrency;

  let priceUsdExpr = 'l.price';
  if (rateEntries.length) {
    const cases = rateEntries.map(([currency, rate]) => `WHEN '${currency}' THEN l.price / ${rate}`).join(' ');
    priceUsdExpr = `(CASE UPPER(l.currency) ${cases} ELSE NULL END)`;
  }

  if (filters.priceMin != null || effectiveMax != null) {
    if (convertPrices) {
      const minUsd = filters.priceMin != null ? priceToUsd(filters.priceMin, filters.priceCurrency, rates) : null;
      const maxUsd = effectiveMax != null ? priceToUsd(effectiveMax, filters.priceCurrency, rates) : null;
      const branches = [];
      for (const [currency, rate] of rateEntries) {
        const predicates = [`UPPER(l.currency) = '${currency}'`, 'l.price IS NOT NULL'];
        if (minUsd != null) predicates.push(`l.price >= ${add(minUsd * rate)}`);
        if (maxUsd != null) predicates.push(`l.price <= ${add(maxUsd * rate)}`);
        branches.push(`(${predicates.join(' AND ')})`);
      }
      if (branches.length) where.push(`(${branches.join(' OR ')})`);
    } else {
      if (filters.priceMin != null) where.push(`l.price >= ${add(Number(filters.priceMin))}`);
      if (effectiveMax != null) where.push(`l.price <= ${add(Number(effectiveMax))}`);
    }
  }

  if (filters.roomsMin != null) where.push(`l.rooms >= ${add(Number(filters.roomsMin))}`);
  if (filters.roomsMax != null) where.push(`l.rooms <= ${add(Number(filters.roomsMax))}`);
  if (filters.areaMin != null) where.push(`l.area_sqm >= ${add(Number(filters.areaMin))}`);
  if (filters.areaMax != null) where.push(`l.area_sqm <= ${add(Number(filters.areaMax))}`);

  if (filters.bedroomsMin != null) where.push(`l.bedrooms >= ${add(Number(filters.bedroomsMin))}`);
  if (filters.bedroomsMax != null) where.push(`l.bedrooms <= ${add(Number(filters.bedroomsMax))}`);
  if (filters.floorMin != null) where.push(`l.floor_number >= ${add(Number(filters.floorMin))}`);
  if (filters.floorMax != null) where.push(`l.floor_number <= ${add(Number(filters.floorMax))}`);
  if (filters.totalFloorsMin != null) where.push(`l.total_floors >= ${add(Number(filters.totalFloorsMin))}`);
  if (filters.totalFloorsMax != null) where.push(`l.total_floors <= ${add(Number(filters.totalFloorsMax))}`);
  if (filters.yearMin != null) where.push(`l.building_year >= ${add(Number(filters.yearMin))}`);
  if (filters.yearMax != null) where.push(`l.building_year <= ${add(Number(filters.yearMax))}`);

  if (filters.pricePerSqmMin != null || filters.pricePerSqmMax != null) {
    where.push('l.price IS NOT NULL AND l.area_sqm IS NOT NULL AND l.area_sqm > 0');
    const perSqm = convertPrices ? `(${priceUsdExpr} / l.area_sqm)` : '(l.price / l.area_sqm)';
    if (convertPrices) {
      const min = filters.pricePerSqmMin != null ? priceToUsd(filters.pricePerSqmMin, filters.priceCurrency, rates) : null;
      const max = filters.pricePerSqmMax != null ? priceToUsd(filters.pricePerSqmMax, filters.priceCurrency, rates) : null;
      if (min != null) where.push(`${perSqm} >= ${add(min)}`);
      if (max != null) where.push(`${perSqm} <= ${add(max)}`);
    } else {
      if (filters.pricePerSqmMin != null) where.push(`${perSqm} >= ${add(Number(filters.pricePerSqmMin))}`);
      if (filters.pricePerSqmMax != null) where.push(`${perSqm} <= ${add(Number(filters.pricePerSqmMax))}`);
    }
  }

  if (filters.newBuilding === true) where.push(`l.data @> '{"newBuilding":true}'::jsonb`);
  if (filters.audience && filters.audience !== 'any') where.push(`l.data->>'audience' = ${add(filters.audience)}`);
  if (filters.pets === true) where.push(`l.data @> '{"petsAllowed":true}'::jsonb`);
  if (filters.children === true) where.push(`COALESCE(l.data->>'childrenAllowed', '') <> 'false'`);
  if (filters.roomOnly === true) where.push(`l.room_only`);
  if (filters.withPhotos === true) {
    where.push(`(
      COALESCE(NULLIF(BTRIM(l.data->>'photo'), ''), '') <> ''
      OR JSONB_ARRAY_LENGTH(CASE WHEN jsonb_typeof(l.data->'photos') = 'array' THEN l.data->'photos' ELSE '[]'::jsonb END) > 0
    )`);
  }

  const booleanFilters = [
    ['dishwasher', 'dishwasher'], ['airConditioner', 'airConditioner'], ['parking', 'parking'], ['internet', 'internet'],
    ['gas', 'gas'], ['balcony', 'balcony'], ['terrace', 'terrace'], ['privateYard', 'privateYard'],
    ['tv', 'tv'], ['microwave', 'microwave'], ['oven', 'oven'], ['bidet', 'bidet'],
    ['walkInCloset', 'walkInCloset'], ['bathtub', 'bathtub'], ['shower', 'shower'], ['euroLayout', 'euroLayout'],
  ];
  for (const [filterName, dataName] of booleanFilters) if (filters[filterName] === true) where.push(`l.data @> '{"${dataName}":true}'::jsonb`);

  // These fields are tri-state (true/false/unknown), so the filter must match
  // an explicit "false" -- not just "not true" -- to mean what its label says
  // (e.g. "no elevator" excludes listings where elevator presence is simply
  // unparsed, same as it excludes ones that do have one).
  if (filters.noElevator === true) where.push(`l.data @> '{"elevator":false}'::jsonb`);
  if (filters.noDeposit === true) where.push(`l.data @> '{"deposit":false}'::jsonb`);
  if (filters.communalIncluded === true) where.push(`l.data @> '{"communalSeparated":false}'::jsonb`);
  if (filters.noCommission === true) {
    where.push(`(
      l.data @> '{"commission":false}'::jsonb
      OR l.commission_percent = 0
    )`);
  }
  if (filters.commissionPercentMin != null) where.push(`l.commission_percent >= ${add(Number(filters.commissionPercentMin))}`);
  if (filters.commissionPercentMax != null) where.push(`l.commission_percent <= ${add(Number(filters.commissionPercentMax))}`);

  if (filters.city) where.push(`l.city = ${add(String(filters.city))}`);
  if (filters.district) where.push(`LOWER(l.district) = ${add(String(filters.district).toLowerCase())}`);
  if (filters.microdistrict) {
    const p = add(String(filters.microdistrict).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = l.id
        AND term.normalized_name = ${p}
        AND term.term_type = 'microdistrict'
    )`);
  }
  if (filters.quartal) {
    const p = add(String(filters.quartal).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = l.id
        AND term.normalized_name = ${p}
        AND term.term_type IN ('quartal', 'local_area', 'mahalla')
    )`);
  }
  if (filters.area) {
    const p = add(String(filters.area).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = l.id
        AND term.normalized_name = ${p}
        AND term.term_type IN ('area', 'local_area', 'development_area', 'informal_area')
    )`);
  }
  if (filters.metro) where.push(`LOWER(l.metro) = ${add(String(filters.metro).toLowerCase())}`);

  if (filters.metroMaxM != null) where.push(`l.metro_distance_m <= ${add(Number(filters.metroMaxM))}`);

  if (filters.nearbyKind || filters.nearbyMaxM != null) {
    const placeChecks = ['place.listing_id = l.id'];
    if (filters.nearbyKind) placeChecks.push(`place.kind = ${add(String(filters.nearbyKind).trim().toLowerCase())}`);
    if (filters.nearbyMaxM != null) placeChecks.push(`place.distance_m <= ${add(Number(filters.nearbyMaxM))}`);
    where.push(`EXISTS (
      SELECT 1 FROM listing_nearby_places place
      WHERE ${placeChecks.join(' AND ')}
    )`);
  }

  if (Number.isFinite(filters.centerLat) && Number.isFinite(filters.centerLng)
    && Number.isFinite(filters.radiusM) && filters.centerLat >= -90 && filters.centerLat <= 90
    && filters.centerLng >= -180 && filters.centerLng <= 180 && filters.radiusM > 0) {
    const centerLat = Number(filters.centerLat);
    const centerLng = Number(filters.centerLng);
    const radiusM = Math.min(Number(filters.radiusM), 200000);
    const centerLatRad = centerLat * Math.PI / 180;
    const angularRadius = radiusM / EARTH_RADIUS_M;
    const latDelta = angularRadius * 180 / Math.PI;
    const minLat = Math.max(-90, centerLat - latDelta);
    const maxLat = Math.min(90, centerLat + latDelta);
    where.push(`l.lat IS NOT NULL AND l.lng IS NOT NULL`);
    where.push(`l.lat BETWEEN ${add(minLat)} AND ${add(maxLat)}`);

    // Use the same spherical model as the exact Haversine predicate. A rough
    // meters-per-degree constant can be slightly narrower than the exact cap
    // and incorrectly drop valid points close to the requested radius.
    if (Math.abs(centerLatRad) + angularRadius < Math.PI / 2) {
      const ratio = Math.min(1, Math.sin(angularRadius) / Math.cos(centerLatRad));
      const lngDelta = Math.asin(ratio) * 180 / Math.PI;
      const minLng = centerLng - lngDelta;
      const maxLng = centerLng + lngDelta;
      if (minLng >= -180 && maxLng <= 180) {
        where.push(`l.lng BETWEEN ${add(minLng)} AND ${add(maxLng)}`);
      } else if (minLng < -180) {
        where.push(`(l.lng >= ${add(minLng + 360)} OR l.lng <= ${add(maxLng)})`);
      } else {
        where.push(`(l.lng >= ${add(minLng)} OR l.lng <= ${add(maxLng - 360)})`);
      }
    }

    const lat = add(centerLat);
    const lng = add(centerLng);
    const radius = add(radiusM);
    where.push(`${EARTH_RADIUS_M} * ACOS(LEAST(1, GREATEST(-1,
      COS(RADIANS(${lat})) * COS(RADIANS(l.lat)) * COS(RADIANS(l.lng) - RADIANS(${lng}))
      + SIN(RADIANS(${lat})) * SIN(RADIANS(l.lat))))) <= ${radius}`);
  }

  if (filters.query && !elasticsearchAuthoritative) {
    const p = add(`%${String(filters.query).toLowerCase()}%`);
    where.push(`LOWER(CONCAT_WS(' ', l.title, l.description, l.city, l.district, l.metro, l.data->>'region', l.data->>'microdistrict', l.data->>'area', l.data->>'kvartal', l.data->>'residenceComplex', l.data->>'tags')) LIKE ${p}`);
  }

  let orderBy;
  let sort = filters.sort || null;
  if (matchRows.length && !sort) orderBy = 'm.rank ASC, l.created_at DESC NULLS LAST, l.id DESC';
  else {
    sort = sort || 'newest';
    switch (sort) {
      case 'oldest': orderBy = 'l.created_at ASC NULLS LAST, l.id ASC'; break;
      case 'priceAsc': orderBy = `${priceUsdExpr} ASC NULLS LAST, l.id ASC`; break;
      case 'priceDesc': orderBy = `${priceUsdExpr} DESC NULLS LAST, l.id DESC`; break;
      case 'newest': default: sort = 'newest'; orderBy = 'l.created_at DESC NULLS LAST, l.id DESC'; break;
    }
  }

  return { params, from, where, rankSelect, orderBy, sort, priceUsdExpr, matchRows };
}

export async function searchPostgresListings({ filters, countries, rates = null, searchMatches = null }) {
  const startedAt = performance.now();
  const context = buildSearchContext({ filters, countries, rates, searchMatches });
  const baseWhere = context.where.join('\n  AND ');
  const baseParams = [...context.params];
  const dedupeEnabled = !filters.listingId;

  // Every consumer of the filtered set needs a different slice of it, and the
  // widest column by far is the listing payload. Project per consumer instead
  // of ranking one wide row set: only the page actually transports l.data, so
  // the statistics and count passes never carry (or detoast) it.
  const dedupeKeySql = dedupeEnabled ? 'l.dedupe_key' : `CONCAT_WS(':', LOWER(l.source), UPPER(l.country), l.source_id)`;

  const filteredSqlFor = (projection) => `
    SELECT
      ${projection},
      ${dedupeKeySql} AS dedupe_key
    ${context.from}
    WHERE ${baseWhere}
  `;

  const rankedSqlFor = (projection) => `
    SELECT filtered.*, ROW_NUMBER() OVER (
      PARTITION BY filtered.dedupe_key ORDER BY filtered.created_at DESC NULLS LAST, filtered.id DESC
    ) AS dedupe_rank
    FROM (${filteredSqlFor(projection)}) filtered
  `;

  const rankedSql = rankedSqlFor(`
      l.id, l.source, l.country, l.source_id, l.created_at, l.first_seen_at, l.price, l.currency, l.title,
      l.deal_type, l.by_agency, l.city, l.district, l.metro, l.data, l.room_only,
      ${context.priceUsdExpr} AS price_usd,
      ${context.rankSelect}`);

  const countRankedSql = rankedSqlFor('l.id, l.created_at');

  const statsRankedSql = rankedSqlFor(`
      l.id, l.country, l.created_at, l.first_seen_at, l.deal_type, l.by_agency,
      l.city, l.district, l.metro, l.room_only,
      ${context.priceUsdExpr} AS price_usd,
      NULLIF(BTRIM(l.data->>'microdistrict'), '') AS microdistrict,
      COALESCE(
        l.data @> '{"commission":true}'::jsonb
        OR (jsonb_typeof(l.data->'commissionPercent') = 'number' AND (l.data->>'commissionPercent')::numeric > 0),
        FALSE
      ) AS has_commission,
      COALESCE(
        l.data @> '{"commission":false}'::jsonb
        OR (jsonb_typeof(l.data->'commissionPercent') = 'number' AND (l.data->>'commissionPercent')::numeric = 0),
        FALSE
      ) AS no_commission,
      COALESCE(
        l.data->>'duplicatePhotoRisk' IN ('high', 'very_high')
        OR l.data->'antiFake' @> '{"suspectedClone":true}'::jsonb
        OR l.data->'antiFake' @> '{"conflictingClone":true}'::jsonb,
        FALSE
      ) AS suspected_fake`);

  const countSql = `SELECT COUNT(*)::int AS count FROM (${countRankedSql}) l WHERE l.dedupe_rank = 1`;

  const statsSql = `
    WITH ranked AS MATERIALIZED (${statsRankedSql}),
    visible AS MATERIALIZED (SELECT * FROM ranked WHERE dedupe_rank = 1),
    -- One aggregate pass for every scalar the response needs, rather than a
    -- separate subquery scan of the materialized CTE per counter.
    totals AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE by_agency = FALSE)::int AS owners,
        COUNT(*) FILTER (WHERE by_agency = TRUE)::int AS agencies,
        COUNT(*) FILTER (WHERE has_commission)::int AS commission,
        COUNT(*) FILTER (WHERE no_commission)::int AS no_commission,
        COUNT(*) FILTER (WHERE suspected_fake)::int AS suspected_fake
      FROM visible
    ),
    raw_totals AS (
      SELECT
        COUNT(*)::int AS raw_total,
        COUNT(*) FILTER (WHERE dedupe_rank > 1)::int AS duplicates_rejected
      FROM ranked
    ),
    classified AS MATERIALIZED (
      SELECT visible.*,
        CASE
          WHEN room_only THEN 'roomRent'
          WHEN deal_type IN ('sale', 'longRent', 'shortRent') THEN deal_type
          ELSE 'unknown'
        END AS deal_key
      FROM visible
    ),
    deal_rows AS (
      SELECT deal_key AS key,
        COUNT(*)::int AS count,
        COUNT(price_usd)::int AS price_count,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd))::numeric, 2) AS median_usd,
        ROUND(AVG(price_usd)::numeric, 2) AS average_usd,
        ROUND(MIN(price_usd)::numeric, 2) AS min_usd,
        ROUND(MAX(price_usd)::numeric, 2) AS max_usd
      FROM classified
      GROUP BY deal_key
    ),
    price_band_rows AS (
      SELECT c.deal_key,
        CASE
          WHEN c.price_usd / d.median_usd < 0.70 THEN 'green'
          WHEN c.price_usd / d.median_usd < 0.85 THEN 'blue'
          WHEN c.price_usd / d.median_usd <= 1.15 THEN 'pink'
          WHEN c.price_usd / d.median_usd < 1.31 THEN 'orange'
          WHEN c.price_usd / d.median_usd < 1.45 THEN 'yellow'
          ELSE 'red'
        END AS band_key,
        COUNT(*)::int AS count
      FROM classified c
      JOIN deal_rows d ON d.key = c.deal_key
      WHERE c.price_usd IS NOT NULL AND c.price_usd > 0 AND d.median_usd IS NOT NULL AND d.median_usd > 0
      GROUP BY c.deal_key, band_key
    ),
    price_band_json AS (
      SELECT deal_key,
        JSONB_AGG(JSONB_BUILD_OBJECT('key', band_key, 'count', count) ORDER BY
          CASE band_key WHEN 'green' THEN 1 WHEN 'blue' THEN 2 WHEN 'pink' THEN 3 WHEN 'orange' THEN 4 WHEN 'yellow' THEN 5 ELSE 6 END
        ) AS bands,
        SUM(count)::int AS samples
      FROM price_band_rows
      GROUP BY deal_key
    ),
    geo_rows AS (
      SELECT CASE WHEN GROUPING(v.deal_key) = 1 THEN NULL ELSE v.deal_key END AS deal_key,
        geo.dimension, geo.label,
        COUNT(*)::int AS count,
        COUNT(v.price_usd)::int AS price_count,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.price_usd))::numeric, 2) AS median_usd,
        ROUND(MIN(v.price_usd)::numeric, 2) AS min_usd,
        ROUND(MAX(v.price_usd)::numeric, 2) AS max_usd
      FROM classified v
      CROSS JOIN LATERAL (VALUES
        ('country', NULLIF(BTRIM(v.country), '')),
        ('city', NULLIF(BTRIM(v.city), '')),
        ('district', NULLIF(BTRIM(v.district), '')),
        ('microdistrict', v.microdistrict),
        ('metro', NULLIF(BTRIM(v.metro), ''))
      ) AS geo(dimension, label)
      WHERE geo.label IS NOT NULL
      GROUP BY GROUPING SETS ((geo.dimension, geo.label), (v.deal_key, geo.dimension, geo.label))
    ),
    geo_ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY deal_key, dimension ORDER BY count DESC, label ASC) AS position
      FROM geo_rows
    ),
    geo_json AS (
      SELECT deal_key, dimension,
        JSONB_AGG(JSONB_BUILD_OBJECT(
          'label', label, 'count', count, 'priceCount', price_count,
          'medianUsd', median_usd, 'minUsd', min_usd, 'maxUsd', max_usd
        ) ORDER BY count DESC, label ASC) AS items
      FROM geo_ranked
      WHERE position <= 12
      GROUP BY deal_key, dimension
    ),
    geo_by_deal_json AS (
      SELECT deal_key, JSONB_OBJECT_AGG(dimension, items) AS dimensions
      FROM geo_json WHERE deal_key IS NOT NULL GROUP BY deal_key
    ),
    activity_rows AS (
      SELECT DATE_TRUNC('day', COALESCE(first_seen_at, created_at))::date AS day, COUNT(*)::int AS count
      FROM visible WHERE COALESCE(first_seen_at, created_at) IS NOT NULL GROUP BY 1 ORDER BY 1
    )
    SELECT
      (SELECT total FROM totals) AS total,
      (SELECT raw_total FROM raw_totals) AS raw_total,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'key', key, 'count', count, 'priceCount', price_count,
        'medianUsd', median_usd, 'averageUsd', average_usd, 'minUsd', min_usd, 'maxUsd', max_usd
      ) ORDER BY count DESC, key ASC) FROM deal_rows), '[]'::jsonb) AS deal_types,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, bands) FROM price_band_json), '{}'::jsonb) AS price_bands_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, samples) FROM price_band_json), '{}'::jsonb) AS price_band_samples_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(dimension, items) FROM geo_json WHERE deal_key IS NULL), '{}'::jsonb) AS geographies,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, dimensions) FROM geo_by_deal_json), '{}'::jsonb) AS geographies_by_deal,
      (SELECT JSONB_BUILD_OBJECT(
        'owners', owners,
        'agencies', agencies,
        'commission', commission,
        'noCommission', no_commission
      ) FROM totals) AS ownership,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('date', day, 'count', count) ORDER BY day) FROM activity_rows), '[]'::jsonb) AS activity,
      JSONB_BUILD_OBJECT(
        'duplicatesRejected', (SELECT duplicates_rejected FROM raw_totals),
        'suspectedFake', (SELECT suspected_fake FROM totals)
      ) AS quality
  `;

  const pageParams = [...baseParams];
  const addPage = (value) => { pageParams.push(value); return `$${pageParams.length}`; };
  const cursor = decodeCursor(filters.cursor);
  const pageWhere = ['l.dedupe_rank = 1'];
  let useCursor = false;
  if (cursor && cursor.sort === context.sort && ['newest', 'oldest'].includes(context.sort) && cursor.id != null) {
    const idParam = addPage(String(cursor.id));
    if (cursor.t) {
      const timeParam = addPage(cursor.t);
      if (context.sort === 'newest') pageWhere.push(`(l.created_at < ${timeParam}::timestamptz OR (l.created_at = ${timeParam}::timestamptz AND l.id < ${idParam}::bigint) OR l.created_at IS NULL)`);
      else pageWhere.push(`(l.created_at > ${timeParam}::timestamptz OR (l.created_at = ${timeParam}::timestamptz AND l.id > ${idParam}::bigint) OR l.created_at IS NULL)`);
    } else if (context.sort === 'newest') pageWhere.push(`l.created_at IS NULL AND l.id < ${idParam}::bigint`);
    else pageWhere.push(`l.created_at IS NULL AND l.id > ${idParam}::bigint`);
    useCursor = true;
  }
  const cursorCount = Number(cursor?.c);
  const hasCursorCount = useCursor && Number.isInteger(cursorCount) && cursorCount >= 0;

  const limit = Math.max(1, Math.min(Number(filters.limit) || 40, 60));
  const fetchLimit = filters.statsOnly ? limit : limit + 1;
  const limitParam = addPage(fetchLimit);
  const offset = useCursor ? 0 : Math.max(0, Number(filters.offset) || 0);
  const offsetParam = addPage(offset);
  const orderBy = context.orderBy.replaceAll('m.rank', 'l.search_rank');

  const pageSql = `
    SELECT l.id AS db_id, l.created_at, l.price, l.currency, l.title, l.data, l.search_rank
    FROM (${rankedSql}) l
    WHERE ${pageWhere.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
  `;

  // Without a cursor, pageWhere is exactly countSql's `dedupe_rank = 1` predicate,
  // so a window COUNT(*) OVER() over that same filtered set gives the identical
  // total countSql would, in the one scan the page fetch already has to do.
  // Cursor tokens carry that first-page total forward, so later cursor pages
  // avoid an otherwise identical exact COUNT scan. Legacy cursors without a
  // carried total fall back to countSql once for compatibility.
  const combinedPageSql = useCursor ? null : `
    SELECT l.id AS db_id, l.created_at, l.price, l.currency, l.title, l.data, l.search_rank,
      COUNT(*) OVER()::int AS total_count
    FROM (${rankedSql}) l
    WHERE ${pageWhere.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
  `;

  let countOrStatsResult;
  let pageResult = {rows: []};
  if (filters.includeStats && filters.statsOnly) countOrStatsResult = await pool.query(statsSql, baseParams);
  else if (filters.includeStats) {
    [countOrStatsResult, pageResult] = await Promise.all([
      pool.query(statsSql, baseParams),
      pool.query(pageSql, pageParams),
    ]);
  } else if (combinedPageSql) {
    pageResult = await pool.query(combinedPageSql, pageParams);
    // An offset past the last matching row returns zero rows, so the window
    // total isn't in the result set either — fall back to the direct count.
    countOrStatsResult = pageResult.rows.length
      ? { rows: [{ count: pageResult.rows[0].total_count }] }
      : await pool.query(countSql, baseParams);
  } else if (hasCursorCount) {
    pageResult = await pool.query(pageSql, pageParams);
    countOrStatsResult = { rows: [{ count: cursorCount }] };
  } else {
    [countOrStatsResult, pageResult] = await Promise.all([
      pool.query(countSql, baseParams),
      pool.query(pageSql, pageParams),
    ]);
  }

  const hasMore = !filters.statsOnly && pageResult.rows.length > limit;
  const rows = filters.statsOnly ? [] : pageResult.rows.slice(0, limit);
  const listings = rows.map((row) => row.data || {});
  const statistics = filters.includeStats ? {
    total: Number(countOrStatsResult.rows[0]?.total) || 0,
    rawTotal: Number(countOrStatsResult.rows[0]?.raw_total) || 0,
    currency: 'USD',
    dealTypes: countOrStatsResult.rows[0]?.deal_types || [],
    priceBandsByDeal: countOrStatsResult.rows[0]?.price_bands_by_deal || {},
    priceBandSamplesByDeal: countOrStatsResult.rows[0]?.price_band_samples_by_deal || {},
    geographies: countOrStatsResult.rows[0]?.geographies || {},
    geographiesByDeal: countOrStatsResult.rows[0]?.geographies_by_deal || {},
    ownership: countOrStatsResult.rows[0]?.ownership || {},
    activity: countOrStatsResult.rows[0]?.activity || [],
    quality: countOrStatsResult.rows[0]?.quality || {},
  } : null;
  const count = statistics?.total ?? (Number(countOrStatsResult.rows[0]?.count) || 0);

  let nextCursor = null;
  if (hasMore && ['newest', 'oldest'].includes(context.sort)) {
    const last = rows[rows.length - 1];
    const time = last.created_at instanceof Date ? last.created_at.toISOString() : (last.created_at ? new Date(last.created_at).toISOString() : null);
    nextCursor = encodeCursor({ v: CURSOR_VERSION, sort: context.sort, t: time, id: String(last.db_id), c: count });
  }

  return {
    count,
    listings,
    ...(statistics ? {statistics} : {}),
    nextCursor,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
    searchPath: searchMatches ? 'postgres+elasticsearch' : 'postgres',
  };
}
