import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoomOnlyBackfill, runRoomOnlyBackfillBatch } from '../src/maintenance/room-only-backfill.js';

const row = (id, price, currency, description = 'Сдаётся квартира') => ({ id, source: 'telegram', country: 'UZ', property_type: 'flat', price, currency, title: 'Квартира', description });

test('beds and shares are planned, ordinary flats are not', () => {
  const changes = planRoomOnlyBackfill([
    row(1, 800_000, 'UZS'),
    row(2, 650, 'USD'),
    row(3, 175, 'USD', 'SROCHNO! Jami 6 ta qiz yashaydi 1 xonada 2 tadan qiz turadi 175$ dan'),
    row(4, 450_000, 'UZS', 'Arenda hovli 80 tagacha odam qabul qilamiz'),
  ]);
  assert.deepEqual(changes.map((change) => [change.id, change.reason]), [
    ['1', 'price-below-flat-rent-floor'],
    ['3', 'room-share-text'],
    ['4', 'room-share-text'],
  ]);
});

test('apply sets roomOnly and keeps the previous deal type', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) return { rows: [row(7, 800_000, 'UZS'), row(8, 650, 'USD')] };
      return { rowCount: params[0].length };
    },
  };
  const dry = await runRoomOnlyBackfillBatch(client, {});
  assert.equal(dry.updated, 0);
  assert.equal(calls.length, 1);
  const applied = await runRoomOnlyBackfillBatch(client, { apply: true });
  assert.equal(applied.updated, 1);
  const update = calls.at(-1);
  assert.match(update.sql, /'roomOnlyRepair'/u);
  assert.deepEqual(update.params[0], ['7']);
  assert.equal(applied.nextAfterId, '8');
});

test('the stored audience and per-person wording are honoured, and the reason says which rule fired', () => {
  const stored = { id: 11, source: 'custom', country: 'UZ', property_type: 'flat', price: 1_500_000, currency: 'UZS', title: 'Аренда', description: 'Аренда ишловчи студентов 4-комн 95 м2', audience: 'men' };
  const perPerson = { id: 12, source: 'olx', country: 'UZ', property_type: 'flat', price: 1_504_350, currency: 'UZS', title: 'Kvartira', description: 'narxi 125 dollardan odam boshiga kvartira 2 xonali 1 ta xonada 2 kishi' };
  const family = { id: 13, source: 'olx', country: 'UZ', property_type: 'flat', price: 1_500_000, currency: 'UZS', title: 'Kvartira', description: 'Ijaraga 3 xonali kvartira oilaga', audience: 'family' };
  const changes = planRoomOnlyBackfill([stored, perPerson, family]);
  assert.deepEqual(changes.map((change) => [change.id, change.reason]), [
    ['11', 'audience-or-weak-phrase-with-low-price'],
    ['12', 'room-share-text'],
  ]);
});
