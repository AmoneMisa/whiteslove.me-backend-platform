import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import {
  closeElasticsearch,
  initElasticsearch,
} from './infrastructure/search/elasticsearch.js';
import { client, SEARCH_INDEX } from './infrastructure/search/elasticsearch/client.js';
import { indexDbRows } from './infrastructure/search/elasticsearch/documents.js';
import { describeBackfillIds, parseBackfillIds } from './maintenance/backfill-id-scope.js';

function parseArgs(argv) {
  let ids = null;
  for (const arg of argv) {
    if (arg.startsWith('--ids=')) ids = parseBackfillIds(arg.slice(6));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/reindex-listings.js --ids=123,456\n\nUpdates only the existing Elasticsearch documents for the selected active PostgreSQL listing IDs. It never deletes or rebuilds the search index.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!ids?.length) throw new Error('--ids is required for targeted reindex');
  return { ids };
}

async function fetchRows(ids) {
  const result = await pool.query(
    `
      SELECT
        id AS db_id,
        source,
        country,
        source_id,
        data,
        first_seen_at,
        last_seen_at,
        updated_at
      FROM listings
      WHERE active = TRUE
        AND id = ANY($1::bigint[])
      ORDER BY id ASC
    `,
    [ids],
  );
  return result.rows;
}

function assertExactScope(rows, ids) {
  const found = new Set(rows.map((row) => String(row.db_id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new Error(`Targeted reindex refused: active PostgreSQL rows not found for IDs ${missing.join(',')}`);
  }
}

async function main() {
  const { ids } = parseArgs(process.argv.slice(2));
  console.log(`[targeted-reindex] ids=${describeBackfillIds(ids)}`);

  await assertDatabaseReady();
  const rows = await fetchRows(ids);
  assertExactScope(rows, ids);

  await initElasticsearch();
  const indexed = await indexDbRows(rows);
  await client.indices.refresh({ index: SEARCH_INDEX });
  console.log(`[targeted-reindex] indexed=${indexed} refreshed=${SEARCH_INDEX}`);
}

main()
  .finally(async () => {
    await Promise.allSettled([
      closeElasticsearch(),
      closeDb(),
    ]);
  })
  .catch((error) => {
    console.error('[targeted-reindex] failed:', error);
    process.exitCode = 1;
  });
