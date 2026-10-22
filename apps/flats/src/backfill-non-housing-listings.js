import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { closeElasticsearch, deleteListingDocuments, initElasticsearch } from './infrastructure/search/elasticsearch.js';
import { runNonHousingBackfillBatch } from './maintenance/non-housing-backfill.js';

// Deactivates stored social posts (Threads/Facebook/Telegram) that mention no
// housing at all and removes them from Elasticsearch. Dry-run by default; rows are
// flagged inactive (availability_reason = not_a_housing_post), never deleted.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 1000, preview: 20, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(5000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 1000));
    else if (arg.startsWith('--preview=')) args.preview = Math.min(500, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-non-housing-listings.js [--batch-size=1000] [--preview=20] [--pause-ms=100] [--apply]\n\nDry-run is the default.');
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
  let afterId = '0';
  let scanned = 0;
  let found = 0;
  let deactivated = 0;
  let previewed = 0;
  const bySource = new Map();
  for (;;) {
    const batch = await runNonHousingBackfillBatch(pool, { ...args, afterId, removeFromIndex: deleteListingDocuments });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    found += batch.changes.length;
    deactivated += batch.deactivated;
    for (const change of batch.changes) {
      bySource.set(change.source, (bySource.get(change.source) ?? 0) + 1);
      if (previewed >= args.preview) continue;
      console.log(`  ${change.source}/#${change.id} | ${change.title}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${source}`);
  console.log(`non-housing: scanned=${scanned} found=${found}${args.apply ? ` deactivated=${deactivated}` : ' (dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`non-housing backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeElasticsearch().catch(() => {});
  await closeDb();
}
