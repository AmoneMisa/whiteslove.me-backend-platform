import { assertDatabaseReady } from './infrastructure/database/schemaReady.js';
import { closeDb, pool } from './infrastructure/database/listingRepository.js';
import { runRoomOnlyBackfillBatch } from './maintenance/room-only-backfill.js';

// Moves long-rent listings that are really a room, a bed or a per-person share
// (by text, or by a price below what a whole flat costs) to room rental. Dry-run
// by default; the previous deal type stays in data.roomOnlyRepair. After --apply
// run `npm run reindex:listings -- --ids=...` for the changed ids.

function parseArgs(argv) {
  const args = { apply: false, batchSize: 500, country: null, preview: 30, pauseMs: 100 };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--batch-size=')) args.batchSize = Math.min(2000, Math.max(1, Number.parseInt(arg.slice(13), 10) || 500));
    else if (arg.startsWith('--country=')) args.country = arg.slice(10).trim().toUpperCase() || null;
    else if (arg.startsWith('--preview=')) args.preview = Math.min(1000, Math.max(0, Number.parseInt(arg.slice(10), 10) || 0));
    else if (arg.startsWith('--pause-ms=')) args.pauseMs = Math.max(0, Number.parseInt(arg.slice(11), 10) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage:\n  node src/backfill-listing-room-only.js [--country=UZ] [--batch-size=500] [--preview=30] [--pause-ms=100] [--apply]\n\nDry-run is the default. Each applied batch fires the room-rent canonicalization and feed triggers, so batches are small and paused.');
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
  const counts = new Map();
  const changedIds = [];
  for (;;) {
    const batch = await runRoomOnlyBackfillBatch(pool, { ...args, afterId });
    if (!batch.nextAfterId) break;
    scanned += batch.scanned;
    changed += batch.changes.length;
    updated += batch.updated;
    for (const change of batch.changes) {
      const bucket = `${change.reason}/${change.source}`;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      changedIds.push(change.id);
      if (previewed >= args.preview) continue;
      console.log(`  ${change.reason} ${change.source}/#${change.id} ${change.price ?? '-'} ${change.currency ?? ''} | ${change.title}`);
      previewed += 1;
    }
    afterId = batch.nextAfterId;
    if (args.apply && batch.changes.length && args.pauseMs) await sleep(args.pauseMs);
  }
  for (const [bucket, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${bucket}`);
  if (args.apply && changedIds.length) console.log(`ids=${changedIds.join(',')}`);
  console.log(`room-only: scanned=${scanned} to_change=${changed} ${args.apply ? `updated=${updated}` : '(dry run; add --apply)'}`);
}

try {
  await main();
} catch (error) {
  console.error(`room-only backfill failed: ${error?.code ?? error?.message ?? 'error'}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
