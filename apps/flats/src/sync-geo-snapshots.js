import {closeDb} from './infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from './infrastructure/database/schemaReady.js';
import {syncGeoCitySnapshots} from './geo/geo-city-snapshot-sync.js';

const LOCK_WAIT_MS = Math.max(
  0,
  Number(process.env.GEO_SNAPSHOT_LOCK_WAIT_MS || 10 * 60_000),
);
const LOCK_POLL_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function strictSync() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waits = 0;

  for (;;) {
    const result = await syncGeoCitySnapshots({strict: true, verify: true});
    if (!result.skipped) return result;
    if (result.reason !== 'locked') {
      throw new Error(`geo snapshot prewarm skipped: ${result.reason || 'unknown reason'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`geo snapshot prewarm lock was not released within ${LOCK_WAIT_MS}ms`);
    }

    waits += 1;
    if (waits === 1 || waits % 5 === 0) {
      console.log(`[geo-snapshot] waiting for existing build lock waits=${waits}`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

async function main() {
  await assertDatabaseReady();
  const result = await strictSync();
  console.log(JSON.stringify(result));
}

main()
  .catch((error) => {
    console.error('[geo-snapshot] sync failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
  });
