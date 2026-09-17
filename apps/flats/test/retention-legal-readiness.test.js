import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RETENTION_CLASSES, RETENTION_POLICY_VERSION, RETENTION_ACTIONS, buildRetentionBatch, retentionApproved, runRetention,
} from '../src/privacy/retention-policy.js';
import { checkLegalReadiness, formatReadinessReport } from '../src/privacy/legal-readiness.js';

// --- retention ---------------------------------------------------------------------

test('every data class has a bounded period or an explicit live-data justification', () => {
  for (const entry of RETENTION_CLASSES) {
    assert.ok(RETENTION_ACTIONS.includes(entry.action), entry.dataClass);
    assert.ok(entry.justification && entry.justification.length > 20, `${entry.dataClass} needs a written justification`);
    if (entry.periodDays === null) {
      assert.equal(entry.dataClass, 'listings_active', 'only live listings are tied to their source instead of a period');
    } else {
      assert.ok(entry.periodDays > 0 && entry.periodDays <= 3 * 365, `${entry.dataClass}: nothing is kept "forever"`);
    }
  }
});

test('the plan\'s data classes are all covered', () => {
  const classes = new Set(RETENTION_CLASSES.map((entry) => entry.dataClass));
  for (const required of [
    'listings_active', 'listing_snapshots_historical', 'contact_points_unobserved', 'identity_alias_history',
    'risk_evidence_unreviewed', 'trust_evidence', 'review_audit_events', 'privacy_requests_closed', 'technical_logs',
  ]) assert.ok(classes.has(required), required);
});

test('nothing is deleted without approval of this exact version', async () => {
  const client = { calls: 0, query: async () => { client.calls += 1; return { rowCount: 0 }; } };
  assert.equal(retentionApproved({}), false);
  assert.equal(retentionApproved({ PRIVACY_RETENTION_POLICY_APPROVED: 'true' }), false, 'a generic yes is not approval');
  assert.equal(retentionApproved({ PRIVACY_RETENTION_POLICY_APPROVED: '2026-01-draft-0' }), false, 'approving an old version does not approve edits');
  const refused = await runRetention(client, { env: {} });
  assert.equal(refused.error, 'retention_policy_not_approved');
  assert.equal(client.calls, 0);
  assert.equal(retentionApproved({ PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION }), true);
});

test('retention deletes in bounded batches by key', () => {
  const entry = RETENTION_CLASSES.find((item) => item.dataClass === 'identity_alias_history');
  const batch = buildRetentionBatch(entry, { batchSize: 50_000 });
  assert.match(batch.sql, /DELETE FROM platform\.platform_identity_observations\s+WHERE id IN \(/u);
  assert.match(batch.sql, /LIMIT \$2/u);
  assert.deepEqual(batch.params, [entry.periodDays, 10_000], 'batch size is capped');
});

test('evidence and contacts under an open dispute survive retention', () => {
  for (const dataClass of ['risk_evidence_dismissed', 'risk_evidence_unreviewed', 'risk_evidence_confirmed', 'trust_evidence', 'contact_points_unobserved']) {
    const sql = buildRetentionBatch(RETENTION_CLASSES.find((item) => item.dataClass === dataClass)).sql;
    assert.match(sql, /NOT EXISTS \(\s+SELECT 1 FROM platform\.dispute_cases d/u, dataClass);
  }
});

test('classes enforced elsewhere produce no statement', () => {
  for (const dataClass of ['listings_active', 'technical_logs', 'subscription_accounts', 'candidate_profiles']) {
    assert.equal(buildRetentionBatch(RETENTION_CLASSES.find((item) => item.dataClass === dataClass)), null, dataClass);
  }
});

test('an unsafe table identifier is refused', () => {
  assert.throws(() => buildRetentionBatch({ dataClass: 'x', table: 'listings; DROP TABLE listings', timeColumn: 'observed_at', periodDays: 1, action: 'delete' }));
});

test('an approved run drains each class and stops at the budget', async () => {
  const counts = [1000, 1000, 10];
  const client = { query: async () => ({ rowCount: counts.length ? counts.shift() : 0 }) };
  const classes = [RETENTION_CLASSES.find((item) => item.dataClass === 'scan_runs')];
  const result = await runRetention(client, { env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION }, classes });
  assert.deepEqual(result.report, [{ dataClass: 'scan_runs', deleted: 2010, batches: 3, exhausted: false }]);

  const endless = { query: async () => ({ rowCount: 1000 }) };
  const capped = await runRetention(endless, { env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION }, classes, maxBatchesPerClass: 2 });
  assert.equal(capped.report[0].exhausted, true);
});

// --- legal readiness -------------------------------------------------------------

const complete = {
  PRIVACY_CONTROLLER_NAME: 'Operator Name',
  PRIVACY_CONTACT_EMAIL: 'privacy@example.test',
  LEGAL_OPERATOR_TYPE: 'natural_person',
  LEGAL_GOVERNING_LAW: 'configured',
};
const decided = {
  LEGAL_DPO_ASSESSMENT: 'not_required',
  LEGAL_ARTICLE22_ASSESSMENT: 'no_significant_effects',
  LEGAL_ARTICLE27_ASSESSMENT: 'not_applicable',
  PRIVACY_DPIA_STATUS: 'approved',
  PRIVACY_LIA_STATUS: 'approved',
  PRIVACY_ARTICLE14_APPROACH: 'notices_sent',
};

test('blank configuration is not ready and names what is missing', () => {
  const report = checkLegalReadiness({});
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing.map((item) => item.name), ['PRIVACY_CONTROLLER_NAME', 'PRIVACY_CONTACT_EMAIL', 'LEGAL_OPERATOR_TYPE', 'LEGAL_GOVERNING_LAW']);
});

test('a natural person is not asked for company registration details', () => {
  const report = checkLegalReadiness(complete);
  assert.equal(report.publicPagesReady, true);
  assert.ok(!report.missing.some((item) => /REGISTRATION|REGISTERED/u.test(item.name)));
  const organization = checkLegalReadiness({ ...complete, LEGAL_OPERATOR_TYPE: 'organization' });
  assert.deepEqual(organization.missing.map((item) => item.name), ['LEGAL_REGISTERED_NAME', 'LEGAL_REGISTERED_ADDRESS', 'LEGAL_REGISTRATION_NUMBER']);
});

test('identity features need every legal review decision recorded', () => {
  const pending = checkLegalReadiness({ ...complete, PRIVACY_DPIA_STATUS: 'draft' }, { identityFeaturesEnabled: true });
  assert.equal(pending.ready, false);
  assert.ok(pending.openReviewItems.some((item) => item.name === 'PRIVACY_DPIA_STATUS'), 'a draft DPIA is not approval');
  assert.ok(pending.openReviewItems.some((item) => item.name === 'LEGAL_DPO_ASSESSMENT'));
  assert.equal(checkLegalReadiness({ ...complete, ...decided }, { identityFeaturesEnabled: true }).ready, true);
  assert.equal(checkLegalReadiness(complete, { identityFeaturesEnabled: false }).ready, true, 'plain aggregation does not wait on identity decisions');
});

test('invalid values are reported, and the report never prints values', () => {
  const report = checkLegalReadiness({ ...complete, PRIVACY_CONTACT_EMAIL: 'secret-not-an-email', LEGAL_OPERATOR_TYPE: 'company' });
  assert.deepEqual(report.invalid.map((item) => item.name), ['PRIVACY_CONTACT_EMAIL', 'LEGAL_OPERATOR_TYPE']);
  const text = formatReadinessReport(checkLegalReadiness({ ...complete, PRIVACY_CONTROLLER_NAME: 'Very Private Name' }));
  assert.ok(!text.includes('Very Private Name'));
  assert.ok(!text.includes('privacy@example.test'));
});

test('deploy runs the readiness preflight before migrating', async () => {
  const deploy = await readFile(new URL('../../../deploy.sh', import.meta.url), 'utf8');
  const preflight = deploy.indexOf('node src/check-legal-readiness.js');
  const migrate = deploy.indexOf('flats phase 1/5: migrate schema');
  assert.ok(preflight > 0 && preflight < migrate);
});
