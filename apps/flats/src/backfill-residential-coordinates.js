import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { buildResidentialCoordinateBackfillPatch } from './geo/residential-coordinate-backfill.js';
import { describeBackfillIds, parseBackfillIds } from './maintenance/backfill-id-scope.js';

function intArg(value, name, min, max) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be ${min}..${max}`);
  }
  return number;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    batchSize: 250,
    country: null,
    ids: null,
    preview: 20,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = intArg(arg.slice(13), '--batch-size', 1, 2000);
    else if (arg.startsWith('--preview=')) args.preview = intArg(arg.slice(10), '--preview', 0, 200);
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--ids=')) args.ids = parseBackfillIds(arg.slice(6));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:\n  node src/backfill-residential-coordinates.js [--country=UZ] [--ids=123,456] [--batch-size=250] [--preview=20] [--apply]\n\nDry-run is the default. --ids accepts PostgreSQL listing IDs (the listings.id column) and restricts both preview and apply to exactly those active rows. Pass --apply to persist only rows whose broad coordinate is replaced by a canonical primary residential-complex anchor.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function fetchBatch(afterId, limit, country, ids) {
  const result = await pool.query(
    `
      SELECT
        id AS db_id,
        source,
        country,
        source_id,
        city,
        residence_complex,
        lat,
        lng,
        data
      FROM listings
      WHERE active = TRUE
        AND id > $1::bigint
        AND lat IS NOT NULL
        AND lng IS NOT NULL
        AND NULLIF(BTRIM(residence_complex), '') IS NOT NULL
        AND ($3::text IS NULL OR country = $3)
        AND ($4::bigint[] IS NULL OR id = ANY($4::bigint[]))
      ORDER BY id ASC
      LIMIT $2
    `,
    [String(afterId || 0), limit, country, ids?.length ? ids : null],
  );
  return result.rows;
}

async function applyPatches(rows) {
  if (!rows.length) return 0;
  const payload = rows.map((row) => ({ db_id: String(row.dbId), patch: row.patch }));
  const result = await pool.query(
    `
      UPDATE listings AS listing
      SET
        data = listing.data || input.patch,
        updated_at = NOW()
      FROM jsonb_to_recordset($1::jsonb) AS input (
        db_id bigint,
        patch jsonb
      )
      WHERE listing.id = input.db_id
    `,
    [JSON.stringify(payload)],
  );
  return result.rowCount;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertDatabaseReady();

  let afterId = '0';
  let scanned = 0;
  let refinable = 0;
  let applied = 0;
  let previewed = 0;

  console.log(`[residential-coordinate-backfill] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} country=${args.country || 'ALL'} ids=${describeBackfillIds(args.ids)} batch=${args.batchSize}`);

  for (;;) {
    const batch = await fetchBatch(afterId, args.batchSize, args.country, args.ids);
    if (!batch.length) break;
    afterId = String(batch[batch.length - 1].db_id);
    scanned += batch.length;

    const changes = [];
    for (const row of batch) {
      const patch = buildResidentialCoordinateBackfillPatch(row);
      if (!patch) continue;
      refinable += 1;
      changes.push({ dbId: row.db_id, patch });

      if (previewed < args.preview) {
        previewed += 1;
        console.log(JSON.stringify({
          dbId: String(row.db_id),
          source: row.source,
          sourceId: row.source_id,
          country: row.country,
          city: row.city,
          residenceComplex: row.residence_complex,
          from: { lat: Number(row.lat), lng: Number(row.lng) },
          to: { lat: patch.lat, lng: patch.lng },
          geoEntityId: patch.locationGeoEntityId,
          distanceM: patch.sourceCoordinateDistanceM,
        }));
      }
    }

    if (args.apply && changes.length) {
      applied += await applyPatches(changes);
    }
  }

  console.log(`[residential-coordinate-backfill] scanned=${scanned} refinable=${refinable} applied=${applied}`);
  if (!args.apply && refinable) {
    console.log('[residential-coordinate-backfill] dry-run only; rerun with --apply to persist these coordinate patches.');
  }
}

main()
  .finally(async () => {
    await closeDb();
  })
  .catch((error) => {
    console.error('[residential-coordinate-backfill] failed:', error);
    process.exitCode = 1;
  });
