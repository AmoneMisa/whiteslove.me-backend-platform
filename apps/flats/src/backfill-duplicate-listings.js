import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { closeElasticsearch, deleteListingDocuments, initElasticsearch } from './infrastructure/search/elasticsearch.js';
import { runDuplicateBackfillBatch } from './maintenance/duplicate-backfill.js';

// Deactivates active custom-source rows that duplicate a newer row with the same
// detail URL and text (see maintenance/duplicate-backfill.js) and removes them
// from Elasticsearch. Dry-run by default. A deactivated row is only flagged
// inactive (availability_reason = duplicate_of_newer_row), never deleted.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 2000, country: null, preview: 12, pauseMs: 200 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(5000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 2000));
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--preview=')) args.preview = Math.min(500, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-duplicate-listings.js [--country=KG] [--batch-size=2000] [--preview=12] [--pause-ms=200] [--apply]\n\nDry-run is the default and reports the first batch only; --apply repeats until none are left.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertDatabaseReady();
  if (args.apply) await initElasticsearch();
  let total = 0;
  let deactivated = 0;
  let previewed = 0;
  for (;;) {
    const batch = await runDuplicateBackfillBatch(pool, { ...args, removeFromIndex: deleteListingDocuments });
    total += batch.found;
    deactivated += batch.deactivated;
    for (const row of batch.duplicates) {
      if (previewed >= args.preview) break;
      console.log(`  #${row.id} ${row.country} ${row.url.slice(0, 90)} | ${row.title}`);
      previewed += 1;
    }
    if (!args.apply || !batch.found || batch.deactivated === 0) break;
    if (args.pauseMs) await sleep(args.pauseMs);
  }
  console.log(`duplicates: found=${total}${args.apply ? ` deactivated=${deactivated}` : ' in the first batch (dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`duplicate backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeElasticsearch().catch(() => {});
  await closeDb();
}
