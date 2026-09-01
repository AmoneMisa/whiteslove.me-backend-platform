import { closeDatabase, ensureSchema } from './db.mjs';

try {
  await ensureSchema();
  console.log('[subscription-bot:migrate] schema is ready');
} finally {
  await closeDatabase();
}
