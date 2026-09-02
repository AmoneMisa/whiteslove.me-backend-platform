-- Promote the four data-JSONB flags actually load-bearing in indexes/triggers
-- (roomOnly, commercial, listingKind, listingStatus) into real generated
-- columns. Same split as 024/026: this migration only adds the columns
-- (single heap rewrite under ACCESS EXCLUSIVE); index/trigger rewrites that
-- depend on them live in 039 so that longer phase doesn't inherit this
-- migration's lock.
--
-- Each expression is copied verbatim from the index/trigger predicates it
-- replaces (011/012/014/015/030/033/034) so behavior is provably identical.
-- room_only/commercial reuse the jsonb `@>` containment operator, which never
-- returns NULL, so both columns are always true/false, never NULL.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS room_only BOOLEAN
    GENERATED ALWAYS AS (
      data @> '{"roomOnly":true}'::jsonb
    ) STORED,
  ADD COLUMN IF NOT EXISTS commercial BOOLEAN
    GENERATED ALWAYS AS (
      data @> '{"commercial":true}'::jsonb
    ) STORED,
  ADD COLUMN IF NOT EXISTS listing_kind TEXT
    GENERATED ALWAYS AS (
      COALESCE(data->>'listingKind', 'propertyOffer')
    ) STORED,
  ADD COLUMN IF NOT EXISTS listing_status TEXT
    GENERATED ALWAYS AS (
      COALESCE(data->>'listingStatus', 'active')
    ) STORED;
