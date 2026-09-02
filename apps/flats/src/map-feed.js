import {pool} from './infrastructure/database/pool.js';
import { buildSearchContext } from './postgres-search.js';

const MAP_MAX_POINTS = Math.max(60, Math.min(Number(process.env.MAP_FEED_MAX_POINTS) || 3000, 10000));

function finiteCoordinate(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapPointFromRow(row) {
  const lat = finiteCoordinate(row?.lat_value);
  const lng = finiteCoordinate(row?.lng_value);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return {
    id: String(row.source_id ?? ''),
    source: String(row.source || ''),
    country: String(row.country || '').toUpperCase(),
    lat,
    lng,
    title: String(row.title || ''),
    price: row.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null,
    currency: String(row.currency || ''),
    publicId: Number.isInteger(Number(row.db_id)) ? Number(row.db_id) : null,
    city: String(row.city || ''),
    district: row.district ? String(row.district) : null,
    dealType: row.deal_type ? String(row.deal_type) : null,
    roomOnly: row.room_only === true,
    byAgency: row.by_agency === true,
    propertyType: String(row.property_type || 'flat'),
    rooms: row.rooms == null ? null : Number(row.rooms),
    areaSqm: row.area_sqm == null ? null : Number(row.area_sqm),
    photo: row.photo ? String(row.photo) : null,
    createdAt: row.created_at || null,
  };
}

/**
 * Map reads share the authoritative filter builder with the normal listing
 * search, but use one narrow SQL query rather than consuming 60-row listing
 * pages. The query preserves the same latest-publication winner per dedupe_key,
 * counts the complete filtered result once, and transfers only marker/card
 * fields instead of the full listing JSONB payload.
 */
export async function searchPostgresMapPoints({ filters, countries, rates = null, searchMatches = null }) {
  const startedAt = performance.now();
  const mapFilters = {
    ...filters,
    includeStats: false,
    statsOnly: false,
    cursor: '',
    offset: 0,
    sort: 'newest',
  };
  const context = buildSearchContext({
    filters: mapFilters,
    countries,
    rates,
    searchMatches,
  });
  const params = [...context.params];
  params.push(MAP_MAX_POINTS);
  const limitParam = `$${params.length}`;
  const dedupeKey = mapFilters.listingId
    ? `CONCAT_WS(':', LOWER(l.source), UPPER(l.country), l.source_id)`
    : 'l.dedupe_key';
  const where = context.where.join('\n      AND ');

  const sql = `
    WITH filtered AS (
      SELECT
        l.id AS db_id,
        l.source,
        l.country,
        l.source_id,
        l.created_at,
        l.price,
        l.currency,
        l.title,
        l.deal_type,
        l.by_agency,
        l.city,
        l.district,
        l.property_type,
        l.rooms,
        l.area_sqm,
        l.lat AS lat_value,
        l.lng AS lng_value,
        (l.data @> '{"roomOnly":true}'::jsonb) AS room_only,
        COALESCE(
          NULLIF(BTRIM(l.data->>'photo'), ''),
          CASE
            WHEN jsonb_typeof(l.data->'photos'->0) = 'string'
              THEN NULLIF(BTRIM(l.data->'photos'->>0), '')
            WHEN jsonb_typeof(l.data->'photos'->0) = 'object'
              THEN COALESCE(
                NULLIF(BTRIM(l.data->'photos'->0->>'link'), ''),
                NULLIF(BTRIM(l.data->'photos'->0->>'url'), ''),
                NULLIF(BTRIM(l.data->'photos'->0->>'src'), '')
              )
            ELSE NULL
          END
        ) AS photo,
        ${dedupeKey} AS dedupe_key
      ${context.from}
      WHERE ${where}
    ),
    visible AS MATERIALIZED (
      SELECT DISTINCT ON (dedupe_key) filtered.*
      FROM filtered
      ORDER BY dedupe_key, created_at DESC NULLS LAST, db_id DESC
    ),
    totals AS (
      SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (
          WHERE lat_value BETWEEN -90 AND 90
            AND lng_value BETWEEN -180 AND 180
        )::int AS point_count
      FROM visible
    )
    SELECT points.*, totals.total_count, totals.point_count
    FROM totals
    LEFT JOIN LATERAL (
      SELECT visible.*
      FROM visible
      WHERE visible.lat_value BETWEEN -90 AND 90
        AND visible.lng_value BETWEEN -180 AND 180
      ORDER BY visible.created_at DESC NULLS LAST, visible.db_id DESC
      LIMIT ${limitParam}
    ) AS points ON TRUE
  `;

  const { rows } = await pool.query(sql, params);
  const points = rows
    .filter((row) => row.db_id != null)
    .map(mapPointFromRow)
    .filter(Boolean);
  const count = Number(rows[0]?.total_count) || 0;
  const pointCount = Number(rows[0]?.point_count) || 0;

  return {
    count,
    points,
    truncated: pointCount > points.length,
    pages: 1,
    maxPoints: MAP_MAX_POINTS,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}
