import { pool } from './pool.js';

/**
 * Inputs for listing lines, for a whole feed page in two queries.
 *
 * `contacts` are `{ contact, type, canonicalValue }` per listing, where
 * `contact` is the stored `listings.data->>'contact'` string. Results are
 * keyed by that string.
 *
 * Query 1 counts other distinct properties per contact through the partial
 * expression index from migration 056. Query 2 walks contact point -> actor ->
 * evidence through the existing unique and reverse indexes, and brings the
 * actor's restriction and objection flags and open disputes with it.
 */
export async function loadListingLineInputs(contacts, client = pool) {
  const rows = (contacts ?? []).filter((item) => item?.contact);
  const byContact = new Map();
  if (!rows.length) return byContact;

  const uniqueContacts = [...new Set(rows.map((row) => row.contact))];
  const points = [...new Map(rows
    .filter((row) => row.type && row.canonicalValue)
    .map((row) => [`${row.type} ${row.canonicalValue}`, row])).values()];

  const [counts, evidence] = await Promise.all([
    client.query(
      `
        SELECT data->>'contact' AS contact, count(DISTINCT dedupe_key)::int AS properties
        FROM listings
        WHERE active = TRUE AND data->>'contact' = ANY($1::text[])
        GROUP BY data->>'contact'
      `,
      [uniqueContacts],
    ),
    points.length
      ? client.query(
        `
          SELECT i.type, i.value,
                 (a.processing_restricted_at IS NOT NULL OR a.processing_objection_at IS NOT NULL
                   OR c.processing_restricted_at IS NOT NULL) AS restricted,
                 e.id, e.polarity, e.reason_code, e.dimension, e.independent_count, e.review_state, e.last_observed_at,
                 EXISTS (
                   SELECT 1 FROM platform.dispute_cases d
                   WHERE d.status IN ('open', 'in_review')
                     AND (d.evidence_id = e.id OR (d.actor_id = a.id AND d.dispute_type <> 'incorrect_risk_evidence'))
                 ) AS under_dispute
          FROM unnest($1::varchar[], $2::text[]) AS i(type, value)
          JOIN platform.contact_points c ON c.type = i.type AND c.canonical_value = i.value
          JOIN platform.actor_contact_points l ON l.contact_point_id = c.id
          JOIN platform.actor_identities a ON a.id = l.actor_id
          LEFT JOIN platform.actor_evidence e ON e.actor_id = a.id
        `,
        [points.map((row) => row.type), points.map((row) => row.canonicalValue)],
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const propertiesByContact = new Map(counts.rows.map((row) => [row.contact, Number(row.properties) || 0]));
  const evidenceByPoint = new Map();
  for (const row of evidence.rows) {
    const key = `${row.type} ${row.value}`;
    const entry = evidenceByPoint.get(key) ?? { restricted: false, evidence: [] };
    entry.restricted ||= row.restricted === true;
    if (row.id !== null && row.id !== undefined) {
      entry.evidence.push({
        id: Number(row.id),
        polarity: row.polarity,
        reasonCode: row.reason_code,
        dimension: row.dimension,
        independentCount: Number(row.independent_count),
        reviewState: row.review_state,
        lastObservedAt: row.last_observed_at,
        underDispute: row.under_dispute === true,
      });
    }
    evidenceByPoint.set(key, entry);
  }

  for (const row of rows) {
    if (byContact.has(row.contact)) continue;
    // Distinct properties (dedupe keys), so a flat reposted or cross-posted
    // counts once. The listing being shown is active and is one of them,
    // hence minus one.
    const otherProperties = Math.max(0, (propertiesByContact.get(row.contact) ?? 0) - 1);
    const point = evidenceByPoint.get(`${row.type} ${row.canonicalValue}`) ?? { restricted: false, evidence: [] };
    byContact.set(row.contact, { otherProperties, restricted: point.restricted, evidence: point.evidence });
  }
  return byContact;
}
