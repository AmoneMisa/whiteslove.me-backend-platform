import test from 'node:test';
import assert from 'node:assert/strict';
import { makeListing } from '../src/listing/normalize.js';
import { isHourlyPriced } from '../src/support/hourly-price.js';

test('only a number followed by "/ час", "за час" or "per hour" is an hourly price', () => {
  for (const text of ['4 000 ⃀ / час Аренда Квартира 2 комн.', 'Цена 2500 сом за час', '20 USD per hour']) assert.equal(isHourlyPriced(text), true, text);
  // The hourly figure must be the listing's own price; a card index glued in front is tolerated.
  assert.equal(isHourlyPriced('1 \\ 1 2 500 ⃀ / час Аренда', 2_500), true);
  assert.equal(isHourlyPriced('Посуточно 999 грн. Почасовая оплата составляет: 350 грн/час', 999), false);
  assert.equal(isHourlyPriced('Посуточно 999 грн. Почасовая оплата составляет: 350 грн/час', 350), true);
  for (const text of ['2 300 сом / сутки', 'Подобово/погодинно, 500 грн за добу', 'Метро 5 минут в час пик', 'Цена 300$ в месяц']) assert.equal(isHourlyPriced(text), false, text);
});

test('an hourly card stays a short stay, keeps the hourly figure and has no night/month price', () => {
  const card = { country: 'KG', source: 'custom', title: '2-комнатная квартира', description: '1 \ 1 2 500 ⃀ / час Аренда Квартира 2 комн. 60 м² 1/9 этаж Бишкек, 7 микрорайон', price: 2_500, currency: 'KGS', dealType: 'longRent' };
  const listing = makeListing(card);
  assert.equal(listing.dealType, 'shortRent');
  assert.equal(listing.price, null);
  assert.equal(listing.pricePerHour, 2_500);
  assert.equal(listing.priceUnit, 'hour');
  assert.equal(listing.roomOnly, false);
  // The same price per month stays a normal long rent.
  const monthly = makeListing({ ...card, description: '2 500 ⃀ / мес Аренда Квартира 2 комн. 60 м² 1/9 этаж Бишкек' });
  assert.equal(monthly.price, 2_500);
  assert.notEqual(monthly.priceUnit, 'hour');
});
