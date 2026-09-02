# Workforce backend

`workforce` is a transitional runtime that hosts two bounded contexts —
**vacancies** and **CV/candidates** — as one deployable app while they are
extracted from the original Personal Site backend. Per
[../../ARCHITECTURE.md](../../ARCHITECTURE.md), the target end state is
independent `vacancies-*` and `cv-*` services; this app is step 4 of that
migration, not the final shape. Read/write access is still split cleanly by
process and queue-claim filter — vacancies and CV never share a worker task
type or scheduler cadence — so the split-out is a build/deploy change, not a
data or code rewrite.

## Entry points

| Path | Runs as | Owns |
| --- | --- | --- |
| `api/server.ts` | `vacancies-api` / `cv-api` (port 4010 / 4011, picked by `WORKFORCE_API_DOMAIN`) | Read-only HTTP API, thin `h3-compat.ts` adapter so route handlers stay framework-agnostic |
| `jobs-worker/worker.ts` | `vacancies-worker` / `cv-worker` | Queue polling, source refresh scheduling, crawler dispatch |
| `server/routes/*.get.ts` | imported by both the API and the Personal Site BFF | Route handlers — the actual request logic; `api/server.ts` just maps paths to them |

Both API and worker processes are started from the **same image** with
different env vars/entrypoints (see [../../README.md](../../README.md)'s
`deploy.sh` invocations); they are still independently selectable Compose
services with independent queue-claim filters, so a vacancies deploy never
recreates the CV worker and vice versa.

## Directory map

```text
api/            HTTP entry point + h3-compat adapter (see table above)
jobs-worker/    Worker entry point, health reporting, per-domain runtimes
server/
  vacancies/    Vacancies bounded context — domain/application/infrastructure/sources (see its README)
  hiring/       CV/candidate bounded context — same layering (see its README; folder kept as "hiring" for now, see below)
  jobs/         Legacy vacancies DB pool, not yet folded into server/vacancies/infrastructure
  routes/       Route handlers shared by api/ and the Personal Site BFF
  utils/        Compatibility-era grab-bag: source configs, parsing glue, rate limiting, health/queue helpers — not yet sorted into a bounded context
shared/         Cross-cutting contracts, types and presentation helpers used by both domains
packages/
  crawler-core/ Traversal mechanics, cursor state, pacing, dedup — shared by all crawling source adapters (see its README)
db/migrations/  Schema-scoped SQL migrations (jobs, hiring, queue)
scripts/        Database migration/schema-prep CLI entry points
tests/          Cross-cutting tests that don't belong to one bounded context
```

`server/vacancies` and `server/hiring` follow the same DDD layering:
`sources/` (upstream adapters) → `domain/` (pure rules, no I/O) →
`application/` (use cases) → `infrastructure/` (Postgres/Elasticsearch/etc).
Each has its own README with the rules specific to that context — read those
before adding code there.

**Naming note:** `server/hiring` is the CV/candidate context, not a generic
"hiring" catch-all — the folder name is historical (kept to avoid touching
imports and persisted queue-key contracts mid-migration) and should be read
as `server/cv`. `server/jobs` (singular DB pool) and `server/vacancies`
(the actual domain) are also two names for adjacent territory for the same
reason — don't add new code to `server/jobs`; extend
`server/vacancies/infrastructure` instead and let `server/jobs` shrink over
time.

## Where to add new code

- New vacancy or candidate business logic → the matching `domain/` folder,
  not `server/utils`.
- New upstream source (job board, Telegram channel, social platform) →
  `sources/` in the matching bounded context, or `sources/` at repo root if
  it's shared adapter data rather than workforce-specific glue.
- New crawler traversal/pacing/retry behavior → `packages/crawler-core`, not
  a source adapter. Adapters must not grow their own concurrency, retry, or
  cursor policy — see the crawler-core README.
- Deterministic multilingual text parsing/dictionaries (salary, experience,
  location, contact extraction) → `@whiteslove/parsing-lexicon`, not a local
  file here. This app is a consumer of that package, not a second home for
  parsing logic.
- Genuinely cross-domain code (used by both vacancies and CV) → `shared/`.

`server/utils` is legacy surface area, not a template to extend — if you're
adding something new that fits one of the categories above, put it there
instead of growing `server/utils` further.
