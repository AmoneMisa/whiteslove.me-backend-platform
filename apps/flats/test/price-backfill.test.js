import test from 'node:test';
import assert from 'node:assert/strict';
import { planPriceRepair, runPriceBackfillBatch } from '../src/maintenance/price-backfill.js';

const rates = { USD: 1, EUR: 0.92, UAH: 41.5, KZT: 470, UZS: 12600, KGS: 87.5, RON: 4.57 };
const plan = (row) => planPriceRepair({ deal_type: 'longRent', room_only: null, ...row }, rates);

test('a plausible price is left alone', () => {
  assert.equal(plan({ country: 'UZ', price: 650, currency: 'USD' }), null);
  assert.equal(plan({ country: 'UZ', price: 6_000_000, currency: 'UZS' }), null);
  assert.equal(plan({ country: 'UZ', deal_type: 'sale', price: 70_000, currency: 'USD' }), null);
});

test('a local-currency amount labelled USD or EUR gets the local currency', () => {
  assert.deepEqual(plan({ country: 'UZ', price: 4_000_000, currency: 'EUR' }), { action: 'currency', reason: 'currency-label-is-local', currency: 'UZS', key: 'longRent' });
  assert.equal(plan({ country: 'UZ', price: 2_500_000, currency: 'USD' }).currency, 'UZS');
});

test('phone digits, zero and unreadable numbers are cleared, not guessed', () => {
  assert.equal(plan({ country: 'KG', price: 996_999_007, currency: 'USD' }).action, 'clear');
  assert.equal(plan({ country: 'KZ', price: 0, currency: 'KZT' }).reason, 'non-positive-price');
  assert.equal(plan({ country: 'UZ', price: 15_173_284_800_000, currency: 'UZS' }).action, 'clear');
  assert.equal(plan({ country: 'KZ', price: 130_000, currency: 'EUR' }).currency, 'KZT');
});

test('a rent priced like a sale is reported but not changed', () => {
  assert.deepEqual(plan({ country: 'RO', price: 85_000, currency: 'EUR' }), { action: 'report', reason: 'rent-priced-like-sale', key: 'longRent' });
});

test('a hard-currency-looking amount under a local label is reported, not cleared', () => {
  assert.equal(plan({ country: 'UA', price: 150, currency: 'UAH' }).action, 'report');
  assert.equal(plan({ country: 'UA', price: 150, currency: 'UAH' }).reason, 'price-reads-as-hard-currency');
});

test('missing price, unknown currency or unknown rate are not judged', () => {
  assert.equal(plan({ country: 'UZ', price: null, currency: 'USD' }), null);
  assert.equal(plan({ country: 'UZ', price: 9e9, currency: 'XXX' }), null);
  assert.equal(plan({ country: 'UZ', price: 9e9, currency: null }), null);
});

test('apply rewrites only the planned rows and keeps the original in data.priceRepair', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) {
        return { rows: [
          { id: '1', country: 'UZ', source: 'telegram', deal_type: 'longRent', price: 4_000_000, currency: 'EUR', room_only: null, title: 'a' },
          { id: '2', country: 'UZ', source: 'olx', deal_type: 'longRent', price: 500, currency: 'USD', room_only: null, title: 'b' },
          { id: '3', country: 'RO', source: 'olx', deal_type: 'longRent', price: 85_000, currency: 'EUR', room_only: null, title: 'c' },
        ] };
      }
      return { rowCount: params[0].length };
    },
  };
  const dry = await runPriceBackfillBatch(client, { rates });
  assert.equal(dry.updated, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(dry.changes.map((change) => [change.id, change.action]), [['1', 'currency'], ['3', 'report']]);

  const applied = await runPriceBackfillBatch(client, { rates, apply: true });
  assert.equal(applied.updated, 1);
  const update = calls.at(-1);
  assert.match(update.sql, /'priceRepair'/u);
  assert.match(update.sql, /l\.data->'priceRepair' IS NULL/u);
  assert.deepEqual(update.params[0], ['1']);
  assert.equal(applied.nextAfterId, '3');
});
