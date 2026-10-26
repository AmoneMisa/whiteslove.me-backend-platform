import {pool} from './pool.js';
import {attachContactActions} from '../../listing/listing-contact-actions.js';
import {findProbableOriginal} from '../../listing/probable-original.js';

export function snapshotEvents(rows) {
  return rows.flatMap((row) => {
    const kinds = [];
    const changed = row.changed || [];
    if (changed.includes('published') && row.is_repost) kinds.push('reposted');
    if (row.lifecycle_state === 'reappeared') kinds.push('reappeared');
    else if (row.lifecycle_state === 'removed') kinds.push('removed');
    if (changed.includes('publication')) kinds.push('date_updated');
    if (changed.includes('price')) kinds.push('price_changed');
    if (changed.includes('contact')) kinds.push('contact_changed');
    if (changed.includes('content')) kinds.push('content_changed');
    return kinds.map((kind) => ({
      id: `${row.id}:${kind}`, kind, observedAt: row.observed_at,
      sourcePublishedAt: row.source_published_at,
      ...(kind === 'price_changed' ? {price: row.price, currency: row.currency} : {}),
    }));
  });
}

const contactKey = (row) => {
  const contact = String(row.data?.contact || '').trim();
  if (/^\+[1-9]\d{6,14}$/u.test(contact)) return contact;
  if (/^@[a-z0-9_]{5,32}$/iu.test(contact)) return contact.toLowerCase();
  return null;
};
const finiteAmount = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

/** Public contacts only, no actor graph, private identifiers, or inferred owner labels. */
export function groupDuplicateListings(rows, currentId) {
  const current = rows.find((row) => Number(row.id) === Number(currentId));
  const currentContact = current && contactKey(current);
  const groups = new Map();
  for (const row of rows) {
    const contact = contactKey(row);
    const key = contact || `unknown:${row.id}`;
    if (!groups.has(key)) groups.set(key, {
      key: `group-${groups.size + 1}`, contact,
      sameAdvertiser: Boolean(contact && currentContact && contact === currentContact),
      listings: [],
    });
    groups.get(key).listings.push({
      ...attachContactActions({
        id: String(row.source_id), publicId: Number(row.id), source: row.source,
        title: row.data?.title || '', url: row.data?.url || null,
        contact: contact || undefined,
      }),
      price: row.price, currency: row.currency, active: row.active,
      firstSeenAt: row.first_seen_at, sourcePublishedAt: row.created_at,
      advertiserType: row.data?.sellerType === 'agency' || row.data?.byAgency === true ? 'agency'
        : row.data?.sellerType === 'owner' ? 'owner_claim' : 'unknown',
      commission: typeof row.data?.commission === 'boolean' ? row.data.commission : null,
      commissionPercent: finiteAmount(row.data?.commissionPercent),
      commissionAmount: finiteAmount(row.data?.commissionAmount?.amount) == null ? null : {
        amount: finiteAmount(row.data.commissionAmount.amount),
        currency: typeof row.data.commissionAmount.currency === 'string' ? row.data.commissionAmount.currency : null,
      },
      matchKind: Number(row.id) === Number(currentId) ? 'current' : row.match_kind || 'fingerprint',
      current: Number(row.id) === Number(currentId),
    });
  }
  return [...groups.values()];
}

export async function readListingActivity(publicId, {before, limit = 40} = {}, client = pool) {
  const base = await client.query(`SELECT l.id, min(r.first_seen_at) AS first_seen_at,
    array_agg(r.id) AS history_ids FROM listings l JOIN listings r ON r.id = l.id OR (
      r.dedupe_key = l.dedupe_key AND r.source = l.source
      AND l.data->>'contact' ~* '^(\\+[1-9][0-9]{6,14}|@[a-z0-9_]{5,32})$'
      AND lower(r.data->>'contact') = lower(l.data->>'contact'))
    WHERE l.id = $1 GROUP BY l.id`, [publicId]);
  if (!base.rows[0]) return null;
  const cursor = before && /^\d{1,19}$/u.test(String(before)) ? String(before) : null;
  const result = await client.query(`
    SELECT s.id, s.observed_at, s.lifecycle_state, s.price, s.currency, s.source_published_at, s.changed,
      EXISTS (SELECT 1 FROM listings r JOIN listings l ON l.id = s.listing_id
        WHERE r.id = ANY($1::bigint[]) AND (r.first_seen_at, r.id) < (l.first_seen_at, l.id)) AS is_repost
    FROM platform.listing_snapshots s WHERE listing_id = ANY($1::bigint[])
      AND ($2::bigint IS NULL OR id < $2::bigint)
    ORDER BY id DESC LIMIT $3
  `, [base.rows[0].history_ids, cursor, Math.min(Math.max(Number(limit) || 40, 1), 100) + 1]);
  const pageSize = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const rows = result.rows.slice(0, pageSize);
  return {
    firstSeenAt: base.rows[0].first_seen_at, events: snapshotEvents(rows),
    nextCursor: result.rows.length > pageSize ? String(rows.at(-1).id) : null,
  };
}

export async function readListingDuplicates(publicId, client = pool) {
  // No title-based matching or unbounded graph traversal: reuse ingestion's
  // fingerprint and explicit lineage edges, including inactive originals.
  const result = await client.query(`
    WITH seed AS (SELECT * FROM listings WHERE id = $1),
    related AS (
      SELECT l.id, 'fingerprint'::text AS match_kind FROM listings l JOIN seed s ON l.dedupe_key = s.dedupe_key
      UNION
      SELECT l.id, 'lineage'::text FROM seed s
      JOIN platform.listing_lineage e ON (e.from_source = s.source AND e.from_country = s.country AND e.from_source_id = s.source_id)
      JOIN listings l ON l.source = e.to_source AND l.country = e.to_country AND l.source_id = e.to_source_id
      UNION
      SELECT l.id, 'lineage'::text FROM seed s
      JOIN platform.listing_lineage e ON (e.to_source = s.source AND e.to_country = s.country AND e.to_source_id = s.source_id)
      JOIN listings l ON l.source = e.from_source AND l.country = e.from_country AND l.source_id = e.from_source_id
    )
    SELECT DISTINCT ON (l.id) l.id, l.source, l.country, l.source_id, l.data, l.price,
      l.currency, l.active, l.first_seen_at, l.created_at, r.match_kind,
      LEAST(l.created_at, (SELECT min(s.source_published_at) FROM platform.listing_snapshots s
        WHERE s.listing_id = l.id)) AS source_first_published_at
    FROM related r JOIN listings l ON l.id = r.id
    ORDER BY l.id, r.match_kind
  `, [publicId]);
  if (!result.rows.length) return null;
  const groups = groupDuplicateListings(result.rows, publicId);
  return {duplicateCount: result.rows.length - 1, groups, origin: findProbableOriginal(result.rows)};
}

/** One indexed batched lookup per feed page. */
export async function loadActivitySummaries(ids, client = pool) {
  if (!ids.length) return new Map();
  const result = await client.query(`
    SELECT l.id, (SELECT min(d.first_seen_at) FROM listings d WHERE d.id = l.id OR (
      d.dedupe_key = l.dedupe_key AND d.source = l.source
      AND l.data->>'contact' ~* '^(\\+[1-9][0-9]{6,14}|@[a-z0-9_]{5,32})$'
      AND lower(d.data->>'contact') = lower(l.data->>'contact'))) AS first_seen_at,
      (SELECT count(*)::int FROM platform.listing_snapshots s WHERE s.listing_id = l.id
        AND 'publication' = ANY(s.changed)) AS date_update_count,
      (SELECT count(*)::int FROM platform.listing_snapshots s WHERE s.listing_id = l.id
        AND s.lifecycle_state = 'reappeared') AS reappearance_count,
      (SELECT source_published_at FROM platform.listing_snapshots s WHERE s.listing_id = l.id
        AND 'publication' = ANY(s.changed) ORDER BY s.id DESC LIMIT 1) AS latest_source_published_at,
      (SELECT count(*)::int FROM listings d WHERE d.id <> l.id AND d.dedupe_key = l.dedupe_key
        AND d.source = l.source AND l.data->>'contact' ~* '^(\\+[1-9][0-9]{6,14}|@[a-z0-9_]{5,32})$'
        AND lower(d.data->>'contact') = lower(l.data->>'contact')) AS repost_count,
      (SELECT count(*)::int FROM (
        SELECT d.id FROM listings d WHERE d.dedupe_key = l.dedupe_key AND d.id <> l.id
        UNION
        SELECT d.id FROM platform.listing_lineage e JOIN listings d
          ON d.source = e.to_source AND d.country = e.to_country AND d.source_id = e.to_source_id
          WHERE e.from_source = l.source AND e.from_country = l.country AND e.from_source_id = l.source_id AND d.id <> l.id
        UNION
        SELECT d.id FROM platform.listing_lineage e JOIN listings d
          ON d.source = e.from_source AND d.country = e.from_country AND d.source_id = e.from_source_id
          WHERE e.to_source = l.source AND e.to_country = l.country AND e.to_source_id = l.source_id AND d.id <> l.id
      ) related) AS duplicate_count
    FROM listings l WHERE l.id = ANY($1::bigint[])
  `, [ids]);
  return new Map(result.rows.map((row) => [Number(row.id), {
    firstSeenAt: row.first_seen_at, dateUpdateCount: row.date_update_count,
    reappearanceCount: row.reappearance_count, duplicateCount: row.duplicate_count,
    repostCount: row.repost_count, latestSourcePublishedAt: row.latest_source_published_at,
  }]));
}

export async function attachActivitySummaries(listings, client = pool) {
  const ids = listings.map((l) => Number(l.publicId)).filter((id) => Number.isSafeInteger(id) && id > 0);
  try {
    const summaries = await loadActivitySummaries(ids, client);
    return listings.map((l) => ({...l, activitySummary: summaries.get(Number(l.publicId))}));
  } catch (error) {
    console.warn(`[listing-activity] unavailable: ${error?.code ?? 'error'}`);
    return listings;
  }
}
