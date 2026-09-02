# whiteslove.me Backend Platform

Backend monorepo for the whiteslove.me product family. It owns shared
infrastructure, AI inference, apartment services, vacancy/CV services and
their crawler execution. The public website remains in its own repository.

The repository started with snapshots of AI Worker and the Flat Finder backend.
The original `ai-worker` repository remains an independent template and is not
linked as a submodule.

## Current services

| Service | Path | Port | Status |
| --- | --- | ---: | --- |
| AI Worker | [`apps/ai-worker`](apps/ai-worker/README.md) | 4030 | migrated |
| Flats API/worker | [`apps/flats`](apps/flats/README.md) | 4000 | imported |
| OLX transport | `services/olx-fetcher` | internal | imported |
| Social transport | `services/social-fetcher` | internal | imported |
| Vacancies worker | [`apps/workforce`](apps/workforce/README.md) | internal | imported |
| CV worker | [`apps/workforce`](apps/workforce/README.md) | internal | imported |
| Crawler core | [`apps/workforce/packages/crawler-core`](apps/workforce/packages/crawler-core/README.md) | library | extracted |
| Job browser transport | `services/job-browser-fetcher` | internal | imported |
| Vacancies API | [`apps/workforce`](apps/workforce/README.md) | 4010 | imported |
| CV API | [`apps/workforce`](apps/workforce/README.md) | 4011 | imported |
| Telegram subscription bot | [`apps/subscription-bot`](apps/subscription-bot/README.md) | internal | imported |

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

The Personal Site BFF cutover is prepared on branch
`codex/backend-platform-migration`: jobs/hiring routes delegate to these APIs,
but that cutover has not been merged/deployed yet.

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

## CI and image publishing

Pull requests run Compose validation plus tests/builds only for affected
domains. A crawler-core-only change schedules the vacancy image/tests but not
CV; a vacancy-only change does not schedule CV, and the reverse is also true.
Explicitly shared workforce paths still schedule both.

Pushes to `master` publish only affected images to GHCR with `latest` and commit
SHA tags. The publish workflow can also be started manually to rebuild all
images. Server deployment remains explicit through `deploy.sh <service...>` so
publishing an image never restarts an unrelated service.
