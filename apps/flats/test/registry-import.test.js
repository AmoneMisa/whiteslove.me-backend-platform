import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { planRegistryImport, reviewCasesFromReport } from '../src/registry/registry-import-plan.js';
import { importLegacyRegistry } from '../src/registry/registry-importer.js';
import { createSheetsReader, readRegistryTabs, REGISTRY_TABS } from '../src/registry/sheets-reader.js';

// Synthetic fixtures of the documented tab shapes. No real registry content.
const RISK_HEADER = ['Cluster ID', 'Country', 'Classification', 'Identity', 'Aliases', 'Phones', 'Confidence', 'Evidence', 'Source URLs / refs', 'Status', 'Last updated'];
const TRUSTED_HEADER = ['Cluster ID', 'Country', 'Identity', 'Aliases', 'Phones', 'Evidence', 'Source URLs / refs', 'Status', 'Last updated'];
const IDENTIFIER_HEADER = ['Cluster ID', 'Country', 'Identifier type', 'Identifier', 'Classification'];
const SOURCE_HEADER = ['Cluster ID', 'Country', 'Classification', 'Source', 'Note'];
const REVIEW_HEADER = ['Type', 'Country', 'Clusters / identifiers', 'Reason', 'State'];

const TABS = {
  risk: [
    RISK_HEADER,
    ['uz_001', 'uz', 'hidden realtor/operator', 'Agency A', 'Andrey', '+998901234567', '0.8', 'Same flat under three names', 'turn123search4', 'active', '2026-01-02'],
  ],
  trusted: [
    TRUSTED_HEADER,
    ['uz_900', 'uz', 'Agency B', 'Boris', '+998901112233', 'Consistent commission policy', 'https://example.com/b', 'active', '2026-01-03'],
  ],
  identifiers: [
    IDENTIFIER_HEADER,
    ['uz_001', 'uz', 'telegram', '@agencya', 'hidden realtor/operator'],
  ],
  sources: [
    SOURCE_HEADER,
    ['uz_001', 'uz', 'high-risk', 'https://example.com/a', 'seen twice'],
  ],
  review: [
    REVIEW_HEADER,
    ['dedupe uncertainty', 'uz', 'uz_001', 'Two clusters share a phone', 'Open'],
  ],
};

function fakeClient(rowsByPattern = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const match = rowsByPattern.find((entry) => entry.pattern.test(text));
      return { rows: match?.rows ?? [], rowCount: match?.rows?.length ?? 0 };
    },
  };
}

// --- planning ---------------------------------------------------------------

test('a plan counts every tab it read', () => {
  const { report } = planRegistryImport(TABS);
  assert.equal(report.counts.riskClusters, 1);
  assert.equal(report.counts.trustedClusters, 1);
  assert.equal(report.counts.clusters, 2);
  assert.equal(report.counts.reviewCases, 1);
  assert.ok(report.counts.identifiers >= 3, 'aliases, phones and the identifiers tab all contribute');
});

test('risk and trusted evidence stay separate kinds', () => {
  const plan = planRegistryImport(TABS);
  const kinds = plan.evidence.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['risk', 'trusted'], 'never collapsed into one blacklist');
});

test('a cluster in both tabs keeps both kinds and is reported, not merged away', () => {
  const tabs = {
    ...TABS,
    trusted: [TRUSTED_HEADER, ['uz_001', 'uz', 'Agency A', '', '', 'Long-standing agency', '', 'active', '2026-01-04']],
  };
  const plan = planRegistryImport(tabs);
  const cluster = plan.clusters.find((item) => item.clusterId === 'uz_001');
  assert.equal(cluster.kind, 'both');
  assert.deepEqual(plan.report.conflicts.clustersWithRiskAndTrust, ['uz_001']);
  assert.equal(plan.evidence.filter((item) => item.clusterId === 'uz_001').length, 2, 'both notes survive');
});

test('the same identifier in two clusters is reported, never merged', () => {
  const tabs = {
    ...TABS,
    identifiers: [
      IDENTIFIER_HEADER,
      ['uz_001', 'uz', 'phone', '+998901234567', 'high-risk'],
      ['uz_900', 'uz', 'phone', '+998901234567', 'trusted'],
    ],
  };
  const { report } = planRegistryImport(tabs);
  const shared = report.conflicts.sharedIdentifiers.find((item) => item.canonicalValue === '+998901234567');
  assert.ok(shared, 'the conflict is surfaced');
  assert.deepEqual(shared.clusterIds, ['uz_001', 'uz_900']);
});

test('a row referencing an undefined cluster keeps its evidence under a placeholder', () => {
  const tabs = { ...TABS, sources: [SOURCE_HEADER, ['uz_missing', 'uz', 'x', 'https://example.com/z', '']] };
  const plan = planRegistryImport(tabs);
  assert.deepEqual(plan.report.conflicts.orphanClusterIds, ['uz_missing']);
  const placeholder = plan.clusters.find((item) => item.clusterId === 'uz_missing');
  assert.equal(placeholder.orphan, true, 'the source row is not dropped');
  assert.equal(placeholder.status, 'orphan_from_import');
});

test('identifiers that cannot be normalised are reported, not discarded', () => {
  const tabs = { ...TABS, identifiers: [IDENTIFIER_HEADER, ['uz_001', 'uz', 'phone', 'call me maybe', '']] };
  const { report } = planRegistryImport(tabs);
  assert.equal(report.invalidIdentifiers.length, 1);
  assert.equal(report.invalidIdentifiers[0].error, 'phone_unparseable');
  assert.equal(report.invalidIdentifiers[0].rawValue, 'call me maybe');
});

test('planning the same workbook twice produces an identical plan', () => {
  // The basis of a rerunnable import: same input, same conflict keys.
  const first = planRegistryImport(TABS);
  const second = planRegistryImport(TABS);
  assert.deepEqual(first.clusters, second.clusters);
  assert.deepEqual(first.evidence, second.evidence);
  assert.deepEqual(first.identifiers, second.identifiers);
  assert.deepEqual(first.report, second.report);
});

test('missing tabs plan as empty rather than throwing', () => {
  const plan = planRegistryImport({ risk: TABS.risk });
  assert.equal(plan.report.counts.trustedClusters, 0);
  assert.deepEqual(plan.cases, []);
  assert.deepEqual(planRegistryImport({}).clusters, []);
  assert.deepEqual(planRegistryImport().clusters, []);
});

test('every conflict becomes an open review case', () => {
  const cases = reviewCasesFromReport({
    conflicts: {
      clustersWithRiskAndTrust: ['uz_001'],
      sharedIdentifiers: [{ identifierType: 'phone', canonicalValue: '+998901234567', clusterIds: ['a', 'b'] }],
      orphanClusterIds: ['uz_missing'],
    },
    invalidIdentifiers: [{ clusterId: 'uz_001', identifierType: 'phone', rawValue: 'x', error: 'phone_unparseable' }],
  });
  assert.deepEqual(cases.map((item) => item.caseType), ['risk_and_trust_conflict', 'shared_identifier', 'orphan_cluster_id', 'invalid_identifier']);
  for (const item of cases) assert.equal(item.state, 'open', 'a conflict nobody looks at is not a reconciliation');
});

test('a risk-and-trust conflict is described as needing a decision, not as a verdict', () => {
  const [item] = reviewCasesFromReport({ conflicts: { clustersWithRiskAndTrust: ['uz_001'] } });
  assert.match(item.reason, /Both are retained/);
  assert.match(item.reason, /operator decides/);
});

// --- writing ----------------------------------------------------------------

test('a dry run reports without writing anything', async () => {
  const client = fakeClient();
  const result = await importLegacyRegistry(TABS, { dryRun: true, client });
  assert.equal(client.calls.length, 0, 'nothing touched the database');
  assert.equal(result.dryRun, true);
  assert.ok(result.report.counts.clusters > 0, 'but the operator still sees what would happen');
});

test('an import writes one batch statement per entity kind', async () => {
  const client = fakeClient([{ pattern: /INSERT INTO platform\.actor_identities/, rows: [{ id: 1, legacy_cluster_id: 'uz_001' }, { id: 2, legacy_cluster_id: 'uz_900' }] }]);
  await importLegacyRegistry(TABS, { client });
  const inserts = client.calls.filter((call) => /INSERT INTO/.test(call.text));
  // actors, clusters, evidence, identifiers, sources, cases, import run.
  assert.equal(inserts.length, 7, 'batched, not one statement per row');
  for (const call of inserts.slice(0, 6)) {
    if (/registry_import_runs/.test(call.text)) continue;
    assert.match(call.text, /unnest\(/, 'rows are expanded server-side');
  }
});

test('every write is an upsert keyed on its unique index, so a rerun adds nothing', async () => {
  const client = fakeClient([{ pattern: /actor_identities/, rows: [{ id: 1, legacy_cluster_id: 'uz_001' }] }]);
  await importLegacyRegistry(TABS, { client });
  const expectations = [
    [/registry_clusters/, /ON CONFLICT \(cluster_id\) DO UPDATE/],
    [/registry_evidence/, /ON CONFLICT \(cluster_id, kind, content_hash\) DO UPDATE/],
    [/registry_identifiers/, /ON CONFLICT \(cluster_id, identifier_type, canonical_value\) DO UPDATE/],
    [/registry_sources/, /ON CONFLICT \(cluster_id, content_hash\) DO UPDATE/],
    [/registry_review_cases/, /ON CONFLICT \(content_hash\) DO UPDATE/],
  ];
  for (const [table, conflict] of expectations) {
    const call = client.calls.find((entry) => table.test(entry.text) && /INSERT INTO/.test(entry.text));
    assert.ok(call, `${table} is written`);
    assert.match(call.text, conflict);
  }
});

test('actors are seeded against the legacy cluster id, not minted per run', async () => {
  const client = fakeClient([{ pattern: /actor_identities/, rows: [{ id: 9, legacy_cluster_id: 'uz_001' }] }]);
  const result = await importLegacyRegistry(TABS, { client });
  const call = client.calls.find((entry) => /actor_identities/.test(entry.text));
  assert.match(call.text, /ON CONFLICT \(legacy_source, legacy_cluster_id\)/);
  assert.equal(result.report.actorsSeeded, 1);
});

test('an operator decision on a review case survives a reimport', async () => {
  const client = fakeClient();
  await importLegacyRegistry(TABS, { client });
  const call = client.calls.find((entry) => /registry_review_cases/.test(entry.text) && /INSERT INTO/.test(entry.text));
  assert.doesNotMatch(call.text, /SET state/, 'the sheet must not reopen a case an operator resolved');
});

test('the import records a run with its report', async () => {
  const client = fakeClient();
  const result = await importLegacyRegistry(TABS, { client });
  const call = client.calls.find((entry) => /registry_import_runs/.test(entry.text));
  assert.ok(call, 'the run is auditable');
  assert.ok(result.written.clusters > 0);
});

// --- sheets reader ----------------------------------------------------------

test('the reader refuses to start without configuration', () => {
  assert.throws(() => createSheetsReader({ sheetId: '' }), /REGISTRY_GOOGLE_SHEET_ID/);
});

test('all tabs are fetched in one batch request', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return {
      ok: true,
      json: async () => ({
        valueRanges: [
          { range: "'Risk clusters'!A1:Z2", values: TABS.risk },
          { range: 'Trusted!A1:Z2', values: TABS.trusted },
        ],
      }),
    };
  };
  const reader = createSheetsReader({ sheetId: 'sheet-id', serviceAccount: { clientEmail: 'x@y', privateKey: 'k' }, fetchImpl });
  reader.readTabs = async (names) => {
    const response = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/sheet-id/values:batchGet?${names.map((n) => `ranges=${n}`).join('&')}`);
    const payload = await response.json();
    const byName = {};
    for (const range of payload.valueRanges) byName[String(range.range).split('!')[0].replace(/^'|'$/g, '')] = range.values;
    return byName;
  };
  const tabs = await readRegistryTabs(reader);
  assert.equal(requests.filter((url) => url.includes('batchGet')).length, 1, 'one call, not one per tab');
  assert.deepEqual(tabs.risk, TABS.risk);
  assert.deepEqual(tabs.identifiers, [], 'a tab the workbook did not return is empty, not undefined');
});

test('tab names match the workbook the plan documents', () => {
  assert.deepEqual(Object.values(REGISTRY_TABS), ['Risk clusters', 'Trusted', 'Aliases & phones', 'Sources', 'Review']);
});

// A real key, so the RS256 assertion is genuinely signed rather than stubbed.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const serviceAccount = { clientEmail: 'importer@example.iam.gserviceaccount.com', privateKey };

test('a failed read reports the status without echoing the response body', async () => {
  // The token endpoint can echo the signed assertion back in an error body,
  // so only the status may be reported.
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: false, status: 403, json: async () => ({ error: 'contains the assertion' }) };
  };
  const reader = createSheetsReader({ sheetId: 'x', serviceAccount, fetchImpl });
  await assert.rejects(() => reader.readTabs(['Trusted']), (error) => {
    assert.match(error.message, /Viewer access/);
    assert.doesNotMatch(error.message, /assertion/, 'the response body is never echoed');
    return true;
  });
});

test('a missing workbook and a token failure are distinguishable', async () => {
  const withStatus = (status) => createSheetsReader({
    sheetId: 'x',
    serviceAccount,
    fetchImpl: async (url) => (String(url).includes('oauth2')
      ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }
      : { ok: false, status, json: async () => ({}) }),
  });
  await assert.rejects(() => withStatus(404).readTabs(['Trusted']), /does not resolve to a workbook/);
  await assert.rejects(() => withStatus(500).readTabs(['Trusted']), /status 500/);

  const badToken = createSheetsReader({
    sheetId: 'x',
    serviceAccount,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(() => badToken.readTabs(['Trusted']), /token exchange failed with status 401/);
});

test('one access token serves the whole import', async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) { tokenCalls += 1; return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }; }
    return { ok: true, json: async () => ({ valueRanges: [] }) };
  };
  const reader = createSheetsReader({ sheetId: 'x', serviceAccount, fetchImpl });
  await reader.readTabs(['Trusted']);
  await reader.readTabs(['Sources']);
  assert.equal(tokenCalls, 1, 'the token is cached for its lifetime');
});

test('reading no tabs makes no request at all', async () => {
  let calls = 0;
  const reader = createSheetsReader({ sheetId: 'x', serviceAccount, fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; } });
  assert.deepEqual(await reader.readTabs([]), {});
  assert.equal(calls, 0);
});
