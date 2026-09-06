// Durable candidate storage in the shared Postgres, in its own `hiring` schema
// so the site's tables never collide with flat-finder's public ones.

import { Pool, type PoolClient } from 'pg'
import { candidateFingerprint, normalizeCandidate } from '../../utils/hiring/hiringNormalize'
import { withProfessionExperience } from '../../utils/hiring/hiringExperience'
import type { CvProfile, HiringStatistics } from '../../../shared/contracts/hiring'
import { runOrigin, type SourceRun } from '../../../shared/hiring/hiringDiagnostics'
import { publicEntityId } from '../../../shared/publicEntityId'
import { canonicalCityValue } from '../../../shared/locationCatalog'
import { hiringStatisticGroupsForProfessions } from '../../../shared/hiringStatisticGroups'
import { expandHiringProfessionFilters } from '../../../shared/hiringProfessionGroups'
import { convertCurrency } from '../../utils/support/currency'
import { BoundedTtlCache } from '../../utils/support/boundedTtlCache'
import {
  publicCandidateGender,
  publicCandidateProfessionKeys,
  publicCandidateRemote,
  publicCandidateSalary,
} from '../../utils/hiring/hiringCandidatePresentation'
import {
  rebuildCurrentCandidates,
  syncCurrentCandidateKeys,
} from './currentCandidateReadModel'

const HYDRATE_LIMIT = 5_000
const UPSERT_BATCH = 500
const RETENTION_MONTHS = 3
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i
const HIRING_STATS_CACHE_TTL_MS = 60_000
const HIRING_STATS_CACHE_MAX_ENTRIES = 250

let pool: Pool | undefined
let schemaReady: Promise<void> | undefined
let candidateBackfillComplete = false

const hiringStatsCache = new BoundedTtlCache<string, HiringStatistics>({
  maxEntries: HIRING_STATS_CACHE_MAX_ENTRIES,
  defaultTtlMs: HIRING_STATS_CACHE_TTL_MS,
})

function schema(): string {
  const raw = (process.env.HIRING_DB_SCHEMA || 'hiring').trim()
  return SCHEMA_RE.test(raw) ? raw : 'hiring'
}

export function hiringDbEnabled(): boolean {
  return Boolean((process.env.HIRING_DATABASE_URL || '').trim())
}

/** Lightweight readiness probe used by the workforce API container. */
export async function checkHiringDbReady(): Promise<boolean> {
  if (!hiringDbEnabled()) return false
  try {
    await ensureSchema()
    await db().query('SELECT 1')
    return true
  } catch (error) {
    console.warn('[hiring:db] readiness probe failed:', (error as Error).message)
    return false
  }
}

function db(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.HIRING_DATABASE_URL,
      max: Number(process.env.HIRING_DB_POOL_MAX) || 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (error) => console.error('[hiring:db] idle client error:', error.message))
  }
  return pool
}

function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady
  const name = schema()
  schemaReady = (async () => {
    const relations = await db().query(
      `SELECT
         to_regclass($1)::text AS candidates,
         to_regclass($2)::text AS source_runs,
         to_regclass($3)::text AS candidate_current,
         to_regclass($4)::text AS migrations`,
      [
        `${name}.candidates`,
        `${name}.source_runs`,
        `${name}.candidate_current`,
        `${name}._site_migrations`,
      ],
    )
    const row = relations.rows[0]
    if (!row?.candidates || !row?.source_runs || !row?.candidate_current || !row?.migrations) {
      throw new Error(`Hiring schema ${name} is not migrated; run scripts/migrate-database.ts before runtime`)
    }
  })().catch((error) => {
    schemaReady = undefined
    throw error
  })
  return schemaReady
}

function isoDate(value: unknown): string | null {
  const date = new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function candidateRow(profile: CvProfile, handle: string) {
  const base = withProfessionExperience(normalizeCandidate(profile))
  const publicProfessions = publicCandidateProfessionKeys(base)
  const normalized: CvProfile = {
    ...base,
    ...publicCandidateSalary(base),
    gender: publicCandidateGender(base),
    remote: publicCandidateRemote(base),
    role: publicProfessions[0] || base.role,
    professions: publicProfessions.length ? publicProfessions : base.professions,
  }
  const sourceKey = String(normalized.sourceKey || normalized.source || 'unknown').toLowerCase()
  const origin = String(normalized.origin || 'telegram').toLowerCase()
  const professions = [...new Set([...(normalized.professions || []), normalized.role]
    .map((value) => String(value || '').trim()).filter(Boolean))]
  const currency = String(normalized.currency || 'USD').trim().toUpperCase()
  return {
    source: String(normalized.source || 'telegram').toLowerCase(),
    country: String(normalized.country || '').toUpperCase(),
    source_id: String(normalized.id || ''),
    source_handle: handle.replace(/^@/, ''),
    name: String(normalized.name || ''),
    role: String(normalized.role || ''),
    city: normalized.city ?? null,
    district: normalized.district ?? null,
    remote: normalized.remote ?? null,
    experience_years: Number.isFinite(Number(normalized.experienceYears)) ? Number(normalized.experienceYears) : null,
    created_at: isoDate(normalized.createdAt),
    url: String(normalized.url || ''),
    public_id: normalized.publicId ?? publicEntityId('candidate', sourceKey, normalized.country, normalized.id),
    origin,
    source_key: sourceKey,
    provider: String(normalized.sourceLabel || (origin === 'telegram' ? 'Telegram' : sourceKey)),
    canonical_city: normalized.city ? canonicalCityValue(normalized.city) : String(normalized.country || '__unknown__'),
    activity_at: isoDate(normalized.activityAt || normalized.updatedAt || normalized.createdAt),
    gender: normalized.gender || 'unknown',
    age: normalized.age != null && Number.isFinite(Number(normalized.age)) ? Number(normalized.age) : null,
    salary_min_usd: convertCurrency(normalized.salaryMin, currency, 'USD') ?? null,
    salary_max_usd: convertCurrency(normalized.salaryMax, currency, 'USD') ?? null,
    seniority: normalized.seniority || null,
    professions,
    sectors: hiringStatisticGroupsForProfessions(professions),
    skills: [...new Set((normalized.skills || []).map((value) => value.toLocaleLowerCase('en')))],
    languages: [...new Set((normalized.languages || []).map((value) => value.toLocaleLowerCase('en')))],
    description: String(normalized.description || ''),
    search_text: [
      normalized.name, ...professions, ...(normalized.previousProfessions || []),
      ...(normalized.features || []), ...(normalized.skills || []), normalized.city,
      normalized.district, normalized.description,
    ].filter(Boolean).join(' '),
    dedupe_key: candidateFingerprint(normalized),
    data: normalized,
  }
}

const UPSERT_SQL = (name: string) => `
  INSERT INTO ${name}.candidates (
    source, country, source_id, source_handle, name, role, city, district,
    remote, experience_years, created_at, url, active, first_seen_at,
    last_seen_at, updated_at, data, public_id, origin, source_key, provider,
    canonical_city, activity_at, gender, age, salary_min_usd,
    salary_max_usd, seniority, professions, sectors, skills, languages,
    description, search_text, dedupe_key
  )
  SELECT
    input.source, input.country, input.source_id, input.source_handle,
    input.name, input.role, input.city, input.district, input.remote,
    input.experience_years, input.created_at, input.url, TRUE,
    NOW(), NOW(), NOW(), input.data, input.public_id, input.origin,
    input.source_key, input.provider, input.canonical_city,
    input.activity_at, input.gender, input.age, input.salary_min_usd,
    input.salary_max_usd, input.seniority, input.professions,
    input.sectors, input.skills, input.languages, input.description,
    input.search_text, input.dedupe_key
  FROM jsonb_to_recordset($1::jsonb) AS input (
    source TEXT, country TEXT, source_id TEXT, source_handle TEXT, name TEXT,
    role TEXT, city TEXT, district TEXT, remote BOOLEAN,
    experience_years DOUBLE PRECISION, created_at TIMESTAMPTZ, url TEXT,
    data JSONB, public_id BIGINT, origin TEXT, source_key TEXT,
    provider TEXT, canonical_city TEXT, activity_at TIMESTAMPTZ,
    gender TEXT, age SMALLINT, salary_min_usd DOUBLE PRECISION,
    salary_max_usd DOUBLE PRECISION, seniority TEXT, professions TEXT[],
    sectors TEXT[], skills TEXT[], languages TEXT[], description TEXT,
    search_text TEXT, dedupe_key TEXT
  )
  WHERE input.source_id <> '' AND input.country <> '' AND input.created_at IS NOT NULL
  ON CONFLICT (source, country, source_id) DO UPDATE SET
    source_handle = EXCLUDED.source_handle,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    city = EXCLUDED.city,
    district = EXCLUDED.district,
    remote = EXCLUDED.remote,
    experience_years = EXCLUDED.experience_years,
    created_at = EXCLUDED.created_at,
    url = EXCLUDED.url,
    active = TRUE,
    last_seen_at = NOW(),
    updated_at = NOW(),
    data = EXCLUDED.data,
    public_id = EXCLUDED.public_id,
    origin = EXCLUDED.origin,
    source_key = EXCLUDED.source_key,
    provider = EXCLUDED.provider,
    canonical_city = EXCLUDED.canonical_city,
    activity_at = EXCLUDED.activity_at,
    gender = EXCLUDED.gender,
    age = EXCLUDED.age,
    salary_min_usd = EXCLUDED.salary_min_usd,
    salary_max_usd = EXCLUDED.salary_max_usd,
    seniority = EXCLUDED.seniority,
    professions = EXCLUDED.professions,
    sectors = EXCLUDED.sectors,
    skills = EXCLUDED.skills,
    languages = EXCLUDED.languages,
    description = EXCLUDED.description,
    search_text = EXCLUDED.search_text,
    dedupe_key = EXCLUDED.dedupe_key;
`

async function finishReadModelBackfill(): Promise<void> {
  await rebuildCurrentCandidates(db(), schema())
  candidateBackfillComplete = true
}

export async function backfillDbCandidateReadModel(): Promise<void> {
  if (!hiringDbEnabled() || candidateBackfillComplete) return
  await ensureSchema()

  for (let batch = 0; batch < Math.ceil(HYDRATE_LIMIT / UPSERT_BATCH); batch += 1) {
    const legacy = await db().query<{
      data: CvProfile
      source: string
      country: string
      source_id: string
      source_handle: string
      created_at: Date
      url: string
    }>(
      `SELECT data, source, country, source_id, source_handle, created_at, url
       FROM ${schema()}.candidates
       WHERE active = TRUE AND (public_id IS NULL OR dedupe_key IS NULL)
       ORDER BY id
       LIMIT $1`,
      [UPSERT_BATCH],
    )
    if (!legacy.rows.length) {
      await finishReadModelBackfill()
      return
    }
    const rows = legacy.rows.map((row) => candidateRow({
      ...(row.data || {}),
      source: row.data?.source || row.source,
      country: row.data?.country || row.country,
      id: row.data?.id || row.source_id,
      createdAt: row.data?.createdAt || isoDate(row.created_at) || String(row.created_at),
      url: row.data?.url || row.url,
    } as CvProfile, row.source_handle))
    await db().query(UPSERT_SQL(schema()), [JSON.stringify(rows)])
    if (legacy.rows.length < UPSERT_BATCH) {
      await finishReadModelBackfill()
      return
    }
  }
  await finishReadModelBackfill()
}

export async function loadDbCandidates(): Promise<CvProfile[]> {
  if (!hiringDbEnabled()) return []
  try {
    await ensureSchema()
    const result = await db().query<{ data: CvProfile }>(
      `SELECT candidate.data
       FROM ${schema()}.candidate_current current
       JOIN ${schema()}.candidates candidate ON candidate.id = current.candidate_id
       WHERE candidate.active = TRUE
         AND candidate.created_at >= (NOW() - INTERVAL '${RETENTION_MONTHS} months')
         AND candidate.created_at <= (NOW() + INTERVAL '48 hours')
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT $1;`,
      [HYDRATE_LIMIT],
    )
    return result.rows.map((row) => row.data).filter(Boolean)
  } catch (error) {
    console.warn('[hiring:db] load failed:', (error as Error).message)
    return []
  }
}

export interface DbCandidateFeed {
  profiles: CvProfile[]
  count: number
  statistics: HiringStatistics
  sourceCounts: Record<string, number>
}

function queryList(params: URLSearchParams, key: string): string[] {
  return (params.get(key) || '').split(',').map((value) => value.trim()).filter(Boolean)
}

function candidateOrder(sort: string, alias = 'candidate'): string {
  const col = (name: string) => `${alias}.${name}`
  if (sort === 'name_asc') return `LOWER(${col('name')}) ASC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'name_desc') return `LOWER(${col('name')}) DESC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'experience_desc') return `${col('experience_years')} DESC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'experience_asc') return `${col('experience_years')} ASC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'age_desc') return `${col('age')} DESC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'age_asc') return `${col('age')} ASC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'salary_desc') return `COALESCE(${col('salary_max_usd')}, ${col('salary_min_usd')}) DESC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  if (sort === 'salary_asc') return `COALESCE(${col('salary_min_usd')}, ${col('salary_max_usd')}) ASC NULLS LAST, ${col('activity_at')} DESC NULLS LAST, ${col('id')} DESC`
  return `${col('activity_at')} DESC NULLS LAST, ${col('created_at')} DESC, ${col('id')} DESC`
}

function emptyHiringStatistics(): HiringStatistics {
  return {
    genders: { female: 0, male: 0, unknown: 0 },
    ages: ['<18', '18–24', '25–34', '35–44', '45–54', '55+', '__unknown__'].map((label) => ({ label, value: 0 })),
    platforms: [], locations: [], sectors: [], professions: [], activity: [],
    salaryByExperience: [null, null, null, null, null],
    salaryByProfession: [], salarySamples: 0,
  }
}

type CandidateFilter = { where: string; values: unknown[] }

function candidateFilter(params: URLSearchParams, alias = 'candidate'): CandidateFilter {
  const values: unknown[] = []
  const add = (value: unknown) => { values.push(value); return `$${values.length}` }
  const col = (name: string) => `${alias}.${name}`
  const where = [
    `${col('active')} = TRUE`,
    `${col('created_at')} >= NOW() - INTERVAL '${RETENTION_MONTHS} months'`,
    `${col('created_at')} <= NOW() + INTERVAL '48 hours'`,
  ]
  const countries = queryList(params, 'countries').map((value) => value.toUpperCase())
  if (countries.length) where.push(`${col('country')} = ANY(${add(countries)}::text[])`)
  const city = String(params.get('city') || '').trim()
  if (city) where.push(`LOWER(${col('canonical_city')}) = LOWER(${add(canonicalCityValue(city))})`)
  const remote = params.get('remote')
  if (remote === '1' || remote === '0') where.push(`${col('remote')} = ${add(remote === '1')}`)
  const experienceMin = Number(params.get('experienceMin'))
  if (Number.isFinite(experienceMin) && experienceMin > 0) where.push(`${col('experience_years')} >= ${add(experienceMin)}`)
  const ageMin = Number(params.get('ageMin'))
  if (Number.isFinite(ageMin) && ageMin > 0) where.push(`${col('age')} >= ${add(ageMin)}`)
  const ageMax = Number(params.get('ageMax'))
  if (Number.isFinite(ageMax) && ageMax > 0) where.push(`${col('age')} <= ${add(ageMax)}`)
  const salaryCurrency = String(params.get('salaryCurrency') || 'USD').trim().toUpperCase()
  const salaryFrom = convertCurrency(Number(params.get('salaryFrom')), salaryCurrency, 'USD')
  const salaryTo = convertCurrency(Number(params.get('salaryTo')), salaryCurrency, 'USD')
  if (salaryFrom != null) where.push(`COALESCE(${col('salary_max_usd')}, ${col('salary_min_usd')}) >= ${add(salaryFrom)}`)
  if (salaryTo != null) where.push(`COALESCE(${col('salary_min_usd')}, ${col('salary_max_usd')}) <= ${add(salaryTo)}`)
  const gender = String(params.get('gender') || '').trim().toLowerCase()
  if (gender) where.push(`${col('gender')} = ${add(gender)}`)
  const professions = expandHiringProfessionFilters(queryList(params, 'professions'))
  if (professions.length) where.push(`${col('professions')} && ${add(professions)}::text[]`)
  const seniority = String(params.get('seniority') || '').trim().toLowerCase()
  if (seniority) where.push(`${col('seniority')} = ${add(seniority)}`)
  const skills = queryList(params, 'skills').map((value) => value.toLocaleLowerCase('en'))
  if (skills.length) where.push(`${col('skills')} @> ${add(skills)}::text[]`)
  const languages = queryList(params, 'languages').map((value) => value.toLocaleLowerCase('en'))
  if (languages.length) where.push(`${col('languages')} && ${add(languages)}::text[]`)
  const query = String(params.get('query') || '').trim()
  if (query) where.push(`to_tsvector('simple', ${col('search_text')}) @@ plainto_tsquery('simple', ${add(query)})`)
  const sources = queryList(params, 'sources').map((value) => value.toLowerCase())
  if (sources.length) where.push(`(${col('source_key')} = ANY(${add(sources)}::text[]) OR ${col('origin')} = ANY(${add(sources)}::text[]))`)
  const profileId = String(params.get('profileId') || params.get('listingId') || '').trim()
  if (profileId) where.push(`${col('source_id')} = ${add(profileId)}`)
  const publicId = String(params.get('publicId') || '').trim()
  if (publicId && /^\d+$/.test(publicId)) where.push(`${col('public_id')} = ${add(publicId)}::bigint`)
  return { where: where.join(' AND '), values }
}

function hiringStatsCacheKey(params: URLSearchParams): string {
  const copy = new URLSearchParams(params)
  for (const key of ['page', 'offset', 'limit', 'sort']) copy.delete(key)
  const entries = [...copy.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    const order = keyA.localeCompare(keyB)
    return order || valueA.localeCompare(valueB)
  })
  return new URLSearchParams(entries).toString()
}

async function queryHiringStatistics(params: URLSearchParams): Promise<HiringStatistics> {
  const cacheKey = hiringStatsCacheKey(params)
  const cached = hiringStatsCache.get(cacheKey)
  if (cached) return cached

  const filter = candidateFilter(params)
  const result = await db().query({
    text: `
      WITH filtered AS MATERIALIZED (
        SELECT
          candidate.gender, candidate.age, candidate.provider,
          candidate.source_key, candidate.origin, candidate.canonical_city,
          candidate.country, candidate.sectors, candidate.professions,
          candidate.activity_at, candidate.salary_min_usd,
          candidate.salary_max_usd, candidate.experience_years
        FROM ${schema()}.candidate_current current
        JOIN ${schema()}.candidates candidate ON candidate.id = current.candidate_id
        WHERE ${filter.where}
      ), platform_counts AS (
        SELECT COALESCE(NULLIF(provider, ''), source_key, origin, 'unknown') label, COUNT(*)::int value
        FROM filtered GROUP BY 1 ORDER BY value DESC, label ASC
      ), location_counts AS (
        SELECT COALESCE(NULLIF(canonical_city, ''), country, '__unknown__') label, COUNT(*)::int value
        FROM filtered GROUP BY 1 ORDER BY value DESC, label ASC
      ), sector_counts AS (
        SELECT sector label, COUNT(*)::int value FROM filtered, unnest(sectors) sector
        GROUP BY sector ORDER BY value DESC, label ASC
      ), profession_counts AS (
        SELECT profession label, COUNT(*)::int value FROM filtered, unnest(professions) profession
        WHERE profession <> 'Any Role' GROUP BY profession ORDER BY value DESC, label ASC
      ), activity_counts AS (
        SELECT activity_at::date::text date, COUNT(*)::int value FROM filtered
        WHERE activity_at >= NOW() - INTERVAL '60 days' AND activity_at <= NOW()
        GROUP BY activity_at::date ORDER BY activity_at::date
      ), salary_profession AS (
        SELECT profession, COUNT(*)::int count,
          MIN(LEAST(COALESCE(salary_min_usd, salary_max_usd), COALESCE(salary_max_usd, salary_min_usd)))::float8 min_usd,
          MAX(GREATEST(COALESCE(salary_min_usd, salary_max_usd), COALESCE(salary_max_usd, salary_min_usd)))::float8 max_usd
        FROM filtered, unnest(professions) profession
        WHERE COALESCE(salary_min_usd, salary_max_usd) IS NOT NULL AND profession <> 'Any Role'
        GROUP BY profession ORDER BY count DESC, max_usd DESC, profession ASC
      ), salary_experience AS (
        SELECT CASE
          WHEN experience_years < 2 THEN 0 WHEN experience_years < 4 THEN 1
          WHEN experience_years < 7 THEN 2 WHEN experience_years < 11 THEN 3 ELSE 4
        END bucket,
          (percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (COALESCE(salary_min_usd, salary_max_usd) + COALESCE(salary_max_usd, salary_min_usd)) / 2.0
          ))::float8 AS median
        FROM filtered
        WHERE experience_years IS NOT NULL AND COALESCE(salary_min_usd, salary_max_usd) IS NOT NULL
        GROUP BY 1
      )
      SELECT jsonb_build_object(
        'genders', jsonb_build_object(
          'female', (SELECT (COUNT(*) FILTER (WHERE gender = 'female'))::int FROM filtered),
          'male', (SELECT (COUNT(*) FILTER (WHERE gender = 'male'))::int FROM filtered),
          'unknown', (SELECT (COUNT(*) FILTER (WHERE gender IS NULL OR gender NOT IN ('female', 'male')))::int FROM filtered)
        ),
        'ages', (SELECT jsonb_agg(jsonb_build_object('label', label, 'value', value) ORDER BY ord) FROM (VALUES
          (1, '<18', (SELECT COUNT(*)::int FROM filtered WHERE age < 18)),
          (2, '18–24', (SELECT COUNT(*)::int FROM filtered WHERE age >= 18 AND age < 25)),
          (3, '25–34', (SELECT COUNT(*)::int FROM filtered WHERE age >= 25 AND age < 35)),
          (4, '35–44', (SELECT COUNT(*)::int FROM filtered WHERE age >= 35 AND age < 45)),
          (5, '45–54', (SELECT COUNT(*)::int FROM filtered WHERE age >= 45 AND age < 55)),
          (6, '55+', (SELECT COUNT(*)::int FROM filtered WHERE age >= 55)),
          (7, '__unknown__', (SELECT COUNT(*)::int FROM filtered WHERE age IS NULL))
        ) ages(ord, label, value)),
        'platforms', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'value', value)) FROM platform_counts), '[]'::jsonb),
        'locations', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'value', value)) FROM location_counts), '[]'::jsonb),
        'sectors', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'value', value)) FROM sector_counts), '[]'::jsonb),
        'professions', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'value', value)) FROM profession_counts), '[]'::jsonb),
        'activity', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', date, 'value', value)) FROM activity_counts), '[]'::jsonb),
        'salaryByExperience', (SELECT jsonb_agg(
          (SELECT median FROM salary_experience WHERE bucket = series.bucket) ORDER BY series.bucket
        ) FROM generate_series(0, 4) series(bucket)),
        'salaryByProfession', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'profession', profession, 'count', count, 'minUsd', min_usd, 'maxUsd', max_usd
        )) FROM salary_profession), '[]'::jsonb),
        'salarySamples', (SELECT COUNT(*)::int FROM filtered
          WHERE experience_years IS NOT NULL AND COALESCE(salary_min_usd, salary_max_usd) IS NOT NULL)
      ) statistics
    `,
    values: filter.values,
  })
  const statistics = { ...emptyHiringStatistics(), ...(result.rows[0]?.statistics || {}) }
  hiringStatsCache.set(cacheKey, statistics)
  return statistics
}

export async function queryDbCandidates(
  params: URLSearchParams,
  offset: number,
  limit: number,
): Promise<DbCandidateFeed | null> {
  if (!hiringDbEnabled()) return null
  try {
    await ensureSchema()

    const pageFilter = candidateFilter(params)
    const pageValues = [...pageFilter.values, limit, offset]
    const pageLimit = `$${pageValues.length - 1}`
    const pageOffset = `$${pageValues.length}`
    const summaryFilter = candidateFilter(params)
    const sort = String(params.get('sort') || 'recent').toLowerCase()

    const [pageResult, summaryResult, statistics] = await Promise.all([
      db().query({
        text: `
          SELECT candidate.data || jsonb_build_object('publicId', candidate.public_id) AS data
          FROM ${schema()}.candidate_current current
          JOIN ${schema()}.candidates candidate ON candidate.id = current.candidate_id
          WHERE ${pageFilter.where}
          ORDER BY ${candidateOrder(sort)}
          LIMIT ${pageLimit} OFFSET ${pageOffset}
        `,
        values: pageValues,
      }),
      db().query({
        text: `
          WITH filtered AS (
            SELECT candidate.source_key, candidate.origin
            FROM ${schema()}.candidate_current current
            JOIN ${schema()}.candidates candidate ON candidate.id = current.candidate_id
            WHERE ${summaryFilter.where}
          )
          SELECT
            (SELECT COUNT(*)::int FROM ${schema()}.candidates WHERE active = TRUE) database_total,
            (SELECT COUNT(*)::int FROM ${schema()}.candidates
              WHERE active = TRUE AND public_id IS NOT NULL AND dedupe_key IS NOT NULL) database_ready,
            (SELECT COUNT(*)::int FROM filtered) count,
            COALESCE((SELECT jsonb_object_agg(key, value) FROM (
              SELECT key, COUNT(*)::int value
              FROM filtered
              CROSS JOIN LATERAL unnest(ARRAY(
                SELECT DISTINCT item FROM unnest(ARRAY[source_key, origin]) item
                WHERE item IS NOT NULL AND item <> ''
              )) key
              GROUP BY key
            ) x), '{}'::jsonb) source_counts
        `,
        values: summaryFilter.values,
      }),
      queryHiringStatistics(params),
    ])

    const row = summaryResult.rows[0]
    if (!row) return null
    if ((Number(row.database_total) || 0) === 0 || Number(row.database_ready) !== Number(row.database_total)) return null
    return {
      profiles: pageResult.rows.map((item) => item.data).filter(Boolean),
      count: Number(row.count) || 0,
      statistics,
      sourceCounts: row.source_counts || {},
    }
  } catch (error) {
    console.warn('[hiring:db] indexed read failed:', (error as Error).message)
    return null
  }
}

async function previousDedupeKeys(client: PoolClient, rows: Array<ReturnType<typeof candidateRow>>): Promise<string[]> {
  if (!rows.length) return []
  const identities = rows.map((row) => ({ source: row.source, country: row.country, source_id: row.source_id }))
  const result = await client.query(
    `SELECT candidate.dedupe_key
     FROM ${schema()}.candidates candidate
     JOIN jsonb_to_recordset($1::jsonb) input(source TEXT, country TEXT, source_id TEXT)
       ON candidate.source = input.source
      AND candidate.country = input.country
      AND candidate.source_id = input.source_id
     WHERE candidate.dedupe_key IS NOT NULL AND candidate.dedupe_key <> ''`,
    [JSON.stringify(identities)],
  )
  return result.rows.map((row) => String(row.dedupe_key || '')).filter(Boolean)
}

export async function saveDbCandidates(
  profiles: CvProfile[],
  diagnostic: SourceRun,
): Promise<number> {
  if (!hiringDbEnabled()) return 0
  try {
    await ensureSchema()
    const unique = new Map<string, ReturnType<typeof candidateRow>>()
    for (const profile of profiles) {
      const row = candidateRow(profile, diagnostic.handle)
      if (!row.source_id || !row.country || !row.created_at) continue
      unique.set(`${row.source}:${row.country}:${row.source_id}`, row)
    }

    const rows = [...unique.values()]
    const client = await db().connect()
    try {
      await client.query('BEGIN')
      const oldKeys = await previousDedupeKeys(client, rows)
      for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH) {
        await client.query(UPSERT_SQL(schema()), [JSON.stringify(rows.slice(offset, offset + UPSERT_BATCH))])
      }
      await syncCurrentCandidateKeys(client, schema(), [
        ...oldKeys,
        ...rows.map((row) => row.dedupe_key),
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    hiringStatsCache.clear()
    await recordDbSourceRun(diagnostic)
    return rows.length
  } catch (error) {
    console.warn(`[hiring:db] upsert @${diagnostic.handle} failed:`, (error as Error).message)
    return 0
  }
}

export async function recordDbSourceRun(diagnostic: SourceRun): Promise<void> {
  if (!hiringDbEnabled()) return
  try {
    await ensureSchema()
    await db().query(
      `INSERT INTO ${schema()}.source_runs (
         source, handle, country, status, fetched, candidates, error,
         checked_at, last_success_at, updated_at
       ) VALUES ($1, $2, $3, $4::text, $5, $6, $7, $8::timestamptz,
         CASE WHEN $4::text <> 'error' THEN $8::timestamptz ELSE NULL END, NOW())
       ON CONFLICT (source, handle) DO UPDATE SET
         country = EXCLUDED.country,
         status = EXCLUDED.status,
         fetched = EXCLUDED.fetched,
         candidates = EXCLUDED.candidates,
         error = EXCLUDED.error,
         checked_at = EXCLUDED.checked_at,
         last_success_at = CASE
           WHEN EXCLUDED.status <> 'error' THEN EXCLUDED.checked_at
           ELSE ${schema()}.source_runs.last_success_at
         END,
         updated_at = NOW();`,
      [
        runOrigin(diagnostic.handle),
        diagnostic.handle.replace(/^@/, ''),
        (diagnostic.country || '').toUpperCase(),
        ['ok', 'empty', 'error'].includes(diagnostic.status) ? diagnostic.status : 'error',
        Math.max(0, diagnostic.fetched || 0),
        Math.max(0, diagnostic.candidates || 0),
        diagnostic.error ? diagnostic.error.slice(0, 2000) : null,
        isoDate(diagnostic.checkedAt) || new Date().toISOString(),
      ],
    )
  } catch (error) {
    console.warn(`[hiring:db] source run @${diagnostic.handle} failed:`, (error as Error).message)
  }
}

const SOURCE_RUNS_TTL_MS = 60_000
let sourceRunsCache: Array<SourceRun & { lastSuccessAt?: string | null }> = []
let sourceRunsAt = 0

export async function loadDbSourceRuns(): Promise<Array<SourceRun & { lastSuccessAt?: string | null }>> {
  if (!hiringDbEnabled()) return []
  if (Date.now() - sourceRunsAt < SOURCE_RUNS_TTL_MS) return sourceRunsCache
  try {
    await ensureSchema()
    const result = await db().query(
      `SELECT source, handle, country, status, fetched, candidates, error, checked_at, last_success_at
       FROM ${schema()}.source_runs ORDER BY checked_at DESC, handle ASC;`,
    )
    sourceRunsCache = result.rows.map((row) => ({
      handle: row.handle,
      country: row.country,
      status: row.status,
      fetched: Number(row.fetched) || 0,
      candidates: Number(row.candidates) || 0,
      error: row.error || undefined,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : '',
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    }))
    sourceRunsAt = Date.now()
    return sourceRunsCache
  } catch (error) {
    console.warn('[hiring:db] source runs failed:', (error as Error).message)
    sourceRunsAt = Date.now()
    sourceRunsCache = []
    return sourceRunsCache
  }
}

export async function pruneDbCandidates(): Promise<number> {
  if (!hiringDbEnabled()) return 0
  try {
    await ensureSchema()
    const client = await db().connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `DELETE FROM ${schema()}.candidates
         WHERE created_at < (NOW() - INTERVAL '${RETENTION_MONTHS} months')
            OR created_at > (NOW() + INTERVAL '48 hours')
         RETURNING dedupe_key;`,
      )
      await syncCurrentCandidateKeys(
        client,
        schema(),
        result.rows.map((row) => String(row.dedupe_key || '')).filter(Boolean),
      )
      await client.query('COMMIT')
      hiringStatsCache.clear()
      return result.rowCount || 0
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.warn('[hiring:db] prune failed:', (error as Error).message)
    return 0
  }
}
