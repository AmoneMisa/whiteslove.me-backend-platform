# Vacancy application layer

This directory contains vacancy use cases. Application modules coordinate
source ports, domain normalization, persistence and search indexing, but do not
implement those concerns themselves.

`jobsSourceRefresh.ts` is the ingestion use case for one durable queue target.
It selects the appropriate source adapter, enriches the canonical vacancy,
writes the PostgreSQL read model and updates search. Scheduling, queue leases,
retry policy and worker lifecycle remain outside this layer.

Application code may depend on `domain`, `sources` and `infrastructure` ports.
The API and worker entrypoints may call application use cases; source adapters
must never call back into this layer.
