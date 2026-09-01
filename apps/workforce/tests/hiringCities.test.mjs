import assert from 'node:assert/strict'
import test from 'node:test'

import { detectCity, detectDistrict } from '../server/hiring/domain/telegramCandidateParser.ts'

// The Telegram side kept its own city table, with the same dead \b as the web
// parsers: a post that named its city in Cyrillic resolved to nothing.
test('Telegram posts written in Cyrillic resolve a city and a district', () => {
  assert.equal(detectCity('Ищу работу, живу в Ташкенте', 'UZ'), 'Tashkent')
  assert.equal(detectCity('Шукаю роботу, Київ', 'UA'), 'Kyiv')
  assert.equal(detectCity('Резюме, Алматы', 'KZ'), 'Almaty')
  assert.equal(detectCity('Резюме, Бишкек', 'KG'), 'Bishkek')
  assert.equal(detectCity('Ищу работу в Берлине', 'UZ'), null)

  assert.equal(detectDistrict('Ташкент, Чиланзар', 'Tashkent'), 'Chilanzar')
  assert.equal(detectDistrict('Mirzo Ulugbek tumani', 'Tashkent'), 'Mirzo Ulugbek')
  assert.equal(detectDistrict('мирзо улугбек', 'Tashkent'), 'Mirzo Ulugbek')
})

test('city names are matched through their case endings, but not into other words', async () => {
  const { cityFrom } = await import('../shared/hiring/webFields.ts')

  // Place names are almost never written in the nominative in running text.
  assert.equal(cityFrom('живу в Ташкенте', 'UZ'), 'Tashkent')
  assert.equal(cityFrom('работа в Киеве', 'UA'), 'Kyiv')
  assert.equal(cityFrom('в Одессе', 'UA'), 'Odesa')
  assert.equal(cityFrom('Наманганской области', 'UZ'), 'Namangan')
  assert.equal(cityFrom('город Ош', 'KG'), 'Osh')
  assert.equal(cityFrom('Бишкеке', 'KG'), 'Bishkek')

  // The allowance is Cyrillic-only and short, so neither of these is a city.
  assert.equal(cityFrom('oshpaz kerak', 'KG'), null)
  assert.equal(cityFrom('ошибка в резюме', 'KG'), null)
})
