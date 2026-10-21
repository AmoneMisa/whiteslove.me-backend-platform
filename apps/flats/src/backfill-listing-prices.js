import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { getRates } from './support/fx.js';
import { runPriceBackfillBatch } from './maintenance/price-backfill.js';

// Repairs stored prices that cannot be real: a number that is plausible only in
// the country's own currency but is labelled USD/EUR gets the right currency;
// a number that is no price at all (phone digits, 0) is cleared. Rent-labelled
// listings priced like a sale are only listed. Dry-run by default; the original
// price and currency of every change stay in data.priceRepair. After --apply run
// `npm run reindex:listings` so Elasticsearch picks the new values up.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 500, country: null, includeInactive: false, preview: 40, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--include-inactive') args.includeInactive = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(2000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 500));
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--preview=')) args.preview = Math.min(1000, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-listing-prices.js [--country=UZ] [--batch-size=500] [--include-inactive] [--preview=40] [--pause-ms=100] [--apply]\n\nDry-run is the default. Each applied batch fires the feed and property-cluster triggers, so batches are small and paused.');
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
  const { rates } = await getRates();
  let afterId = '0';
  let scanned = 0;
  let updated = 0;
  let previewed = 0;
  const counts = new Map();
  for (;;) {
    const batch = await runPriceBackfillBatch(pool, { ...args, afterId, rates });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    updated += batch.updated;
    for (const change of batch.changes) {
      const bucket = `${change.action}/${change.reason}/${change.source}`;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      if (previewed >= args.preview) continue;
      const target = change.action === 'currency' ? ` -> ${change.toCurrency}`
        : change.action === 'reparse' ? ` -> ${change.newPrice} ${change.toCurrency}`
          : change.action === 'clear' ? ' -> NULL' : '';
      console.log(`  ${change.action} ${change.source}/${change.country} #${change.id} ${change.dealType ?? '-'} ${change.price} ${change.currency}${target} | ${change.title}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  for (const [bucket, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${bucket}`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  console.log(`prices: scanned=${scanned} flagged=${total} ${args.apply ? `updated=${updated}` : '(dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`price backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
