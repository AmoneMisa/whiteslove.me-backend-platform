import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {accountInstallationId, credentialsFromRequest} from '../src/mobile/mobile-saved-state.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const request = (headers) => ({get: (name) => headers[name.toLowerCase()]});

test('a client can never present the account state holder as its device', () => {
  const secret = 'ab'.repeat(32);
  const holder = accountInstallationId('0123456789abcdef01234567');
  assert.equal(holder, 'acct:0123456789abcdef01234567');
  assert.equal(credentialsFromRequest(request({'x-flat-finder-device-id': holder, 'x-flat-finder-device-secret': secret})), null);
  assert.deepEqual(
    credentialsFromRequest(request({'x-flat-finder-device-id': 'web-0123456789abcdef', 'x-flat-finder-device-secret': secret})),
    {deviceId: 'web-0123456789abcdef', secret},
  );
});

test('only the Google subject id is stored, and deleting an account unlinks devices', async () => {
  const migration = await read('migrations/059_user_accounts.sql');
  const table = /CREATE TABLE IF NOT EXISTS user_data\.accounts \(([\s\S]*?)\n\);/u.exec(migration)[1];
  assert.doesNotMatch(table, /email|name|picture|token/iu);
  assert.match(table, /google_sub VARCHAR\(255\) NOT NULL UNIQUE/u);
  assert.match(migration, /REFERENCES user_data\.accounts\(account_id\)\s+ON DELETE SET NULL/u);
});

test('linking merges an anonymous device in, never across accounts, and never overwrites', async () => {
  const source = await read('src/mobile/mobile-account.js');
  assert.match(source, /const merged = !installation\.accountId;/u);
  // Every copy is additive.
  const merge = source.slice(source.indexOf('export async function mergeSavedState'), source.indexOf('async function clearSavedState'));
  assert.equal((merge.match(/ON CONFLICT[^\n]*DO NOTHING/gu) || []).length, 3);
  assert.doesNotMatch(merge, /DO UPDATE/u);
  // Over the limits the whole link rolls back rather than dropping items.
  assert.match(source, /await assertImportCapacity\(client, accountOwner\);/u);
});

test('the saved-state API reads and writes the account once linked', async () => {
  const source = await read('src/mobile/mobile-saved-state.js');
  assert.match(source, /return accountId \? accountInstallationId\(accountId\) : deviceId;/u);
  assert.equal((source.match(/const deviceId = await ensureInstallation\(client, credentials\);/gu) || []).length, 3);
  assert.doesNotMatch(source, /const \{deviceId\} = credentials;/u);
  const app = await read('src/app.js');
  assert.match(app, /registerMobileAccountRoutes\(app\);/u);
});
