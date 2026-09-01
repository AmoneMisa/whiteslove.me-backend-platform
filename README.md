# whiteslove.me Backend Platform

Backend monorepo for the whiteslove.me product family. It will own shared
infrastructure, AI inference, apartment services, vacancy/CV services and
their crawler execution. The public website remains in its own repository.

The repository starts with snapshots of AI Worker and the Flat Finder backend.
The original `ai-worker` repository remains an independent template and is not
linked as a submodule.

## Current services

| Service | Path | Port | Status |
| --- | --- | ---: | --- |
| AI Worker | `apps/ai-worker` | 4030 | migrated |
| Flats API/worker | `apps/flats` | 4000 | imported |
| OLX transport | `services/olx-fetcher` | internal | imported |
| Social transport | `services/social-fetcher` | internal | imported |
| Hiring API/worker | `apps/hiring-*` | 4010 | planned |
| Scraper worker | `apps/scraper-worker` | internal | planned |

## Local development

```bash
cp .env.example .env
npm --prefix apps/ai-worker ci
npm test
docker compose config
docker compose up -d ai-worker
```

Production updates are service-scoped:

```bash
./deploy.sh ai-worker
./deploy.sh flats-migrate flats-api flats-worker
# Later:
./deploy.sh vacancies-migrate vacancies-api vacancies-worker
./deploy.sh cv-migrate cv-api cv-worker
```

The deploy helper uses `--no-deps`. It never recreates an unchanged domain or
restarts shared infrastructure implicitly.

Flat Finder currently uses one domain image for API, migrations and worker,
but each runs as an independently selected Compose service. No flats service
depends on future CV or vacancies services.

Only backend processes should join the `whiteslove-backend-platform` Docker
network. Browser code must use same-origin website routes rather than private
Docker service names.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership boundaries and the
migration sequence.
