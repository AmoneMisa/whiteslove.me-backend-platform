-- Employer collections (companies with 2+ different live roles).
--
-- No table: an employer is an aggregate over live vacancies grouped by the
-- cluster's normalised company, and the URL key is a reversible encoding of
-- (country, normalised company). Materialising it would add a refresh step to
-- every sync for a read that these two indexes already serve.

-- The collections list: group live postings by cluster within a country.
-- Partial on the same predicate as the query so closed vacancies, which are
-- most of the table over time, stay out of the index entirely.
CREATE INDEX IF NOT EXISTS vacancies_employer_group_idx
  ON {{schema}}.vacancies (country, cluster_key)
  WHERE active = TRUE AND cluster_key IS NOT NULL;

-- One employer's page: reach its clusters by normalised name, then its
-- postings through the existing vacancies_cluster_idx.
CREATE INDEX IF NOT EXISTS job_clusters_company_idx
  ON {{schema}}.job_clusters (company_normalized, country);
