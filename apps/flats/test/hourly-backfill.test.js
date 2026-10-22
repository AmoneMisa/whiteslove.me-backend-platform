import test from 'node:test';
import assert from 'node:assert/strict';
import { planHourlyBackfill, runHourlyBackfillBatch } from '../src/maintenance/hourly-backfill.js';

const row = (id, price, description, deal = 'roomRent') => ({ id, source: 'custom', deal_type: deal, price, currency: 'KGS', title: '1-комнатная квартира', description });

test('hourly-priced rows are planned, daily and monthly rows are not', () => {
  const changes = planHourlyBackfill([
    row(1, 4_000, '1 \\ 13 4 000 ⃀ / час Аренда Квартира 1 комн.'),
    row(2, 2_300, '2 300 сом / сутки 1-комн. квартира'),
    row(3, 65_000, '65 000 ⃀ / мес Аренда Квартира 2 комн.', 'longRent'),
    row(4, null, '3 500 ⃀ / час'),
  ]);
  assert.deepEqual(changes.map((change) => change.id), ['1']);
});

test('apply moves the price to pricePerHour and keeps the old values for a reversal', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) return { rows: [row(7, 2_500, '1 \\ 1 2 500 ⃀ / час Аренда Квартира 2 комн.'), row(8, 2_300, '2 300 сом / сутки')] };
      return { rowCount: params[0].length };
    },
  };
  const dry = await runHourlyBackfillBatch(client, {});
  assert.equal(dry.updated, 0);
  assert.equal(calls.length, 1);
  const applied = await runHourlyBackfillBatch(client, { apply: true });
  assert.equal(applied.updated, 1);
  const update = calls.at(-1);
  assert.match(update.sql, /'pricePerHour', l\.price/u);
  assert.match(update.sql, /hourlyRepair/u);
  assert.deepEqual(update.params[0], ['7']);
  assert.equal(applied.nextAfterId, '8');
});
