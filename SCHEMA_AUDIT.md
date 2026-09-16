# Backend schema audit

Inventory of the existing schema against the capabilities the integrity /
identity / GDPR plan asks for, taken before any new migration is written.

Scope: `apps/flats/migrations/*.sql` (47 files), `db/init/001-domain-schemas.sql`,
`apps/workforce/db/migrations/{jobs,hiring,queue}`. Audited at
`46a2043` on `improvement`.

The rule this document exists to enforce: **extend what is here, create a new
table only where the entity's lifecycle genuinely differs.** No `listings_v2`,
no `contacts_new`.

## Schemas

`platform`, `flats`, `jobs`, `hiring`, `queue`, `subscriptions`, plus
`user_data`. Flats migrations run unqualified against the default search path;
workforce migrations are templated with `{{schema}}`.

## What already exists — reuse, do not rebuild

| Capability asked for | Existing implementation | Notes |
| --- | --- | --- |
| Property entity resolution (§24) | `listing_property_clusters`, `listings.dedupe_key`, `listings.is_canonical`, migration 020 trigger, 029 atomic merge | Listing→cluster **mapping** exists. There is no cluster **entity** table. |
| Media fingerprinting (§25) | `listing_photo_hashes`: `hash CHAR(64)` (exact), `perceptual_hash CHAR(16)`, `first_seen_at`/`last_seen_at`, plus denormalised title/price/rooms/area/district/metro/residence_complex; migration 028 hash bands | Covers most of §25 already, including the "compare complete image sets" data. |
| Crawl lifecycle | `crawl_tasks`, `crawl_task_runs`, `source_scan_runs` (flats), `hiring.source_runs` (workforce) | Scan confidence states landed in `source_scan_runs` at `e8a7871`. |
| Geo resolution | `learned_geo`, `places`, `listing_nearby_places`, `listing_location_terms`, `geo_city_snapshots`, `geo_city_options`, `listings.lat/lng`, `metro_distance_m` | |
| Availability (current state) | `listings.availability_status`, `availability_reason`, `availability_checked_at`, `inactive_at`, `active`, `missed_runs` | Only three statuses in use: `active`, `inactive`, `unknown`. |
| Jobs read model (§37) | `jobs.vacancies` — `identity_key`, `source`/`source_id`, company, posted_at, active, `data` JSONB | |
| Candidate read model (§38) | `hiring.candidates`, `hiring.candidate_current` — `source_handle`, `first_seen_at`/`last_seen_at`, `data` JSONB | |
| Public feed / search | `listing_public_feed_canonical`, `listing_public_feed_members`, `listing_statistics_snapshots` | Statistics snapshots are aggregates, **not** listing history. |

## What partially exists — extend

**Availability observations (§30).** Current state only, on `listings`. There is
no observation history and no vocabulary for `viewing_available`, `reserved`,
`already_rented`, `offered_alternative` or `no_response`. Extend by adding
observation rows keyed to the listing; do not widen `listings` further, because
the whole point is a time series.

**Listing lifecycle snapshots (§28).** `first_seen_at` / `last_seen_at` /
`inactive_at` / `active` describe the present. Price, contact, content and media
are overwritten in place, so "reappeared", "price changed", "contact changed"
cannot be reconstructed. Needed for §26 lineage, §29 repost cycles and §37 job
provenance, all of which are historical questions.

**Contacts (§15).** Contacts are parsed today — `normalize-legacy.js` calls
`parsePrimaryContact()` and stores the result on the listing — but they live
only inside `listings.data` JSONB and are indexed into Elasticsearch as
searchable text. Phone normalisation exists in exactly one place and it is a
SQL function: migration 019 strips a phone to digits inside `dedupe_key`
computation. There is no contact table, no E.164 canonical column, and no
first/last seen per contact. §15 needs all three.

**Property cluster attributes (§24).** `listing_property_clusters` maps a
listing to a `cluster_id` string; nothing stores per-cluster facts, evidence or
confidence. A `property_clusters` entity table is justified — but it must key on
the existing `cluster_id`, not introduce a second identity.

## Genuinely missing — new tables justified

Identity: `ActorIdentity` (§14), `ContactPoint` (§15), `PlatformIdentity` (§19),
identity observation history (§21), churn counters (§22).

Legacy Google registry (§7–13): risk clusters, trusted clusters, aliases and
phones, sources, review cases — keyed by the external `Cluster ID` (§9).

Integrity: listing lineage (§26), repost cycles (§29), bait-and-switch graph
(§31), reason-code evidence (§27), multi-dimensional scores (§34).

Governance: review queue (§36), privacy requests (§47), correction/dispute cases
(§49), audit events (§60), retention policy state (§53).

Jobs: `JobCluster` (§37) — `jobs.vacancies` is a read model of individual
postings, not a cluster.

## Collisions and naming hazards

- `listing_property_clusters` sounds like an entity table but is a mapping.
  Name a cluster entity table distinctly and reference the same `cluster_id`.
- `hiring.source_runs` and flats `source_scan_runs` solve similar problems with
  different shapes. Converging them is out of scope here, but a third variant
  should not be added.
- `listings.data` JSONB is already load-bearing (contact, photo fingerprint
  keys, enrichment). Promoting a field out of it must keep the JSONB path
  working until readers move, because `dedupe_key` SQL reads `p_data->>...`
  directly.
- Flats migrations are unqualified; workforce ones are `{{schema}}`-templated.
  New cross-domain tables need an explicit decision about which schema owns them.

## GDPR data inventory seed (§41)

Personal data the system stores **today**, before any new identity feature:

| Data | Location | Subject | Source |
| --- | --- | --- | --- |
| Device id, sync secret hash, account id | `user_data.installations` | User | Direct |
| Saved collections, items, presets | `user_data.saved_*` | User | Direct |
| Push token, platform, language | `subscriptions.mobile_devices` | User | Direct |
| **Parsed contact (phone) from listing text** | `listings.data`, Elasticsearch | **Third party** | **Indirect** |
| Listing title/description authored by a third party | `listings`, `listing_photo_hashes` | Third party | Indirect |
| Photo URLs and fingerprints | `listing_photo_hashes` | Third party | Indirect |

The finding that matters: **Article 14 obligations already apply.** Contact
details and free text written by advertisers are extracted, stored and indexed
now, and were not collected from those people directly. That is not a future
consequence of the identity work — it is the current state, and the privacy
notice has to describe it whether or not ActorIdentity ships.

There is no audit table, no review queue, no privacy-request state and no
retention mechanism anywhere in the schema today.

## Recommended order

1. `ContactPoint` + `ActorIdentity`, promoting the contact already parsed into
   `listings.data` rather than parsing anything new.
2. `PlatformIdentity` and identity observations, which the Google registry
   importer then seeds into.
3. Legacy registry import (§7–13) — blocked on credentials; buildable against
   fixtures first.
4. Listing snapshots, then lineage and repost cycles on top of them.
5. Governance tables (review, privacy, audit) before any identity or risk
   signal becomes externally visible.
