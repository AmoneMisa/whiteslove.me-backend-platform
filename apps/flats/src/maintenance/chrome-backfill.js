import { parseHousingPrice } from '@whiteslove/parsing-lexicon/housing-money';
import { COUNTRIES } from '../geo/countries.js';
import { cutPageChrome } from '../scrapers/owner-html.js';

// Same markers as owner-html's PAGE_CHROME_RE, as a PostgreSQL regex.
const CHROME_SQL_RE = '(Показать\\s+следующие\\s+[0-9]+\\s+объект|Show\\s+next\\s+[0-9]+\\s+(propert|listing|object)|Типы\\s+недвижимости\\s+в\\s|©\\s*20[0-9][0-9])';
const CHROME_HEADING_RE = /^(?:Типы\s+недвижимости|Параметры\s+недвижимости|Показать\s+следующие|©)/iu;

/**
 * Plans the repair of one stored card that swallowed page chrome (pagination, menus,
 * footer, modal copy). The text is cut at the first chrome marker; a row left with
 * almost nothing is a pure page section and is deactivated; otherwise the title (if
 * it is a menu heading) and the price are read again from the cleaned text.
 */
export function planChromeRepair(row) {
  const original = String(row?.description ?? '');
  const cleaned = cutPageChrome(original).trim();
  if (cleaned === original.trim()) return null;
  if (cleaned.length < 30) return { action: 'deactivate', reason: 'page-section-not-a-listing' };

  const country = String(row.country || '').toUpperCase();
  const parsed = parseHousingPrice(cleaned, { country, currency: COUNTRIES[country]?.currency || '' });
  const title = CHROME_HEADING_RE.test(String(row.title ?? '').trim())
    ? cleaned.split(/\n|(?<=[.!?])\s/u)[0].replace(/\s+/gu, ' ').slice(0, 90)
    : row.title;
  return {
    action: 'clean',
    reason: 'page-chrome-cut',
    description: cleaned,
    title,
    price: parsed?.amount ?? null,
    currency: parsed?.amount != null ? parsed.currency || row.currency : row.currency,
  };
}

/**
 * One batch (keyset by id): read active rows whose text carries a chrome marker and, in
 * apply mode, write the cleaned text/title/price (data copy included) or deactivate a
 * pure page section. The previous values stay in data.chromeRepair.
 */
export async function runChromeBackfillBatch(client, { afterId = 0, batchSize = 200, apply = false, removeFromIndex } = {}) {
  const rows = await client.query(
    `
      SELECT id, source, country, source_id, title, description, price, currency
      FROM listings
      WHERE id > $1::bigint
        AND active = TRUE
        AND description ~* $3
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, CHROME_SQL_RE],
  );
  const changes = [];
  for (const row of rows.rows) {
    const plan = planChromeRepair(row);
    if (plan) changes.push({ id: String(row.id), source: row.source, country: row.country, sourceId: String(row.source_id), oldTitle: row.title, oldPrice: row.price == null ? null : Number(row.price), oldCurrency: row.currency, ...plan });
  }
  let updated = 0;
  let deactivated = 0;
  if (apply) {
    for (const change of changes) {
      if (change.action === 'deactivate') {
        const result = await client.query(
          `UPDATE listings SET active = FALSE, inactive_at = COALESCE(inactive_at, NOW()), availability_status = 'inactive',
             availability_reason = 'page_section_not_a_listing', updated_at = NOW()
           WHERE id = $1::bigint AND active = TRUE RETURNING source, country, source_id`,
          [change.id],
        );
        deactivated += result.rowCount ?? 0;
        if (removeFromIndex && result.rows.length) await removeFromIndex(result.rows.map((r) => ({ source: r.source, country: r.country, id: String(r.source_id) })));
      } else {
        const result = await client.query(
          `UPDATE listings AS l
           SET title = $2, description = $3,
               price = COALESCE($4::numeric, l.price), currency = COALESCE(NULLIF($5, ''), l.currency),
               data = l.data || jsonb_build_object('title', $2::text, 'description', $3::text,
                        'price', COALESCE($4::numeric, l.price), 'currency', COALESCE(NULLIF($5, ''), l.currency),
                        'chromeRepair', jsonb_build_object('title', l.title, 'price', l.price, 'currency', l.currency, 'at', NOW())),
               updated_at = NOW()
           WHERE l.id = $1::bigint AND l.active = TRUE`,
          [change.id, change.title, change.description, change.price, change.currency],
        );
        updated += result.rowCount ?? 0;
      }
    }
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, updated, deactivated, nextAfterId: last ? String(last.id) : null };
}
