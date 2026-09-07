# Country-aware housing parser integration

Flat Finder will keep a single shared parser core and pass canonical country context into parsing-lexicon. Country-specific behavior is limited to declarative ambiguity rules; parser algorithms remain shared.

Backend changes in this branch:
- pass canonical country context into lexicon parsing where supported;
- never let a price-floor heuristic overwrite an explicit long-rent classification;
- add production regressions for Ukrainian listings where `80 м` and `606 м/р` were parsed as millions;
- keep fallback heuristics only for genuinely unresolved deal type.

The parsing-lexicon companion branch is `feature/country-aware-housing-parsers`.
