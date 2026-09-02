# Database infrastructure

This directory contains PostgreSQL-specific repositories, row mapping and schema
readiness checks for the flats domain.

- `pool.js` owns the single runtime PostgreSQL pool and its lifecycle.
- `listingMapper.js` converts normalized domain listings into bounded database
  rows without executing SQL.
- `placesRepository.js` persists and reads city points of interest.
- `customSourceRepository.js` owns persistence operations scoped to custom
  listing sources.
- `schemaReady.js` verifies that versioned migrations were applied before an API
  or worker starts.

Runtime modules in this directory must reuse the flats database pool and must not
create or alter schema objects. DDL belongs exclusively to `apps/flats/migrations`
and the `flats-migrate` service.

The current root `db.js` owns the main listing SQL repository. It re-exports
`pool` temporarily for mixed imports while consumers are moved to explicit
repositories.
