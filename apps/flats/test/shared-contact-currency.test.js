import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePhoneNumbers, findTelegramContacts } from '@whiteslove/parsing-lexicon/contact';
import { countryCurrency, countryPhoneHint } from '@whiteslove/parsing-lexicon/country-context';
import { moneyCurrencyFromText } from '@whiteslove/parsing-lexicon/currency';
import { parseHousingPrice as parsePriceFromText } from '@whiteslove/parsing-lexicon/housing-money';

test('backend consumes shared country-aware contact parsing', () => {
  assert.equal(countryCurrency('Украина'), 'UAH');
  assert.equal(countryPhoneHint('Uzbekistan'), 'UZ');
  assert.equal(parsePhoneNumbers('095 082 01 03', { countryHint: 'UA' })[0]?.number, '+380950820103');
  assert.equal(findTelegramContacts('Контакт: t.me/maria_jobs')[0]?.handle, '@maria_jobs');
});

test('backend consumes expanded shared currency parsing through housing parser', () => {
  assert.equal(moneyCurrencyFromText('Rent 1200 CAD', 'USD'), 'CAD');
  assert.deepEqual(parsePriceFromText('Аренда 950 CHF в месяц', 'EUR'), {
    amount: 950,
    currency: 'CHF',
    approximate: false,
  });
});
