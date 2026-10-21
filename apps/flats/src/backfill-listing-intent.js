import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { runIntentBackfillBatch } from './maintenance/intent-backfill.js';

// Re-reads stored listings with the current lexicon and marks "looking for a
// flat" posts (propertyWanted) that were ingested as offers before the lexicon
// learned third-person/plural phrasing ("шукає", "знімемо", "ищем"). Search and
// the public feed already exclude propertyWanted. Dry-run by default; the old
// kind stays in data.listingKindRepair. After --apply run
// `npm run reindex:listings` so Elasticsearch drops them too.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 500, country: null, includeInactive: false, preview: 30, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--include-inactive') args.includeInactive = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(2000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 500));
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--preview=')) args.preview = Math.min(1000, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-listing-intent.js [--country=UA] [--batch-size=500] [--include-inactive] [--preview=30] [--pause-ms=100] [--apply]\n\nDry-run is the default. Each applied batch fires the feed and property-cluster triggers, so batches are small and paused.');
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
  let afterId = '0';
  let scanned = 0;
  let changed = 0;
  let updated = 0;
  let previewed = 0;
  const bySource = new Map();
  for (;;) {
    const batch = await runIntentBackfillBatch(pool, { ...args, afterId });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    changed += batch.changes.length;
    updated += batch.updated;
    for (const change of batch.changes) {
      bySource.set(change.source, (bySource.get(change.source) ?? 0) + 1);
      if (previewed >= args.preview) continue;
      console.log(`  ${change.source}/#${change.id} ${change.from} -> propertyWanted | ${change.title}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${source}`);
  console.log(`intent: scanned=${scanned} to_change=${changed} ${args.apply ? `updated=${updated}` : '(dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`intent backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
