import { pool } from '../infrastructure/database/pool.js';
import { planRegistryImport, reviewCasesFromReport } from './registry-import-plan.js';

/**
 * Writes a registry import plan.
 *
 * Every statement is a batch upsert keyed on the unique indexes from migration
 * 049, which is what makes a rerun idempotent: the same workbook produces the
 * same conflict keys, so a second run updates rows instead of adding any.
 *
 * A dry run plans and reports without writing, so an operator can see what an
 * import would do -- including its conflicts -- before it does it.
 */

const TAB_ORDER = ['clusters', 'evidence', 'identifiers', 'sources', 'cases'];

/** Actors are seeded per cluster, keyed by the legacy cluster id (§9), so a
 * rerun reuses the actor rather than minting a second identity for the same
 * person. */
async function seedActors(clusters, client) {
  if (!clusters.length) return new Map();
  const result = await client.query(
    `
      WITH input AS (
        SELECT * FROM unnest($1::text[], $2::varchar[]) AS t(cluster_id, country)
      ),
      created AS (
        INSERT INTO platform.actor_identities (actor_type, legacy_source, legacy_cluster_id)
        SELECT 'organization', 'google_sheet', cluster_id FROM input
        ON CONFLICT (legacy_source, legacy_cluster_id) WHERE legacy_cluster_id IS NOT NULL
          DO UPDATE SET last_seen_at = NOW()
        RETURNING id, legacy_cluster_id
      )
      SELECT id, legacy_cluster_id FROM created
    `,
    [clusters.map((cluster) => cluster.clusterId), clusters.map((cluster) => cluster.country ?? null)],
  );
  const byCluster = new Map();
  for (const row of result.rows) byCluster.set(row.legacy_cluster_id, Number(row.id));
  return byCluster;
}

async function writeClusters(clusters, actorsByCluster, client) {
  if (!clusters.length) return;
  await client.query(
    `
      INSERT INTO platform.registry_clusters
        (cluster_id, country, kind, identity, status, last_updated_text, actor_id)
      SELECT * FROM unnest($1::text[], $2::varchar[], $3::varchar[], $4::text[], $5::text[], $6::text[], $7::bigint[])
      ON CONFLICT (cluster_id) DO UPDATE
        SET country = COALESCE(EXCLUDED.country, platform.registry_clusters.country),
            kind = EXCLUDED.kind,
            identity = COALESCE(EXCLUDED.identity, platform.registry_clusters.identity),
            status = COALESCE(EXCLUDED.status, platform.registry_clusters.status),
            last_updated_text = COALESCE(EXCLUDED.last_updated_text, platform.registry_clusters.last_updated_text),
            actor_id = COALESCE(platform.registry_clusters.actor_id, EXCLUDED.actor_id),
            last_imported_at = NOW()
    `,
    [
      clusters.map((cluster) => cluster.clusterId),
      clusters.map((cluster) => cluster.country ?? null),
      clusters.map((cluster) => cluster.kind),
      clusters.map((cluster) => cluster.identity ?? null),
      clusters.map((cluster) => cluster.status ?? null),
      clusters.map((cluster) => cluster.lastUpdatedText ?? null),
      clusters.map((cluster) => actorsByCluster.get(cluster.clusterId) ?? null),
    ],
  );
}

async function writeEvidence(evidence, client) {
  if (!evidence.length) return;
  await client.query(
    `
      INSERT INTO platform.registry_evidence
        (cluster_id, kind, classification, evidence_text, confidence, content_hash)
      SELECT * FROM unnest($1::text[], $2::varchar[], $3::text[], $4::text[], $5::double precision[], $6::char(64)[])
      ON CONFLICT (cluster_id, kind, content_hash) DO UPDATE
        SET last_imported_at = NOW()
    `,
    [
      evidence.map((item) => item.clusterId),
      evidence.map((item) => item.kind),
      evidence.map((item) => item.classification ?? null),
      evidence.map((item) => item.evidenceText ?? null),
      evidence.map((item) => item.confidence ?? null),
      evidence.map((item) => item.contentHash),
    ],
  );
}

async function writeIdentifiers(identifiers, client) {
  if (!identifiers.length) return;
  await client.query(
    `
      INSERT INTO platform.registry_identifiers
        (cluster_id, country, identifier_type, canonical_value, raw_value, normalization_error, classification)
      SELECT * FROM unnest($1::text[], $2::varchar[], $3::varchar[], $4::text[], $5::text[], $6::text[], $7::text[])
      ON CONFLICT (cluster_id, identifier_type, canonical_value) DO UPDATE
        SET raw_value = EXCLUDED.raw_value,
            normalization_error = EXCLUDED.normalization_error,
            classification = COALESCE(EXCLUDED.classification, platform.registry_identifiers.classification),
            last_imported_at = NOW()
    `,
    [
      identifiers.map((item) => item.clusterId),
      identifiers.map((item) => item.country ?? null),
      identifiers.map((item) => item.identifierType),
      identifiers.map((item) => item.canonicalValue),
      identifiers.map((item) => item.rawValue),
      identifiers.map((item) => item.normalizationError ?? null),
      identifiers.map((item) => item.classification ?? null),
    ],
  );
}

async function writeSources(sources, client) {
  if (!sources.length) return;
  await client.query(
    `
      INSERT INTO platform.registry_sources
        (cluster_id, country, classification, url, legacy_ref, note, content_hash)
      SELECT * FROM unnest($1::text[], $2::varchar[], $3::text[], $4::text[], $5::text[], $6::text[], $7::char(64)[])
      ON CONFLICT (cluster_id, content_hash) DO UPDATE
        SET last_imported_at = NOW()
    `,
    [
      sources.map((item) => item.clusterId),
      sources.map((item) => item.country ?? null),
      sources.map((item) => item.classification ?? null),
      sources.map((item) => item.url ?? null),
      sources.map((item) => item.legacyRef ?? null),
      sources.map((item) => item.note ?? null),
      sources.map((item) => item.contentHash),
    ],
  );
}

async function writeReviewCases(cases, client) {
  if (!cases.length) return;
  await client.query(
    `
      INSERT INTO platform.registry_review_cases
        (case_type, country, subjects, reason, state, legacy_state_text, content_hash)
      SELECT * FROM unnest($1::text[], $2::varchar[], $3::text[], $4::text[], $5::varchar[], $6::text[], $7::char(64)[])
      ON CONFLICT (content_hash) DO UPDATE
        -- An operator may have moved a case on since the last import. Their
        -- decision wins over the sheet's stale state.
        SET last_imported_at = NOW()
    `,
    [
      cases.map((item) => item.caseType ?? null),
      cases.map((item) => item.country ?? null),
      cases.map((item) => item.subjects ?? null),
      cases.map((item) => item.reason ?? null),
      cases.map((item) => item.state),
      cases.map((item) => item.legacyStateText ?? null),
      cases.map((item) => item.contentHash),
    ],
  );
}

/** Links imported identifiers to contact points so the identity graph reaches
 * the registry's phones and handles. Only well-formed values are linked. */
async function linkIdentifierContacts(client) {
  await client.query(
    `
      UPDATE platform.registry_identifiers ri
      SET contact_point_id = cp.id
      FROM platform.contact_points cp
      WHERE ri.contact_point_id IS NULL
        AND ri.normalization_error IS NULL
        AND ri.identifier_type IN ('phone', 'telegram', 'email')
        AND cp.type = ri.identifier_type
        AND cp.canonical_value = ri.canonical_value
    `,
  );
}

/**
 * Runs an import.
 *
 * `dryRun` plans and reports without writing anything, which is what an
 * operator should run first.
 */
export async function importLegacyRegistry(tabs, options = {}) {
  const { dryRun = false, client = pool, now = () => new Date() } = options;
  const startedAt = now();
  const plan = planRegistryImport(tabs);

  // Conflicts the import itself found become review cases, because a conflict
  // nobody looks at is not a reconciliation.
  const derivedCases = reviewCasesFromReport(plan.report).map((item, index) => ({
    ...item,
    legacyStateText: null,
    contentHash: `${item.caseType}:${index}:${item.subjects}`.padEnd(64, '0').slice(0, 64),
  }));
  const allCases = [...plan.cases, ...derivedCases];

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      report: { ...plan.report, derivedReviewCases: derivedCases.length },
      written: Object.fromEntries(TAB_ORDER.map((key) => [key, 0])),
    };
  }

  const actorsByCluster = await seedActors(plan.clusters, client);
  await writeClusters(plan.clusters, actorsByCluster, client);
  await writeEvidence(plan.evidence, client);
  await writeIdentifiers(plan.identifiers, client);
  await writeSources(plan.sources, client);
  await writeReviewCases(allCases, client);
  await linkIdentifierContacts(client);

  const report = { ...plan.report, derivedReviewCases: derivedCases.length, actorsSeeded: actorsByCluster.size };
  const finishedAt = now();

  await client.query(
    `
      INSERT INTO platform.registry_import_runs (started_at, finished_at, dry_run, ok, report)
      VALUES ($1, $2, FALSE, TRUE, $3::jsonb)
    `,
    [startedAt, finishedAt, JSON.stringify(report)],
  );

  return {
    ok: true,
    dryRun: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    report,
    written: {
      clusters: plan.clusters.length,
      evidence: plan.evidence.length,
      identifiers: plan.identifiers.length,
      sources: plan.sources.length,
      cases: allCases.length,
    },
  };
}
