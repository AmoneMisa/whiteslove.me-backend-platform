import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { canonicalizeListingLocations } from './listing/location-canonicalization.js';

const LOCATION_DATA_KEYS = Object.freeze([
  'country',
  'city',
  'region',
  'district',
  'area',
  'kvartal',
  'metro',
  'residenceComplex',
  'microdistrict',
  'street',
  'locality',
  'mahallas',
  'localAreas',
  'suburbs',
  'settlements',
  'informalAreas',
  'developmentAreas',
  'searchClusters',
  'nearby',
  'locationEntities',
  'locationCanonical',
  'sourceCountry',
  'sourceCity',
  'sourceRegion',
  'sourceDistrict',
  'sourceArea',
  'sourceKvartal',
  'sourceMetro',
  'sourceResidenceComplex',
  'sourceMicrodistrict',
  'sourceStreet',
  'sourceLocality',
  'sourceMahallas',
  'sourceLocalAreas',
  'sourceSuburbs',
  'sourceSettlements',
  'sourceInformalAreas',
  'sourceDevelopmentAreas',
  'sourceSearchClusters',
  'sourceNearby',
  'sourceLocationEntities',
  'sourceLocationCanonical',
]);

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
    preview: 20,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = intArg(arg.slice(13), '--batch-size', 1, 2000);
    else if (arg.startsWith('--preview=')) args.preview = intArg(arg.slice(10), '--preview', 0, 200);
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:\n  node src/backfill-location-canonicals.js [--country=UZ] [--batch-size=250] [--preview=20] [--apply]\n\nDry-run is the default. Known aliases are replaced by their single canonical vocabulary value in both structured listing columns and JSON data. Unknown values are retained unchanged. Existing source* audit values are replayed so partially applied older canonicalization can be repaired safely.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hydrate(row) {
  const data = object(row.data);
  return {
    ...data,
    id: data.id ?? row.source_id ?? String(row.db_id),
    source: data.source ?? row.source,
    country: data.country ?? row.country,
    city: data.city ?? row.city,
    district: data.district ?? row.district,
    area: data.area ?? row.area,
    metro: data.metro ?? row.metro,
    address: data.address ?? row.address,
    residenceComplex: data.residenceComplex ?? row.residence_complex,
  };
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildChange(row) {
  const before = hydrate(row);
  // Backfill is also the repair path for the partially-applied first canonical
  // migration. Replaying source* values means a bad historical canonical value
  // is never treated as fresh source truth; current type-safe rules decide again.
  const after = canonicalizeListingLocations(before, { preferSourceAudit: true });
  const patch = {};
  const changed = {};

  for (const key of LOCATION_DATA_KEYS) {
    if (!Object.hasOwn(after, key)) continue;
    if (equal(before[key], after[key])) continue;
    patch[key] = after[key];
    changed[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }

  const columns = {
    city: after.city ?? null,
    district: after.district ?? null,
    area: after.area ?? after.kvartal ?? null,
    metro: after.metro ?? null,
    residence_complex: after.residenceComplex ?? null,
  };
  const columnBefore = {
    city: row.city ?? null,
    district: row.district ?? null,
    area: row.area ?? null,
    metro: row.metro ?? null,
    residence_complex: row.residence_complex ?? null,
  };

  for (const [key, value] of Object.entries(columns)) {
    if (!equal(columnBefore[key], value)) {
      changed[`column:${key}`] = { from: columnBefore[key], to: value };
    }
  }

  if (!Object.keys(changed).length) return null;
  return {
    dbId: String(row.db_id),
    patch,
    columns,
    changed,
  };
}

async function fetchBatch(afterId, limit, country) {
  const result = await pool.query(
    `
      SELECT
        id AS db_id,
        source,
        country,
        source_id,
        city,
        district,
        area,
        metro,
        address,
        residence_complex,
        data
      FROM listings
      WHERE active = TRUE
        AND id > $1::bigint
        AND ($3::text IS NULL OR country = $3)
      ORDER BY id ASC
      LIMIT $2
    `,
    [String(afterId || 0), limit, country],
  );
  return result.rows;
}

async function applyChanges(changes) {
  if (!changes.length) return 0;
  const payload = changes.map((change) => ({
    db_id: change.dbId,
    city: change.columns.city,
    district: change.columns.district,
    area: change.columns.area,
    metro: change.columns.metro,
    residence_complex: change.columns.residence_complex,
    patch: change.patch,
  }));

  const result = await pool.query(
    `
      UPDATE listings AS listing
      SET
        city = input.city,
        district = input.district,
        area = input.area,
        metro = input.metro,
        residence_complex = input.residence_complex,
        data = listing.data || input.patch,
        updated_at = NOW()
      FROM jsonb_to_recordset($1::jsonb) AS input (
        db_id bigint,
        city text,
        district text,
        area text,
        metro text,
        residence_complex text,
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

  let afterId = 0;
  let scanned = 0;
  let refinable = 0;
  let applied = 0;
  let previewed = 0;

  console.log(`[location-canonical-backfill] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} country=${args.country || 'ALL'} batch=${args.batchSize}`);

  for (;;) {
    const batch = await fetchBatch(afterId, args.batchSize, args.country);
    if (!batch.length) break;
    afterId = Number(batch[batch.length - 1].db_id);
    scanned += batch.length;

    const changes = [];
    for (const row of batch) {
      const change = buildChange(row);
      if (!change) continue;
      refinable += 1;
      changes.push(change);

      if (previewed < args.preview) {
        previewed += 1;
        console.log(JSON.stringify({
          dbId: String(row.db_id),
          source: row.source,
          sourceId: row.source_id,
          country: row.country,
          changed: change.changed,
        }));
      }
    }

    if (args.apply && changes.length) applied += await applyChanges(changes);
  }

  console.log(`[location-canonical-backfill] scanned=${scanned} refinable=${refinable} applied=${applied}`);
  if (!args.apply && refinable) {
    console.log('[location-canonical-backfill] dry-run only; rerun with --apply to persist canonical geography.');
  }
}

main()
  .finally(async () => {
    await closeDb();
  })
  .catch((error) => {
    console.error('[location-canonical-backfill] failed:', error);
    process.exitCode = 1;
  });
