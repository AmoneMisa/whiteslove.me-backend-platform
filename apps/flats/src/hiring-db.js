import {pool} from './db.js';

let initPromise;

function safeDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function boundedText(value, max) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function candidateRow(candidate, sourceHandle = '') {
  const data = candidate && typeof candidate === 'object' ? candidate : {};
  return {
    source: String(data.source || 'telegram').toLowerCase(),
    country: String(data.country || '').toUpperCase(),
    source_id: String(data.id || ''),
    source_handle: boundedText(String(sourceHandle || '').replace(/^@/, ''), 255) || '',
    name: boundedText(data.name || '', 200) || '',
    role: boundedText(data.role || '', 200) || '',
    city: boundedText(data.city, 160),
    district: boundedText(data.district, 160),
    remote: data.remote == null ? null : Boolean(data.remote),
    experience_years: Number.isFinite(Number(data.experienceYears)) ? Number(data.experienceYears) : null,
    created_at: safeDate(data.createdAt),
    url: String(data.url || ''),
    data,
  };
}

export async function initHiringDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hiring_candidates (
        id BIGSERIAL PRIMARY KEY,
        source VARCHAR(32) NOT NULL,
        country VARCHAR(8) NOT NULL,
        source_id TEXT NOT NULL,
        source_handle VARCHAR(255) NOT NULL DEFAULT '',
        name VARCHAR(200) NOT NULL DEFAULT '',
        role VARCHAR(200) NOT NULL DEFAULT '',
        city VARCHAR(160),
        district VARCHAR(160),
        remote BOOLEAN,
        experience_years DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT hiring_candidates_source_country_id_unique
          UNIQUE (source, country, source_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS hiring_source_runs (
        source VARCHAR(32) NOT NULL,
        handle VARCHAR(255) NOT NULL,
        country VARCHAR(8) NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL,
        fetched INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_success_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, handle)
      );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS hiring_candidates_active_created_idx ON hiring_candidates(active, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS hiring_candidates_country_created_idx ON hiring_candidates(country, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS hiring_candidates_city_idx ON hiring_candidates(city);');
    await pool.query('CREATE INDEX IF NOT EXISTS hiring_candidates_handle_idx ON hiring_candidates(source_handle);');
    await pool.query('CREATE INDEX IF NOT EXISTS hiring_candidates_data_gin_idx ON hiring_candidates USING GIN(data jsonb_path_ops);');
    console.log('[hiring:postgres] schema ready');
  })().catch((error) => {
    initPromise = undefined;
    throw error;
  });
  return initPromise;
}

const UPSERT_SQL = `
  INSERT INTO hiring_candidates (
    source, country, source_id, source_handle, name, role, city, district,
    remote, experience_years, created_at, url, active, first_seen_at,
    last_seen_at, updated_at, data
  )
  SELECT
    input.source, input.country, input.source_id, input.source_handle,
    input.name, input.role, input.city, input.district, input.remote,
    input.experience_years, input.created_at, input.url, TRUE,
    NOW(), NOW(), NOW(), input.data
  FROM jsonb_to_recordset($1::jsonb) AS input (
    source TEXT,
    country TEXT,
    source_id TEXT,
    source_handle TEXT,
    name TEXT,
    role TEXT,
    city TEXT,
    district TEXT,
    remote BOOLEAN,
    experience_years DOUBLE PRECISION,
    created_at TIMESTAMPTZ,
    url TEXT,
    data JSONB
  )
  WHERE input.source_id <> '' AND input.country <> '' AND input.created_at IS NOT NULL
  ON CONFLICT (source, country, source_id)
  DO UPDATE SET
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
    data = EXCLUDED.data;
`;

export async function upsertHiringCandidates(candidates, sourceHandle = '') {
  await initHiringDb();
  if (!Array.isArray(candidates) || !candidates.length) return 0;

  const unique = new Map();
  for (const candidate of candidates) {
    const row = candidateRow(candidate, sourceHandle);
    if (!row.source_id || !row.country || !row.created_at) continue;
    unique.set(`${row.source}:${row.country}:${row.source_id}`, row);
  }

  const rows = [...unique.values()];
  if (!rows.length) return 0;

  let saved = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await pool.query(UPSERT_SQL, [JSON.stringify(batch)]);
    saved += batch.length;
  }
  return saved;
}

export async function recordHiringSourceRun({
  source = 'telegram',
  handle,
  country = '',
  status,
  fetched = 0,
  candidates = 0,
  error = null,
  checkedAt = null,
}) {
  await initHiringDb();
  const normalizedStatus = ['ok', 'empty', 'error'].includes(status) ? status : 'error';
  const checked = safeDate(checkedAt) || new Date().toISOString();

  await pool.query(`
    INSERT INTO hiring_source_runs (
      source, handle, country, status, fetched, candidates, error,
      checked_at, last_success_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
      CASE WHEN $4 <> 'error' THEN $8::timestamptz ELSE NULL END,
      NOW()
    )
    ON CONFLICT (source, handle)
    DO UPDATE SET
      country = EXCLUDED.country,
      status = EXCLUDED.status,
      fetched = EXCLUDED.fetched,
      candidates = EXCLUDED.candidates,
      error = EXCLUDED.error,
      checked_at = EXCLUDED.checked_at,
      last_success_at = CASE
        WHEN EXCLUDED.status <> 'error' THEN EXCLUDED.checked_at
        ELSE hiring_source_runs.last_success_at
      END,
      updated_at = NOW();
  `, [
    String(source).toLowerCase(),
    boundedText(String(handle || '').replace(/^@/, ''), 255) || '',
    String(country || '').toUpperCase(),
    normalizedStatus,
    Math.max(0, Number(fetched) || 0),
    Math.max(0, Number(candidates) || 0),
    error ? String(error).slice(0, 2000) : null,
    checked,
  ]);
}

export async function pruneHiringCandidates() {
  await initHiringDb();
  const result = await pool.query(`
    DELETE FROM hiring_candidates
    WHERE created_at < (NOW() - INTERVAL '3 months')
       OR created_at > (NOW() + INTERVAL '48 hours');
  `);
  return result.rowCount || 0;
}

export async function listHiringCandidates({ limit = 5000, offset = 0 } = {}) {
  await initHiringDb();
  const safeLimit = Math.min(10_000, Math.max(1, Number(limit) || 5000));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const result = await pool.query(`
    SELECT data
    FROM hiring_candidates
    WHERE active = TRUE
      AND created_at >= (NOW() - INTERVAL '3 months')
      AND created_at <= (NOW() + INTERVAL '48 hours')
    ORDER BY created_at DESC, id DESC
    LIMIT $1 OFFSET $2;
  `, [safeLimit, safeOffset]);

  return result.rows.map((row) => row.data).filter(Boolean);
}

export async function listHiringSourceRuns() {
  await initHiringDb();
  const result = await pool.query(`
    SELECT source, handle, country, status, fetched, candidates, error,
           checked_at, last_success_at
    FROM hiring_source_runs
    ORDER BY checked_at DESC, handle ASC;
  `);
  return result.rows.map((row) => ({
    source: row.source,
    handle: row.handle,
    country: row.country,
    status: row.status,
    fetched: Number(row.fetched) || 0,
    candidates: Number(row.candidates) || 0,
    error: row.error || undefined,
    checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
  }));
}

export async function hiringDbHealth() {
  await initHiringDb();
  await pool.query('SELECT 1');
  return true;
}
