// Recomputes jobs.vacancies.salary_usd (and data.salaryUsd / data.salaryPeriod) from the stored
// salaryMin/salaryMax/salaryCurrency with the current period + plausibility rules
// (server/vacancies/domain/salaryPlausibility.ts). Dry run by default; --apply writes.
// The previous values stay in data.salaryRepair so a change can be reversed.
//   node --experimental-transform-types --import ./jobs-worker/alias-loader.mjs scripts/backfill-vacancy-salary.ts [--apply] [--sample=20]
import pg from 'pg'
import { annualSalary } from '../server/vacancies/domain/enrich.ts'

const apply = process.argv.includes('--apply')
const sample = Number(process.argv.find((arg) => arg.startsWith('--sample='))?.slice(9)) || 20
const url = String(process.env.JOBS_DATABASE_URL || process.env.HIRING_DATABASE_URL || '').trim()
if (!url) throw new Error('JOBS_DATABASE_URL is not set')
const schema = String(process.env.JOBS_DB_SCHEMA || 'jobs').replace(/[^a-z0-9_]/gi, '')
// Sources that quote pay per month; when their stored period is the "year" default it is a mislabel.
const MONTHLY_BY_CONVENTION = new Set(['hh'])

const pool = new pg.Pool({ connectionString: url, max: 2 })
const { rows } = await pool.query(
  `SELECT identity_key, source, salary_usd, data FROM ${schema}.vacancies
   WHERE (data ? 'salaryMin' OR data ? 'salaryMax')`,
)

type Change = {
  key: string
  source: string
  before: number | null
  after: number | null
  period: string | null
  was: string | null
  currency: string | null
  min: number | null
  max: number | null
}
const changes: Change[] = []
for (const row of rows) {
  const data = row.data || {}
  const was = typeof data.salaryPeriod === 'string' ? data.salaryPeriod : null
  const period = MONTHLY_BY_CONVENTION.has(row.source) && (was === 'year' || was === null) ? 'month' : was
  if (period !== 'hour' && period !== 'month' && period !== 'year') continue
  const annual = annualSalary(
    { salaryMin: data.salaryMin, salaryMax: data.salaryMax, salaryCurrency: data.salaryCurrency } as any,
    period,
  )
  const after = annual?.usd ?? null
  const before = row.salary_usd == null ? null : Number(row.salary_usd)
  if (after === before && (annual?.period ?? period) === was) continue
  // Only salaries that were already stored are repaired here; filling a missing one is the crawler's job.
  if (before == null) continue
  changes.push({
    key: row.identity_key,
    source: row.source,
    before,
    after,
    period: annual?.period ?? period,
    was,
    currency: data.salaryCurrency ?? null,
    min: data.salaryMin ?? null,
    max: data.salaryMax ?? null,
  })
}

const kinds = {
  cleared: changes.filter((change) => change.before != null && change.after == null).length,
  gained: changes.filter((change) => change.before == null && change.after != null).length,
  rescaled: changes.filter((change) => change.before != null && change.after != null).length,
}
const bySource: Record<string, { n: number; cleared: number }> = {}
for (const change of changes) {
  const entry = (bySource[change.source] ||= { n: 0, cleared: 0 })
  entry.n += 1
  if (change.after == null) entry.cleared += 1
}
console.log(JSON.stringify({ scanned: rows.length, changes: changes.length, kinds, apply, bySource }, null, 1))
for (const kind of ['cleared', 'gained', 'rescaled'] as const) {
  const pick = changes.filter((change) => (kind === 'cleared' ? change.before != null && change.after == null : kind === 'gained' ? change.before == null && change.after != null : change.before != null && change.after != null))
  console.log(`--- ${kind}`)
  for (const change of pick.sort(() => Math.random() - 0.5).slice(0, sample)) console.log(JSON.stringify(change))
}

if (apply && changes.length) {
  let updated = 0
  for (let offset = 0; offset < changes.length; offset += 500) {
    const batch = changes.slice(offset, offset + 500)
    const result = await pool.query(
      `UPDATE ${schema}.vacancies v
       SET salary_usd = c.after,
           data = (v.data - 'salaryUsd')
                  || jsonb_strip_nulls(jsonb_build_object('salaryUsd', c.after, 'salaryPeriod', c.period))
                  || jsonb_build_object('salaryRepair', jsonb_build_object('salaryUsd', c.before, 'salaryPeriod', c.was, 'at', NOW())),
           updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS c(key text, before double precision, after double precision, period text, was text)
       WHERE v.identity_key = c.key`,
      [JSON.stringify(batch)],
    )
    updated += result.rowCount ?? 0
  }
  console.log(JSON.stringify({ updated }))
}
await pool.end()
