import test from 'node:test';
import assert from 'node:assert/strict';
import { planNonHousingBackfill, runNonHousingBackfillBatch } from '../src/maintenance/non-housing-backfill.js';
import { classifyHousingOffer } from '../src/scrapers/social.js';

const row = (id, title, description = '') => ({ id, source: 'threads', country: 'KZ', source_id: `t-${id}`, title, description });

test('posts with no housing signal are planned, housing posts are kept', () => {
  const changes = planNonHousingBackfill([
    row(1, 'Продам игровой ноутбук Acer Nitro 5', 'Intel Core i5 SSD 512 Экран 15,6'),
    row(2, 'iPhone Air', 'Аренда с последующим выкупом Полная оплата'),
    row(3, 'аренда дома Астана', 'Шикарный 6 комн дом Площадь 485 м2'),
    row(4, 'Сдам квартиру', 'на длительный срок 400$'),
  ]);
  assert.deepEqual(changes.map((change) => change.id), ['1', '2']);
});

test('dry run only reports; apply deactivates and removes from the index', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) return { rows: [row(5, 'Продам ноутбук Acer'), row(6, 'Сдам квартиру 500$')] };
      return { rowCount: 1, rows: [{ source: 'threads', country: 'KZ', source_id: 't-5' }] };
    },
  };
  const dry = await runNonHousingBackfillBatch(client, {});
  assert.equal(dry.deactivated, 0);
  assert.equal(calls.length, 1);
  const removed = [];
  const applied = await runNonHousingBackfillBatch(client, { apply: true, removeFromIndex: async (docs) => removed.push(...docs) });
  assert.equal(applied.deactivated, 1);
  assert.match(calls.at(-1).sql, /not_a_housing_post/u);
  assert.deepEqual(calls.at(-1).params[0], ['5']);
  assert.deepEqual(removed, [{ source: 'threads', country: 'KZ', id: 't-5' }]);
});

test('posts about phones and laptops are not housing offers even when they say "продам" or "аренда"', () => {
  assert.equal(classifyHousingOffer('Продам игровой ноутбук Acer Nitro 5 Intel Core i5 SSD 512 Экран 15,6'), null);
  assert.equal(classifyHousingOffer('iPhone Air 256GB Аренда с последующим выкупом Полная оплата'), null);
  assert.equal(classifyHousingOffer('Срочно продажа раскладушек! Разгрузка склада От 10.000-15.000 тенге'), null);
  assert.equal(classifyHousingOffer('Сдам 2-комнатную квартиру на длительный срок 400$'), 'longRent');
  assert.equal(classifyHousingOffer('Аренда студии 28 м2 в центре 500$'), 'longRent');
});
