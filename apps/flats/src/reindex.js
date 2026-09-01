import {closeDb} from './db.js';
import {assertDatabaseReady} from './db-ready.js';
import {
  closeElasticsearch,
  rebuildSearchIndex,
} from './elasticsearch.js';

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
