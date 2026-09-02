import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPANDED_REGIONAL_REMOTE_COMPANIES,
  mapExpandedGreenhousePostings,
  mapExpandedLeverPostings,
} from '../server/utils/sources/expandedRegionalRemoteSources.ts'

const posting = (location, title = 'Operations Manager', workplaceType = 'remote') => ({
  id: `${location}-${title}`,
  text: title,
  hostedUrl: `https://jobs.lever.co/example/${encodeURIComponent(location)}-${encodeURIComponent(title)}`,
  createdAt: Date.now(),
  descriptionPlain: 'Customer operations, finance, security and service delivery role',
  categories: { location, team: 'Operations', commitment: 'Full-time' },
  workplaceType,
})

test('expanded catalog covers all requested regional and remote markets', () => {
  const markets = new Set(EXPANDED_REGIONAL_REMOTE_COMPANIES.map((company) => company.market))
  assert.deepEqual(
    [...markets].sort(),
    ['CA', 'CN', 'CY', 'JP', 'KG', 'KR', 'KZ', 'REMOTE', 'RO', 'UA', 'US', 'UZ'],
  )
  assert.ok(EXPANDED_REGIONAL_REMOTE_COMPANIES.length >= 46)

  for (const [handle, market] of [
    ['ppro', 'CN'],
    ['EnvisionRPO', 'JP'],
    ['cagents', 'JP'],
    ['binance', 'KZ'],
    ['binance', 'JP'],
    ['mistplay', 'KR'],
    ['rws', 'KR'],
    ['applydigital', 'CA'],
    ['cscgeneration-2', 'CA'],
    ['capital', 'CY'],
    ['unlimit', 'CY'],
    ['exadelinc', 'UZ'],
    ['exadelinc', 'RO'],
  ]) {
    assert.ok(EXPANDED_REGIONAL_REMOTE_COMPANIES.some((item) => item.handle === handle && item.market === market))
  }
})

test('US remote mapping keeps US roles and rejects foreign locations', () => {
  const company = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'pointclickcare' && item.market === 'US')
  assert.ok(company)
  const jobs = mapExpandedLeverPostings([
    posting('Remote - US', 'Customer Support Manager'),
    posting('Toronto, Canada', 'Customer Support Manager'),
  ], company)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'direct')
  assert.equal(jobs[0].remote, true)
})

test('Canada and Cyprus targets stay scoped', () => {
  const canada = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'applydigital' && item.market === 'CA')
  const cyprus = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'unlimit' && item.market === 'CY')
  assert.ok(canada)
  assert.ok(cyprus)

  assert.equal(mapExpandedLeverPostings([posting('Canada')], canada).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Remote - Canada')], canada).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Limassol, Cyprus')], cyprus).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('London')], cyprus).length, 0)
})

test('Romania and Uzbekistan cross-border aliases remain scoped', () => {
  const romania = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'tsmg')
  const uzbekistan = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'remofirst' && item.market === 'UZ')
  assert.ok(romania)
  assert.ok(uzbekistan)

  assert.equal(mapExpandedLeverPostings([posting('Bucharest')], romania).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Egypt / Kazakhstan / Uzbekistan')], uzbekistan).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('India')], uzbekistan).length, 0)
})

test('Central Asia targets keep Kazakhstan and Kyrgyzstan vacancies scoped', () => {
  const kazakhstan = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'binance' && item.market === 'KZ')
  const kyrgyzstan = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'binance' && item.market === 'KG')
  assert.ok(kazakhstan)
  assert.ok(kyrgyzstan)

  assert.equal(mapExpandedLeverPostings([posting('Kazakhstan, Astana')], kazakhstan).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Kyrgyzstan, Bishkek')], kyrgyzstan).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Dubai')], kyrgyzstan).length, 0)
})

test('East Asia targets match country and city aliases without cross-market leakage', () => {
  const china = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'ppro' && item.market === 'CN')
  const japan = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'EnvisionRPO' && item.market === 'JP')
  const korea = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'mistplay' && item.market === 'KR')
  assert.ok(china)
  assert.ok(japan)
  assert.ok(korea)

  assert.equal(mapExpandedLeverPostings([posting('Shanghai')], china).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Tokyo, Japan')], japan).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Seoul, South Korea')], korea).length, 1)
  assert.equal(mapExpandedLeverPostings([posting('Singapore')], china).length, 0)
})

test('Exadel Greenhouse posting maps as a direct Uzbekistan job with full description', () => {
  const exadel = EXPANDED_REGIONAL_REMOTE_COMPANIES.find((item) => item.handle === 'exadelinc' && item.market === 'UZ')
  assert.ok(exadel)
  assert.equal(exadel.provider, 'greenhouse')

  const jobs = mapExpandedGreenhousePostings([{
    id: 6161162004,
    title: 'Senior Backend Engineer (.NET)',
    absolute_url: 'https://job-boards.greenhouse.io/exadelinc/jobs/6161162004',
    updated_at: '2026-08-29T12:00:00Z',
    location: { name: 'Bulgaria, Georgia, Poland, Romania, Uzbekistan' },
    departments: [{ name: 'Engineering' }],
    content: '<p>Azure Cloud, Microservices Architecture, .NET 8, ASP.NET Core services, Mongo, Azure SQL, Angular 18, Kendo.</p><p>In-office, hybrid, or remote flexibility</p>',
  }], exadel)

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, 'Exadel')
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'direct')
  assert.equal(jobs[0].location, 'Bulgaria, Georgia, Poland, Romania, Uzbekistan')
  assert.equal(jobs[0].remote, true)
  assert.match(jobs[0].description, /ASP\.NET Core/)
  assert.ok(jobs[0].tags.includes('Engineering'))
})
