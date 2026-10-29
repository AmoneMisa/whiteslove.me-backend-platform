import test from 'node:test';
import assert from 'node:assert/strict';

const { loadStoredListingLinesWithRegistry } = await import('../src/infrastructure/database/listingLineRepository.js');
const { loadRegistrySignals, refreshListingRegistrySignals } = await import('../src/infrastructure/database/listingRegistrySignalRepository.js');

const clientFor = (rowsByTable) => ({
  query: async (sql) => ({ rows: rowsByTable.find(([needle]) => sql.includes(needle))?.[1] ?? [] }),
});

test('registry signals: ids are cleaned, one lookup, id -> signal', async () => {
  const client = clientFor([['listing_registry_signals', [{ listing_id: '7', category: 'hidden_agent', sources: ['https://olx.uz/a'] }]]]);
  assert.deepEqual([...(await loadRegistrySignals([7, 7, 'x', -1], client))], [[7, { category: 'hidden_agent', sources: ['https://olx.uz/a'] }]]);
  assert.equal((await loadRegistrySignals([], client)).size, 0);
});

test('lines and registry signals merge per listing; a signal alone makes an entry without a line', async () => {
  const client = clientFor([
    ['listing_lines', [{ listing_id: '1', line: 'steady', other_properties: 0 }]],
    ['listing_registry_signals', [{ listing_id: '1', category: 'trusted', sources: [] }, { listing_id: '2', category: 'flagged', sources: ['https://x.example/p'] }]],
  ]);
  const merged = await loadStoredListingLinesWithRegistry([1, 2], client);
  assert.deepEqual(merged.get(1), { line: 'steady', otherProperties: 0, registrySignal: 'trusted', registrySources: [] });
  assert.deepEqual(merged.get(2), { line: null, otherProperties: 0, registrySignal: 'flagged', registrySources: ['https://x.example/p'] });
});

test('a failed signal lookup never hides the lines', async () => {
  const client = { query: async (sql) => { if (sql.includes('listing_registry_signals')) throw new Error('down'); return { rows: [{ listing_id: '1', line: 'steady', other_properties: 0 }] }; } };
  assert.equal((await loadStoredListingLinesWithRegistry([1], client)).get(1).line, 'steady');
});

test('the refresh excludes ambiguous contacts and restricted subjects in SQL, and reports counts', async () => {
  let sql = '';
  const client = { query: async (text) => { sql = text; return { rows: [{ upserted: 3, removed: 1 }] }; } };
  const result = await refreshListingRegistrySignals({ client });
  assert.equal(result.upserted, 3);
  assert.match(sql, /hidden realtor/);
  assert.match(sql, /HAVING bool_or\(c\.kind IN \('risk', 'both'\)\) <> bool_or\(c\.kind IN \('trusted', 'both'\)\)/);
  assert.match(sql, /processing_restricted_at IS NOT NULL/);
  assert.match(sql, /processing_objection_at IS NOT NULL/);
});
