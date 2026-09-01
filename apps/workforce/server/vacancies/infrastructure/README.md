# Vacancy infrastructure

Adapters in this directory implement technical ports for the vacancy domain:
PostgreSQL read/write models, Elasticsearch indexing/search and transitional
snapshot persistence.

Infrastructure may depend on domain contracts, database/search clients and
configuration. Domain and source modules must not import implementation details
from this directory unless an application use case explicitly coordinates the
operation.

The snapshot adapter is a rollout fallback. PostgreSQL remains the authoritative
read model; new behavior must not make snapshot storage authoritative again.
