import test from 'node:test';
import assert from 'node:assert/strict';
import { planIntentBackfill, runIntentBackfillBatch } from '../src/maintenance/intent-backfill.js';

const row = (id, title, description, kind = 'propertyOffer') => ({ id, source: 'telegram', title, description, listing_kind: kind });

test('seeker posts stored as offers are planned, offers and already-wanted rows are not', () => {
  const changes = planIntentBackfill([
    row(1, '', 'Сімʼя терміново шукає квартиру/дім в районі Вишеньки'),
    row(2, '', "Доброго дня! Сім'я шукає 1–2-кімнатну квартиру в довгострокову оренду"),
    row(3, '', 'Здається 2-х кімнатна квартира в центрі'),
    row(4, '', 'Здається квартира, власник шукає порядних орендарів'),
    row(5, '', 'Ищем квартиру на длительный срок', 'propertyWanted'),
    row(6, '', null),
  ]);
  assert.deepEqual(changes.map((change) => change.id), ['1', '2']);
  assert.equal(changes[0].from, 'propertyOffer');
});

test('apply flips only the planned rows and keeps the previous kind', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) return { rows: [row(7, '', 'Ищем квартиру на длительный срок'), row(8, '', 'Сдам квартиру')] };
      return { rowCount: params[0].length };
    },
  };
  const dry = await runIntentBackfillBatch(client, {});
  assert.equal(dry.updated, 0);
  assert.equal(calls.length, 1);
  const applied = await runIntentBackfillBatch(client, { apply: true });
  assert.equal(applied.updated, 1);
  const update = calls.at(-1);
  assert.match(update.sql, /'listingKindRepair'/u);
  assert.deepEqual(update.params[0], ['7']);
  assert.equal(applied.nextAfterId, '8');
});
