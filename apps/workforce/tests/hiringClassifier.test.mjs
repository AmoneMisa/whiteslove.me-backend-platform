import assert from 'node:assert/strict'
import test from 'node:test'

import { isLikelyCvPost } from '../server/hiring/domain/telegramCandidateParser.ts'

import { extractProfessionExperience } from '../server/utils/hiring/hiringExperience.ts'

// Every one of these was rejected while the intent patterns were anchored
// with \b next to Cyrillic, where a JavaScript word boundary never fires:
// only one of eight was recognised, and the Russian and Ukrainian side of the
// candidate detection was effectively switched off.
test('Russian and Ukrainian job-seeker posts are recognised as CVs', () => {
  const posts = [
    'Ищу работу водителем категории B. Опыт 5 лет. Ташкент.',
    'Работу ищу срочно, любую, в Алматы. Могу работать грузчиком.',
    'Нужна работа, 25 лет, без опыта, могу учиться.',
    'Могу работать сварщиком, есть свой инструмент.',
    'Шукаю роботу продавця в Києві, досвід 2 роки.',
    'В поиске работы: маркетолог, удалённо. Опыт 4 года.',
    'Ищу подработку на выходные, 20 лет, студент, оператор ПК.',
  ]
  for (const post of posts) assert.equal(isLikelyCvPost(post), true, post)
})

test('employer posts stay out of the candidate feed', () => {
  const posts = [
    'Ищем водителя категории B. Зарплата от 5 млн. Требования: опыт от 2 лет.',
    'Требуется бухгалтер в компанию, полный день, официальное оформление.',
    'Вакансия: менеджер по продажам. Обязанности: работа с клиентами.',
    'Шукаємо продавця в магазин, графік 2/2.',
    'В связи с расширением требуются электрики и сантехники. Оплата еженедельно.',
    'Компания ищет маркетолога. Условия работы: офис, 5/2, соцпакет.',
    'Ishchi kerak! Oylik 5 mln. Murojaat uchun: +998 90 000 00 00',
    'Открыта вакансия юриста. Требования: высшее образование, опыт от 3 лет.',
  ]
  for (const post of posts) assert.equal(isLikelyCvPost(post), false, post)
})

test('HR news, career events and empty recommendations are not CVs', () => {
  const posts = [
    'Happy Monday оновила функціонал відгуків про роботодавців. Залиште відгук на Happy Monday.',
    'Women Career Day — кар’єрна подія. Придбати квитки за посиланням. Head of Recruitment та HR директори серед спікерів.',
    'Корисна добірка новин від HURMA Community. Хочете отримувати такі новини щотижня? Приєднуйтесь.',
    'Колеги, вітаю! Рекомендую класного кандидата. Контакти та резюме додаю.',
  ]
  for (const post of posts) assert.equal(isLikelyCvPost(post, true), false, post)
})

test('a duration in months is not read as that many years', () => {
  // "Опыт работы: 2 мес, Administrator" was being published as two years.
  const months = extractProfessionExperience('Опыт работы: 2 мес, Администратор, Language Centre')
  assert.ok(months.length, 'expected the administrator mention to be found')
  assert.ok(months[0].years < 1, `expected under a year, got ${months[0].years}`)

  const years = extractProfessionExperience('Опыт работы: 5 лет, Офис менеджер, Colgate')
  assert.ok(years.length)
  assert.equal(years[0].years, 5)
})
