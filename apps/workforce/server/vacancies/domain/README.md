# Vacancy domain

This directory owns pure vacancy concepts and deterministic business rules.

- `enrich.ts` derives canonical structured fields from a vacancy payload.
- `aggregate.ts` applies filtering, deduplication, sorting and statistics.
- `jobVisaSponsorship.ts` classifies sponsorship evidence conservatively.

Domain code must not access PostgreSQL, Elasticsearch, queues, HTTP transports
or environment-specific worker lifecycle. It may use shared language/catalog
packages and stable vacancy contracts. Source acquisition belongs in
`../sources`; orchestration belongs in `../application`; storage belongs in
`../infrastructure`.

Compatibility imports that still point to `server/utils` are temporary and
should be replaced with direct shared/domain contracts in subsequent slices.
