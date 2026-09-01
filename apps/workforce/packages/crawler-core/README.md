# @whiteslove/crawler-core

Shared execution mechanics for backend crawlers.

This first extraction is intentionally co-located under `apps/workforce` while
vacancy crawling is its only consumer. It preserves the existing workforce
Docker build boundary during the backend-platform cutover. When a second domain
needs the same runtime, move the package to the repository-level `packages/`
directory without changing its public execution contract.

The package owns traversal mechanics, durable page/cursor state, pacing,
deduplication and detail-stage fallback. Source adapters own only source facts:
request construction, response parsing and documented upstream capabilities.
They must not introduce independent execution loops, request delays, page/run
limits, retry policy or cursor persistence.

State namespaces are injected by consumers. The vacancy adapter uses
`jobs:board`, preserving the pre-migration keys such as
`jobs:board-cursor:v1:<source>` and `jobs:board-opaque-cursor:v1:<source>`.
