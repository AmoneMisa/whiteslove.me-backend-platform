# Production database volume migration

The existing production PostgreSQL data is a required input to the platform
cutover. A fresh `platform-postgres-data` volume is not an acceptable production
deployment.

The old volume must remain untouched until the new platform has passed data and
application verification and the rollback window has closed. Do not remove,
rename or reuse it as scratch space.

## Why the volume is not mounted directly

The platform defaults to PostgreSQL 18, database `whiteslove`, and isolated
schemas (`flats`, `jobs`, `hiring`, `queue`, and `subscriptions`). An existing
Flat Finder volume may use another PostgreSQL major version, database name,
owner and `public` schema. Mounting that data directory into the new container
can therefore fail at the storage-format boundary or start successfully with
services pointed at the wrong database.

Use a logical dump and restore unless the source PostgreSQL major version,
database contract and ownership are proven identical. PostgreSQL data
directories must never be copied between different major versions.

## Required cutover sequence

1. Stop writes to the old backend or place it in an explicit maintenance mode.
2. Record the old Compose project, container, PostgreSQL version, database,
   owner, schemas and Docker volume name with `docker compose ps`,
   `docker volume ls` and SQL catalog queries.
3. Create and checksum a full logical backup (`pg_dump` custom format plus a
   globals/roles dump). Store it outside both the old and new Docker volumes.
4. Restore into an isolated staging database first. Never test the restore by
   overwriting the only production copy.
5. Map the old Flat Finder tables into the platform `flats` schema. Preserve
   identifiers, timestamps, queue state, listing activity, deduplication keys
   and subscription-related data that still belongs to the flats domain.
6. Run `flats-migrate`, `workforce-queue-migrate`, `vacancies-migrate`,
   `cv-migrate`, and `subscriptions-migrate` against the restored database.
7. Rebuild Elasticsearch from PostgreSQL. Elasticsearch is a derived index and
   must not be treated as the authoritative backup.
8. Compare source and target row counts and domain invariants, then exercise
   health checks and representative listing/CV/vacancy reads.
9. Switch traffic only after verification. Keep the old backend and volume
   stopped but recoverable throughout the rollback window.

## Mandatory verification

- The target contains every active and historical listing expected from the
  source database.
- Stable listing IDs and public share links still resolve.
- `schema_migrations` contains every required flats migration.
- Queue rows are either deliberately resumed or deliberately archived; no
  in-flight lease is silently interpreted as successful work.
- CV and vacancy data live in their platform schemas, not in flats tables.
- Subscription records are present before enabling Telegram delivery.
- API/worker health checks pass using the restored database.
- A documented restore test proves that the backup is usable.

## Rollback gate

Rollback means stopping the platform writers and restarting the old stack with
its original, unchanged volume. Do not allow both stacks to write to divergent
copies at the same time. Deleting the old volume requires a separate explicit
decision after the rollback window; it is not part of normal deployment.

The concrete source volume/container names and the final row-count report must
be filled in on the production host during the migration rehearsal, because
they cannot be inferred safely from this repository.
