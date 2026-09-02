import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {listMigrationFiles} from './support/migration-files.js';

const { Pool } = pg;
const MIGRATION_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.MIGRATION_MAX_ATTEMPTS || '4', 10) || 4,
);
const MIGRATION_RETRY_BASE_MS = Math.max(
  100,
  Number.parseInt(process.env.MIGRATION_RETRY_BASE_MS || '1000', 10) || 1000,
);

const pool = new Pool({
  host: process.env.PGHOST || 'flat-finder-postgres',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.POSTGRES_DB || 'flatfinder',
  user: process.env.POSTGRES_USER || 'flatfinder',
  password: process.env.POSTGRES_PASSWORD,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyMigration(client, file, sql) {
  for (let attempt = 1; attempt <= MIGRATION_MAX_ATTEMPTS; attempt += 1) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
      return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      const retryableDeadlock = error?.code === '40P01' && attempt < MIGRATION_MAX_ATTEMPTS;
      if (!retryableDeadlock) throw error;

      const delayMs = MIGRATION_RETRY_BASE_MS * (2 ** (attempt - 1));
      console.warn(
        `[migrate] deadlock while applying ${file}; ` +
        `retrying ${attempt + 1}/${MIGRATION_MAX_ATTEMPTS} in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('flat_finder_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((row) => row.version));
    const files = await listMigrationFiles();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      await applyMigration(client, file, sql);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('flat_finder_migrations'))").catch(() => {});
    client.release();
  }
}

runMigrations()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('[migrate] failed:', error?.stack || error?.message || error);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
