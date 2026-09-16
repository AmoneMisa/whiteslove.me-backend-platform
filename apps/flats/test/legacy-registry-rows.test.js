import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHeaderIndex, splitList, contentHash, classifySourceRef,
  normalizeIdentifier, inferIdentifierType,
  parseClusterRows, parseIdentifierRows, parseSourceRows, parseReviewRows,
} from '../src/registry/legacy-registry-rows.js';

// Fixtures follow the column names the plan documents for the existing
// workbook. Values are synthetic: no real registry content belongs in tests.
const RISK_HEADER = ['Cluster ID', 'Country', 'Classification', 'Identity', 'Aliases', 'Phones', 'Confidence', 'Evidence', 'Source URLs / refs', 'Status', 'Last updated'];
const TRUSTED_HEADER = ['Cluster ID', 'Country', 'Identity', 'Aliases', 'Phones', 'Evidence', 'Source URLs / refs', 'Status', 'Last updated'];
const IDENTIFIER_HEADER = ['Cluster ID', 'Country', 'Identifier type', 'Identifier', 'Classification'];
const SOURCE_HEADER = ['Cluster ID', 'Country', 'Classification', 'Source', 'Note'];
const REVIEW_HEADER = ['Type', 'Country', 'Clusters / identifiers', 'Reason', 'State'];

test('headers are matched despite case, spacing and punctuation', () => {
  const index = buildHeaderIndex(['  cluster_id ', 'COUNTRY', 'Source URLs / refs', 'Last Updated']);
  assert.equal(index.clusterId, 0);
  assert.equal(index.country, 1);
  assert.equal(index.sourceRefs, 2);
  assert.equal(index.lastUpdated, 3);
});

test('list cells split on commas, semicolons and newlines', () => {
  assert.deepEqual(splitList('a, b; c\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitList('  '), []);
  assert.deepEqual(splitList(null), []);
});

test('content hashes are stable across runs and differ on change', () => {
  assert.equal(contentHash('a', 'b'), contentHash('a', 'b'));
  assert.notEqual(contentHash('a', 'b'), contentHash('a', 'c'));
  assert.notEqual(contentHash('ab', ''), contentHash('a', 'b'), 'fields are delimited, not concatenated');
});

test('a legacy turn reference is kept opaque, not treated as a link', () => {
  assert.deepEqual(classifySourceRef('turn123search4'), { url: null, legacyRef: 'turn123search4' });
  assert.deepEqual(classifySourceRef('https://example.com/x'), { url: 'https://example.com/x', legacyRef: null });
  assert.deepEqual(classifySourceRef('some free note'), { url: null, legacyRef: null, note: 'some free note' });
  assert.equal(classifySourceRef(''), null);
});

test('phones normalise to E.164 and keep their original spelling', () => {
  const normalized = normalizeIdentifier('phone', '+998 90 123 45 67', 'UZ');
  assert.equal(normalized.canonicalValue, '+998901234567');
  assert.equal(normalized.rawValue, '+998 90 123 45 67');
  assert.equal(normalized.normalizationError, null);
});

test('an unparseable phone is recorded with an error, never dropped', () => {
  // §13 wants invalid identifiers listed in the report; silently discarding
  // them would hide sheet problems instead of surfacing them.
  const normalized = normalizeIdentifier('phone', 'call me maybe', 'UZ');
  assert.ok(normalized);
  assert.equal(normalized.normalizationError, 'phone_unparseable');
  assert.equal(normalized.rawValue, 'call me maybe');
});

test('telegram handles lose the @ and are lowercased', () => {
  assert.equal(normalizeIdentifier('telegram', '@RealtorAndrey').canonicalValue, 'realtorandrey');
  assert.equal(normalizeIdentifier('telegram', 'https://t.me/RealtorAndrey').canonicalValue, 'realtorandrey');
});

test('identifier types are inferred only when the sheet does not say', () => {
  assert.equal(inferIdentifierType('+998901234567'), 'phone');
  assert.equal(inferIdentifierType('@andrey'), 'telegram');
  assert.equal(inferIdentifierType('a@b.com'), 'email');
  assert.equal(inferIdentifierType('Andrey Ivanov'), 'name');
});

test('risk clusters yield a cluster, its evidence and its identifiers', () => {
  const parsed = parseClusterRows([
    RISK_HEADER,
    ['uz_001', 'uz', 'hidden realtor/operator', 'Agency A', 'Andrey, @agencya', '+998901234567', '0.8', 'Posted same flat under three names', 'turn123search4', 'active', '2026-01-02'],
  ], 'risk');

  assert.equal(parsed.clusters.length, 1);
  assert.equal(parsed.clusters[0].clusterId, 'uz_001');
  assert.equal(parsed.clusters[0].country, 'UZ');
  assert.equal(parsed.clusters[0].kind, 'risk');

  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].kind, 'risk');
  assert.equal(parsed.evidence[0].classification, 'hidden realtor/operator', 'the legacy label is carried verbatim');
  assert.equal(parsed.evidence[0].confidence, 0.8);

  const values = parsed.identifiers.map((item) => item.canonicalValue);
  assert.ok(values.includes('+998901234567'));
  assert.ok(values.includes('andrey'));
  assert.ok(values.includes('agencya'));
});

test('a classification is never mapped onto a verdict vocabulary', () => {
  for (const label of ['hard blacklist', 'high-risk', 'hidden realtor/operator', 'something new']) {
    const parsed = parseClusterRows([RISK_HEADER, ['c1', 'uz', label, '', '', '', '', 'e', '', '', '']], 'risk');
    assert.equal(parsed.evidence[0].classification, label, `${label} must survive unchanged`);
  }
});

test('trusted rows produce trusted evidence, not the absence of risk', () => {
  const parsed = parseClusterRows([
    TRUSTED_HEADER,
    ['uz_900', 'uz', 'Agency B', 'Boris', '+998901112233', 'Consistent commission policy', 'https://example.com/b', 'active', '2026-01-03'],
  ], 'trusted');
  assert.equal(parsed.clusters[0].kind, 'trusted');
  assert.equal(parsed.evidence[0].kind, 'trusted');
  assert.equal(parsed.evidence[0].evidenceText, 'Consistent commission policy');
});

test('confidence accepts 0-1 and percentages, and rejects nonsense', () => {
  const one = parseClusterRows([RISK_HEADER, ['c', 'uz', 'x', '', '', '', '0,75', 'e', '', '', '']], 'risk');
  assert.equal(one.evidence[0].confidence, 0.75, 'a decimal comma is accepted');
  const percent = parseClusterRows([RISK_HEADER, ['c', 'uz', 'x', '', '', '', '80%', 'e', '', '', '']], 'risk');
  assert.equal(percent.evidence[0].confidence, 0.8);
  const bad = parseClusterRows([RISK_HEADER, ['c', 'uz', 'x', '', '', '', 'very sure', 'e', '', '', '']], 'risk');
  assert.equal(bad.evidence[0].confidence, null, 'an unreadable confidence is null, not invented');
});

test('a row with no cluster id is reported rather than silently skipped', () => {
  const parsed = parseClusterRows([RISK_HEADER, ['', 'uz', 'high-risk', 'Someone', '', '', '', 'evidence', '', '', '']], 'risk');
  assert.deepEqual(parsed.clusters, []);
  assert.equal(parsed.problems[0].kind, 'missing_cluster_id');
});

test('a fully empty row is not a problem, just skipped', () => {
  const parsed = parseClusterRows([RISK_HEADER, ['', '', '', '', '', '', '', '', '', '', '']], 'risk');
  assert.deepEqual(parsed.clusters, []);
  assert.deepEqual(parsed.problems, []);
});

test('the identifiers tab honours its own type column over inference', () => {
  const parsed = parseIdentifierRows([
    IDENTIFIER_HEADER,
    ['uz_001', 'uz', 'organization', 'Agency A', 'hidden realtor/operator'],
    ['uz_001', 'uz', '', '+998901234567', ''],
  ]);
  assert.equal(parsed.identifiers[0].identifierType, 'organization', 'not inferred as a name');
  assert.equal(parsed.identifiers[1].identifierType, 'phone');
  assert.equal(parsed.identifiers[1].inferredType, true, 'inference is flagged so the report can show it');
});

test('the same phone in two clusters is preserved as two records to reconcile', () => {
  // §63: conflicting clusters must not be silently merged.
  const parsed = parseIdentifierRows([
    IDENTIFIER_HEADER,
    ['uz_001', 'uz', 'phone', '+998901234567', 'high-risk'],
    ['uz_900', 'uz', 'phone', '+998901234567', 'trusted'],
  ]);
  assert.equal(parsed.identifiers.length, 2);
  assert.deepEqual(parsed.identifiers.map((item) => item.clusterId), ['uz_001', 'uz_900']);
});

test('sources split multiple refs and separate URLs from legacy references', () => {
  const parsed = parseSourceRows([
    SOURCE_HEADER,
    ['uz_001', 'uz', 'high-risk', 'https://example.com/a, turn123search4', 'seen twice'],
  ]);
  assert.equal(parsed.sources.length, 2);
  assert.equal(parsed.sources[0].url, 'https://example.com/a');
  assert.equal(parsed.sources[0].legacyRef, null);
  assert.equal(parsed.sources[1].legacyRef, 'turn123search4');
  assert.equal(parsed.sources[1].url, null);
});

test('review rows map states and keep the original wording', () => {
  const parsed = parseReviewRows([
    REVIEW_HEADER,
    ['dedupe uncertainty', 'uz', 'uz_001, uz_002', 'Two clusters share a phone', 'Watch'],
    ['migration gap', 'kz', 'kz_010', 'No source captured', 'Done'],
  ]);
  assert.equal(parsed.cases[0].state, 'watch');
  assert.equal(parsed.cases[0].legacyStateText, 'Watch');
  assert.equal(parsed.cases[0].reason, 'Two clusters share a phone', 'reason text is preserved verbatim');
  assert.equal(parsed.cases[1].state, 'resolved');
});

test('an unrecognised review state stays open rather than assumed resolved', () => {
  const parsed = parseReviewRows([REVIEW_HEADER, ['x', 'uz', 'uz_001', 'Something', 'на проверке']]);
  assert.equal(parsed.cases[0].state, 'open', 'guessing the other way would silently close a real case');
  assert.equal(parsed.cases[0].legacyStateText, 'на проверке');
  assert.equal(parsed.problems[0].kind, 'unknown_review_state');
});

test('parsing the same rows twice yields identical hashes, so a rerun is idempotent', () => {
  const rows = [RISK_HEADER, ['uz_001', 'uz', 'high-risk', 'A', 'Andrey', '+998901234567', '0.8', 'evidence', 'turn1search2', 'active', '2026-01-02']];
  const first = parseClusterRows(rows, 'risk');
  const second = parseClusterRows(rows, 'risk');
  assert.deepEqual(first.evidence.map((item) => item.contentHash), second.evidence.map((item) => item.contentHash));
  assert.deepEqual(first.identifiers, second.identifiers);
});

test('empty tabs parse to empty results without throwing', () => {
  assert.deepEqual(parseClusterRows([], 'risk').clusters, []);
  assert.deepEqual(parseIdentifierRows([IDENTIFIER_HEADER]).identifiers, []);
  assert.deepEqual(parseSourceRows(null).sources, []);
  assert.deepEqual(parseReviewRows([REVIEW_HEADER]).cases, []);
});
