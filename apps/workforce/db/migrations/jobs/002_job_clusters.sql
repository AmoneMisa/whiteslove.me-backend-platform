-- Job clusters and provenance (§37).
--
-- vacancies.identity_key is one posting (source:url). A cluster is the role
-- being advertised, which may be reposted, cross-posted and handed between
-- recruiters without becoming a different job. The key excludes salary, text
-- and application URL on purpose: those change between postings of one role,
-- and including them would make every repost look new.

CREATE TABLE IF NOT EXISTS {{schema}}.job_clusters (
  cluster_key CHAR(64) PRIMARY KEY,
  country TEXT,
  company_normalized TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  locality TEXT,

  posting_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Provenance findings as reason codes. Evidence, not a verdict: evergreen
  -- recruiting and agencies advertising for many companies are both ordinary.
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
)
WITH (fillfactor = 85);

-- Postings already exist in vacancies; the cluster link is one nullable
-- column there rather than a second copy of every posting.
ALTER TABLE {{schema}}.vacancies
  ADD COLUMN IF NOT EXISTS cluster_key CHAR(64);

-- "All postings of this role", the read every provenance check makes.
CREATE INDEX IF NOT EXISTS vacancies_cluster_idx
  ON {{schema}}.vacancies (cluster_key, posted_at)
  WHERE cluster_key IS NOT NULL;

-- Review reads only clusters that carry findings, a small slice of the table.
CREATE INDEX IF NOT EXISTS job_clusters_findings_idx
  ON {{schema}}.job_clusters (last_seen_at DESC)
  WHERE cardinality(reason_codes) > 0;
