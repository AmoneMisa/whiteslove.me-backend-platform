import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHousingOffer } from '../src/scrapers/social.js';
import { buildThreadsHousingCoverage, UKRAINE_OBLASTS } from '../src/social-search-coverage.js';

test('social housing covers all 24 Ukrainian oblasts without assigning an oblast centre as city', () => {
  assert.equal(UKRAINE_OBLASTS.length, 24);
  const coverage = buildThreadsHousingCoverage();
  for (const oblast of UKRAINE_OBLASTS) {
    const matches = coverage.filter((target) => target.country === 'UA' && target.region === oblast.region);
    assert.ok(matches.length >= 4, `${oblast.ua} should cover rent, short rent and dwelling types`);
    assert.ok(matches.every((target) => !target.city), `${oblast.ua} must remain oblast-wide`);
    assert.ok(
      matches.some((target) => /подобово|погодинно|подобова оренда/i.test(target.target)),
      `${oblast.ua} should include short-rent discovery`,
    );
  }
});

test('housing coverage includes expanded rent and short-rent searches in local languages', () => {
  const coverage = buildThreadsHousingCoverage();
  for (const query of [
    'аренда Узбекистан',
    'сдам Ташкент',
    'посуточно Ташкент',
    'на сутки Ташкент',
    'ijara Toshkent',
    'kunlik ijara Toshkent',
    'ижара Тошкент',
    'кунлик ижара Тошкент',
    'аренда Алматы',
    'тәуліктік жалға Алматы',
    'închiriere București',
    'regim hotelier București',
    'оренда Україна',
    'подобово Україна',
  ]) {
    assert.ok(
      coverage.some((target) => target.target.toLocaleLowerCase() === query.toLocaleLowerCase()),
      `missing ${query}`,
    );
  }
});

test('social housing classifier accepts offers and rejects demand in supported languages', () => {
  assert.equal(classifyHousingOffer('Сдам 2-комнатную квартиру в Ташкенте, цена 500$'), 'longRent');
  assert.equal(classifyHousingOffer('Продам квартиру в Алматы, 2 комнаты, 45 м2'), 'sale');
  assert.equal(classifyHousingOffer('Здам квартиру у Львові, 18000 грн на місяць'), 'longRent');
  assert.equal(classifyHousingOffer('Închiriez apartament în București, 600 EUR'), 'longRent');
  assert.equal(classifyHousingOffer('Vând apartament în Cluj-Napoca, 85000 EUR'), 'sale');
  assert.equal(classifyHousingOffer('Uy ijaraga beriladi Toshkent, 500 USD'), 'longRent');
  assert.equal(classifyHousingOffer('Уй ижарага берилади Тошкент, 500 USD'), 'longRent');
  assert.equal(classifyHousingOffer('Пәтер жалға беріледі Алматы, 250000 теңге'), 'longRent');

  assert.equal(classifyHousingOffer('Ищу квартиру в Ташкенте, сниму на год'), null);
  assert.equal(classifyHousingOffer('Шукаю квартиру у Києві, зніму на тривалий термін'), null);
  assert.equal(classifyHousingOffer('Caut apartament să închiriez în București'), null);
  assert.equal(classifyHousingOffer('Куплю квартиру в Алматы'), null);
});

test('social housing classifier recognizes short-rent offers across target languages', () => {
  for (const text of [
    'Сдам квартиру посуточно в Ташкенте, 400000 сум за сутки',
    'Квартира подобово у Києві, 1500 грн за добу',
    'Toshkentda kunlik kvartira, 400000 som',
    'Тошкентда кунлик квартира, 400000 сум',
    'Алматыда пәтер тәулікке, бағасы 20000 теңге',
    'Apartament în regim hotelier București, 200 lei pe noapte',
  ]) {
    assert.equal(classifyHousingOffer(text), 'shortRent', text);
  }

  assert.equal(classifyHousingOffer('Ищу квартиру посуточно в Ташкенте на 3 дня'), null);
  assert.equal(classifyHousingOffer('Шукаю квартиру подобово у Києві на вихідні'), null);
});
