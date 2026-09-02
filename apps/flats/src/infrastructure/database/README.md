# Database infrastructure

This directory contains PostgreSQL-specific repositories and schema readiness
checks for the flats domain.

- `placesRepository.js` persists and reads city points of interest.
- `customSourceRepository.js` owns persistence operations scoped to custom
  listing sources.
- `schemaReady.js` verifies that versioned migrations were applied before an API
  or worker starts.

Runtime modules in this directory must reuse the flats database pool and must not
create or alter schema objects. DDL belongs exclusively to `apps/flats/migrations`
and the `flats-migrate` service.

The current root `db.js` still combines pool creation, row mapping and the main
listing repository. It remains at the compatibility boundary until those three
responsibilities are extracted independently.
