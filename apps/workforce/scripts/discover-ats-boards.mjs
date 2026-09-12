// Resolve registered company homepages to hosted ATS job boards.
//
// Most companies in PUBLIC_JOB_BOARDS are registered by homepage URL, which the
// generic board parser can only scrape for anchors that happen to look like job
// links. A homepage rarely lists jobs, and on most of these sites the careers
// page is a JS-rendered ATS embed with nothing in the server HTML — so those
// entries cost a fetch per cycle and return little or nothing.
//
// Companies that use a hosted ATS do expose a documented public JSON API. This
// script finds those boards by deriving handle candidates from each company's
// domain and label, calling the four ATS APIs the crawler already supports, and
// keeping only boards that actually return postings.
//
// Identity is the hard part: a handle guess can land on a different company's
// board (the handle "ark" is Ark Veterinary Hospital, not ARK the blockchain
// company). Greenhouse and SmartRecruiters publish the board's display name, so
// a match can be verified and auto-accepted. Lever and Ashby publish no company
// identity at all, and the company's own site does not carry the ATS URL in
// server HTML, so those are reported as candidates for human review and never
// auto-accepted.
//
// Discovery is deliberately offline: it emits a handle list to paste into
// coreCompanyJobTargets.ts rather than probing at crawl time, so a crawl costs
// one API call per known board instead of a fan-out of guesses.
//
// Usage:
//   node scripts/discover-ats-boards.mjs [--limit N] [--concurrency N] [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_FILE = resolve(HERE, '../server/utils/sources/extraPublicJobSources.ts')
const CORE_FILE = resolve(HERE, '../server/utils/sources/coreCompanyJobTargets.ts')

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'
const TIMEOUT_MS = 15_000

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const LIMIT = Number(flag('--limit', '0')) || 0
const CONCURRENCY = Math.max(1, Number(flag('--concurrency', '8')))
const JSON_OUT = flag('--json', '')

/**
 * Handle guesses that land on a real board belonging to a different company.
 *
 * These were reviewed by reading the postings themselves and must never be
 * re-suggested: a handle collision looks exactly like a success, because the
 * board is live and returns jobs. Kept here rather than in the registry so the
 * reasoning survives the next rerun.
 */
const KNOWN_HANDLE_MISMATCHES = new Map([
  ['ashby/build', 'energy venture builder — not Grou.ps (build.gr.ps)'],
  ['ashby/calibre', 'London AI-infrastructure firm — not calibreapp.com'],
  ['ashby/litmus', 'Litmus Automation (industrial IoT) — not litmus.com'],
  ['ashby/primer', 'K-8 school network — not primer.io'],
  ['lever/mindful', 'digital-health ADHD practice — not getmindful.com'],
  ['lever/tri', 'Toyota Research Institute — not Modern Tribe (tri.be)'],
  ['greenhouse/ark', 'Ark Veterinary Hospital — not ARK (ark.io)'],
  ['greenhouse/aha', 'Animal Health Associates — not Aha!'],
  ['greenhouse/remote', 'General Assembly Remote Jobs — not Remote.co'],
  ['smartrecruiters/alight', 'A Light (assembly staffing) — not Alight Solutions'],
])

/** Platforms whose board carries a company name we can verify against. */
const PLATFORMS = [
  {
    name: 'greenhouse',
    verifiable: true,
    listUrl: (h) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(h)}/jobs`,
    countJobs: (d) => (d.jobs || []).length,
    identityUrl: (h) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(h)}`,
    identityName: (d) => d?.name || null,
  },
  {
    name: 'smartrecruiters',
    verifiable: true,
    listUrl: (h) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(h)}/postings?limit=10`,
    countJobs: (d) => (typeof d.totalFound === 'number' ? d.totalFound : (d.content || []).length),
    identityUrl: (h) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(h)}/postings?limit=1`,
    identityName: (d) => (d.content || [])[0]?.company?.name || null,
  },
  {
    name: 'lever',
    verifiable: false,
    listUrl: (h) => `https://api.lever.co/v0/postings/${encodeURIComponent(h)}?mode=json`,
    countJobs: (d) => (Array.isArray(d) ? d.length : 0),
  },
  {
    name: 'ashby',
    verifiable: false,
    listUrl: (h) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(h)}`,
    countJobs: (d) => (d.jobs || []).length,
  },
]

/**
 * Words, not a squashed string. Collapsing to characters made "A Light" and
 * "Alight Solutions" identical once a corporate suffix was stripped, which
 * accepted an Oceanside assembly-line staffing board as Alight Solutions.
 */
function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Whether a board's display name plausibly denotes the registered company.
 *
 * The shorter name must be a whole-word prefix of the longer one: "Ghost" vs
 * "Ghost Foundation" and "Applaudo" vs "Applaudo Studios" pass, while
 * "General Assembly Remote Jobs" vs "Remote.co" and "A Light" vs "Alight
 * Solutions" do not. The four-character floor keeps a short handle like "ark"
 * from claiming "Ark Veterinary Hospital"; a genuinely short company name is
 * left unresolved rather than guessed at.
 */
function namesMatch(boardName, label) {
  const a = nameTokens(boardName)
  const b = nameTokens(label)
  if (!a.length || !b.length) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.join('').length < 4) return false
  return short.every((token, index) => long[index] === token)
}

function handleCandidates(label, url) {
  const out = new Set()
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length >= 2) out.add(parts[0])
    out.add(parts.slice(0, -1).join(''))
  } catch { /* a malformed registry URL just yields fewer candidates */ }
  const slug = String(label).toLowerCase()
  out.add(slug.replace(/[^a-z0-9]+/g, ''))
  out.add(slug.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  return [...out].filter((h) => h.length >= 3 && h.length <= 40)
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) return null
  try { return await response.json() } catch { return null }
}

async function probe(platform, handle, label) {
  const mismatch = KNOWN_HANDLE_MISMATCHES.get(`${platform.name}/${handle}`)
  if (mismatch) return { platform: platform.name, handle, jobs: 0, verified: false, boardName: null, mismatch }

  const list = await getJson(platform.listUrl(handle))
  if (!list) return null
  const jobs = platform.countJobs(list) || 0
  if (jobs <= 0) return null

  if (!platform.verifiable) {
    return { platform: platform.name, handle, jobs, verified: false, boardName: null }
  }

  const identity = await getJson(platform.identityUrl(handle))
  const boardName = platform.identityName(identity ?? list) || platform.identityName(list)
  return {
    platform: platform.name,
    handle,
    jobs,
    verified: namesMatch(boardName, label),
    boardName: boardName || null,
  }
}

async function resolveCompany(company) {
  const rejected = []
  for (const handle of handleCandidates(company.label, company.url)) {
    for (const platform of PLATFORMS) {
      const found = await probe(platform, handle, company.label)
      if (!found) continue
      if (found.mismatch) {
        rejected.push({ ...found, reason: found.mismatch })
        continue
      }
      if (found.verified) return { ...company, ...found, outcome: 'verified' }
      if (platform.verifiable) {
        // Name mismatch on a platform that publishes one: a different company.
        rejected.push({ ...found, reason: `board name "${found.boardName}" != "${company.label}"` })
        continue
      }
      return { ...company, ...found, outcome: 'review' }
    }
  }
  return { ...company, outcome: 'none', rejected }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}

function registeredCompanies() {
  const src = readFileSync(SOURCE_FILE, 'utf8')
  return [...src.matchAll(/\{ label: '([^']+)', url: '([^']+)', remoteByDefault: true \}/g)]
    .map((match) => ({ label: match[1], url: match[2] }))
}

/** Handles already present in coreCompanyJobTargets, so reruns stay additive. */
function existingHandles() {
  const src = readFileSync(CORE_FILE, 'utf8')
  const set = new Set()
  for (const match of src.matchAll(/'([a-zA-Z0-9_-]+):([^']+)'/g)) set.add(match[1].toLowerCase())
  return set
}

const companies = LIMIT ? registeredCompanies().slice(0, LIMIT) : registeredCompanies()
const known = existingHandles()
console.error(`probing ${companies.length} companies at concurrency ${CONCURRENCY}…`)

let done = 0
const results = await mapWithConcurrency(companies, CONCURRENCY, async (company) => {
  const result = await resolveCompany(company)
  done += 1
  if (done % 25 === 0) console.error(`  …${done}/${companies.length}`)
  return result
})

const verified = results.filter((r) => r.outcome === 'verified' && !known.has(r.handle.toLowerCase()))
const review = results.filter((r) => r.outcome === 'review' && !known.has(r.handle.toLowerCase()))
const already = results.filter((r) => r.outcome !== 'none' && known.has(r.handle.toLowerCase()))
const rejected = results.flatMap((r) => (r.rejected || []).map((x) => ({ label: r.label, ...x })))

console.log('\n=== VERIFIED (board name matches; safe to add) ===')
for (const platform of ['greenhouse', 'smartrecruiters']) {
  const rows = verified.filter((r) => r.platform === platform)
  if (!rows.length) continue
  console.log(`\n// ${platform}`)
  console.log(rows.map((r) => `  '${r.handle}:${r.label}',`).join('\n'))
  for (const r of rows) console.error(`  ${platform}/${r.handle} — ${r.jobs} jobs — "${r.boardName}"`)
}

console.log('\n=== NEEDS REVIEW (no company identity published by the ATS) ===')
for (const r of review) {
  console.log(`  ${r.platform}/${r.handle} — ${r.jobs} jobs — claimed by "${r.label}" (${r.url})`)
}

console.log('\n=== REJECTED (handle belongs to another company) ===')
for (const r of rejected) console.log(`  ${r.platform}/${r.handle} — ${r.reason}`)

console.error(
  `\nverified=${verified.length} review=${review.length} already-registered=${already.length} `
  + `rejected=${rejected.length} unresolved=${results.filter((r) => r.outcome === 'none').length}`,
)

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ verified, review, already, rejected }, null, 2))
  console.error(`wrote ${JSON_OUT}`)
}
