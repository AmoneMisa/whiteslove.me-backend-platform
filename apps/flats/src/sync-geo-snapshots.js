import {closeDb} from './infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from './infrastructure/database/schemaReady.js';
import {syncGeoCitySnapshots} from './geo/geo-city-snapshot-sync.js';

async function main() {
  await assertDatabaseReady();
  const result = await syncGeoCitySnapshots();
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
