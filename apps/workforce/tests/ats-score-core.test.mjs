import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCvProfile, scoreJob } from '../shared/hiring/ats/scoreCore.ts'

const frontendCv = `
Marharyta Kubai
Frontend Developer

Experience
Frontend Developer, 3 years
Built React and TypeScript single-page apps, Vue.js components, CSS layouts.

Skills
JavaScript, TypeScript, React, Vue, HTML, CSS
`

test('vacancy with no overlap with the CV does not score near neutral', () => {
  const profile = buildCvProfile(frontendCv)
  const result = scoreJob(profile, {
    title: 'Physician - OBGYN',
    description: 'Board-certified physician needed for outpatient obstetrics and gynecology clinic. Patient care, delivery, and clinical rounds.',
    country: 'US',
  })
  assert.ok(result.fitScore <= 40, `expected <= 40, got ${result.fitScore}`)
  assert.equal(result.breakdown.skills, 0)
})

test('vacancy with no overlap and a stated requirement does not score near neutral', () => {
  const profile = buildCvProfile(frontendCv)
  const result = scoreJob(profile, {
    title: 'Internal Medicine Senior',
    description: 'Senior internal medicine physician. Requires 5+ years clinical experience and an MD degree.',
    country: 'US',
  })
  assert.ok(result.fitScore <= 40, `expected <= 40, got ${result.fitScore}`)
})

test('vacancy that matches the CV scores above the no-overlap cap', () => {
  const profile = buildCvProfile(frontendCv)
  const result = scoreJob(profile, {
    title: 'Frontend Developer',
    description: 'Required: React, TypeScript, CSS. Build responsive single-page applications.',
    skills: ['React', 'TypeScript', 'CSS'],
    country: 'US',
  })
  assert.ok(result.fitScore > 40, `expected > 40, got ${result.fitScore}`)
  assert.ok(result.matched.length > 0)
})
