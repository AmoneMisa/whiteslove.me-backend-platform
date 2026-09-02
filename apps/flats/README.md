# Flats backend

The flats application owns listing ingestion, normalization, persistence, search,
availability processing and its HTTP API. It is deployed independently from the
workforce, AI-worker and subscription services (`flats-api`, `flats-worker`,
`flats-migrate` — see [../../README.md](../../README.md)).

## Source layout

```text
src/
  scrapers/           source-specific listing adapters (see below)
  infrastructure/     database, queue and search — each has its own README
  domain/parsing/      reserved for the extraction target below; currently empty
  *.js (root)          compatibility-era application, routes and glue — see groups below
```

Root `src/*.js` is being separated incrementally into explicit
application/domain/API layers, following the same shape `apps/workforce`
already uses (`domain/` → `application/` → `infrastructure/`). Until a file
moves, treat these groups as the de facto module boundaries — don't reach
across one to patch another:

- **Entry points** — `app.js`, `server.js`, `worker.js`, `migrate.js`,
  `reindex.js`.
- **HTTP routes** — `listing-routes.js`, `listing-item-routes.js`,
  `listing-public.js`, `catalog-routes.js`, `availability-routes.js`,
  `media-routes.js`, `mobile-listing-routes.js`, `social-routes.js`,
  `system-routes.js`, `translation-routes.js`, `map-feed.js`.
- **Listing normalization** — `normalize.js` (the current entry point),
  `normalize-legacy.js`, `textparse-overrides.js`, `lexicon-parse.js`,
  `tags.js`, `amenity-parse.js`, `listing-enrichment.js`,
  `listing-lifecycle.js`, `listing-policy.js`, `listing-filter-canonical.js`,
  `vision-enrichment.js`, `photo-antifake.js`. Deterministic multilingual
  text parsing (amenities, owner/commission signals, quarter labels, deal
  type) lives in `@whiteslove/parsing-lexicon`, not here — these files
  compose that package's exports into flats-specific listing shapes; they
  should not grow new hand-rolled dictionaries.
- **Geo/location** — `geocode.js`, `geocode-persistent.js`,
  `geocode-spatial.js`, `geo-catalog.js`, `reverse-geo.js`,
  `nominatim-client.js`, `locations.js`, `location-dictionary-resolver.js`,
  `location-dictionaries-ua-regions.js`, `district-zones.js`,
  `coordinate-validation.js`, `metro-nearest.js`, `nearby-places.js`,
  `transport-nearby.js`, `structured-address.js`, `tashkent-areas.js`,
  `tashkent-metro.js`, `market-comparison.js`, `countries.js`,
  `olx-segment.js`. City/district canonicalization comes from
  `@whiteslove/parsing-lexicon` and `@whiteslove/geo-catalog`; these files
  own flats-specific geo behavior (learned proximity, spatial persistence,
  reverse geocoding) that's out of scope for those packages.
- **Learned-geo subsystem** — `learned-geo.js`, `learned-geo-export.js`,
  `learned-geo-proximity.js`, `places-sync.js`: builds and persists
  geo-inference data from confirmed listings, distinct from the static
  lexicon/geo-catalog data above.
- **Source management** — `external-housing-sources.js`,
  `owner-housing-sources.js`, `realtor-housing-sources.js`,
  `telegram-housing-sources.js`, `custom-source-queue.js`,
  `social-housing-scheduler.js`, `social-search-coverage.js`,
  `telegram-room-share.js`, `crawl-reconciliation.js`. `scrapers/` (below)
  does the actual fetching; these coordinate what to fetch and when.
- **Queue/scheduling** — `queuePlan.js`, `queueTasks.js`, `scheduler.js`.
- **Availability** — `availability.js`, `availability-policy.js`,
  `availability-sweep.js`.
- **Mobile** — `mobile-fcm.js`, `mobile-subscriptions.js` (routes are listed
  above with the other route files).
- **Cross-cutting infra** — `internal-auth.js`, `ratelimit.js`,
  `request-rate-limit.js`, `cache.js`, `photoCache.js`,
  `postgres-canonical-feed.js`, `postgres-cursor-scope.js`,
  `postgres-search.js`, `postgres-search-fast.js` (route-facing wrappers
  over `infrastructure/search`'s core implementations),
  `statistics-snapshot.js`, `migration-files.js`, `fx.js` (static fallback
  FX rates for cold-start/outage only — live rates come from a fetched
  source; this is not a canonical currency dictionary).
- **AI enrichment client** — `ai-worker.js` (calls the `ai-worker` service;
  see its README for the contract).
- **Test-only** — `mock.js` generates synthetic listings for tests/dev and is
  gated off in production; don't wire it into a real request path.
- **Legacy parity checks** — `legacy-listing-filter.js`, `listing-semantics.js`,
  `listing-sort.js` are not imported by any production module; they exist
  solely for their dedicated tests (see `test/filter-parity.integration.test.js`
  and friends), which compare the legacy path's output against the current
  one. They look unused by grep alone — they aren't. Don't delete without
  first checking what parity property their test is actually protecting.

### `scrapers/`

Source-specific listing adapters: `olx.js`, `telegram.js`, `social.js`,
`owner-html.js`, `custom.js`. These describe request/response semantics and
map source records into the canonical listing contract. Shared crawling
mechanics belong in the source-management group above or a shared package,
not duplicated per scraper.

### `infrastructure/`

- [`database/`](src/infrastructure/database/README.md) — PostgreSQL
  repositories and schema-readiness checks.
- [`queue/`](src/infrastructure/queue/README.md) — durable Postgres queue
  mechanics for ingestion tasks.
- [`search/`](src/infrastructure/search/README.md) — Elasticsearch and
  Postgres search implementations.

## Refactoring rules

Refactoring must preserve the listing contract and database migration path.
Source adapters should not own shared scheduling, retry or persistence
policy — that belongs in the source-management/queue groups or
infrastructure layer. When a root `src/*.js` file's responsibility becomes
clear enough to name, move it into `domain/`, `application/`, or
`infrastructure/` rather than leaving it in the root group indefinitely.
