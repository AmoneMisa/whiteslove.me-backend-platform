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

Every vacancy/candidate source must execute through the shared
crawler/orchestration layer. A source adapter provides source facts; it does not
own execution policy.

Crawler completion is semantic. A crawl continues until the configured domain
date boundary for the requested entity type is reached, or the upstream source
is naturally exhausted/repeats. Result counts, page counts, run counts, scroll
counts and similar quantitative caps must never be used as a successful crawl
boundary — not in source adapters and not in shared crawler code.

Entity type controls which records are accepted. Date controls how far a
chronological source is traversed. A record with an unreadable date does not
prove that the date boundary was reached.

Do not add source-local implementations of:

- concurrency limits;
- request timeouts/deadlines;
- request delays or pacing loops;
- pages-per-run or maximum crawl depth;
- maximum result/vacancy/candidate counts used as execution policy;
- retries/backoff;
- durable cursor rotation or resume state;
- scheduler cadence;
- queue leases/claims.

Concurrency, transport deadlines and pacing are shared execution mechanics only;
they do not limit crawl depth or successful result volume. A timeout or transport
failure is an error/retry condition. It must preserve the failed page/cursor and
must not be reported as a completed crawl.

A source-specific exception is allowed only when an upstream contract genuinely
requires different transport behavior. Document that upstream requirement and
expose it as adapter metadata/capability consumed by the shared crawler. Do not
implement a second crawler inside the adapter and do not turn an upstream API
page size into a local crawl-depth/result cap.

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

## Using parsing-lexicon and geo-catalog

Before writing a regex to detect a currency, price, room count, or any other
housing/hiring vocabulary in a source adapter, check whether
`@whiteslove/parsing-lexicon` already has it — it almost certainly does, and
a hand-copied list silently drifts from the shared one. This has caused real
bugs: a source adapter's local currency regex was missing a symbol
(`₸`/KZT) and a token (`у.е.`) that the lexicon's own `CURRENCY_TERMS`
already had, and a local numbered-rooms regex didn't accept the "3-room"
hyphenated form that `parseHousingRoomsFromText` already handled. Both were
duplicating, and drifting from, logic that already existed.

- Need "does this text mention money at all" as a cheap pre-filter (e.g.
  scanning many HTML card candidates before running the full parser)? Use
  `moneyMentionPattern()` from `@whiteslove/parsing-lexicon/currency`, not a
  hand-copied symbol list. See that package's README, "Money & currency".
- Need full price/salary extraction? Use `parseHousingPrice`
  (`./housing-money`) or `parseSalary` (`./money`).
- Need room/area/floor extraction from free text? Use
  `parseHousingRoomsFromText` / `parseHousingAreaFromText` /
  `parseHousingFloorFromText` from `./housing-text`.
- Need to resolve a location string to canonical geography (coordinates,
  hierarchy, boundaries)? Resolve the canonical entity via
  `@whiteslove/parsing-lexicon` first (city/district/etc. text ->
  canonical name), then look it up in `@whiteslove/geo-catalog` via
  `resolveLexiconGeoEntity`/`getGeoEntity`/`findGeoEntities`. Never
  hand-maintain coordinates or aliases in a backend-platform source adapter —
  coordinates belong in geo-catalog, aliases/vocabulary belong in
  parsing-lexicon.

If a lexicon or geo-catalog gap blocks you (a missing currency symbol, a
missing city/district, a parsing pattern that doesn't cover a real case),
fix it in that package's own repo and bump its version there — do not work
around the gap with a local patch in this repo. A local patch is exactly what
caused the drift bugs above.

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
