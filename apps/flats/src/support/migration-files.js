import {readdir} from 'node:fs/promises';

export const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
export const migrationsDir = new URL('../migrations/', import.meta.url);

export async function listMigrationFiles() {
  return (await readdir(migrationsDir))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
}
