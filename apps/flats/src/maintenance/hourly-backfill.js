import { isHourlyPriced } from '../support/hourly-price.js';

/**
 * Plans the repair of stored cards whose price is per hour ("4 000 ⃀ / час"). They were filed as room
 * rental or as a night price. Each becomes a short stay with the hourly figure in pricePerHour and no
 * night/month price (see support/hourly-price.js).
 */
export function planHourlyBackfill(rows) {
  const changes = [];
  for (const row of rows ?? []) {
    if (row?.price == null) continue;
    if (!isHourlyPriced(`${row.title ?? ''}\n${row.description ?? ''}`, row.price)) continue;
    changes.push({
      id: String(row.id),
      source: row.source ?? null,
      dealType: row.deal_type ?? null,
      price: Number(row.price),
      currency: row.currency ?? null,
      title: String(row.title ?? '').replace(/\s+/gu, ' ').slice(0, 60),
    });
  }
  return changes;
}

/**
 * One batch (keyset by id): read active rows with a price whose text carries an "/ час" style unit and,
 * in apply mode, move the price to data.pricePerHour. The previous deal type, price and currency stay
 * in data.hourlyRepair so the change can be reversed.
 */
export async function runHourlyBackfillBatch(client, { afterId = 0, batchSize = 500, apply = false } = {}) {
  const rows = await client.query(
    `
      SELECT id, source, deal_type, price, currency, title, description
      FROM listings
      WHERE id > $1::bigint
        AND active = TRUE
        AND price IS NOT NULL
        AND NOT (data ? 'pricePerHour')
        AND (COALESCE(title, '') || ' ' || COALESCE(description, '')) ~* '(/\\s*(час|hour|hr)|за\\s+час|per\\s+(hour|hr))'
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize],
  );
  const changes = planHourlyBackfill(rows.rows);
  let updated = 0;
  if (apply && changes.length) {
    const result = await client.query(
      `
        UPDATE listings AS l
        SET deal_type = 'shortRent',
            price = NULL,
            data = l.data || jsonb_build_object(
              'dealType', 'shortRent', 'roomOnly', FALSE, 'price', NULL,
              'pricePerHour', l.price, 'priceUnit', 'hour',
              'hourlyRepair', jsonb_build_object('dealType', l.deal_type, 'price', l.price, 'currency', l.currency, 'at', NOW())
            ),
            updated_at = NOW()
        WHERE l.id = ANY($1::bigint[])
          AND l.price IS NOT NULL
          AND NOT (l.data ? 'pricePerHour')
      `,
      [changes.map((change) => change.id)],
    );
    updated = result.rowCount ?? 0;
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, updated, nextAfterId: last ? String(last.id) : null };
}
