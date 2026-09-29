import { Pool } from 'pg'
import type { Job, JobEmployerSummary, JobQuery, JobResponse, JobStats } from '../../../shared/contracts/jobs'
import { MIN_EMPLOYER_ROLES, isPlaceholderCompany, jobEmployerKey, parseJobEmployerKey } from '../../../shared/hiring/jobEmployer'
import { jobClusterIdentity, type JobClusterIdentity } from '../../../shared/hiring/jobCluster'
import { publicEntityId } from '../../../shared/publicEntityId'
import { toPostgresJson } from '../../../shared/postgresJson'
import { BoundedTtlCache } from '../../utils/support/boundedTtlCache'
import { jobProfessionArea } from '../../vacancies/domain/aggregate'
import { keepUsaForeignerCandidate } from '../../vacancies/domain/jobVisaSponsorship'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i
const UPSERT_BATCH = 500
const JOB_STATS_CACHE_TTL_MS = 60_000
const JOB_STATS_CACHE_MAX_ENTRIES = 250
const JOB_SALARY_TREND_MAX_POINTS = 750

let pool: Pool | undefined
let schemaReady: Promise<void> | undefined

const jobStatsCache = new BoundedTtlCache<string, JobStats>({
  maxEntries: JOB_STATS_CACHE_MAX_ENTRIES,
  defaultTtlMs: JOB_STATS_CACHE_TTL_MS,
})

function databaseUrl(): string {
  return String(process.env.JOBS_DATABASE_URL || process.env.HIRING_DATABASE_URL || '').trim()
}

function schema(): string {
  const raw = String(process.env.JOBS_DB_SCHEMA || 'jobs').trim()
  return SCHEMA_RE.test(raw) ? raw : 'jobs'
}

export function jobsDbEnabled(): boolean {
  return Boolean(databaseUrl())
}

/** Lightweight readiness probe used by the workforce API container. */
export async function checkJobsDbReady(): Promise<boolean> {
  if (!jobsDbEnabled()) return false
  try {
    await ensureSchema()
    await db().query('SELECT 1')
    return true
  } catch (error) {
    console.warn('[jobs:db] readiness probe failed:', (error as Error).message)
    return false
  }
}

function db(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.JOBS_DB_POOL_MAX) || 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (error) => console.error('[jobs:db] idle client error:', error.message))
  }
  return pool
}

function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady
  const name = schema()
  schemaReady = (async () => {
    const relations = await db().query(
      'SELECT to_regclass($1)::text AS vacancies, to_regclass($2)::text AS migrations',
      [`${name}.vacancies`, `${name}._site_migrations`],
    )
    const row = relations.rows[0]
    if (!row?.vacancies || !row?.migrations) {
      throw new Error(`Jobs schema ${name} is not migrated; run scripts/migrate-database.ts before runtime`)
    }
  })().catch((error) => {
    schemaReady = undefined
    throw error
  })
  return schemaReady
}

function identityKey(job: Job): string {
  return `${job.source}:${job.url || job.id}`
}

function languageKeys(job: Job): string[] {
  return [...new Set((job.languages || []).flatMap((item) => {
    const language = String(item.language || '').trim().toLocaleLowerCase('en')
    if (!language) return []
    const level = String(item.level || '').trim().toLocaleLowerCase('en')
    return level ? [language, `${language}:${level}`] : [language]
  }))]
}

function clusterOf(job: Job): JobClusterIdentity | null {
  // Unattributable, like a posting with no company at all (see jobEmployer.ts).
  if (isPlaceholderCompany(job.company)) return null
  return jobClusterIdentity({ company: job.company, title: job.title, location: job.location, city: job.city, country: job.country })
}

function jobRow(job: Job, syncToken: string) {
  return {
    identity_key: identityKey(job),
    source: job.source,
    source_id: String(job.id),
    public_id: job.publicId ?? publicEntityId('job', job.source, job.id),
    title: job.title,
    company: job.company || '',
    location: job.location || '',
    country: job.country || null,
    city: job.city || null,
    posted_at: job.postedAt,
    remote: job.remote ?? null,
    work_mode: job.workMode || null,
    relocation: job.relocation || null,
    employment_kind: job.employmentKind || null,
    salary_usd: Number.isFinite(job.salaryUsd) ? job.salaryUsd : null,
    experience_min_years: Number.isFinite(job.experienceMinYears) ? job.experienceMinYears : null,
    foreigner_friendly: job.foreignerFriendly === true,
    usa_foreigner_friendly: keepUsaForeignerCandidate(job),
    no_experience: job.noExperience === true,
    risk_category: job.riskCategory || null,
    profession: jobProfessionArea(job),
    languages: job.languages || [],
    language_keys: languageKeys(job),
    skills: [...new Set([...(job.skills || []), ...(job.niceToHave || [])].map((value) => value.toLocaleLowerCase('en')))],
    search_text: [job.title, job.company, job.location, job.description, ...(job.tags || []), ...(job.skills || []), ...(job.niceToHave || [])]
      .filter(Boolean)
      .join(' '),
    sync_token: syncToken,
    // The role this posting advertises (shared/hiring/jobCluster.ts): what
    // repost detection and employer collections group by.
    cluster_key: clusterOf(job)?.key ?? null,
    data: job,
  }
}

/** One job_clusters row per role in this sync, with its live posting count. */
function clusterRows(jobs: Job[]) {
  const byKey = new Map<string, { cluster_key: string; country: string | null; company_normalized: string; title_normalized: string; locality: string | null; posting_count: number }>()
  for (const job of jobs) {
    const cluster = clusterOf(job)
    if (!cluster) continue
    const row = byKey.get(cluster.key)
    if (row) row.posting_count += 1
    else byKey.set(cluster.key, {
      cluster_key: cluster.key,
      country: cluster.country || null,
      company_normalized: cluster.company,
      title_normalized: cluster.title,
      locality: cluster.locality || null,
      posting_count: 1,
    })
  }
  return [...byKey.values()]
}

// first_seen_at and reason_codes are kept: a cluster outlives the postings of
// one sync, and its history is what repost detection reads.
const CLUSTER_UPSERT_SQL = (name: string) => `
  INSERT INTO ${name}.job_clusters (
    cluster_key, country, company_normalized, title_normalized, locality, posting_count, last_seen_at
  )
  SELECT input.cluster_key, input.country, input.company_normalized, input.title_normalized,
         input.locality, input.posting_count, NOW()
  FROM jsonb_to_recordset($1::jsonb) AS input (
    cluster_key TEXT, country TEXT, company_normalized TEXT, title_normalized TEXT,
    locality TEXT, posting_count INTEGER
  )
  ON CONFLICT (cluster_key) DO UPDATE SET
    country = EXCLUDED.country, company_normalized = EXCLUDED.company_normalized,
    title_normalized = EXCLUDED.title_normalized, locality = EXCLUDED.locality,
    posting_count = EXCLUDED.posting_count, last_seen_at = NOW()
  -- Only when something changed; last_seen_at refreshes hourly, which is
  -- ample resolution for repost detection.
  WHERE ${name}.job_clusters.posting_count IS DISTINCT FROM EXCLUDED.posting_count
     OR ${name}.job_clusters.country IS DISTINCT FROM EXCLUDED.country
     OR ${name}.job_clusters.locality IS DISTINCT FROM EXCLUDED.locality
     OR ${name}.job_clusters.last_seen_at < NOW() - INTERVAL '1 hour'
`

const UPSERT_SQL = (name: string) => `
  INSERT INTO ${name}.vacancies (
    identity_key, source, source_id, public_id, title, company, location,
    country, city, posted_at, active, remote, work_mode, relocation,
    employment_kind, salary_usd, experience_min_years, foreigner_friendly,
    usa_foreigner_friendly, no_experience, risk_category, profession,
    languages, language_keys, skills, search_text, sync_token, cluster_key, data, updated_at
  )
  SELECT
    input.identity_key, input.source, input.source_id, input.public_id,
    input.title, input.company, input.location, input.country, input.city,
    input.posted_at, TRUE, input.remote, input.work_mode, input.relocation,
    input.employment_kind, input.salary_usd, input.experience_min_years,
    input.foreigner_friendly, input.usa_foreigner_friendly,
    input.no_experience, input.risk_category, input.profession,
    input.languages, input.language_keys, input.skills, input.search_text, input.sync_token,
    input.cluster_key, input.data, NOW()
  FROM jsonb_to_recordset($1::jsonb) AS input (
    identity_key TEXT, source TEXT, source_id TEXT, public_id BIGINT,
    title TEXT, company TEXT, location TEXT, country TEXT, city TEXT,
    posted_at TIMESTAMPTZ, remote BOOLEAN, work_mode TEXT, relocation TEXT,
    employment_kind TEXT, salary_usd DOUBLE PRECISION,
    experience_min_years DOUBLE PRECISION, foreigner_friendly BOOLEAN,
    usa_foreigner_friendly BOOLEAN, no_experience BOOLEAN,
    risk_category TEXT, profession TEXT, languages JSONB,
    language_keys TEXT[], skills TEXT[], search_text TEXT, sync_token TEXT, cluster_key TEXT, data JSONB
  )
  ON CONFLICT (identity_key) DO UPDATE SET
    source = EXCLUDED.source, source_id = EXCLUDED.source_id,
    public_id = EXCLUDED.public_id, title = EXCLUDED.title,
    company = EXCLUDED.company, location = EXCLUDED.location,
    country = EXCLUDED.country, city = EXCLUDED.city,
    posted_at = EXCLUDED.posted_at, active = TRUE, remote = EXCLUDED.remote,
    work_mode = EXCLUDED.work_mode, relocation = EXCLUDED.relocation,
    employment_kind = EXCLUDED.employment_kind,
    salary_usd = EXCLUDED.salary_usd,
    experience_min_years = EXCLUDED.experience_min_years,
    foreigner_friendly = EXCLUDED.foreigner_friendly,
    usa_foreigner_friendly = EXCLUDED.usa_foreigner_friendly,
    no_experience = EXCLUDED.no_experience,
    risk_category = EXCLUDED.risk_category, profession = EXCLUDED.profession,
    languages = EXCLUDED.languages, language_keys = EXCLUDED.language_keys,
    skills = EXCLUDED.skills, sync_token = EXCLUDED.sync_token,
    search_text = EXCLUDED.search_text, cluster_key = EXCLUDED.cluster_key,
    data = EXCLUDED.data, updated_at = NOW()
  -- Rewrite a row only when the vacancy changed (lastSeen alone does not
  -- count) or it is coming back. Rewriting every row on every sync had
  -- reached 167M updates for 82k live vacancies, a 1.8 GB table and
  -- constant autovacuum, slowing every read.
  WHERE ${name}.vacancies.active = FALSE
     OR ${name}.vacancies.cluster_key IS DISTINCT FROM EXCLUDED.cluster_key
     OR (${name}.vacancies.data - 'lastSeen') IS DISTINCT FROM (EXCLUDED.data - 'lastSeen')
`

export async function syncJobsDb(jobs: Job[]): Promise<number> {
  if (!jobsDbEnabled()) return 0
  await ensureSchema()
  const syncToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`
  const rows = jobs.map((job) => jobRow(job, syncToken))
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    // Clusters first: a vacancy's cluster_key refers to a job_clusters row
    // that the employer queries join on.
    const clusters = clusterRows(jobs)
    for (let offset = 0; offset < clusters.length; offset += UPSERT_BATCH) {
      await client.query(CLUSTER_UPSERT_SQL(schema()), [toPostgresJson(clusters.slice(offset, offset + UPSERT_BATCH))])
    }
    for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH) {
      await client.query(UPSERT_SQL(schema()), [toPostgresJson(rows.slice(offset, offset + UPSERT_BATCH))])
    }
    // Unchanged rows keep their old sync_token now, so deactivate by key:
    // live vacancies the snapshot no longer holds.
    await client.query(
      `UPDATE ${schema()}.vacancies SET active = FALSE, updated_at = NOW()
        WHERE active = TRUE AND NOT (identity_key = ANY($1::text[]))`,
      [rows.map((row) => row.identity_key)],
    )
    await client.query('COMMIT')
    // Statistics are not dropped here: they refresh on their own TTL while
    // the previous result is served (queryJobStats), instead of every request
    // after each sync paying for a cold recomputation.
    return rows.length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

type SqlBuilder = { values: unknown[]; add(value: unknown): string }

function sqlBuilder(): SqlBuilder {
  const values: unknown[] = []
  return {
    values,
    add(value) {
      values.push(value)
      return `$${values.length}`
    },
  }
}

function filteredWhere(query: JobQuery, sql: SqlBuilder): string {
  const parts = [
    'active = TRUE',
    `posted_at >= NOW() - (${sql.add(Math.min(query.maxAgeDays || 14, 14))}::text || ' days')::interval`,
  ]
  if (query.sources.length) parts.push(`source = ANY(${sql.add(query.sources)}::text[])`)
  if (query.countries.length) parts.push(`country = ANY(${sql.add(query.countries)}::text[])`)
  if (query.remote != null) parts.push(`remote = ${sql.add(query.remote)}`)
  if (query.workMode) parts.push(`work_mode = ${sql.add(query.workMode)}`)
  if (query.relocation) parts.push(`relocation = ${sql.add(query.relocation)}`)
  if (query.employmentKind) parts.push(`employment_kind = ${sql.add(query.employmentKind)}`)
  if (query.salaryMin != null) parts.push(`salary_usd >= ${sql.add(query.salaryMin)}`)
  if (query.hasSalary) parts.push('salary_usd IS NOT NULL')
  if (query.maxExperienceYears != null) {
    parts.push(`(experience_min_years IS NULL OR experience_min_years <= ${sql.add(query.maxExperienceYears)})`)
  }
  if (query.noExperience) parts.push('no_experience = TRUE')
  if (query.hideRiskyIndustries !== false) parts.push('risk_category IS NULL')
  if (query.foreignerFriendly != null) {
    const usa = query.foreignerFriendly && query.countries.includes('US')
    parts.push(`${usa ? 'usa_foreigner_friendly' : 'foreigner_friendly'} = ${sql.add(query.foreignerFriendly)}`)
  }
  if (!query.includeRu) parts.push(`(remote = TRUE OR country IS DISTINCT FROM 'RU')`)
  if (!query.includeBy) parts.push(`(remote = TRUE OR country IS DISTINCT FROM 'BY')`)
  if (query.cities.length) {
    const cities = query.cities.map((value) => value.toLocaleLowerCase('en'))
    parts.push(`(LOWER(city) = ANY(${sql.add(cities)}::text[]) OR EXISTS (
      SELECT 1 FROM unnest(${sql.add(cities)}::text[]) term
      WHERE LOWER(location || ' ' || title) LIKE '%' || term || '%'
    ))`)
  }
  if (query.location) parts.push(`LOWER(location) LIKE '%' || LOWER(${sql.add(query.location)}) || '%'`)
  if (query.q) parts.push(`to_tsvector('simple', search_text) @@ plainto_tsquery('simple', ${sql.add(query.q)})`)
  if (query.skills.length) {
    parts.push(`skills @> ${sql.add(query.skills.map((value) => value.toLocaleLowerCase('en')))}::text[]`)
  }
  if (query.language) {
    const language = query.language.toLocaleLowerCase('en')
    const key = query.languageLevel ? `${language}:${query.languageLevel.toLocaleLowerCase('en')}` : language
    parts.push(`${sql.add(key)} = ANY(language_keys)`)
  }
  if (query.excludeLanguages.length) {
    parts.push(`NOT (language_keys && ${sql.add(query.excludeLanguages.map((value) => value.toLocaleLowerCase('en')))}::text[])`)
  }
  return parts.join(' AND ')
}

function orderBy(sort: JobQuery['sort']): string {
  if (sort === 'oldest') return 'posted_at ASC, identity_key ASC'
  if (sort === 'title') return 'LOWER(title) ASC, posted_at DESC, identity_key ASC'
  if (sort === 'company') return 'LOWER(company) ASC, posted_at DESC, identity_key ASC'
  if (sort === 'salary') return 'salary_usd DESC NULLS LAST, posted_at DESC, identity_key ASC'
  return 'posted_at DESC, identity_key ASC'
}

function emptyStats(): JobStats {
  return {
    salary: { count: 0, medianUsd: 0, avgUsd: 0, minUsd: 0, maxUsd: 0 },
    bySource: {},
    byCountry: {},
    byWorkMode: { remote: 0, hybrid: 0, office: 0, unknown: 0 },
    byRelocation: { offered: 0, none: 0, unknown: 0 },
    byEmploymentKind: {
      fulltime: 0,
      parttime: 0,
      contract: 0,
      project: 0,
      freelance: 0,
      internship: 0,
      temporary: 0,
      volunteer: 0,
      seasonal: 0,
      unknown: 0,
    },
    experience: {
      knownCount: 0,
      medianYears: null,
      noExperience: 0,
      upToOne: 0,
      oneToThree: 0,
      threeToFive: 0,
      fivePlus: 0,
      unknown: 0,
    },
    byProfession: [],
    foreignerFriendly: 0,
    byLanguage: {},
    topSkills: [],
    salaryTrend: [],
  }
}

function normalizedList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase('en')).filter(Boolean))].sort()
}

function statsCacheKey(query: JobQuery): string {
  return JSON.stringify({
    q: query.q.trim().toLocaleLowerCase('en'),
    location: query.location.trim().toLocaleLowerCase('en'),
    remote: query.remote ?? null,
    sources: normalizedList(query.sources),
    maxAgeDays: query.maxAgeDays,
    salaryMin: query.salaryMin ?? null,
    countries: normalizedList(query.countries),
    cities: normalizedList(query.cities),
    includeRu: query.includeRu === true,
    includeBy: query.includeBy === true,
    workMode: query.workMode ?? null,
    relocation: query.relocation ?? null,
    employmentKind: query.employmentKind ?? null,
    hasSalary: query.hasSalary === true,
    maxExperienceYears: query.maxExperienceYears ?? null,
    foreignerFriendly: query.foreignerFriendly ?? null,
    hideRiskyIndustries: query.hideRiskyIndustries !== false,
    noExperience: query.noExperience === true,
    language: query.language?.toLocaleLowerCase('en') ?? null,
    languageLevel: query.languageLevel?.toLocaleLowerCase('en') ?? null,
    excludeLanguages: normalizedList(query.excludeLanguages),
    skills: normalizedList(query.skills),
  })
}

// Statistics aggregate every matching vacancy (medians per source, country,
// profession, city...), ~37 s cold at 80k vacancies. A request gets the
// fresh result when there is one, otherwise the last result while a single
// background refresh recomputes it; only a query never seen before waits.
const staleJobStats = new BoundedTtlCache<string, JobStats>({
  maxEntries: JOB_STATS_CACHE_MAX_ENTRIES,
  defaultTtlMs: 6 * 60 * 60_000,
})
const refreshingJobStats = new Map<string, Promise<JobStats>>()

async function queryJobStats(query: JobQuery): Promise<JobStats> {
  const cacheKey = statsCacheKey(query)
  const fresh = jobStatsCache.get(cacheKey)
  if (fresh) return fresh
  let refresh = refreshingJobStats.get(cacheKey)
  if (!refresh) {
    refresh = computeJobStats(query, cacheKey).finally(() => refreshingJobStats.delete(cacheKey))
    refreshingJobStats.set(cacheKey, refresh)
  }
  const stale = staleJobStats.get(cacheKey)
  if (stale) {
    refresh.catch((error) => console.warn('[jobs:db] stats refresh failed:', (error as Error).message))
    return stale
  }
  return refresh
}

async function computeJobStats(query: JobQuery, cacheKey: string): Promise<JobStats> {

  const sql = sqlBuilder()
  const where = filteredWhere(query, sql)
  const result = await db().query({
    text: `
      WITH filtered AS MATERIALIZED (
        SELECT
          source, country, city, posted_at, title, work_mode, relocation,
          employment_kind, salary_usd, experience_min_years, no_experience,
          profession, foreigner_friendly, languages, skills
        FROM ${schema()}.vacancies
        WHERE ${where}
      ), grouped_source AS (
        SELECT source AS key, COUNT(*)::int AS count, COUNT(salary_usd)::int AS salary_count,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8 AS median
        FROM filtered GROUP BY source
      ), grouped_country AS (
        SELECT COALESCE(country, 'OTHER') AS key, COUNT(*)::int AS count,
          COUNT(salary_usd)::int AS salary_count,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8 AS median
        FROM filtered GROUP BY COALESCE(country, 'OTHER')
      ), grouped_profession AS (
        SELECT profession, COUNT(*)::int AS count, COUNT(salary_usd)::int AS salary_count,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8 AS median,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY experience_min_years)
            FILTER (WHERE experience_min_years IS NOT NULL))::float8 AS median_experience
        FROM filtered GROUP BY profession ORDER BY count DESC, salary_count DESC LIMIT 20
      ), profession_geo_raw AS (
        SELECT profession, 'country'::text kind, COALESCE(country, 'OTHER') key,
          COUNT(*)::int count, COUNT(salary_usd)::int salary_count,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8 median
        FROM filtered GROUP BY profession, COALESCE(country, 'OTHER')
        UNION ALL
        SELECT profession, 'city'::text kind, city key,
          COUNT(*)::int count, COUNT(salary_usd)::int salary_count,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8 median
        FROM filtered WHERE city IS NOT NULL AND city <> '' GROUP BY profession, city
      ), profession_geo AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY profession ORDER BY count DESC, salary_count DESC, median DESC
        ) rank
        FROM profession_geo_raw WHERE salary_count > 0
      ), language_counts AS (
        SELECT item->>'language' AS key, COUNT(*)::int AS count
        FROM filtered, jsonb_array_elements(languages) item
        WHERE COALESCE(item->>'language', '') <> '' GROUP BY item->>'language'
      ), skill_counts AS (
        SELECT skill AS key, COUNT(*)::int AS count FROM filtered, unnest(skills) skill
        GROUP BY skill ORDER BY count DESC, key ASC LIMIT 20
      ), salary_ranked AS (
        SELECT posted_at, salary_usd, country, city, title, profession, experience_min_years,
          ROW_NUMBER() OVER (
            PARTITION BY date_trunc('day', posted_at), COALESCE(country, ''), profession
            ORDER BY posted_at DESC, title ASC
          ) AS sample_rank
        FROM filtered WHERE salary_usd IS NOT NULL
      ), salary_trend AS (
        SELECT posted_at, salary_usd, country, city, title, profession, experience_min_years
        FROM salary_ranked
        WHERE sample_rank <= 3
        ORDER BY posted_at DESC
        LIMIT ${JOB_SALARY_TREND_MAX_POINTS}
      )
      SELECT jsonb_build_object(
        'salary', COALESCE((SELECT jsonb_build_object(
          'count', COUNT(salary_usd)::int,
          'medianUsd', COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_usd)
            FILTER (WHERE salary_usd IS NOT NULL), 0)::float8,
          'avgUsd', COALESCE(AVG(salary_usd), 0)::float8,
          'minUsd', COALESCE(MIN(salary_usd), 0)::float8,
          'maxUsd', COALESCE(MAX(salary_usd), 0)::float8
        ) FROM filtered), '{}'::jsonb),
        'bySource', COALESCE((SELECT jsonb_object_agg(
          key, jsonb_build_object('count', count, 'salaryCount', salary_count, 'medianUsd', median)
        ) FROM grouped_source), '{}'::jsonb),
        'byCountry', COALESCE((SELECT jsonb_object_agg(
          key, jsonb_build_object('count', count, 'salaryCount', salary_count, 'medianUsd', median)
        ) FROM grouped_country), '{}'::jsonb),
        'byWorkMode', COALESCE((SELECT jsonb_object_agg(key, count) FROM (
          SELECT COALESCE(work_mode, 'unknown') key, COUNT(*)::int count FROM filtered GROUP BY 1
        ) x), '{}'::jsonb),
        'byRelocation', COALESCE((SELECT jsonb_object_agg(key, count) FROM (
          SELECT COALESCE(relocation, 'unknown') key, COUNT(*)::int count FROM filtered GROUP BY 1
        ) x), '{}'::jsonb),
        'byEmploymentKind', COALESCE((SELECT jsonb_object_agg(key, count) FROM (
          SELECT COALESCE(employment_kind, 'unknown') key, COUNT(*)::int count FROM filtered GROUP BY 1
        ) x), '{}'::jsonb),
        'experience', (SELECT jsonb_build_object(
          'knownCount', COUNT(experience_min_years)::int,
          'medianYears', percentile_cont(0.5) WITHIN GROUP (ORDER BY experience_min_years)
            FILTER (WHERE experience_min_years IS NOT NULL),
          'noExperience', (COUNT(*) FILTER (WHERE no_experience OR experience_min_years = 0))::int,
          'upToOne', (COUNT(*) FILTER (
            WHERE NOT no_experience AND experience_min_years > 0 AND experience_min_years <= 1
          ))::int,
          'oneToThree', (COUNT(*) FILTER (
            WHERE NOT no_experience AND experience_min_years > 1 AND experience_min_years <= 3
          ))::int,
          'threeToFive', (COUNT(*) FILTER (WHERE experience_min_years > 3 AND experience_min_years <= 5))::int,
          'fivePlus', (COUNT(*) FILTER (WHERE experience_min_years > 5))::int,
          'unknown', (COUNT(*) FILTER (WHERE experience_min_years IS NULL))::int
        ) FROM filtered),
        'byProfession', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'profession', gp.profession,
          'count', gp.count,
          'salaryCount', gp.salary_count,
          'medianUsd', gp.median,
          'medianExperienceYears', gp.median_experience,
          'geographies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'kind', kind,
            'key', key,
            'count', count,
            'salaryCount', salary_count,
            'medianUsd', median
          ) ORDER BY rank) FROM profession_geo
            WHERE profession = gp.profession AND rank <= 6), '[]'::jsonb)
        )) FROM grouped_profession gp), '[]'::jsonb),
        'foreignerFriendly', (SELECT (COUNT(*) FILTER (WHERE foreigner_friendly))::int FROM filtered),
        'byLanguage', COALESCE((SELECT jsonb_object_agg(key, count) FROM language_counts), '{}'::jsonb),
        'topSkills', COALESCE((SELECT jsonb_agg(jsonb_build_object('skill', key, 'count', count))
          FROM skill_counts), '[]'::jsonb),
        'salaryTrend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'postedAt', posted_at,
          'salaryUsd', salary_usd,
          'country', country,
          'city', city,
          'title', title,
          'profession', profession,
          'experienceYears', experience_min_years
        ) ORDER BY posted_at) FROM salary_trend), '[]'::jsonb)
      ) AS stats
    `,
    values: sql.values,
  })

  const raw = result.rows[0]?.stats || {}
  const stats = { ...emptyStats(), ...raw } as JobStats
  stats.byWorkMode = { ...emptyStats().byWorkMode, ...(stats.byWorkMode || {}) }
  stats.byRelocation = { ...emptyStats().byRelocation, ...(stats.byRelocation || {}) }
  stats.byEmploymentKind = { ...emptyStats().byEmploymentKind, ...(stats.byEmploymentKind || {}) }
  jobStatsCache.set(cacheKey, stats)
  staleJobStats.set(cacheKey, stats)
  return stats
}

export async function queryJobsDb(query: JobQuery): Promise<(JobResponse & { loadedSources: string[] }) | null> {
  if (!jobsDbEnabled()) return null
  try {
    await ensureSchema()

    const pageSql = sqlBuilder()
    const pageWhere = filteredWhere(query, pageSql)
    const pageLimit = pageSql.add(query.pageSize)
    const pageOffset = pageSql.add((query.page - 1) * query.pageSize)

    const summarySql = sqlBuilder()
    const summaryWhere = filteredWhere(query, summarySql)

    const [pageResult, summaryResult, stats] = await Promise.all([
      db().query({
        text: `
          SELECT data
          FROM ${schema()}.vacancies
          WHERE ${pageWhere}
          ORDER BY ${orderBy(query.sort)}
          LIMIT ${pageLimit} OFFSET ${pageOffset}
        `,
        values: pageSql.values,
      }),
      db().query({
        text: `
          WITH filtered_sources AS (
            SELECT source FROM ${schema()}.vacancies WHERE ${summaryWhere}
          ), source_counts AS (
            SELECT source, COUNT(*)::int AS count FROM filtered_sources GROUP BY source
          )
          SELECT
            (SELECT COUNT(*)::int FROM ${schema()}.vacancies WHERE active = TRUE) AS database_total,
            COALESCE((SELECT jsonb_agg(source ORDER BY source) FROM (
              SELECT DISTINCT source FROM ${schema()}.vacancies WHERE active = TRUE
            ) active_sources), '[]'::jsonb) AS loaded_sources,
            (SELECT COUNT(*)::int FROM filtered_sources) AS total,
            COALESCE((SELECT jsonb_object_agg(source, count) FROM source_counts), '{}'::jsonb) AS sources
        `,
        values: summarySql.values,
      }),
      queryJobStats(query),
    ])

    const summary = summaryResult.rows[0]
    if (!summary || (Number(summary.database_total) || 0) === 0) return null

    return {
      jobs: pageResult.rows.map((row) => row.data).filter(Boolean),
      total: Number(summary.total) || 0,
      page: query.page,
      pageSize: query.pageSize,
      sources: summary.sources || {},
      stats,
      loadedSources: summary.loaded_sources || [],
    }
  } catch (error) {
    console.warn('[jobs:db] indexed read failed:', (error as Error).message)
    return null
  }
}

export async function getJobByPublicIdDb(publicId: string): Promise<Job | null> {
  if (!jobsDbEnabled() || !/^\d+$/.test(publicId)) return null
  try {
    await ensureSchema()
    const result = await db().query(
      `SELECT data FROM ${schema()}.vacancies WHERE active = TRUE AND public_id = $1::bigint LIMIT 1`,
      [publicId],
    )
    return result.rows[0]?.data || null
  } catch {
    return null
  }
}

/**
 * Employer collections: companies with two or more different live roles.
 *
 * Counted over job_clusters, not postings: `cluster_key` is the role, so a
 * vacancy reposted weekly stays one role. Postings with no cluster (no company
 * or no title, see jobClusterKey) cannot be attributed to an employer and are
 * excluded rather than grouped under an empty name.
 */
export async function listJobEmployersDb(
  country: string,
  limit = 24,
): Promise<JobEmployerSummary[]> {
  if (!jobsDbEnabled()) return []
  try {
    await ensureSchema()
    const result = await db().query(
      `SELECT c.company_normalized,
              v.country,
              COUNT(DISTINCT v.cluster_key)::int AS roles,
              COUNT(*)::int AS postings,
              MAX(v.posted_at) AS last_posted_at,
              (ARRAY_AGG(v.company ORDER BY v.posted_at DESC))[1] AS display_company
         FROM ${schema()}.vacancies v
         JOIN ${schema()}.job_clusters c ON c.cluster_key = v.cluster_key
        WHERE v.active = TRUE
          AND v.cluster_key IS NOT NULL
          AND ($1 = '' OR v.country = $1)
        GROUP BY c.company_normalized, v.country
       HAVING COUNT(DISTINCT v.cluster_key) >= $2
        ORDER BY roles DESC, last_posted_at DESC
        LIMIT $3`,
      [country, MIN_EMPLOYER_ROLES, Math.min(Math.max(limit, 1), 100)],
    )
    return result.rows.flatMap((row) => {
      const key = jobEmployerKey(row.country, row.company_normalized)
      // normalizeCompany is idempotent, so a stored value that will not
      // re-normalise is corrupt; skip it rather than emit an unusable key.
      if (!key) return []
      return [{
        employerKey: key,
        company: String(row.display_company || row.company_normalized),
        country: String(row.country || ''),
        roles: row.roles,
        postings: row.postings,
        lastPostedAt: row.last_posted_at ? new Date(row.last_posted_at).toISOString() : null,
      }]
    })
  } catch (error) {
    console.warn('[jobs:db] employers read failed:', (error as Error).message)
    return []
  }
}

/** One employer collection with its live postings, newest first. */
export async function getJobEmployerDb(
  employerKey: string,
  limit = 100,
): Promise<{ employer: JobEmployerSummary; jobs: Job[] } | null> {
  const identity = parseJobEmployerKey(employerKey)
  if (!jobsDbEnabled() || !identity) return null
  try {
    await ensureSchema()
    // Totals come from a separate aggregate over the same rows: PostgreSQL does
    // not allow DISTINCT in a window function, and the totals must cover every live
    // posting, not just the page LIMIT keeps.
    //
    // The country matches exactly, including "no country": the list groups a
    // NULL country as its own employer (key country ''), so '' here must mean
    // NULL rather than "every country", or this page would pull in the same
    // company's postings from countries the list counted separately.
    const result = await db().query(
      `WITH live AS (
         SELECT v.data, v.company, v.posted_at, v.cluster_key
           FROM ${schema()}.vacancies v
           JOIN ${schema()}.job_clusters c ON c.cluster_key = v.cluster_key
          WHERE v.active = TRUE
            AND v.cluster_key IS NOT NULL
            AND c.company_normalized = $1
            AND COALESCE(v.country, '') = $2
       ),
       totals AS (
         SELECT COUNT(*)::int AS postings,
                COUNT(DISTINCT cluster_key)::int AS roles
           FROM live
       )
       SELECT live.data, live.company, live.posted_at, totals.postings, totals.roles
         FROM live CROSS JOIN totals
        ORDER BY live.posted_at DESC
        LIMIT $3`,
      [identity.company, identity.country, Math.min(Math.max(limit, 1), 200)],
    )
    const rows = result.rows
    // Below the threshold it is not a collection, and answering would leak a
    // page for every one-off posting.
    if (!rows.length || rows[0].roles < MIN_EMPLOYER_ROLES) return null
    return {
      employer: {
        employerKey,
        company: String(rows[0].company || identity.company),
        country: identity.country,
        roles: rows[0].roles,
        postings: rows[0].postings,
        lastPostedAt: rows[0].posted_at ? new Date(rows[0].posted_at).toISOString() : null,
      },
      jobs: rows.map((row) => row.data as Job),
    }
  } catch (error) {
    console.warn('[jobs:db] employer read failed:', (error as Error).message)
    return null
  }
}
