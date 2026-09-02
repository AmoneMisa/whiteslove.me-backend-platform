import assert from 'node:assert/strict';
import test from 'node:test';

import { olxSegmentDealType } from '../src/geo/olx-segment.js';
import { telegramHousingChannels } from '../src/sources/telegram-housing-sources.js';

test('OLX dedicated daily-rent segment maps to shortRent', () => {
  assert.equal(olxSegmentDealType('flat:shortRent'), 'shortRent');
  assert.equal(olxSegmentDealType('flat:longRent'), 'longRent');
  assert.equal(olxSegmentDealType('flat:sale'), 'sale');
});

test('Tashkent Telegram coverage includes dedicated daily-rent channels', () => {
  const channels = telegramHousingChannels('UZ');
  for (const name of ['posutochnotashkent', 'kunlik_kvartira_toshkent_arenda']) {
    const channel = channels.find((item) => item.name === name);
    assert.ok(channel, `missing @${name}`);
    assert.equal(channel.city, 'Tashkent');
    assert.equal(channel.dealType, 'shortRent');
  }
});

test('Ukraine Telegram coverage includes dedicated daily-rent channels', () => {
  const channels = telegramHousingChannels('UA');
  for (const [name, city] of [
    ['kyiv_kvartira', 'Kyiv'],
    ['posutochnaya_arenda_odessa', 'Odesa'],
    ['OdessaDailyRentUar', 'Odesa'],
  ]) {
    const channel = channels.find((item) => item.name === name);
    assert.ok(channel, `missing @${name}`);
    assert.equal(channel.city, city);
    assert.equal(channel.dealType, 'shortRent');
  }
});
