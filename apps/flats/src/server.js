import {COUNTRY_CODES} from './countries.js';
import {closeDb} from './db.js';
import {assertDatabaseReady} from './db-ready.js';
import {closeElasticsearch, initElasticsearch} from './elasticsearch.js';
import {createApp} from './app.js';
import {startMobileSubscriptionScanner, stopMobileSubscriptionScanner} from './mobile-subscriptions.js';

const PORT = process.env.PORT || 4000;

async function start() {
  await assertDatabaseReady();

  // Elasticsearch is an optional search layer. PostgreSQL remains available if
  // it cannot initialize.
  try {
    await initElasticsearch();
  } catch (err) {
    console.warn(
      '[elasticsearch] startup failed:',
      err?.message ?? String(err),
    );
  }

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`flat-finder backend listening on http://localhost:${PORT}`);
    console.log(`countries: ${COUNTRY_CODES.join(', ')}`);
    startMobileSubscriptionScanner();
  });

  async function shutdown(signal) {
    console.log(`[server] ${signal}, shutting down`);

    stopMobileSubscriptionScanner();
    server.close(async () => {
      try {
        await Promise.allSettled([
          closeElasticsearch(),
          closeDb(),
        ]);
      } finally {
        process.exit(0);
      }
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
