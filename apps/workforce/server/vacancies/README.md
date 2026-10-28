# Vacancies domain

This directory owns the vacancy bounded context. Code belongs here when it
creates, normalizes, stores, searches or serves job openings.

## Sections

- `sources/` — upstream adapters. They describe request/response semantics and
  map source records into the canonical vacancy contract. They do not own
  retries, pacing, queue leases, crawl depth or scheduler cadence.
- `domain/` — pure vacancy rules and value transformations. Domain modules must
  not import HTTP, PostgreSQL, Elasticsearch or worker lifecycle code.
- `application/` — use cases that coordinate domain rules and ports.
- `infrastructure/` — PostgreSQL, Elasticsearch and external service adapters.

Shared traversal and transport mechanics belong in `packages/` or `shared/`,
not in a source adapter. CV/candidate behavior belongs in `server/hiring` until
that bounded context is renamed to `server/cv` in a contract-preserving step.

## Where the vacancy list lives (`JOBS_STORE`)

- `snapshot` (default): the whole list is one JSON value (`jobs:store:v4` in the state store, hundreds of MB). Every
  source merge reads and parses it, merges, prunes, serialises and writes it back, and a coalesced sync then parses it
  again to update Elasticsearch and PostgreSQL. Several copies of it sit on the heap at once.
- `postgres`: `jobs.vacancies` is the store. A source writes only its own vacancies (`upsertJobsIncremental`, which
  also recounts the clusters it touched), a vacancy a source reports closed is deactivated by key, ageing out is a query
  (`pruneJobs`: posted more than 14 days ago, or last seen by its source more than 4 days ago), and Elasticsearch gets
  just the changed documents. AI results update the row of a vacancy that is still live. Nothing reads the whole table.
  The JSON value is still produced, in pieces and from the database (`snapshotPieces`, at most every
  `JOBS_SNAPSHOT_EXPORT_MIN_INTERVAL_SECONDS`, 300 by default), because readers that have not moved yet use it (text
  search in `jobs-feed`, `jobs-vacancy`, share previews) and because switching back has to find it current. The search
  index is reconciled against the table every six hours.

`last_seen_at` (migration `005_last_seen.sql`) is nullable on purpose: a vacancy the incremental store has not seen yet
is aged out by its posting date only, so switching the store does not drop live vacancies whose sources have not come
round again.

Switching on: deploy the migration first (the `vacancies-migrate` service), then set `JOBS_STORE=postgres` for
`vacancies-worker` and recreate it. Switching back is `JOBS_STORE=snapshot` and a recreate: the exported value is at most
a few minutes behind. The CV worker keeps its own snapshot (`hiring:store:v4`) and is not changed by this.

