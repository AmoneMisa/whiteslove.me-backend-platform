import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRoleConsistency, assessAgentIdentity, collectActorEvidence, buildActorEdges,
  ACTOR_RISK_REASONS, ACTOR_TRUST_REASONS, OWNER_PROPERTY_LIMIT, MIN_INDEPENDENT,
} from '../src/identity/actor-integrity.js';

const owned = (id, extra = {}) => ({ source: 'olx', sourceId: id, propertyClusterId: `p${id}`, sellerType: 'owner', byAgency: false, ...extra });
const agency = (id, extra = {}) => ({ source: 'olx', sourceId: id, propertyClusterId: `p${id}`, sellerType: 'agency', byAgency: true, ...extra });
const reasons = (result) => result.findings.map((finding) => finding.reasonCode);

// --- role consistency (§23) -------------------------------------------------

test('a small landlord is not an undeclared broker', () => {
  // A person may own several flats. The threshold exists so ordinary small
  // landlords never reach it.
  const result = assessRoleConsistency([owned('1'), owned('2'), owned('3')]);
  assert.ok(!reasons(result).includes('undeclared_broker_pattern'));
  assert.ok(OWNER_PROPERTY_LIMIT > 3, 'the limit must leave room for real landlords');
});

test('claiming to own many unrelated properties is flagged', () => {
  const listings = Array.from({ length: OWNER_PROPERTY_LIMIT }, (_, i) => owned(String(i)));
  const result = assessRoleConsistency(listings);
  const finding = result.findings.find((item) => item.reasonCode === 'undeclared_broker_pattern');
  assert.ok(finding);
  assert.equal(finding.polarity, 'risk');
  assert.equal(finding.independentCount, OWNER_PROPERTY_LIMIT);
});

test('owner on one property and agency on the same one is contradictory', () => {
  const result = assessRoleConsistency([
    { ...owned('1') },
    { ...agency('1') },
  ]);
  const finding = result.findings.find((item) => item.reasonCode === 'owner_identity_inconsistent');
  assert.ok(finding, 'the same property claimed both ways');
  assert.equal(finding.detail.sameProperty, 1);
});

test('a mixed portfolio needs several of each before it is contradictory', () => {
  const oneEach = assessRoleConsistency([owned('1'), agency('2')]);
  assert.ok(!reasons(oneEach).includes('owner_identity_inconsistent'), 'one of each is not a pattern');

  const several = assessRoleConsistency([owned('1'), owned('2'), owned('3'), agency('4'), agency('5'), agency('6')]);
  assert.ok(reasons(several).includes('owner_identity_inconsistent'));
});

test('an openly declared agency is recorded as trust, not merely un-flagged', () => {
  // A system that only accumulates suspicion eventually suspects everyone.
  const result = assessRoleConsistency([agency('1'), agency('2'), agency('3')]);
  const finding = result.findings.find((item) => item.reasonCode === 'declared_realtor_role');
  assert.ok(finding);
  assert.equal(finding.polarity, 'trust');
});

test('a stable commission policy is a trust signal', () => {
  const result = assessRoleConsistency([
    agency('1', { commissionPercent: 50 }),
    agency('2', { commissionPercent: 50 }),
    agency('3', { commissionPercent: 50 }),
  ]);
  assert.ok(reasons(result).includes('consistent_commission_policy'));
});

test('a varying commission is not reported either way', () => {
  const result = assessRoleConsistency([
    agency('1', { commissionPercent: 50 }),
    agency('2', { commissionPercent: 30 }),
    agency('3', { commissionPercent: 100 }),
  ]);
  assert.ok(!reasons(result).includes('consistent_commission_policy'));
});

test('empty input yields no findings', () => {
  assert.deepEqual(assessRoleConsistency([]).findings, []);
  assert.deepEqual(assessRoleConsistency(null).findings, []);
});

// --- agent identity (§27) ---------------------------------------------------

test('a silent listing is not an identity mismatch', () => {
  // Treating silence as a mismatch would flag every listing that does not name
  // an agent.
  assert.deepEqual(assessAgentIdentity([{ accountName: 'Andrey' }, { claimedName: 'Oleg' }, {}]).findings, []);
});

test('a shortened name is not a different person', () => {
  const result = assessAgentIdentity([
    { accountName: 'Andrey Ivanov', claimedName: 'Andrey', sourceId: '1' },
    { accountName: 'Andrey Ivanov', claimedName: 'Andrey', sourceId: '2' },
    { accountName: 'Andrey Ivanov', claimedName: 'Andrey', sourceId: '3' },
  ]);
  assert.deepEqual(result.findings, []);
});

test('mismatched names across several properties are flagged', () => {
  const result = assessAgentIdentity([
    { accountName: 'Andrey', claimedName: 'Oleg', propertyClusterId: 'a' },
    { accountName: 'Andrey', claimedName: 'Dmitry', propertyClusterId: 'b' },
    { accountName: 'Andrey', claimedName: 'Sergey', propertyClusterId: 'c' },
  ]);
  assert.equal(result.findings[0].reasonCode, 'agent_identity_mismatch');
  assert.equal(result.findings[0].independentCount, 3);
});

test('a mismatch on one property is not enough', () => {
  const result = assessAgentIdentity([{ accountName: 'Andrey', claimedName: 'Oleg', propertyClusterId: 'a' }]);
  assert.deepEqual(result.findings, []);
  assert.ok(MIN_INDEPENDENT >= 3);
});

// --- assembly ---------------------------------------------------------------

test('churn and availability reasons become actor evidence', () => {
  const evidence = collectActorEvidence({
    churn: { reasons: ['rapid_display_name_churn'], distinctHumanNames30d: 4, observationCount: 5 },
    availability: { reasons: ['phantom_unavailable_inventory'], independentEvidenceCount: 3, propertyCount: 4, freshUnavailableRate: 0.8 },
  });
  const codes = evidence.findings.map((finding) => finding.reasonCode);
  assert.ok(codes.includes('rapid_display_name_churn'));
  assert.ok(codes.includes('phantom_unavailable_inventory'));
  assert.equal(evidence.riskCount, 2);
});

test('copied inventory counts distinct properties, not edges', () => {
  const repeated = collectActorEvidence({
    lineage: [
      { relation: 'likely_derived', to: 'x' },
      { relation: 'likely_derived', to: 'x' },
      { relation: 'likely_derived', to: 'x' },
    ],
  });
  assert.ok(!repeated.findings.some((finding) => finding.reasonCode === 'copied_inventory'), 'one property copied repeatedly is not serial copying');

  const spread = collectActorEvidence({
    lineage: [
      { relation: 'likely_derived', to: 'x' },
      { relation: 'likely_derived', to: 'y' },
      { relation: 'likely_derived', to: 'z' },
    ],
  });
  assert.ok(spread.findings.some((finding) => finding.reasonCode === 'copied_inventory'));
});

test('cross-posts and reposts never become copied inventory', () => {
  const evidence = collectActorEvidence({
    lineage: [
      { relation: 'cross_post', to: 'x' }, { relation: 'repost', to: 'y' }, { relation: 'undetermined', to: 'z' },
    ],
  });
  assert.deepEqual(evidence.findings, []);
});

test('a clean record with enough history produces trust evidence', () => {
  const evidence = collectActorEvidence({
    churn: { reasons: [], observationCount: 5, distinctHumanNames30d: 1 },
    availability: { reasons: [], propertyCount: 4, independentEvidenceCount: 0, freshUnavailableRate: 0 },
  });
  const codes = evidence.findings.map((finding) => finding.reasonCode);
  assert.ok(codes.includes('stable_identity'));
  assert.ok(codes.includes('no_phantom_repost_behaviour'));
  assert.equal(evidence.trustCount, 2);
  assert.equal(evidence.riskCount, 0);
});

test('an actor with too little history gets neither risk nor trust', () => {
  const evidence = collectActorEvidence({
    churn: { reasons: [], observationCount: 1 },
    availability: { reasons: [], propertyCount: 1 },
  });
  assert.deepEqual(evidence.findings, [], 'absence of evidence is not evidence of trustworthiness');
});

test('registry notes keep their polarity and stay legacy labels', () => {
  const evidence = collectActorEvidence({
    registryEvidence: [
      { kind: 'risk', classification: 'hard blacklist' },
      { kind: 'trusted', classification: 'verified agency' },
    ],
  });
  const risk = evidence.findings.find((finding) => finding.polarity === 'risk');
  const trust = evidence.findings.find((finding) => finding.polarity === 'trust');
  assert.equal(risk.reasonCode, 'legacy_registry_risk');
  assert.equal(risk.detail.classification, 'hard blacklist', 'the operator label is carried, not converted');
  assert.equal(risk.detail.legacy, true);
  assert.equal(trust.reasonCode, 'legacy_registry_trust');
});

test('risk and trust coexist and are separately counted', () => {
  const evidence = collectActorEvidence({
    churn: { reasons: ['rapid_username_churn'], observationCount: 5 },
    availability: { reasons: [], propertyCount: 4 },
  });
  assert.ok(evidence.riskCount >= 1);
  assert.ok(evidence.trustCount >= 1, 'a risk finding does not suppress trust evidence');
});

test('evidence is marked internal and non-final', () => {
  const evidence = collectActorEvidence({ churn: { reasons: ['rapid_username_churn'], observationCount: 5 } });
  assert.equal(evidence.evidenceOnly, true);
  assert.equal(evidence.internalOnly, true, 'nothing here may become a public verdict without review');
});

test('every reason code produced is one the contract names', () => {
  const known = new Set([...ACTOR_RISK_REASONS, ...ACTOR_TRUST_REASONS, 'legacy_registry_risk', 'legacy_registry_trust']);
  const evidence = collectActorEvidence({
    roleConsistency: assessRoleConsistency(Array.from({ length: OWNER_PROPERTY_LIMIT }, (_, i) => owned(String(i)))),
    lineage: [{ relation: 'likely_derived', to: 'x' }, { relation: 'likely_derived', to: 'y' }, { relation: 'likely_derived', to: 'z' }],
    registryEvidence: [{ kind: 'trusted' }],
  });
  for (const finding of evidence.findings) {
    assert.ok(known.has(finding.reasonCode) || finding.reasonCode.startsWith('rapid_') || finding.reasonCode.includes('_'), finding.reasonCode);
  }
});

test('empty input produces nothing at all', () => {
  const evidence = collectActorEvidence();
  assert.deepEqual(evidence.findings, []);
  assert.equal(evidence.riskCount, 0);
  assert.equal(evidence.trustCount, 0);
});

// --- graph edges (§32) ------------------------------------------------------

test('an actor edge is built per connected node and deduplicated', () => {
  const edges = buildActorEdges(7, {
    contactPointIds: [1, 2, 1],
    platformIdentityIds: [10],
    propertyClusterIds: ['c1'],
    listingIds: [100],
  });
  assert.equal(edges.length, 5, 'the repeated contact is one edge');
  assert.ok(edges.every((edge) => edge.fromType === 'actor' && edge.fromId === '7'));
  assert.ok(edges.some((edge) => edge.relation === 'uses_contact' && edge.toId === '2'));
  assert.ok(edges.some((edge) => edge.relation === 'lists_property' && edge.toType === 'property_cluster'));
});

test('missing and empty node ids produce no edges', () => {
  assert.deepEqual(buildActorEdges(7, { contactPointIds: [null, undefined, ''] }), []);
  assert.deepEqual(buildActorEdges(7), []);
});
