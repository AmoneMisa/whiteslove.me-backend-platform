import { pool } from './infrastructure/database/pool.js';
import { importLegacyRegistry } from './registry/registry-importer.js';
import { createPublicSheetsReader, createSheetsReader, loadServiceAccount, readRegistryTabs } from './registry/sheets-reader.js';

// Seeds the legacy realtor registry (Google Sheet) into platform.registry_*. Dry-run by default: it plans and prints
// counts without writing. The sheet id comes from REGISTRY_GOOGLE_SHEET_ID; with REGISTRY_GOOGLE_SERVICE_ACCOUNT_FILE
// it reads through the service account, otherwise the workbook must be shared by link. Only counts are printed: the
// registry holds personal data.

const apply = process.argv.includes('--apply');

async function main() {
  const sheetId = process.env.REGISTRY_GOOGLE_SHEET_ID;
  const keyFile = process.env.REGISTRY_GOOGLE_SERVICE_ACCOUNT_FILE;
  const reader = keyFile
    ? createSheetsReader({ sheetId, serviceAccount: await loadServiceAccount(keyFile) })
    : createPublicSheetsReader({ sheetId });
  const tabs = await readRegistryTabs(reader);
  console.log('rows read per tab:', JSON.stringify(Object.fromEntries(Object.entries(tabs).map(([key, rows]) => [key, rows.length]))));
  const result = await importLegacyRegistry(tabs, { dryRun: !apply });
  // Counts only: the conflict lists name phones and people.
  const conflicts = Object.fromEntries(Object.entries(result.report.conflicts ?? {}).map(([key, list]) => [key, Array.isArray(list) ? list.length : list]));
  console.log(JSON.stringify({ dryRun: result.dryRun, counts: result.report.counts, conflicts, derivedReviewCases: result.report.derivedReviewCases, written: result.written }, null, 2));
  if (!apply) console.log('dry-run: nothing was written; rerun with --apply to import');
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
