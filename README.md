# whiteslove.me Backend Platform

Backend monorepo for the whiteslove.me product family. It will own shared
infrastructure, AI inference, apartment services, vacancy/CV services and
their crawler execution. The public website remains in its own repository.

The repository starts with a snapshot of AI Worker. The original `ai-worker`
repository remains an independent template and is not linked as a submodule.

## Current services

| Service | Path | Port | Status |
| --- | --- | ---: | --- |
| AI Worker | `apps/ai-worker` | 4030 | migrated |
| Flats API/worker | `apps/flats-*` | 4000 | planned |
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
# Later:
./deploy.sh flats-migrate flats-api flats-worker
./deploy.sh vacancies-migrate vacancies-api vacancies-worker
./deploy.sh cv-migrate cv-api cv-worker
```

The deploy helper uses `--no-deps`. It never recreates an unchanged domain or
restarts shared infrastructure implicitly.

Only backend processes should join the `whiteslove-backend-platform` Docker
network. Browser code must use same-origin website routes rather than private
Docker service names.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership boundaries and the
migration sequence.
