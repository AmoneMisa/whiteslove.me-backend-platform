// Drops hiring.candidates salaries that are not a monthly wish (plausibleCandidateSalary: an age, a
// date, a "1 so'm" placeholder, a mistyped zero count) and, where the stored text carries a real
// amount, replaces them with the one the current parser reads. Dry run by default; --apply writes.
// The previous values stay in data.salaryRepair so a change can be reversed.
//   node --experimental-transform-types --import ./jobs-worker/alias-loader.mjs scripts/backfill-candidate-salary.ts [--apply] [--sample=20]
import pg from 'pg'
import { plausibleCandidateSalary } from '../server/utils/hiring/hiringNormalize.ts'
import { convertCurrency } from '../server/utils/support/currency.ts'
import { parseSalary } from '../shared/hiring/webFields.ts'

const apply = process.argv.includes('--apply')
const sample = Number(process.argv.find((arg) => arg.startsWith('--sample='))?.slice(9)) || 20
const url = String(process.env.HIRING_DATABASE_URL || '').trim()
if (!url) throw new Error('HIRING_DATABASE_URL is not set')
const schema = String(process.env.HIRING_DB_SCHEMA || 'hiring').replace(/[^a-z0-9_]/gi, '')

const pool = new pg.Pool({ connectionString: url, max: 2 })
const { rows } = await pool.query(
  `SELECT id, country, data, salary_min_usd, salary_max_usd FROM ${schema}.candidates
   WHERE salary_min_usd IS NOT NULL OR salary_max_usd IS NOT NULL OR data ? 'salaryMin'`,
)

type Change = {
  id: string
  country: string
  before: unknown
  after: { min: number; max: number; currency: string; minUsd: number | null; maxUsd: number | null } | null
}
const changes: Change[] = []
for (const row of rows) {
  const data = row.data || {}
  if (data.salaryMin == null && data.salaryMax == null) continue
  const kept = plausibleCandidateSalary({
    salaryMin: data.salaryMin ?? undefined,
    salaryMax: data.salaryMax ?? undefined,
    currency: data.currency,
  })
  if (kept.salaryMin != null || kept.salaryMax != null) continue
  const text = String(data.originalText || data.description || '')
  const reread = plausibleCandidateSalary(parseSalary(text, row.country))
  const after = reread.salaryMin != null && reread.currency
    ? {
        min: reread.salaryMin,
        max: reread.salaryMax ?? reread.salaryMin,
        currency: reread.currency,
        minUsd: convertCurrency(reread.salaryMin, reread.currency, 'USD') ?? null,
        maxUsd: convertCurrency(reread.salaryMax ?? reread.salaryMin, reread.currency, 'USD') ?? null,
      }
    : null
  changes.push({
    id: String(row.id),
    country: row.country,
    after,
    before: {
      min: data.salaryMin ?? null,
      max: data.salaryMax ?? null,
      currency: data.currency ?? null,
      minUsd: row.salary_min_usd,
      maxUsd: row.salary_max_usd,
    },
  })
}

const byCountry: Record<string, number> = {}
for (const change of changes) byCountry[change.country] = (byCountry[change.country] || 0) + 1
console.log(JSON.stringify({
  scanned: rows.length,
  wrong: changes.length,
  replaced: changes.filter((change) => change.after).length,
  cleared: changes.filter((change) => !change.after).length,
  apply,
  byCountry,
}, null, 1))
for (const change of changes.sort(() => Math.random() - 0.5).slice(0, sample)) console.log(JSON.stringify(change))

if (apply && changes.length) {
  let updated = 0
  for (const change of changes) {
    const result = await pool.query(
      `UPDATE ${schema}.candidates
       SET salary_min_usd = $2, salary_max_usd = $3,
           data = (data - 'salaryMin' - 'salaryMax' - 'currency')
                  || jsonb_strip_nulls(jsonb_build_object('salaryMin', $4::double precision, 'salaryMax', $5::double precision, 'currency', $6::text))
                  || jsonb_build_object('salaryRepair', jsonb_build_object(
                       'salaryMin', data->'salaryMin', 'salaryMax', data->'salaryMax',
                       'currency', data->'currency', 'at', NOW())),
           updated_at = NOW()
       WHERE id = $1::bigint`,
      [change.id, change.after?.minUsd ?? null, change.after?.maxUsd ?? null, change.after?.min ?? null, change.after?.max ?? null, change.after?.currency ?? null],
    )
    updated += result.rowCount ?? 0
  }
  console.log(JSON.stringify({ updated }))
}
await pool.end()
