import {closeDb} from './infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from './infrastructure/database/schemaReady.js';
import {
  closeElasticsearch,
  rebuildSearchIndex,
} from './infrastructure/search/elasticsearch.js';

async function main() {
  try {
    await assertDatabaseReady();

    const result = await rebuildSearchIndex();
    console.log('[reindex] done:', result);
  } finally {
    await Promise.allSettled([
      closeElasticsearch(),
      closeDb(),
    ]);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('[reindex] failed:', err);
    process.exit(1);
  });
