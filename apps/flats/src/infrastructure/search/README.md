# Search infrastructure

This directory owns the storage-specific search implementations for flat listings.

- `elasticsearch.js` manages the Elasticsearch index, mappings, health checks,
  document writes and text-search queries.
- `postgres-search-core.js` implements the general PostgreSQL read path,
  filtering, pagination and aggregate queries.
- `postgres-search-fast-core.js` implements the optimized PostgreSQL feed path
  and delegates unsupported query shapes to the general implementation.

HTTP routes and workers may call this layer, but infrastructure modules must not
import route handlers or scraper orchestration. Public response shaping remains
outside this directory. Moving these files does not change their runtime API.
