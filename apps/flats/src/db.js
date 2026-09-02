import {closePool, pool} from './infrastructure/database/pool.js';
export {pool} from './infrastructure/database/pool.js';
import {enrichListingDetails} from './listing-enrichment.js';
import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';


function finiteNumber(value) {
    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function finiteInteger(value) {
    const number =
        finiteNumber(value);

    return number == null
        ? null
        : Math.trunc(number);
}

function safeTimestamp(value) {
    if (!value) {
        return null;
    }

    const time =
        Date.parse(value);

    if (!Number.isFinite(time)) {
        return null;
    }

    return new Date(time)
        .toISOString();
}

function dbListing(inputListing) {
    const listing = enrichListingDetails(inputListing);
    const country = String(listing.country || '').toUpperCase();
    const sourceCity = String(listing.city || '').trim();
    const city = sourceCity ? (canonicalCity(sourceCity, country) || sourceCity) : null;
    const data = city && sourceCity && city !== sourceCity ? {...listing, city, sourceCity} : {...listing, city};

    return {
        source:
            String(
                listing.source || '',
            ).toLowerCase(),

        country,

        source_id:
            String(
                listing.id,
            ),

        title:
            listing.title ?? '',

        description:
            listing.description ?? '',

        property_type:
            listing.propertyType ?? null,

        deal_type:
            listing.dealType ?? null,

        city,

        district:
            listing.district ?? null,

        area:
            listing.area ??
            listing.kvartal ??
            null,

        metro:
            listing.metro ?? null,

        address:
            listing.address ?? null,

        residence_complex:
            listing.residenceComplex ?? null,

        price:
            finiteNumber(
                listing.price,
            ),

        currency:
            listing.currency ?? null,

        rooms:
            finiteInteger(
                listing.rooms,
            ),

        area_sqm:
            finiteNumber(
                listing.areaSqm,
            ),

        by_agency:
            Boolean(
                listing.byAgency,
            ),

        created_at:
            safeTimestamp(
                listing.createdAt,
            ),

        // Полный normalized Listing.
        // ES позже будем строить именно из него.
        data,
    };
}

const UPSERT_SQL = `
  INSERT INTO listings (
    source,
    country,
    source_id,

    title,
    description,

    property_type,
    deal_type,

    city,
    district,
    area,
    metro,
    address,
    residence_complex,

    price,
    currency,

    rooms,
    area_sqm,

    by_agency,

    created_at,

    active,
    missed_runs,

    first_seen_at,
    last_seen_at,
    updated_at,

    data
  )

  SELECT
    input.source,
    input.country,
    input.source_id,

    input.title,
    input.description,

    input.property_type,
    input.deal_type,

    input.city,
    input.district,
    input.area,
    input.metro,
    input.address,
    input.residence_complex,

    input.price,
    input.currency,

    input.rooms,
    input.area_sqm,

    input.by_agency,

    input.created_at,

    TRUE,
    0,

    NOW(),
    NOW(),
    NOW(),

    input.data

  FROM jsonb_to_recordset(
    $1::jsonb
  ) AS input (
    source TEXT,
    country TEXT,
    source_id TEXT,

    title TEXT,
    description TEXT,

    property_type TEXT,
    deal_type TEXT,

    city TEXT,
    district TEXT,
    area TEXT,
    metro TEXT,
    address TEXT,
    residence_complex TEXT,

    price DOUBLE PRECISION,
    currency TEXT,

    rooms INTEGER,
    area_sqm DOUBLE PRECISION,

    by_agency BOOLEAN,

    created_at TIMESTAMPTZ,

    data JSONB
  )

  ON CONFLICT (
    source,
    country,
    source_id
  )

  DO UPDATE SET
    title =
      EXCLUDED.title,

    description =
      EXCLUDED.description,

    property_type =
      EXCLUDED.property_type,

    deal_type =
      EXCLUDED.deal_type,

    city =
      EXCLUDED.city,

    district =
      EXCLUDED.district,

    area =
      EXCLUDED.area,

    metro =
      EXCLUDED.metro,

    address =
      EXCLUDED.address,

    residence_complex =
      EXCLUDED.residence_complex,

    price =
      EXCLUDED.price,

    currency =
      EXCLUDED.currency,

    rooms =
      EXCLUDED.rooms,

    area_sqm =
      EXCLUDED.area_sqm,

    by_agency =
      EXCLUDED.by_agency,

    created_at =
      EXCLUDED.created_at,

    active =
      TRUE,

    missed_runs =
      0,

    last_seen_at =
      NOW(),

    updated_at =
      NOW(),

    -- Existing normalized/enriched keys that are absent from the new source
    -- snapshot survive the crawl. Keys explicitly present in EXCLUDED.data,
    -- including null/false/empty values, remain authoritative because the
    -- right-hand JSONB operand wins on duplicate keys.
    data =
      listings.data || EXCLUDED.data;
`;

export async function upsertListings(
    listings,
) {
    if (
        !Array.isArray(listings) ||
        !listings.length
    ) {
        return 0;
    }

    /*
     * Заодно убираем дубли внутри batch.
     *
     * PostgreSQL ON CONFLICT не должен
     * получить один и тот же unique key
     * дважды внутри одного INSERT.
     */
    const unique =
        new Map();

    for (const listing of listings) {
        if (
            !listing?.source ||
            !listing?.country ||
            listing?.id == null
        ) {
            continue;
        }

        const normalized =
            dbListing(listing);

        const key = [
            normalized.source,
            normalized.country,
            normalized.source_id,
        ].join(':');

        unique.set(
            key,
            normalized,
        );
    }

    const rows = [
        ...unique.values(),
    ];

    if (!rows.length) {
        return 0;
    }

    const BATCH_SIZE = 500;

    let saved = 0;

    for (
        let offset = 0;
        offset < rows.length;
        offset += BATCH_SIZE
    ) {
        const batch =
            rows.slice(
                offset,
                offset + BATCH_SIZE,
            );

        await pool.query(
            UPSERT_SQL,
            [
                JSON.stringify(
                    batch,
                ),
            ],
        );

        saved += batch.length;
    }

    return saved;
}

/*
 * Вызывать ТОЛЬКО после полного,
 * успешного crawl источника.
 *
 * Все объявления, которые существовали
 * до начала crawl, но в новом полном
 * проходе не встретились, получают miss.
 *
 * После трёх последовательных miss:
 * active = false.
 */
export async function markMissingAfterCompleteCrawl({
                                                        source,
                                                        country,
                                                        crawlStartedAt,
                                                    }) {
    const result =
        await pool.query(
            `
                UPDATE listings

                SET
                    missed_runs =
                        missed_runs + 1,

                    active =
                        CASE
                            WHEN missed_runs + 1 >= 3
                                THEN FALSE
                            ELSE TRUE
                            END,

                    updated_at =
                        NOW()

                WHERE
                    source = $1

                  AND country = $2

                  AND active = TRUE

                  AND last_seen_at <
                      $3::timestamptz

            RETURNING
              source,
              country,
              source_id,
              active,
              missed_runs;
            `,
            [
                String(source)
                    .toLowerCase(),

                String(country)
                    .toUpperCase(),

                crawlStartedAt,
            ],
        );

    const deactivated =
        result.rows
            .filter(
                (row) =>
                    row.active === false,
            )
            .map(
                (row) => ({
                    source:
                    row.source,

                    country:
                    row.country,

                    id:
                        String(
                            row.source_id,
                        ),
                }),
            );

    if (result.rowCount) {
        console.log(
            `[postgres] ${source}/${country}: ` +
            `${result.rowCount} listings missed, ` +
            `${deactivated.length} deactivated`,
        );
    }

    return {
        missed:
        result.rowCount,

        deactivated,
    };
}

export async function dbHealth() {
    await pool.query(
        'SELECT 1',
    );

    return true;
}

export async function getDbStats() {
    const result =
        await pool.query(`
        SELECT
          source,
          country,

          COUNT(*)::int
            AS total,

          COUNT(*) FILTER (
            WHERE active = TRUE
          )::int
            AS active,

          COUNT(*) FILTER (
            WHERE active = FALSE
          )::int
            AS inactive

        FROM listings

        GROUP BY
          source,
          country

        ORDER BY
          country,
          source;
      `);

    return result.rows;
}

export async function getActiveListingsBatch(
    afterId = 0,
    limit = 500,
) {
    const safeLimit =
        Math.max(
            1,
            Math.min(
                Number(limit) || 500,
                2000,
            ),
        );

    const result =
        await pool.query(
            `
            SELECT
              id AS db_id,

              source,
              country,
              source_id,

              first_seen_at,
              last_seen_at,
              updated_at,

              data

            FROM listings

            WHERE
              active = TRUE

              AND id >
                $1::bigint

            ORDER BY
              id ASC

            LIMIT $2
            `,
            [
                String(
                    afterId || 0,
                ),

                safeLimit,
            ],
        );

    return result.rows;
}

export async function closeDb() {
    await closePool();
}

export async function getAvailableListingLocations(
    countryCode,
) {
    const country =
        String(countryCode ?? '')
            .trim()
            .toUpperCase();

    if (!country) {
        return [];
    }

    const result =
        await pool.query(
            `
            SELECT
              BTRIM(city) AS city,

              NULLIF(
                BTRIM(district),
                ''
              ) AS district,

              COUNT(*)::int AS listings_count

            FROM listings

            WHERE
              active = TRUE

              AND country = $1

              AND city IS NOT NULL

              AND BTRIM(city) <> ''

            GROUP BY
              BTRIM(city),

              NULLIF(
                BTRIM(district),
                ''
              )

            ORDER BY
              BTRIM(city) ASC,

              NULLIF(
                BTRIM(district),
                ''
              ) ASC NULLS LAST
            `,
            [
                country,
            ],
        );

    return result.rows;
}
