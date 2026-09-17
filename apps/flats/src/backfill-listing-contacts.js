import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { runContactBackfillBatch } from './maintenance/contact-backfill.js';

// Rewrites stored listing contacts into one form per contact: phones as E.164
// using the listing's country, Telegram as lower-case @username. Dry-run by
// default; prints counts and a few examples (country and length only for
// phones would hide the change, so examples are masked).

function parseArgs(argv) {
  const args = { apply: false, batchSize: 500, country: null, includeInactive: false, preview: 10, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--include-inactive') args.includeInactive = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(2000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 500));
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--preview=')) args.preview = Math.min(100, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-listing-contacts.js [--country=UZ] [--batch-size=500] [--include-inactive] [--preview=10] [--pause-ms=100] [--apply]\n\nDry-run is the default. Each applied batch recomputes dedupe keys and fires the feed and property-cluster triggers, so batches are small and paused.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Keeps the shape of a contact visible without printing the number. */
function mask(value) {
  return String(value).replace(/\d(?=\d{2})/gu, '•');
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
  for (;;) {
    const batch = await runContactBackfillBatch(pool, { ...args, afterId });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    changed += batch.changes.length;
    updated += batch.updated;
    for (const change of batch.changes) {
      if (previewed >= args.preview) break;
      console.log(`  listing ${change.id}: ${mask(change.from)} -> ${mask(change.to)}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  console.log(`contacts: scanned=${scanned} to_change=${changed} ${args.apply ? `updated=${updated}` : '(dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`contact backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
