import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { closeElasticsearch, deleteListingDocuments, initElasticsearch } from './infrastructure/search/elasticsearch.js';
import { runChromeBackfillBatch } from './maintenance/chrome-backfill.js';

// Repairs stored cards that swallowed page chrome (pagination, menus, footer, modal
// copy): cuts the text at the first marker, fixes a menu-heading title and re-reads
// the price from the cleaned text. A row that is only page chrome is deactivated.
// Dry-run by default; the old title/price/currency stay in data.chromeRepair. After
// --apply run `npm run reindex:listings -- --ids=...` with the printed ids.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 200, preview: 25, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(1000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 200));
    else if (arg.startsWith('--preview=')) args.preview = Math.min(500, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-page-chrome.js [--batch-size=200] [--preview=25] [--pause-ms=100] [--apply]\n\nDry-run is the default.');
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
  let updated = 0;
  let deactivated = 0;
  let previewed = 0;
  const changedIds = [];
  const counts = new Map();
  for (;;) {
    const batch = await runChromeBackfillBatch(pool, { ...args, afterId, removeFromIndex: deleteListingDocuments });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    found += batch.changes.length;
    updated += batch.updated;
    deactivated += batch.deactivated;
    for (const change of batch.changes) {
      const bucket = `${change.action}/${change.source}`;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      if (change.action === 'clean') changedIds.push(change.id);
      if (previewed >= args.preview) continue;
      const price = change.action === 'clean' ? ` ${change.oldPrice} ${change.oldCurrency} -> ${change.price} ${change.currency} | "${String(change.oldTitle).slice(0, 30)}" -> "${String(change.title).slice(0, 40)}"` : '';
      console.log(`  ${change.action} ${change.source}/#${change.id}${price}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  for (const [bucket, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${bucket}`);
  if (args.apply && changedIds.length) console.log(`ids=${changedIds.join(',')}`);
  console.log(`page-chrome: scanned=${scanned} found=${found}${args.apply ? ` updated=${updated} deactivated=${deactivated}` : ' (dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`page-chrome backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeElasticsearch().catch(() => {});
  await closeDb();
}
