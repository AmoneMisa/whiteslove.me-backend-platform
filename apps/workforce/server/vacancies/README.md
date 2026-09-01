# Vacancies domain

This directory owns the vacancy bounded context. Code belongs here when it
creates, normalizes, stores, searches or serves job openings.

## Sections

- `sources/` — upstream adapters. They describe request/response semantics and
  map source records into the canonical vacancy contract. They do not own
  retries, pacing, queue leases, crawl depth or scheduler cadence.
- `domain/` — pure vacancy rules and value transformations. Domain modules must
  not import HTTP, PostgreSQL, Elasticsearch or worker lifecycle code.
- `application/` — use cases that coordinate domain rules and ports.
- `infrastructure/` — PostgreSQL, Elasticsearch and external service adapters.

Shared traversal and transport mechanics belong in `packages/` or `shared/`,
not in a source adapter. CV/candidate behavior belongs in `server/hiring` until
that bounded context is renamed to `server/cv` in a contract-preserving step.
