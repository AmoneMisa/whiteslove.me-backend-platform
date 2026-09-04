import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeCandidate } from '../src/schemas/candidate.js';
import { sanitizeVacancy } from '../src/schemas/vacancy.js';

// Structured output requires every field to be present, so a model that cannot
// determine one must still answer. For a salary the usual cop-out is 0, and a
// zero that reaches a profile or a posting reads as a real figure rather than
// a blank. This is the text-side counterpart of a photo set that never showed
// a bathroom reporting bathroomsVisible=0.

test('a candidate does not expect a salary of zero', () => {
  const v = sanitizeCandidate({ salaryMin: 0, salaryMax: 0, confidence: 0.9 });
  assert.equal(v.salaryMin, null);
  assert.equal(v.salaryMax, null);
});

test('a vacancy does not advertise a salary of zero', () => {
  const v = sanitizeVacancy({ salaryMin: 0, salaryMax: 0, confidence: 0.9 });
  assert.equal(v.salaryMin, null);
  assert.equal(v.salaryMax, null);
});

test('a vacancy rejects a negative salary, which nothing guarded before', () => {
  const v = sanitizeVacancy({ salaryMin: -500, salaryMax: -100, confidence: 0.9 });
  assert.equal(v.salaryMin, null);
  assert.equal(v.salaryMax, null);
});

test('a real salary is untouched', () => {
  const candidate = sanitizeCandidate({ salaryMin: 800, salaryMax: 1200, confidence: 0.9 });
  assert.equal(candidate.salaryMin, 800);
  assert.equal(candidate.salaryMax, 1200);

  const vacancy = sanitizeVacancy({ salaryMin: 500, salaryMax: 900, confidence: 0.9 });
  assert.equal(vacancy.salaryMin, 500);
  assert.equal(vacancy.salaryMax, 900);
});

test('zero experience stays, because a CV can genuinely say so', () => {
  // Unlike a salary, "no experience" is a real statement a junior candidate
  // makes about themselves. Nulling it would lose a fact, not protect one.
  const v = sanitizeCandidate({ experienceYears: 0, confidence: 0.9 });
  assert.equal(v.experienceYears, 0);
});

test('a vacancy open to beginners keeps its zero minimum', () => {
  const v = sanitizeVacancy({ experienceMinYears: 0, experienceMaxYears: 2, confidence: 0.9 });
  assert.equal(v.experienceMinYears, 0);
  assert.equal(v.experienceMaxYears, 2);
});

test('an implausible age is still rejected', () => {
  assert.equal(sanitizeCandidate({ age: 0, confidence: 0.9 }).age, null);
});
