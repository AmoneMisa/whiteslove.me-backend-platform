# Flats geocoding accuracy audit

Date: 2026-09-03

Scope: `apps/flats` forward geocoding, canonical geo-catalog fallback, source-coordinate validation, reverse geocoding, and address provenance.

This document records the precision rules and the concrete checks performed for the geocoding hardening branch. The goal is not to manufacture a plausible point for every listing. The goal is to prefer the strongest defensible spatial evidence, preserve uncertainty, and reject or downgrade contradictory evidence.

## Required precedence

The resolver should use the strongest available evidence in this order:

1. explicit source address with a concrete street + house, after the geocoder proves country, city, street and house (and corpus/building when supplied);
2. canonical residential complex with a verified geo-catalog point;
3. directly stated street when no building-level address is available;
4. specific primary POI / landmark when it is the best remaining property-location signal;
5. primary metro station;
6. constrained multi-anchor spatial inference from two or more quantified nearby references;
7. microdistrict / mahalla / local area / suburb / settlement;
8. nearby/reference ЖК, POI or metro as an explicitly approximate fallback;
9. district only as broad location evidence.

A city centre is viewport/search metadata and is never an apartment point.

`near X`, `до X`, `рядом с X`, `N минут от X` and equivalent context must preserve `X` as useful evidence but must not promote it to the property itself.

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

Nominatim search results are not accepted because they are first in the response. A candidate must prove the expected structured facts.

For a building-level address:

- requested country must match `address.country_code`;
- requested city must match structured city/town/municipality evidence;
- requested house number must match;
- requested street must match a structured road/street field;
- requested corpus/building must match the compound house number or a structured building/block/unit field.

For named entities:

- country and city must match;
- the requested entity name must match structured name/namedetails evidence;
- a different entity containing the requested words only somewhere in `display_name` is insufficient.

The Nominatim cache identity includes the validation expectations and selector version so an old weakly validated result cannot bypass stricter rules after deployment.

## Pass 2 — canonical anchors and contextual roles

Canonical `@whiteslove/geo-catalog` coordinates are preferred over ambiguous free-text geocoder guesses when a matching canonical entity exists.

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

A weak legacy field that only parses through permissive bare-address mode and contains listing prose such as `продаж`, `квартира`, or `ЖК` is not trusted over a strong explicit address in the actual listing text.

A street + house appearing under a lexical `nearby` role remains a nearby geo reference and is not upgraded into the property's building address.

## Pass 6 — canonical data verification for the motivating Tashkent case

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

### Infinity

The current catalog entry resolves `Infinity` separately from `Assalom Sohil`. Golden House's current site places Infinity in Yashnabad district and its project/contact materials identify the Istiqbol / Sadyk Azimov area. Third-party property/map records independently place the Infinity residential development at the catalog coordinate used by the backend.

For the motivating listing, Infinity is contextually nearby, so even a perfectly accurate Infinity coordinate must not become the apartment point.

## Regression coverage

The branch includes or relies on regression tests for:

- Assalom Sohil canonical anchor;
- nearby Infinity suppression;
- source-address provenance;
- parsed-address provenance;
- nearby street/house suppression;
- malformed legacy address vs strong listing-prose address;
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
- source coordinate replaced by independently verified exact address while retaining discrepancy diagnostics.

## Remaining irreducible uncertainty

No geocoder can recover an exact apartment entrance when the listing supplies only a district, metro, landmark, residential-complex name, or vague travel-time relation. In those cases the correct output is an explicitly approximate point/radius or no point at all.

Travel-time phrases such as `5 мин на машине` are not converted to fake metre radii. They may be kept as semantic nearby evidence, but traffic-dependent travel time is not a reliable geometric distance.

Provider data can be stale or incomplete. Canonical geo-catalog points remain the runtime source of truth when independently verified; external provider IDs and reverse-geocoder output are evidence/provenance, not automatic replacements for stored canonical centers.

## Merge gate

Before merge, all of the following must be true:

- current branch `npm test` is green in GitHub Actions;
- no new geocoding regression test is failing;
- parsing-lexicon contextual role support required by the Tashkent example is available in the backend dependency lock;
- package/catalog coordinates used as canonical anchors are from an approved published or otherwise intentionally pinned dependency version;
- the PR remains unmerged until explicit user approval.
