# Backend Platform Contributor Rules

## Ownership

`whiteslove.me-backend-platform` owns backend domain services, workers,
persistence/search infrastructure and crawler execution for whiteslove.me.
The Personal Site owns Nuxt UI/SSR and same-origin BFF routes. Reusable language
parsing stays in `@whiteslove/parsing-lexicon`; canonical geography stays in
`@whiteslove/geo-catalog`.

Do not copy backend behavior back into the website because a local patch is
easier. During migration, preserve HTTP/queue contracts until traffic has moved
and rollback has been verified.

## Crawler execution policy

Every vacancy source must execute through the shared crawler/orchestration
layer. A source adapter provides source facts; it does not own execution policy.

Do not add source-local implementations of:

- concurrency limits;
- request timeouts/deadlines;
- request delays or pacing loops;
- pages-per-run or maximum crawl depth;
- maximum result/vacancy counts used as execution policy;
- retries/backoff;
- durable cursor rotation or resume state;
- scheduler cadence;
- queue leases/claims.

A source-specific exception is allowed only when an upstream contract genuinely
requires different behavior. Document that upstream requirement and expose it
as adapter metadata/capability consumed by the shared crawler. Do not implement
a second crawler inside the adapter.

The current first extracted crawler library is:

```text
apps/workforce/packages/crawler-core
```

While workforce is its only consumer it remains co-located there to preserve
the current isolated Docker build context. Promote it to repository-level
`packages/` when another backend domain consumes it.

## Source and transport boundary

Source adapters own request/response semantics and product normalization.
Browser/TLS/social sidecars provide transport only. Semantic parsing belongs in
the domain adapter or shared parsing packages, never in transport sidecars.

## Deployment isolation

Deploy by explicit service name and use the existing service-scoped deployment
flow. A vacancy-only change must not rebuild/restart CV, flats, AI or
subscription services unless a declared shared dependency actually changed.

Shared infrastructure changes do not authorize an application-wide restart.

## Migration safety

Prefer compatibility-preserving extractions before behavior changes. Keep
existing state keys, queue task types and public DTOs stable while moving code.
Remove legacy implementations only after production traffic has switched and a
rollback path has been verified.
