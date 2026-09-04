# whiteslove.me Backend Platform

Backend monorepo for the whiteslove.me product family. It owns shared
infrastructure, AI inference, apartment services, vacancy/CV services and
their crawler execution. The public website remains in its own repository.

The repository started with snapshots of AI Worker and the Flat Finder backend.
The original `ai-worker` repository remains an independent template and is not
linked as a submodule.

## Current services

| Service | Path | Port |
| --- | --- | ---: |
| AI Worker | [`apps/ai-worker`](apps/ai-worker/README.md) | 4030 |
| Flats API/worker | [`apps/flats`](apps/flats/README.md) | 4000 |
| OLX transport | `services/olx-fetcher` | internal |
| Social transport | `services/social-fetcher` | internal |
| Vacancies worker | [`apps/workforce`](apps/workforce/README.md) | internal |
| CV worker | [`apps/workforce`](apps/workforce/README.md) | internal |
| Crawler core | [`apps/workforce/packages/crawler-core`](apps/workforce/packages/crawler-core/README.md) | library |
| Job browser transport | `services/job-browser-fetcher` | internal |
| Vacancies API | [`apps/workforce`](apps/workforce/README.md) | 4010 |
| CV API | [`apps/workforce`](apps/workforce/README.md) | 4011 |
| Telegram subscription bot | [`apps/subscription-bot`](apps/subscription-bot/README.md) | internal |

### Shared infrastructure

These are Compose services too, and every application above depends on them.

| Service | What it is |
| --- | --- |
| `freellmapi` | Third-party LLM gateway (pinned image). Owns free-tier provider/model health, quota routing and failover for `ai-worker`. |
| `platform-postgres` | The `whiteslove` database. Flats, hiring, jobs, queue and subscriptions each own a schema in it. |
| `platform-elasticsearch` | Search indices (`flat-listings-v1`, `job-listings-v1`). Search only — enrichment is **not** stored here, see below. |
| `flats-olx-router` | nginx in front of the OLX fetchers. |

Enrichment results live in Postgres, not Elasticsearch: `flats.listings.data`
carries the `ai` and `vision` objects as jsonb. Querying the search index for
enrichment coverage always returns zero. The database role is not `postgres` —
read `$POSTGRES_USER` from the container environment.

## Local development

```bash
cp .env.example .env
npm --prefix apps/ai-worker ci
npm --prefix apps/workforce/packages/crawler-core test
npm test
docker compose config
docker compose up -d ai-worker
```

Production updates are service-scoped:

```bash
./deploy.sh ai-worker
./deploy.sh flats-migrate flats-api flats-worker
./deploy.sh vacancies-migrate vacancies-api vacancies-worker
./deploy.sh cv-migrate cv-api cv-worker
./deploy.sh subscriptions-migrate subscription-bot
```

The deploy helper uses `--no-deps`. It never recreates an unchanged domain or
restarts shared infrastructure implicitly.

Flat Finder currently uses one domain image for API, migrations and worker,
but each runs as an independently selected Compose service. No flats service
depends on CV or vacancies services.

Vacancy and CV execution use separate Compose services, image tags, task-type
claims and scheduler flags. Neither worker can claim or reschedule the other
domain's queue work. Their read APIs run as separately selectable Compose
services and preserve the existing Nuxt response contracts.

The Personal Site BFF cutover has landed on `master`: the site's jobs/hiring
routes delegate to `vacancies-api` and `cv-api` rather than owning that data.

Crawler traversal, durable page/cursor state, pacing, deduplication and the
shared detail stage are now extracted into `@whiteslove/crawler-core`. The
package is temporarily co-located under workforce so the existing vacancy
Docker build context remains isolated during cutover. Source adapters continue
to expose source-specific transport/parsing only.

Telegram subscription delivery runs independently in `subscription-bot`.
The website continues to own the subscription button and same-origin handoff
and status routes.

Only backend processes should join the `whiteslove-backend-platform` Docker
network. Browser code must use same-origin website routes rather than private
Docker service names.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership boundaries,
[docs/DATABASE_VOLUME_MIGRATION.md](./docs/DATABASE_VOLUME_MIGRATION.md) for the
mandatory production data cutover, and [AGENTS.md](./AGENTS.md) for contributor
invariants.

## AI enrichment

Enrichment is an optional layer over deterministic parsing: callers keep their
parser output when inference is unavailable, slow or low-confidence. Nothing
downstream may require an AI answer.

**The chain.** `TEXT_PROVIDERS`, `VISION_PROVIDERS` and `TRANSLATION_PROVIDERS`
are ordered lists tried until one succeeds. `freellmapi` leads each of them and
fans out across free-tier models; the named direct providers after it are real
fallbacks, not debug-only, and in practice produce a large share of results.

**The schema is enforced, not requested.** Every extraction kind ships a JSON
Schema that travels as a strict `json_schema` response format, so a model
cannot return the right answer in the wrong shape. `json_object` alone obliges
valid JSON and nothing more, which smaller models satisfy while ignoring the
field structure entirely. An endpoint that rejects schema mode falls back to
`json_object` once and is remembered for the life of the process.

A consequence worth knowing: strict mode requires every field to be present, so
a model that cannot determine one answers anyway — `0` is the usual cop-out for
a number. Sanitizers reject the values that are never legitimate (a zero
salary, a zero bathroom count on a dwelling) while keeping the ones that are
("no experience required" is a real statement).

**Capacity is the binding constraint.** These are free tiers: per-day request
caps, daily compute allowances, monthly credits and per-second rate limits. A
provider failing with 402/429 is out of allowance, not broken. Because capacity
sits far below intake, candidates are ordered newest-first — a fresh advert is
the one someone is about to open.

**Tuning knobs**, all optional with defaults in `docker-compose.yml`:

| Variable | Purpose |
| --- | --- |
| `AI_CONCURRENCY`, `VISION_CONCURRENCY` | Parallel jobs. Raising these scales throughput until upstream rate limits bite. |
| `VISION_PROVIDER_TIMEOUT_MS` | Must be generous: `freellmapi` walks its own fallback loop, and cutting it off cancels the attempt *and* stops it benching the failed model. |
| `VISION_COOLDOWN_MS` | Bench for a failing provider. |
| `VISION_RATE_LIMIT_COOLDOWN_MS` | Shorter bench for a 429, since a rate limit is measured in seconds. `Retry-After` wins when sent. |
| `AI_MAX_PHOTOS_PER_LISTING` | Photos per vision request; more photos is more evidence. |
| `AI_MAX_INLINE_REQUEST_BYTES` | Cap for providers that need images inline as base64. Must stay under any proxy body limit in front of them. |

**Diagnosing "AI produces nothing".** Check in this order: are jobs reaching
the worker at all (a missing `AI_WORKER_KEY` fails every request with 401); are
answers arriving and being *rejected* rather than never arriving (the schema
rejection detail is in the worker logs); and only then whether providers are
out of quota.

## CI and image publishing

Pull requests run Compose validation plus tests/builds only for affected
domains. A crawler-core-only change schedules the vacancy image/tests but not
CV; a vacancy-only change does not schedule CV, and the reverse is also true.
Explicitly shared workforce paths still schedule both.

Pushes to `master` publish only affected images to GHCR with `latest` and commit
SHA tags. The publish workflow can also be started manually to rebuild all
images. Server deployment remains explicit through `deploy.sh <service...>` so
publishing an image never restarts an unrelated service.
