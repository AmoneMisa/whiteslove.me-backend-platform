# Flats geographic search audit and implementation plan

Date: 2026-09-06
Branch: `develop`

## Goal

Geographic filtering is a backend/database responsibility. Flutter and the web UI may select canonical geography and render the answer, but they must not narrow listing or map result sets after pagination/counting.

The target invariant is:

> the database predicate used for `count`, list pages, cursors and map points is the same geographic predicate, and it evaluates the best persisted listing coordinate against canonical `@whiteslove/geo-catalog` geometry.

Coordinate generation remains governed by `GEO_ACCURACY_AUDIT.md`. In particular, the strongest defensible spatial evidence wins and uncertainty is preserved:

1. verified explicit street + house;
2. verified canonical residential complex;
3. verified primary POI / landmark;
4. verified primary metro station;
5. directly stated street;
6. constrained multi-anchor inference;
7. microdistrict / mahalla / local area / suburb / settlement;
8. nearby/reference complex, POI or metro as approximate fallback;
9. district only as broad evidence.

A city centre is not an apartment point.

## Audit findings

### A1. Flutter currently owns part of metro filtering — incorrect ownership

`flat-finder/app/lib/state/app_state.dart` imports `metro_proximity.dart`, fetches map-zone coordinates, builds station proximity predicates and narrows both listing pages and map points after the backend response.

This creates four correctness classes:

- server `count` can disagree with the displayed list;
- cursor pagination is calculated over a different set from the displayed set;
- map points can disagree with list rows;
- `loadMore()` and `reloadAll()` do not follow exactly the same narrowing path as the initial search.

`Filters.toUpstreamQueryParams()` makes this split explicit: for more than one selected station it removes `metro` and `metroMaxM`, and it always removes `metroArc`.

### A2. Backend metro filtering is name/nearest-metro based, not selected-station geometry

Both PostgreSQL search paths currently use:

- `LOWER(...metro) = LOWER(filter.metro)`;
- `metro_distance_m <= metroMaxM`.

That is insufficient for a selected station because `metro_distance_m` describes the persisted nearest/assigned metro, not necessarily the station selected by the user. It also cannot represent a union of several selected stations or a directional arc.

### A3. Backend district filtering is raw string equality

Both PostgreSQL search paths currently use case-insensitive equality on the persisted district string.

This ignores the strongest available evidence when a listing has coordinates. If listing text says one district but the final verified point lies across the administrative boundary, the text currently wins.

### A4. Canonical geo geometry already exists

`@whiteslove/geo-catalog` already supplies stable entity IDs, canonical names, station centres, district bounding boxes and real GeoJSON Polygon/MultiPolygon boundaries. The backend already exposes these zones to clients. Search should consume the same canonical entities instead of re-implementing a second geography source.

### A5. Count/list/map can already share one SQL predicate

The general list search and map feed both build from the same PostgreSQL search context. The fast public-feed path has a parallel SQL builder. Therefore the fix belongs in the shared SQL builders, not in UI post-processing.

### A6. Deep links and older clients require compatibility

Current clients send human-readable values (`district=...`, `metro=a,b`) rather than canonical geo IDs. The backend should continue accepting those names and resolve them to canonical entities. New IDs can be introduced later without breaking existing links.

## Required semantics

### District

1. Resolve the requested district to one canonical geo-catalog entity in the selected country/city.
2. When the canonical entity has a real boundary and a listing has valid coordinates, coordinate-in-boundary is authoritative.
3. Only listings without usable coordinates may fall back to canonical district-name equality.
4. A contradictory district string must not override a valid coordinate.
5. If no canonical boundary can be resolved, preserve the canonicalized name fallback rather than inventing a spatial boundary.

### Metro

1. Parse one or many selected station names.
2. Resolve every station independently to its canonical geo-catalog point.
3. With a distance and/or arc constraint, a listing must have valid coordinates and satisfy the geometric predicate for **any** selected station (union semantics).
4. Distance is computed from the selected station centre to the final persisted listing point, not from `metro_distance_m` of an unrelated nearest station.
5. Direction is the initial great-circle bearing from station to listing, clockwise from north; wrap-around arcs such as `340 -> 20` must work.
6. Without a geometric constraint, station selection remains compatible with canonical metro-name matching.
7. An unresolved legacy station may use name-based fallback, but it must not silently borrow another station's coordinates.

### Result-set invariants

The same geographic SQL predicate must be applied before deduplication/count/page/map projection, so:

- `count` equals the full filtered set;
- cursors paginate that same set;
- list pages are subsets of that set;
- map points are the coordinate-bearing subset of that same set;
- no Flutter/web post-filter changes membership.

## Implementation plan

1. Add a backend-only geo filter resolver that canonicalizes district/metro filter names with `parsing-lexicon` and resolves geometry through `geo-catalog`. Attach the resolved geometry as non-serialized request metadata.
2. Extend the public filter parser to understand multi-station CSV and `metroArc` while preserving the existing `metro` query parameter.
3. Add a shared PostgreSQL geographic predicate builder used by both the general and fast/public-feed SQL paths:
   - district Polygon/MultiPolygon containment with hole support;
   - selected-station Haversine distance;
   - selected-station bearing/arc;
   - OR semantics across stations;
   - coordinate-first district precedence with name fallback only when coordinates are absent.
4. Preserve resolved geometry through internal filter copies/cursor scoping without returning catalog boundaries in the public JSON response.
5. Make map search preserve the same backend-only geometry metadata when it clones filters.
6. Add backend regression tests for parser compatibility, canonical resolution, district coordinate precedence, multi-metro union and wrap-around arc SQL generation.
7. Remove Flutter result-set narrowing and send multi-metro + arc upstream. Keep the client geometry utilities only for drawing/interactions, not result membership.
8. Apply the same ownership cleanup to the web client if it still mirrors the Flutter post-filter.
9. Verify backend CI first; then verify Flutter/web CI. Do not merge to `master` as part of this work.

## Non-goals

- Do not manufacture exact apartment coordinates from district/metro evidence.
- Do not replace the geocoding precedence defined in `GEO_ACCURACY_AUDIT.md` with search-time guesses.
- Do not duplicate geo-catalog data into UI-owned dictionaries.
- Do not use a city centre as a listing coordinate.
