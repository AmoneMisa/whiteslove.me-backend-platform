import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { professionByCanonical } from '@whiteslove/parsing-lexicon/hiring-professions'

import { JOB_DIRECTIONS, JOB_DIRECTION_LABELS } from '../shared/contracts/jobs.ts'
import { filterAndPaginate } from '../server/vacancies/domain/aggregate.ts'
import {
  DIRECTION_PROFESSIONS,
  classifyJobDirections,
  matchesJobDirections,
} from '../server/vacancies/domain/jobDirections.ts'

const RECENT = new Date(Date.now() - 86_400_000).toISOString()

function job(overrides) {
  return {
    id: overrides.id ?? overrides.title,
    title: overrides.title,
    company: 'Acme',
    location: 'Tashkent',
    url: overrides.url ?? `https://example.test/${encodeURIComponent(overrides.title)}`,
    source: 'hh',
    remote: false,
    tags: overrides.tags ?? [],
    postedAt: RECENT,
    description: '',
    workMode: 'office',
    skillDetails: overrides.skillDetails ?? [],
    niceToHaveDetails: [],
    skills: [],
    niceToHave: [],
    languages: [],
    riskCategory: null,
    ...overrides.extra,
  }
}

function skill(name, subcategory) {
  return { name, category: 'IT', subcategory }
}

function query(overrides = {}) {
  return {
    q: '',
    location: '',
    remote: undefined,
    sources: ['hh'],
    sort: 'date',
    maxAgeDays: 14,
    salaryMin: undefined,
    page: 1,
    pageSize: 50,
    countries: [],
    cities: [],
    includeRu: true,
    includeBy: true,
    workMode: undefined,
    relocation: undefined,
    employmentKind: undefined,
    hasSalary: undefined,
    maxExperienceYears: undefined,
    foreignerFriendly: undefined,
    hideRiskyIndustries: false,
    noExperience: undefined,
    language: undefined,
    languageLevel: undefined,
    excludeLanguages: [],
    skills: [],
    ...overrides,
  }
}

test('every direction has labels and a non-empty canonical profession list', () => {
  for (const direction of JOB_DIRECTIONS) {
    assert.ok(JOB_DIRECTION_LABELS[direction].en, direction)
    assert.ok(JOB_DIRECTION_LABELS[direction].ru, direction)
    assert.ok(DIRECTION_PROFESSIONS[direction].length > 0, direction)
  }
  assert.deepEqual(Object.keys(DIRECTION_PROFESSIONS).sort(), [...JOB_DIRECTIONS].sort())
})

test('direction professions are canonical lexicon professions, not local names', () => {
  for (const direction of JOB_DIRECTIONS) {
    for (const canonical of DIRECTION_PROFESSIONS[direction]) {
      assert.ok(professionByCanonical(canonical), `${direction}: ${canonical} is missing from parsing-lexicon`)
    }
  }
})

test('a canonical profession belongs to one direction only', () => {
  const seen = new Map()
  for (const direction of JOB_DIRECTIONS) {
    for (const canonical of DIRECTION_PROFESSIONS[direction]) {
      assert.equal(seen.has(canonical), false, `${canonical} listed under ${seen.get(canonical)} and ${direction}`)
      seen.set(canonical, direction)
    }
  }
})

test('title names the direction', () => {
  const cases = [
    ['Senior Frontend Developer (React)', ['frontend']],
    ['Фронтенд разработчик', ['frontend']],
    ['Mobile Developer (Flutter)', ['mobile']],
    ['iOS разработчик', ['mobile']],
    ['Android developer Kotlin', ['mobile']],
    ['React Native developer', ['mobile']],
    ['Backend Developer Node.js', ['backend']],
    ['Бэкенд разработчик Python', ['backend']],
    ['Fullstack developer', ['fullstack']],
    ['DevOps engineer', ['devops']],
    ['Site Reliability Engineer', ['devops']],
    ['Manual QA engineer', ['qa']],
    ['Data Scientist', ['data']],
    ['Penetration tester', ['security']],
    ['Product Designer', ['design']],
    ['Product Manager', ['product']],
    ['Медсестра', ['healthcare']],
    ['Семейный врач', ['healthcare']],
    ['Family doctor', ['healthcare']],
    ['Стоматолог', ['healthcare']],
    ['Водитель', ['driving']],
    ['Driver category B', ['driving']],
    ['Курьер', ['driving']],
  ]
  for (const [title, expected] of cases) {
    assert.deepEqual(classifyJobDirections(job({ title })), expected, title)
  }
})

test('unrelated titles stay unclassified instead of guessed', () => {
  for (const title of ['Бухгалтер', 'Cashier', 'Waiter', 'Business Analyst']) {
    assert.deepEqual(classifyJobDirections(job({ title })), [], title)
  }
})

test('tags can name the direction when the title does not', () => {
  assert.deepEqual(classifyJobDirections(job({ title: 'Developer wanted', tags: ['DevOps engineer'] })), ['devops'])
})

test('required skills decide when the title is generic', () => {
  const frontendSkills = [skill('React', 'Frontend'), skill('TypeScript', 'Frontend')]
  assert.deepEqual(
    classifyJobDirections(job({ title: 'Software engineer', skillDetails: frontendSkills })),
    ['frontend'],
  )
})

test('a single skill is not enough evidence for a direction', () => {
  const oneSkill = [skill('Git', 'DevOps & Cloud')]
  assert.deepEqual(classifyJobDirections(job({ title: 'Software engineer', skillDetails: oneSkill })), [])
})

test('a title match takes precedence over skill evidence', () => {
  const backendSkills = [skill('Node.js', 'Backend'), skill('Express', 'Backend')]
  assert.deepEqual(
    classifyJobDirections(job({ title: 'Frontend developer', skillDetails: backendSkills })),
    ['frontend'],
  )
})

test('matchesJobDirections is an OR over the requested directions', () => {
  const mobile = job({ title: 'Flutter developer' })
  assert.equal(matchesJobDirections(mobile, undefined), true)
  assert.equal(matchesJobDirections(mobile, []), true)
  assert.equal(matchesJobDirections(mobile, ['frontend', 'mobile']), true)
  assert.equal(matchesJobDirections(mobile, ['frontend', 'devops']), false)
})

test('filterAndPaginate applies a multi-select direction filter', () => {
  const pool = [
    job({ title: 'Frontend developer' }),
    job({ title: 'iOS developer' }),
    job({ title: 'DevOps engineer' }),
    job({ title: 'Бухгалтер' }),
  ]
  const onlyFrontend = filterAndPaginate(pool, query({ directions: ['frontend'] }))
  assert.deepEqual(onlyFrontend.jobs.map((item) => item.title), ['Frontend developer'])

  const mobileOrDevops = filterAndPaginate(pool, query({ directions: ['mobile', 'devops'] }))
  assert.deepEqual(mobileOrDevops.jobs.map((item) => item.title).sort(), ['DevOps engineer', 'iOS developer'])
  assert.equal(mobileOrDevops.total, 2)

  const unfiltered = filterAndPaginate(pool, query())
  assert.equal(unfiltered.total, 4)
})

test('jobs-feed parses the directions parameter and bypasses the PostgreSQL path for it', async () => {
  const route = await readFile(new URL('../server/routes/jobs-feed.get.ts', import.meta.url), 'utf8')
  assert.match(route, /String\(q\.directions \?\? ''\)/)
  assert.match(route, /\(JOB_DIRECTIONS as string\[\]\)\.includes\(s\)/)
  assert.match(route, /directions,\r?\n\s+page: clampInt/)
  assert.match(route, /if \(!search && !directions\.length\) \{/)
  assert.match(route, /directions: classifyJobDirections\(job\)/)
})
