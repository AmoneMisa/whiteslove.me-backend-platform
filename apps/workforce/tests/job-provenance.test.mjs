import assert from 'node:assert/strict'
import test from 'node:test'

import {
  jobClusterKey, normalizeCompany, normalizeTitle, domainOf,
  assessJobProvenance, assessRecruiterCompanyIdentity, detectCopiedJob,
  STALE_AFTER_DAYS, PERMANENT_REPOST_COUNT,
} from '../shared/hiring/jobCluster.ts'
import { matchCandidates, groupCandidateProfiles } from '../shared/hiring/candidateIdentity.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-03-01T00:00:00.000Z')
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString()

// --- clustering -------------------------------------------------------------

test('company legal forms and punctuation do not split a cluster', () => {
  assert.equal(normalizeCompany('Acme, LLC.'), normalizeCompany('ACME llc'))
  assert.equal(normalizeCompany('ООО Ромашка'), normalizeCompany('Ромашка'))
})

test('seniority and contract noise do not split a role', () => {
  assert.equal(normalizeTitle('Senior Backend Engineer (Remote)'), normalizeTitle('Backend Engineer'))
})

test('Cyrillic legal forms and qualifiers are stripped too', () => {
  // Regression: \b never fires next to Cyrillic in JavaScript, so these were
  // silently kept and split Russian and Uzbek postings into separate clusters.
  assert.equal(normalizeCompany('МЧЖ Ромашка'), 'ромашка')
  assert.equal(normalizeTitle('Разработчик удалённо'), normalizeTitle('Разработчик'))
})

test('reposts of one role share a cluster even when salary and text change', () => {
  const first = jobClusterKey({ company: 'Acme LLC', title: 'Backend Engineer', city: 'Tashkent', country: 'uz', salaryUsd: 2000, description: 'v1' })
  const second = jobClusterKey({ company: 'ACME', title: 'Senior Backend Engineer', city: 'Tashkent', country: 'UZ', salaryUsd: 2500, description: 'v2' })
  assert.equal(first, second, 'otherwise every repost would look like a new job')
})

test('the same role in another city is another cluster', () => {
  assert.notEqual(
    jobClusterKey({ company: 'Acme', title: 'Backend Engineer', city: 'Tashkent', country: 'UZ' }),
    jobClusterKey({ company: 'Acme', title: 'Backend Engineer', city: 'Almaty', country: 'KZ' }),
  )
})

test('a posting without company or title has no cluster', () => {
  assert.equal(jobClusterKey({ title: 'Backend Engineer' }), null)
  assert.equal(jobClusterKey({ company: 'Acme' }), null)
})

test('domains are extracted leniently and rejected when unusable', () => {
  assert.equal(domainOf('https://www.acme.com/jobs/1'), 'acme.com')
  assert.equal(domainOf('acme.com/apply'), 'acme.com')
  assert.equal(domainOf(''), null)
  assert.equal(domainOf('not a url at all'), null)
})

// --- provenance -------------------------------------------------------------

const posting = (id, extra = {}) => ({ identityKey: id, clusterKey: 'c', postedAt: ago(10), lastSeenAt: ago(1), active: true, ...extra })
const codes = (result) => result.findings.map((finding) => finding.reasonCode)

test('an evergreen role reposted a few times is not a finding', () => {
  const result = assessJobProvenance([posting('1'), posting('2'), posting('3')], { now: NOW })
  assert.deepEqual(result.findings, [])
})

test('very frequent reposting is described, not accused', () => {
  const postings = Array.from({ length: PERMANENT_REPOST_COUNT }, (_, i) => posting(String(i)))
  const finding = assessJobProvenance(postings, { now: NOW }).findings.find((item) => item.reasonCode === 'permanent_reposting')
  assert.ok(finding)
  assert.match(finding.detail.note, /legitimate/)
})

test('a role active for months without refresh is stale', () => {
  const result = assessJobProvenance([posting('1', { postedAt: ago(STALE_AFTER_DAYS + 20), lastSeenAt: ago(90) })], { now: NOW })
  assert.ok(codes(result).includes('stale_job'))
})

test('a long-running role that is still being refreshed is not stale', () => {
  // Genuinely hard-to-fill roles do run for months.
  const result = assessJobProvenance([posting('1', { postedAt: ago(STALE_AFTER_DAYS + 20), lastSeenAt: ago(2) })], { now: NOW })
  assert.ok(!codes(result).includes('stale_job'))
})

test('a changed application destination is reported', () => {
  const result = assessJobProvenance([
    posting('1', { applicationUrl: 'https://acme.com/apply' }),
    posting('2', { applicationUrl: 'https://forms.example.net/x' }),
  ], { now: NOW })
  const finding = result.findings.find((item) => item.reasonCode === 'application_destination_changed')
  assert.deepEqual(finding.detail.destinations.sort(), ['acme.com', 'forms.example.net'])
})

test('one recruiter handover is not rotation', () => {
  const two = assessJobProvenance([posting('1', { recruiterId: 'a' }), posting('2', { recruiterId: 'b' })], { now: NOW })
  assert.ok(!codes(two).includes('recruiter_identity_rotation'))
  const three = assessJobProvenance([posting('1', { recruiterId: 'a' }), posting('2', { recruiterId: 'b' }), posting('3', { recruiterId: 'c' })], { now: NOW })
  assert.ok(codes(three).includes('recruiter_identity_rotation'))
})

test('a contact domain contradicting the company is reported', () => {
  const result = assessJobProvenance([posting('1', { contactEmail: 'hr@acme-careers.biz', companyDomain: 'acme.com' })], { now: NOW })
  assert.ok(codes(result).includes('job_contact_domain_mismatch'))
})

test('a free mailbox or a subdomain is not a domain mismatch', () => {
  assert.deepEqual(assessJobProvenance([posting('1', { contactEmail: 'recruiter@gmail.com', companyDomain: 'acme.com' })], { now: NOW }).findings, [])
  assert.deepEqual(assessJobProvenance([posting('1', { contactEmail: 'hr@jobs.acme.com', companyDomain: 'acme.com' })], { now: NOW }).findings, [])
})

test('an agency advertising for many companies is ordinary', () => {
  const result = assessRecruiterCompanyIdentity([{ company: 'Acme' }, { company: 'Globex' }, { company: 'Initech' }, { company: 'Umbrella' }])
  assert.deepEqual(result.findings, [])
  assert.equal(result.distinctCompanies, 4)
})

test('claiming to be the employer for several unrelated companies is reported', () => {
  const result = assessRecruiterCompanyIdentity([
    { company: 'Acme', claimsToBeEmployer: true },
    { company: 'Globex', claimsToBeEmployer: true },
    { company: 'Initech', claimsToBeEmployer: true },
  ])
  assert.equal(result.findings[0].reasonCode, 'recruiter_company_identity_mismatch')
})

test('identical text under the same company is a cross-post, not a copy', () => {
  const text = 'We are hiring a backend engineer to build payment services. '.repeat(5)
  assert.equal(detectCopiedJob({ description: text, company: 'Acme', source: 'hh' }, { description: text, company: 'ACME LLC', source: 'linkedin' }), null)
  assert.equal(detectCopiedJob({ description: text, company: 'Acme' }, { description: text, company: 'Globex' }).reasonCode, 'copied_job')
})

test('short boilerplate is never treated as a copy', () => {
  assert.equal(detectCopiedJob({ description: 'Apply now', company: 'A' }, { description: 'Apply now', company: 'B' }), null)
})

test('empty provenance input yields nothing', () => {
  assert.deepEqual(assessJobProvenance([], { now: NOW }).findings, [])
  assert.equal(assessJobProvenance(null, { now: NOW }).postingCount, 0)
})

// --- candidate identity (§38) -----------------------------------------------

test('a shared email merges candidates', () => {
  const match = matchCandidates({ emails: ['Aziz@Example.com'] }, { emails: ['aziz@example.com'] })
  assert.equal(match.merge, true)
  assert.deepEqual(match.basis, ['same_email'])
})

test('a shared phone merges despite formatting differences', () => {
  assert.equal(matchCandidates({ phones: ['+998 90 123-45-67'] }, { phones: ['998901234567'] }).merge, true)
})

test('a shared name never merges, however much else agrees', () => {
  // Two people called Aziz Karimov who both know TypeScript are two people.
  const match = matchCandidates(
    { name: 'Aziz Karimov', skills: ['TypeScript', 'Node.js'], employers: ['Acme'], education: ['TUIT'] },
    { name: 'Aziz Karimov', skills: ['TypeScript', 'Node.js'], employers: ['Acme'], education: ['TUIT'] },
  )
  assert.equal(match.merge, false)
  assert.equal(match.strength, 'weak')
  assert.ok(match.corroboration.includes('same_name'), 'reported for a reviewer, not acted on')
})

test('corroboration is attached to a strong match', () => {
  const match = matchCandidates(
    { emails: ['a@example.com'], name: 'Aziz', skills: ['Go', 'Rust'] },
    { emails: ['a@example.com'], name: 'Aziz', skills: ['Go', 'Rust'] },
  )
  assert.equal(match.strength, 'strong')
  assert.ok(match.corroboration.includes('same_name'))
  assert.ok(match.corroboration.includes('overlapping_skills'))
})

test('a malformed email or a short number is not an identifier', () => {
  assert.equal(matchCandidates({ emails: ['not-an-email'] }, { emails: ['not-an-email'] }).merge, false)
  assert.equal(matchCandidates({ phones: ['123'] }, { phones: ['123'] }).merge, false, 'an extension is not a phone')
})

test('profiles chain together through shared strong identifiers', () => {
  const groups = groupCandidateProfiles([
    { id: 'a', emails: ['x@example.com'] },
    { id: 'b', emails: ['x@example.com'], phones: ['+998901234567'] },
    { id: 'c', phones: ['998901234567'] },
    { id: 'd', name: 'Aziz Karimov' },
    { id: 'e', name: 'Aziz Karimov' },
  ])
  assert.deepEqual(groups, [['a', 'b', 'c'], ['d'], ['e']], 'the two namesakes stay apart')
})

test('grouping an empty set yields no groups', () => {
  assert.deepEqual(groupCandidateProfiles([]), [])
})
