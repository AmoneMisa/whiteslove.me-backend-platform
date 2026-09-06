# Flats geocoding accuracy audit

Date: 2026-09-06

Scope: `apps/flats` forward geocoding, canonical geo-catalog fallback, persistent learned coordinates, keyless provider fallback, source-coordinate validation, reverse geocoding, address provenance, and dependency-level spatial semantics.

This document records the precision rules and the concrete checks performed for the geocoding hardening branch. The goal is not to manufacture a plausible point for every listing. The goal is to prefer the strongest defensible spatial evidence, preserve uncertainty, and reject or downgrade contradictory evidence.

## Required precedence

The resolver should use the strongest available evidence in this order:

1. explicit source address with a concrete street + house, after the geocoder proves country, city, street and house (and corpus/building when supplied);
2. canonical residential complex with a verified curated geo-catalog point;
3. the same exact typed residential complex from persistent `learned_geo` when no curated catalog anchor exists;
4. specific primary POI / landmark, preferring a verified curated canonical point, then an exact typed learned/provider match;
5. primary metro station, preferring a verified curated canonical point, then an exact typed learned/provider match;
6. directly stated street when no stronger point-like anchor is available; a street result remains approximate without a house;
7. constrained multi-anchor spatial inference from two or more quantified nearby references;
8. microdistrict / mahalla / local area / suburb / settlement;
9. nearby/reference ЖК, POI or metro as an explicitly approximate fallback;
10. district only as broad location evidence.

A city centre is viewport/search metadata and is never an apartment point.

`near X`, `до X`, `рядом с X`, `N минут от X` and equivalent context must preserve `X` as useful evidence but must not promote it to the property itself.

The point-like canonical order intentionally puts a verified POI/metro ahead of a bare street centroid. A named object with a known center normally constrains the property more tightly than an arbitrarily chosen point on a street. A street + house remains stronger than all of these and is handled by rule 1.

`@whiteslove/geo-catalog` is the curated source of truth. `learned_geo` is a persistent runtime extension/cache, not an equal-authority replacement. A learned row is consulted only by its exact typed identity and may later be promoted into the curated catalog after verification.

## Precision and provenance contract

Every generated point should expose enough provenance for the API/UI to distinguish exact from inferred geography:

- `locationSource`
- `locationProvider`
- `locationProviderId`
- `locationProviderType`
- `locationCanonical`
- `locationRole`
- `locationPrecision`
- `locationAccuracyM`
- `locationApproximate`

Address provenance remains separate:

- `addressSource`
- `addressPrecision`
- `addressApproximate`
- `addressConfidence`

An inferred/reverse-geocoded address must never silently become a source-provided address.

## Pass 1 — forward-geocoder result validation

Provider search results are not accepted because they are first in the response. A candidate must prove the expected structured facts.

For a building-level address:

- requested country must match structured country evidence;
- requested city must match structured city/town/municipality evidence;
- requested house number must match;
- requested street must match a structured road/street field;
- requested corpus/building must match the compound house number or a structured building/block/unit field.

For named entities:

- country and city must match;
- the requested entity name must match structured name evidence;
- a different entity containing the requested words only somewhere in a display label is insufficient.

The provider cache identity includes the validation expectations and selector version so an old weakly validated result cannot bypass stricter rules after deployment.

### Keyless provider chain

The runtime first uses persistent/curated coordinates and only reaches a public geocoder for a cache miss. Two keyless OSM-backed sources are supported for forward lookup:

- Photon is tried first for named entities and streets. Its result must still prove country, city, name and semantic level. Broad `place`/`boundary` objects are rejected for point-like RC/POI/metro/street requests.
- Public Nominatim remains the fallback and the provider for exact building validation. Its public endpoint is throttled for recurring/background use and all hits/misses are cached. `NOMINATIM_URL` can point to a self-hosted/managed instance when higher throughput is required.

Photon is deliberately **not** trusted for exact street+house placement. The exact-address tier keeps the stricter structured Nominatim validation contract instead of adding a second provider that cannot prove the same fields.

Open-Meteo's keyless geocoding API is suitable for city/place-name lookup but does not provide the address/object semantics required for the exact residential-complex or building tiers. It is therefore not promoted into those tiers merely to increase provider count.

## Pass 1b — matched-footprint validation

A name does not say how large the thing wearing it is. `Chilonzor` is a metro
station, an administrative district and a supermarket; `Assalom Sohil` is a
residential complex and, in some extracts, a surrounding area. Country/city/name
validation accepts all of them, so the selector additionally compares the
**footprint the provider actually returned** with the semantic level that was
requested.

Every candidate carries its expected level (`building`, `street`, `complex`,
`station`, `reference`, `neighborhood`, `locality`, `district`, `city`) into the
geocoder expectation, and the expectation participates in the cache identity.

Rules:

- the ground radius of a result is derived from its bounding box/extent when available;
- among validated candidates, the one whose radius best fits the requested level ranks highest — footprint fit is ranked ahead of provider popularity/importance;
- a result with no footprint falls back to provider type/rank evidence rather than inventing geometry;
- a point-like request (`building`, `street`, `complex`, `station`, `reference`) is rejected when the matched footprint is clearly a much broader object sharing the same name;
- provider semantic tags such as Photon `place`/`boundary` are also used to reject a neighborhood/district masquerading as a point-like anchor.

The measured footprint is also reported (`locationExtentM`) and folded into the
accuracy radius: a placed listing never advertises a radius tighter than the
object that was actually matched. The semantic baseline still applies in the
other direction, so a complex resolved to a single OSM node keeps its ~300 m
complex-level radius instead of claiming node precision.

## Pass 2 — canonical anchors and contextual roles

Canonical `@whiteslove/geo-catalog` coordinates are preferred over learned rows and ambiguous free-text provider guesses when a matching canonical entity exists.

The resolver preserves lexical role:

- `primary` — direct property-location evidence;
- `nearby` — reference point only;
- `mentioned` — usable but lower-context evidence.

A `nearby` residential complex cannot become the listing's `residenceComplex` coordinate simply because its catalog point is known.

Concrete regression case:

```text
АССАЛОМ СОХИЛ
2/10/16
До Ц1 и ЖК Инфинити 5 мин на машине
```

Expected spatial interpretation:

- `Assalom Sohil` — property residential complex / primary anchor;
- `Infinity` — nearby reference, never the property complex;
- `C-1` — nearby/reference location, never allowed to displace the primary complex;
- `2/10/16` — rooms/floor/total floors, never an address.

## Pass 2b — persistent learned coordinates and deduplication

`learned_geo` is read before any fresh network lookup for the same exact candidate. A valid learned hit stops the provider chain and therefore reduces external requests.

Identity is typed. The following are intentionally different keys even when the display name is identical:

```text
UZ | Tashkent | residential_complex | Yangi Sergeli
UZ | Tashkent | local_area          | Yangi Sergeli
```

A declared `residenceComplex` can therefore never be satisfied by the same-named learned `local_area` row.

Learned address/entity keys are semantic identities, not query identities. `query_text` and inferred district are excluded. City names are canonicalized; address street labels, house-number punctuation and building prefixes are normalized; harmless entity type labels such as `Residential Complex` are removed from the identity while the original display value remains stored. The descriptor also retains legacy/raw lookup-key aliases, so normalization upgrades reuse an already learned row instead of creating another one when the previous key is known.

`lookup_key` remains the database primary key and upserts refresh the existing row. `exported_at` is workflow state only: it records promotion/export processing and is **not** a runtime trust gate.

## Pass 3 — source-coordinate validation

Marketplace coordinates are not assumed to be surveyed building coordinates. A generic source marker is treated as broad/approximate unless stronger upstream precision is explicitly available.

If a real source-stated street + house independently geocodes successfully, the verified building address outranks an unqualified marketplace marker. Their distance is kept in `sourceCoordinateDistanceM` for diagnostics; an arbitrary discrepancy threshold must not force the weaker marker to win.

Out-of-area validation uses a city bbox result that itself must match the requested country and city. A bbox from a same-named place in another country/city is not accepted.

## Pass 4 — reverse geocoding

Reverse geocoding is enrichment and validation. It is not allowed to increase precision without evidence.

Rules:

- a residential-complex centroid may infer a nearby road, but never the nearest house number;
- a POI, metro, neighbourhood, local-area or broad marketplace marker must never receive the nearest building number as if it were the listing's exact address;
- a house number from reverse geocoding is exposed only when the point is already building-level and is backed by the listing's own exact address evidence;
- broad district/neighbourhood points are used for administrative enrichment, not arbitrary road display;
- reverse-geocoded country mismatch rejects generated coordinates and only warns on stronger source/catalog coordinates;
- reverse-geocoded mismatch to another known target city rejects generated coordinates and only warns on stronger source/catalog coordinates.

The resolver therefore cannot convert `ЖК Assalom Sohil` into a fake apartment address such as the house number of whichever OSM building happens to be closest to the complex centroid.

## Pass 5 — address extraction / legacy-data contamination

A source address field remains authoritative when it is genuinely an address. The same value previously extracted from listing prose keeps `parsed` provenance rather than being upgraded to `source` on a later pass.

A weak legacy field that only parses through permissive bare-address mode and contains listing prose such as `продаж`, `квартира`, or `ЖК` is not trusted over a strong explicit address in the actual listing text. If no valid replacement exists, the malformed legacy address is dropped rather than sent to the geocoder.

A street + house appearing under a lexical `nearby` role remains a nearby geo reference and is not upgraded into the property's building address.

## Pass 6 — canonical data verification for the motivating Tashkent cases

### Assalom Sohil

Canonical geo-catalog point:

- `41.282995, 69.308420`
- catalog accuracy radius: `140 m`
- catalog entity: `uz:tashkent:residential:assalom-sohil`

Cross-checks performed:

- Yandex Maps resolves the named residential complex `Assalom! Sohil` at exactly `41.282995, 69.308420` in Yashnabad District;
- Golden House's historical project contact text places `Assalom Sohil` in Tashkent, Yashnabad district, Fargona street;
- the `ASSALOM SOHIL` trademark is registered to Golden House Property Group, supporting the developer/project identity.

The stored point is therefore suitable as the representative complex anchor. It must still be reported as complex-level/approximate geography, not the exact apartment entrance.

### Yangi Sergeli

`Yangi Sergeli` exists as two different semantic objects and must remain two different identities:

- residential complex: `41.221894, 69.225708`;
- local area: a separate neighborhood-level anchor.

When a listing explicitly declares `residenceComplex = Yangi Sergeli`, the residential-complex coordinate wins. If the RC cannot be resolved, an identically named `area/local_area` is skipped rather than allowed to impersonate the missing RC; a differently named honest broader parent such as `Sergeli` district may still remain as an explicitly broad fallback.

### Infinity

The current catalog entry resolves `Infinity` separately from `Assalom Sohil`. Golden House's current site places Infinity in Yashnabad district and its project/contact materials identify the Istiqbol / Sadyk Azimov area. Third-party property/map records independently place the Infinity residential development at the catalog coordinate used by the backend.

For the motivating listing, Infinity is contextually nearby, so even a perfectly accurate Infinity coordinate must not become the apartment point.

The catalog hierarchy audit also checks spatial parent metadata. Both complexes belong under the Yashnabad parent instead of the generic Tashkent parent; correcting a parent must not silently move the already verified representative center or upgrade its precision.

## Pass 7 — lexical boundary checks that affect geocoding

Geocoding quality depends on the parser not manufacturing broader anchors from substrings. Numbered residential/local-area tokens are therefore checked before the backend sees them.

Example:

- `Qorasuv dahasi` may resolve to umbrella `Qorasuv`;
- `Qorasuv-6` must **not** additionally leak the plain umbrella `Qorasuv` match merely because the alias regex can stop at the hyphen.

The generic guard is limited to an unnumbered `local_area` candidate followed immediately by a numbered child suffix. True numbered canonical areas such as `C-7` or `Ibn Sino-2` remain valid entities.

This matters downstream because a false umbrella match can create a broad catalog anchor that appears internally consistent while actually pointing to the wrong part of a numbered housing area.

## Pass 8 — failure-mode / CI review

The audit treats CI failures as evidence to inspect, not something to suppress by weakening assertions.

Provider failure is also not evidence that a weaker spatial level is correct. If an exact lookup is deferred because the network budget is exhausted, the listing stays unresolved for that pass instead of falling through to a broad point.

## Regression coverage

The branch includes or relies on regression tests for:

- Assalom Sohil canonical anchor;
- Yangi Sergeli residential-complex/local-area identity separation;
- same-name broad geography suppression when a residential complex is declared;
- a differently named honest parent remaining available as broad fallback;
- normalized learned address identity ignoring query text, inferred district, street labels and harmless number formatting;
- learned entity identity retaining `entity_type` isolation;
- Photon country/city/name validation;
- Photon point-like requests rejecting same-name broad `place` objects;
- Photon exact-building suppression;
- nearby Infinity suppression;
- source-address provenance;
- parsed-address provenance;
- nearby street/house suppression;
- malformed legacy address vs strong listing-prose address;
- malformed legacy address being discarded when no valid replacement exists;
- wrong house number;
- same house number on another street;
- same address in another city;
- country mismatch;
- missing country evidence for an exact lookup;
- requested corpus/building mismatch;
- named-entity false first result;
- partial-word entity-name collision;
- structured name/street/city not being overridden by text appearing only in `display_name`;
- city bbox country/city validation;
- approximate complex reverse geocoding not inventing a house number;
- broad source marker not inventing road/house precision;
- cross-city reverse-geocode conflict;
- source coordinate replaced by independently verified exact address while retaining discrepancy diagnostics;
- umbrella local-area aliases not swallowing numbered child blocks;
- a district-sized polygon losing a residential-complex lookup to the complex;
- a shop-sized match losing a district lookup to the district;
- a point-like anchor rejected when its footprint is a whole region;
- the matched footprint being reported so the accuracy radius stays honest;
- a geometry-free result inventing no accuracy and keeping prior behaviour;
- broad candidates carrying their semantic level into the geocoder expectation;
- the semantic level separating two cache identities for the same name.

## Remaining irreducible uncertainty

No geocoder can recover an exact apartment entrance when the listing supplies only a district, metro, landmark, residential-complex name, or vague travel-time relation. In those cases the correct output is an explicitly approximate point/radius or no point at all.

Travel-time phrases such as `5 мин на машине` are not converted to fake metre radii. They may be kept as semantic nearby evidence, but traffic-dependent travel time is not a reliable geometric distance.

The out-of-area bbox guard states its padding in latitude degrees. A degree of
longitude is shorter than a degree of latitude away from the equator, so the
padding is converted at the bbox latitude; otherwise the tolerance is ~25%
tighter east-west than north-south at Tashkent's latitude and clips valid points
off the eastern and western city edges.

Provider data can be stale or incomplete. Curated canonical geo-catalog points remain the highest-authority runtime source when independently verified. `learned_geo` is a typed persistent runtime cache beneath that layer; external provider IDs and reverse-geocoder output are evidence/provenance, not automatic replacements for stored curated centers.

## Known remaining gap

Learned-key normalization deliberately does not attempt arbitrary transliteration equivalence. For example, two unrelated strings should not collapse merely because a heuristic transliterator makes them look similar. Canonical parser/catalog aliases remain the correct place to bind verified Cyrillic/Latin spellings of the same physical entity.

The public Photon service is a best-effort fallback, not an SLA-backed dependency. Heavy/bulk usage must be avoided or moved to a self-hosted Photon instance. The public Nominatim endpoint is similarly treated as a scarce fallback and is cached/throttled; production-scale throughput should use an intentionally provisioned endpoint rather than increasing public-service concurrency.

## Merge gate

Before merge, all of the following must be true:

- current branch `npm test` is green in GitHub Actions;
- no new geocoding regression test is failing;
- parsing-lexicon contextual role and numbered-block boundary support required by the Tashkent examples is available in the backend dependency lock;
- package/catalog coordinates used as canonical anchors are from an approved published or otherwise intentionally pinned dependency version;
- geo-catalog validation is green;
- keyless-provider selectors preserve country/city/type/footprint validation and do not increase exact-address precision without proof;
- the PR remains unmerged until explicit user approval.
