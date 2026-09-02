# Flats backend

The flats application owns listing ingestion, normalization, persistence, search,
availability processing and its HTTP API. It is deployed independently from the
workforce, AI-worker and subscription services (`flats-api`, `flats-worker`,
`flats-migrate` — see [../../README.md](../../README.md)).

## Source layout

```text
src/
  app.js, server.js, worker.js, migrate.js, reindex.js   entry points (stay at root)
  mock.js                                                 test/dev synthetic listings — never wired into a real request path
  routes/         HTTP route handlers
  listing/        listing normalization/enrichment domain
  legacy/         parity-test-only code — see note below, don't delete on a grep-based hunch
  geo/            geo/location resolution, canonicalization glue
  geo/learned/    learned-geo subsystem: builds/persists geo-inference data from confirmed listings
  sources/        source coordination — what to fetch and when (scrapers/ does the actual fetching)
  scheduling/     queue planning and the scheduler loop
  availability/   OLX/source availability checking
  mobile/         mobile push/subscription glue (mobile routes live in routes/)
  support/        cross-cutting infra: auth, rate limiting, caching, FX fallback, the AI-worker client, Postgres search/feed wrappers
  scrapers/       source-specific listing adapters (see below)
  infrastructure/ database, queue and search — each has its own README (see below)
  domain/parsing/ reserved for future extraction target; currently empty
```

Each folder above is a real module boundary, not just a naming convention —
don't reach across one to patch another. When adding a file, put it in the
folder matching its concern; when a file's responsibility no longer matches
its folder, move it rather than letting the grouping drift from the code.

- **`routes/`** — `listing-routes.js`, `listing-item-routes.js`,
  `listing-public.js`, `catalog-routes.js`, `availability-routes.js`,
  `media-routes.js`, `mobile-listing-routes.js`, `social-routes.js`,
  `system-routes.js`, `translation-routes.js`, `map-feed.js`.
- **`listing/`** — `normalize.js` (the current entry point),
  `normalize-legacy.js`, `textparse-overrides.js`, `lexicon-parse.js`,
  `tags.js`, `amenity-parse.js`, `listing-enrichment.js`,
  `listing-lifecycle.js`, `listing-policy.js`, `listing-filter-canonical.js`,
  `vision-enrichment.js`, `photo-antifake.js`. Deterministic multilingual
  text parsing (amenities, owner/commission signals, quarter labels, deal
  type) lives in `@whiteslove/parsing-lexicon`, not here — these files
  compose that package's exports into flats-specific listing shapes; they
  should not grow new hand-rolled dictionaries.
- **`legacy/`** — `legacy-listing-filter.js`, `listing-semantics.js`,
  `listing-sort.js` are not imported by any production module; they exist
  solely for their dedicated tests (see `test/filter-parity.integration.test.js`
  and friends), which compare the legacy path's output against the current
  one. They look unused by grep alone — they aren't. Don't delete without
  first checking what parity property their test is actually protecting.
- **`geo/`** — `geocode.js`, `geocode-persistent.js`, `geocode-spatial.js`,
  `geo-catalog.js`, `reverse-geo.js`, `nominatim-client.js`, `locations.js`,
  `location-dictionary-resolver.js`, `location-dictionaries-ua-regions.js`,
  `district-zones.js`, `coordinate-validation.js`, `metro-nearest.js`,
  `nearby-places.js`, `transport-nearby.js`, `structured-address.js`,
  `tashkent-areas.js`, `tashkent-metro.js`, `market-comparison.js`,
  `countries.js`, `olx-segment.js`. City/district canonicalization comes
  from `@whiteslove/parsing-lexicon` and `@whiteslove/geo-catalog`; this
  folder owns flats-specific geo behavior (learned proximity, spatial
  persistence, reverse geocoding) that's out of scope for those packages.
  `geo/learned/` (`learned-geo.js`, `learned-geo-export.js`,
  `learned-geo-proximity.js`, `places-sync.js`) is a distinct subsystem
  within it — inferred data from confirmed listings, not static reference
  data.
- **`sources/`** — `external-housing-sources.js`, `owner-housing-sources.js`,
  `realtor-housing-sources.js`, `telegram-housing-sources.js`,
  `custom-source-queue.js`, `social-housing-scheduler.js`,
  `social-search-coverage.js`, `telegram-room-share.js`,
  `crawl-reconciliation.js`.
- **`scheduling/`** — `queuePlan.js`, `queueTasks.js`, `scheduler.js`.
- **`availability/`** — `availability.js`, `availability-policy.js`,
  `availability-sweep.js`.
- **`mobile/`** — `mobile-fcm.js` (FCM transport), `mobile-preset-search.js`
  (turns a stored preset into search filters), `mobile-subscription-routes.js`
  (the `PUT /api/mobile-subscriptions` HTTP surface),
  `mobile-subscription-scanner.js` (the background delivery scanner —
  advisory-locked, durable per-delivery claim/complete/fail so a crash
  mid-scan never double-sends). `mobile-subscriptions.js` is a thin barrel
  re-exporting all three, kept only so the multi-worker delivery test's
  dynamic `import()` and existing consumer paths didn't need to change.
- **`support/`** — `internal-auth.js`, `ratelimit.js`,
  `request-rate-limit.js`, `cache.js`, `photoCache.js`,
  `postgres-canonical-feed.js`, `postgres-cursor-scope.js`,
  `postgres-search.js`, `postgres-search-fast.js` (route-facing wrappers
  over `infrastructure/search`'s core implementations),
  `statistics-snapshot.js`, `migration-files.js`, `fx.js` (static fallback
  FX rates for cold-start/outage only — live rates come from a fetched
  source, this is not a canonical currency dictionary), `ai-worker.js`
  (calls the `ai-worker` service; see its README for the contract).

### `scrapers/`

Source-specific listing adapters: `olx.js`, `telegram.js`, `social.js`,
`owner-html.js`, `custom.js`. These describe request/response semantics and
map source records into the canonical listing contract. Shared crawling
mechanics belong in `sources/`/`scheduling/` or a shared package, not
duplicated per scraper.

### `infrastructure/`

- [`database/`](src/infrastructure/database/README.md) — PostgreSQL
  repositories and schema-readiness checks.
- [`queue/`](src/infrastructure/queue/README.md) — durable Postgres queue
  mechanics for ingestion tasks.
- [`search/`](src/infrastructure/search/README.md) — Elasticsearch and
  Postgres search implementations.

## Sources

Ingestion is per-country. Each country in [`geo/countries.js`](src/geo/countries.js)
declares which mechanisms it uses (`olx`, `telegram`); curated web catalogues
are declared separately in `sources/*.js` and queued as `flat.custom.url`
tasks, fetched generically by [`scrapers/custom.js`](src/scrapers/custom.js)
(JSON-LD → RSS/Atom → allowlisted SSR card extraction via
[`scrapers/owner-html.js`](src/scrapers/owner-html.js)). Site names below are
domains for orientation only — exact URLs, `dealType` and `ownerOnly`/city
scoping live in the registry files, which are the source of truth.

| Country | OLX | Telegram | Owner-only catalogues (`owner-housing-sources.js`) | Realtor catalogues (`realtor-housing-sources.js`) | External/mixed catalogues (`external-housing-sources.js`) |
| --- | --- | --- | --- | --- | --- |
| UZ | yes | yes | rentli.uz, ostona.app, turar.uz | hata.uz, realting.uz, domza.uz | uybor.uz, **m2bomber.com** |
| UA | yes | yes | easy-house.in.ua, kvarto.app, norieltor.com.ua, dom.ria.com, bezmakler.com.ua, dobalux.com | x-estate.com, parklane.ua, blagovist.ua, atlanta.ua | lun.ua, rieltor.ua, **m2bomber.com** |
| KZ | yes | yes | krisha.kz, kn.kz | — | **m2bomber.com** |
| RO | yes | yes | proprietaripebune.ro, proprietar-direct.ro, directfaracomision.ro, garsoniera.ro, publi24.ro | — | imobiliare.ro, anuntul.ro, lajumate.ro, imobiliare-anunturi.ro, **m2bomber.com** |
| KG | no | yes (empty list) | arendator.kg, myhouse.kg, sutochno.kg | — | house.kg, lalafo.kg |

m2bomber runs the same platform/template across every locale it operates —
`ro.`/`ua.`/`kz.`/`uz.m2bomber.com` — so it's registered as a mixed (owner +
agency) catalogue in each; it doesn't have a Kyrgyzstan locale, so it's absent
from KG. OLX is fetched through a dedicated `curl_cffi` sidecar
([`scrapers/olx.js`](src/scrapers/olx.js)) rather than the generic adapter
because ordinary server-side fetches are WAF-blocked; it's disabled for KG
until a dedicated transport exists there.

## Refactoring rules

Refactoring must preserve the listing contract and database migration path.
Source adapters should not own shared scheduling, retry or persistence
policy — that belongs in `sources/`/`scheduling/` or the infrastructure
layer.
