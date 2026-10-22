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
  assert.deepEqual(plan({ country: 'RO', price: 35_000, currency: 'EUR' }), { action: 'report', reason: 'rent-priced-like-sale', key: 'longRent' });
});

test('a Ukrainian hryvnia label on a dollar-sized price is relabelled to USD', () => {
  assert.deepEqual(plan({ country: 'UA', price: 150, currency: 'UAH' }), { action: 'currency', reason: 'ua-uah-label-is-usd', currency: 'USD', key: 'longRent' });
  assert.equal(plan({ country: 'UA', deal_type: 'sale', price: 69_000, currency: 'UAH' }).currency, 'USD');
  // Real hryvnia rents and sales are left alone.
  assert.equal(plan({ country: 'UA', price: 14_000, currency: 'UAH' }), null);
  assert.equal(plan({ country: 'UA', deal_type: 'sale', price: 4_500_000, currency: 'UAH' }), null);
});

test('elsewhere a hard-currency-looking amount under a local label is only reported', () => {
  assert.equal(plan({ country: 'KZ', price: 150, currency: 'KZT' }).action, 'report');
  assert.equal(plan({ country: 'KZ', price: 150, currency: 'KZT' }).reason, 'price-reads-as-hard-currency');
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
          { id: '3', country: 'RO', source: 'olx', deal_type: 'longRent', price: 35_000, currency: 'EUR', room_only: null, title: 'c' },
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
  assert.match(update.sql, /\{priceRepair\}/u);
  assert.match(update.sql, /input\.action IN \('currency', 'reparse'\)/u);
  assert.deepEqual(update.params[0], ['1']);
  assert.equal(applied.nextAfterId, '3');
});

test('a flagged price is re-read from the stored text with the current parser', () => {
  const row = (text, price, currency, country) => ({ country, deal_type: 'sale', room_only: null, price, currency, text });
  // "у.о." was filed under the country default (UAH): the same text now reads 47 500 USD.
  const fixed = planPriceRepair(row('Продаж 1-км Ціна 47500 у.о. тел 050 123 45 67', 47_500, 'UAH', 'UA'), rates);
  assert.deepEqual([fixed.action, fixed.price, fixed.currency], ['reparse', 47_500, 'USD']);
  // Text that gives nothing better leaves the old decision in place.
  assert.equal(planPriceRepair(row('нема ціни', 99_699_999_000, 'KGS', 'KG'), rates).action, 'clear');
  // A plausible stored price is never re-read.
  assert.equal(planPriceRepair(row('Ціна 50000 у.о.', 70_000, 'USD', 'UA'), rates), null);
});

test('apply writes the re-read price and currency together', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) {
        return { rows: [{ id: '9', country: 'UA', source: 'custom', deal_type: 'sale', price: 475, currency: 'UAH', room_only: null, title: 'x', text: 'Продаж Ціна 47500 у.о.' }] };
      }
      return { rowCount: params[0].length };
    },
  };
  const result = await runPriceBackfillBatch(client, { rates, apply: true });
  assert.equal(result.updated, 1);
  const update = calls.at(-1);
  assert.deepEqual(update.params[1], ['reparse']);
  assert.deepEqual(update.params[2], ['USD']);
  assert.deepEqual(update.params[4], [475]);
  assert.deepEqual(update.params[5], [47_500]);
});

test('a monthly rent above 50 000 USD is a glued-digits error and is hidden, a luxury rent is left alone', () => {
  assert.deepEqual(plan({ country: 'KG', price: 996_708_772, currency: 'KGS' }), { action: 'clear', reason: 'impossible-rent-price', key: 'longRent' });
  assert.equal(plan({ country: 'UA', price: 1_716_500, currency: 'EUR' }).reason, 'impossible-rent-price');
  assert.equal(plan({ country: 'UA', price: 181_000, currency: 'UAH' }), null);
  // 8 000 USD a month is an expensive but real penthouse rent: untouched. 35 000 EUR is reported only.
  assert.equal(plan({ country: 'UA', price: 8_000, currency: 'USD' }), null);
  assert.equal(plan({ country: 'RO', price: 35_000, currency: 'EUR' }).action, 'report');
});
