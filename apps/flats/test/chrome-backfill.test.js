import test from 'node:test';
import assert from 'node:assert/strict';
import { planChromeRepair, runChromeBackfillBatch } from '../src/maintenance/chrome-backfill.js';

const FOOTER = 'Показать следующие 30 объектов 1 ... 13 14 Типы недвижимости в Ташкенте пентхаусы © 2023 - 2026 Realting.uz Суперлайк! списывается 50 риэлтингов (5 EUR) Оплатить 50000 UZS';
const stored = {
  id: '10262310', source: 'custom', country: 'UZ', source_id: 'owner-x', title: 'Типы недвижимости в Ташкенте', price: 50_000, currency: 'EUR',
  description: `Квартира 2 комнаты Ташкент, Узбекистан 2 51 м² 1/4 Кора камиш Навастройка евро ремон хама кулайликлари бор $273 в месяц Рекомендовать Показать контакты ${FOOTER}`,
};

test('a card that swallowed the page footer gets its text cut, its title fixed and its price re-read', () => {
  const plan = planChromeRepair(stored);
  assert.equal(plan.action, 'clean');
  assert.equal(plan.price, 273);
  assert.equal(plan.currency, 'USD');
  assert.equal(/Суперлайк|50000|Типы недвижимости/u.test(plan.description), false);
  assert.match(plan.title, /^Квартира 2 комнаты/u);
});

test('a row that is only page chrome is deactivated, a clean row is left alone', () => {
  assert.equal(planChromeRepair({ ...stored, description: FOOTER }).action, 'deactivate');
  assert.equal(planChromeRepair({ ...stored, description: 'Сдам 2-комнатную квартиру $500' }), null);
});

test('apply writes the cleaned row and keeps the old values in data.chromeRepair', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/u.test(sql)) return { rows: [stored] };
      return { rowCount: 1, rows: [] };
    },
  };
  const dry = await runChromeBackfillBatch(client, {});
  assert.equal(dry.changes.length, 1);
  assert.equal(calls.length, 1);
  const applied = await runChromeBackfillBatch(client, { apply: true });
  assert.equal(applied.updated, 1);
  assert.match(calls.at(-1).sql, /chromeRepair/u);
  assert.equal(calls.at(-1).params[3], 273);
});
