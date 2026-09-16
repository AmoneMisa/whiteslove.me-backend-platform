import test from 'node:test';
import assert from 'node:assert/strict';

import {
  personaCore, personaRole, classifyPersonaChange,
  identityMatchStrength, accountAgeFacts,
} from '../src/identity/identity-change.js';
import {
  summarizeIdentityChurn, detectContactIdentityMismatch,
  CHURN_REASONS, CHURN_THRESHOLDS,
} from '../src/identity/identity-churn.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

// --- persona classification -------------------------------------------------

test('decoration is stripped to the claimed name', () => {
  assert.equal(personaCore('Andrey 🏠'), 'andrey');
  assert.equal(personaCore('  ANDREY  '), 'andrey');
  assert.equal(personaCore('⭐️Andrey⭐️'), 'andrey');
  assert.equal(personaCore(null), '');
});

test('roles are read with the lexicon vocabulary, in any supported language', () => {
  assert.equal(personaRole('Andrey, собственник'), 'owner');
  assert.equal(personaRole('Andrey realtor'), 'agency');
  assert.equal(personaRole('Uy egasi Andrey'), 'owner');
  assert.equal(personaRole('Andrey'), null);
});

test('adding an emoji is cosmetic, not identity churn', () => {
  // The false positive that would otherwise flag ordinary users.
  const change = classifyPersonaChange('Andrey', 'Andrey 🏠');
  assert.equal(change.kind, 'cosmetic');
  assert.equal(change.coreChanged, false);
});

test('a different human name is semantic', () => {
  const change = classifyPersonaChange('Realtor Andrey', 'Realtor Anton');
  assert.equal(change.kind, 'semantic');
  assert.equal(change.coreChanged, true);
});

test('the same name claiming a different role is semantic', () => {
  const change = classifyPersonaChange('Andrey собственник', 'Andrey риелтор');
  assert.equal(change.kind, 'semantic');
  assert.equal(change.roleChanged, true);
  assert.equal(change.fromRole, 'owner');
  assert.equal(change.toRole, 'agency');
});

test('no change is reported when nothing changed', () => {
  assert.equal(classifyPersonaChange('Andrey', 'Andrey').kind, 'none');
  assert.equal(classifyPersonaChange(null, null).kind, 'none');
});

// --- identity resolution ----------------------------------------------------

test('a shared platform subject id merges actors', () => {
  const match = identityMatchStrength(
    { platform: 'telegram', subjectId: '123', displayName: 'Andrey' },
    { platform: 'telegram', subjectId: '123', displayName: 'Oleg' },
  );
  assert.equal(match.merge, true);
  assert.equal(match.basis, 'platform_subject_id');
});

test('a display name alone never merges actors', () => {
  // Two people called Andrey are two people. Merging them would attribute one
  // person's history to the other.
  const match = identityMatchStrength(
    { platform: 'telegram', displayName: 'Andrey' },
    { platform: 'telegram', displayName: 'Andrey' },
  );
  assert.equal(match.merge, false);
  assert.equal(match.basis, 'display_name_only');
});

test('resolution prefers a subject id over a username', () => {
  const strong = identityMatchStrength({ platform: 'telegram', subjectId: '1', username: 'a' }, { platform: 'telegram', subjectId: '1', username: 'b' });
  const weak = identityMatchStrength({ platform: 'telegram', username: 'a' }, { platform: 'telegram', username: 'a' });
  assert.equal(strong.basis, 'platform_subject_id');
  assert.equal(weak.basis, 'platform_username');
  assert.ok(strong.confidence > weak.confidence);
});

test('the same username on different platforms is not the same person', () => {
  assert.equal(identityMatchStrength({ platform: 'telegram', username: 'andrey' }, { platform: 'facebook', username: 'andrey' }).merge, false);
});

// --- account age (§20) ------------------------------------------------------

test('an unknown account creation date stays unknown', () => {
  const facts = accountAgeFacts({ firstObservedAt: daysAgo(10) });
  assert.equal(facts.accountCreatedAt, null);
  assert.equal(facts.accountCreatedAtKnown, false);
  assert.equal(facts.displayHint, 'account_created_unavailable');
  assert.equal(facts.firstObservedAt, daysAgo(10), 'first seen is reported separately, never as the age');
});

test('an authoritative creation date is reported as one', () => {
  const facts = accountAgeFacts({ accountCreatedAt: daysAgo(400), firstObservedAt: daysAgo(10) });
  assert.equal(facts.accountCreatedAtKnown, true);
  assert.equal(facts.displayHint, 'account_created_known');
});

// --- churn ------------------------------------------------------------------

const observe = (days, displayName, extra = {}) => ({ observedAt: daysAgo(days), displayName, ...extra });

test('cosmetic edits do not count as churn', () => {
  const churn = summarizeIdentityChurn([
    observe(6, 'Andrey'),
    observe(5, 'Andrey 🏠'),
    observe(4, 'ANDREY'),
    observe(3, 'Andrey ⭐'),
  ], { now: NOW });
  assert.equal(churn.displayNameChanges7d, 0, 'four edits, none of them a change of persona');
  assert.deepEqual(churn.reasons, []);
});

test('rapid semantic renames are flagged', () => {
  const churn = summarizeIdentityChurn([
    observe(6, 'Andrey'),
    observe(5, 'Anton'),
    observe(4, 'Oleg'),
    observe(3, 'Dmitry'),
  ], { now: NOW });
  assert.equal(churn.displayNameChanges7d, 3);
  assert.ok(churn.reasons.includes('rapid_display_name_churn'));
  assert.equal(churn.distinctHumanNames30d, 4);
});

test('owner to agent switching is called out specifically', () => {
  const churn = summarizeIdentityChurn([
    observe(20, 'Andrey', { claimedRole: 'owner' }),
    observe(10, 'Andrey', { claimedRole: 'agency' }),
  ], { now: NOW });
  assert.ok(churn.reasons.includes('owner_agent_role_switching'));
  assert.deepEqual(churn.roleSequence, ['owner->agency']);
});

test('several role changes are role rotation', () => {
  const churn = summarizeIdentityChurn([
    observe(25, 'A', { claimedRole: 'owner' }),
    observe(20, 'A', { claimedRole: 'agency' }),
    observe(15, 'A', { claimedRole: 'owner' }),
  ], { now: NOW });
  assert.equal(churn.roleChanges30d, 2);
  assert.ok(churn.reasons.includes('role_identity_rotation'));
});

test('many personas under one platform id are flagged', () => {
  const churn = summarizeIdentityChurn([
    observe(25, 'Andrey'), observe(20, 'Anton'), observe(15, 'Oleg'),
  ], { now: NOW });
  assert.ok(churn.reasons.includes('same_platform_id_multiple_personas'));
});

test('changes outside the window do not count', () => {
  const churn = summarizeIdentityChurn([
    observe(100, 'Andrey'), observe(90, 'Anton'), observe(80, 'Oleg'),
  ], { now: NOW });
  assert.equal(churn.displayNameChanges7d, 0);
  assert.equal(churn.displayNameChanges30d, 0);
  assert.equal(churn.distinctHumanNames30d, 0);
  assert.deepEqual(churn.reasons, []);
});

test('username churn is counted separately from display names', () => {
  const churn = summarizeIdentityChurn([
    { observedAt: daysAgo(5), displayName: 'Andrey', username: 'andrey_1' },
    { observedAt: daysAgo(4), displayName: 'Andrey', username: 'andrey_2' },
    { observedAt: daysAgo(3), displayName: 'Andrey', username: 'andrey_3' },
  ], { now: NOW });
  assert.equal(churn.usernameChanges7d, 2);
  assert.equal(churn.displayNameChanges7d, 0);
  assert.ok(churn.reasons.includes('rapid_username_churn'));
});

test('a stable identity produces no reasons at all', () => {
  const churn = summarizeIdentityChurn([
    observe(30, 'Andrey', { claimedRole: 'owner' }),
    observe(15, 'Andrey', { claimedRole: 'owner' }),
    observe(1, 'Andrey', { claimedRole: 'owner' }),
  ], { now: NOW });
  assert.deepEqual(churn.reasons, []);
  assert.equal(churn.observationCount, 3);
});

test('churn output states plainly that it is evidence', () => {
  const churn = summarizeIdentityChurn([observe(1, 'A')], { now: NOW });
  assert.equal(churn.evidenceOnly, true, 'no consumer should mistake this for a verdict');
  for (const reason of churn.reasons) assert.ok(CHURN_REASONS.includes(reason));
});

test('empty and malformed observations do not throw', () => {
  assert.equal(summarizeIdentityChurn([], { now: NOW }).observationCount, 0);
  assert.equal(summarizeIdentityChurn(null, { now: NOW }).observationCount, 0);
  assert.equal(summarizeIdentityChurn([{ observedAt: 'not a date', displayName: 'x' }], { now: NOW }).observationCount, 0);
});

test('thresholds are exposed so a reviewer can see what triggered a reason', () => {
  assert.ok(CHURN_THRESHOLDS.displayNameChanges7d >= 2, 'a single rename must never trigger anything');
  assert.ok(CHURN_THRESHOLDS.usernameChanges7d >= 2);
});

// --- contact mismatch -------------------------------------------------------

test('a contact naming someone else is a mismatch', () => {
  const result = detectContactIdentityMismatch({ accountDisplayName: 'Andrey', contactClaimedName: 'Oleg' });
  assert.equal(result.mismatch, true);
  assert.equal(result.reason, 'contact_channel_identity_mismatch');
});

test('a shortened or extended name is not a mismatch', () => {
  assert.equal(detectContactIdentityMismatch({ accountDisplayName: 'Andrey Ivanov', contactClaimedName: 'Andrey' }).mismatch, false);
  assert.equal(detectContactIdentityMismatch({ accountDisplayName: 'Andrey', contactClaimedName: 'Andrey Ivanov' }).mismatch, false);
});

test('a missing name is not a mismatch', () => {
  assert.equal(detectContactIdentityMismatch({ accountDisplayName: 'Andrey' }).mismatch, false);
  assert.equal(detectContactIdentityMismatch({}).mismatch, false);
});
