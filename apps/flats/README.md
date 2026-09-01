# Flats backend

The flats application owns listing ingestion, normalization, persistence, search,
availability processing and its HTTP API. It is deployed independently from the
workforce, AI-worker and subscription services.

## Source layout

- `src/scrapers/` — source-specific listing adapters.
- `src/infrastructure/` — database, search and external-system integrations.
- root `src/*.js` — compatibility-era application and transport modules that are
  being separated incrementally into explicit application, domain and API layers.

Refactoring must preserve the listing contract and database migration path. Source
adapters should not own shared scheduling, retry or persistence policy.
