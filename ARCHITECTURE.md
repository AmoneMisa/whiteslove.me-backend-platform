# Target architecture

## Repository ownership

This repository owns backend domain services and infrastructure:

- AI enrichment;
- apartment API, ingestion, persistence and search;
- vacancy and candidate API, ingestion, persistence and search;
- crawler orchestration and source adapters;
- PostgreSQL, Elasticsearch and versioned migrations;
- internal browser/social transport sidecars.

The Personal Site repository continues to own Nuxt UI/SSR, same-origin BFF
routes and its small Python tools backend. Generic language parsing remains in
`@whiteslove/parsing-lexicon`; canonical geography remains in
`@whiteslove/geo-catalog`.

## Planned layout

```text
apps/       deployable Node services and workers
services/   internal Python/browser/transport sidecars
packages/   reusable runtime contracts and infrastructure libraries
sources/    flat, vacancy and candidate source adapters
db/         schema-scoped versioned migrations
```

One PostgreSQL server may host the platform, but domain tables remain isolated
in schemas: `platform`, `flats`, `jobs`, `hiring`, `queue`, and
`subscriptions`. Services must not reach into another domain's private tables;
cross-domain access uses public contracts.

## Deployment isolation

API and worker lifecycle is isolated by domain and role. There is no umbrella
backend image and no umbrella worker image. The target services are:

```text
flats-migrate       flats-api       flats-worker
vacancies-migrate   vacancies-api   vacancies-worker
cv-migrate          cv-api          cv-worker
ai-worker
```

Each domain has an independent Docker build context, image tag, CI path filter,
migration job and deployment command. A flats change may build and deploy only
the flats services. Vacancy and CV containers are not Compose dependencies of
flats services and therefore must not be recreated or restarted.

Shared PostgreSQL and Elasticsearch are infrastructure dependencies, but a
normal application deploy uses `docker compose up --no-deps` and never restarts
them. Infrastructure upgrades are a separate, explicitly invoked deployment.

Worker code that is genuinely shared belongs in a versioned package. Updating
that package affects only consumers whose lockfile/image was rebuilt; it does
not authorize restarting every worker.

CI must calculate changes independently for at least these path groups:

```text
apps/flats-* + sources/flats/**
apps/vacancies-* + sources/vacancies/**
apps/cv-* + sources/candidates/**
apps/ai-worker/**
packages/<package>/** -> only declared consumers
```

Compose-file changes are not treated as permission to recreate every service.
The deploy job must still select the affected service names explicitly.

## Crawler boundary

The planned `@whiteslove/crawler-core` package owns traversal, durable cursor
state, PostgreSQL leases, retries, pacing, deadlines, deduplication and
observability. Concrete source adapters stay under `sources/`. Python fetchers
provide transport only (TLS/browser impersonation or social acquisition);
semantic parsing and product normalization stay in domain adapters.

## Migration order

1. Run AI Worker from this repository without changing its HTTP API.
2. Import Flat Finder API/worker and its migrations without changing public
   apartment endpoints.
3. Move PostgreSQL and Elasticsearch ownership into the platform Compose.
4. Extract vacancy and CV code into independent APIs and independent workers.
5. Convert Personal Site jobs/hiring routes into thin API adapters.
6. Consolidate crawler execution policy, then move individual sources.
7. Remove legacy services from source repositories only after production
   traffic has switched and rollback has been verified.

## Current migration state

- AI Worker and its FreeLLMAPI gateway are imported.
- Flat Finder API, worker, migrations, Elasticsearch image, OLX transport and
  social transport are imported.
- Source repositories remain unchanged and production traffic has not moved.
- Vacancy and CV workers, migrations and browser transport are imported as a
  transitional `apps/workforce` runtime. They run as separate services with
  distinct image tags and queue claim filters.
- Vacancy and CV read APIs are imported behind a small H3-compatible adapter.
  They run as separate services and preserve the site's current DTO contracts.
- Personal Site BFF routes still use their local implementations; switching
  them to the platform APIs remains the next migration phase.
