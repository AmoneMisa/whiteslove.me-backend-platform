-- The registry signal says why, not only "risk": 'hidden_agent' is a realtor or agency publishing as a private owner
-- (nearly all of the legacy registry), 'flagged' is a negative classification (blacklist, high risk, negative review),
-- 'trusted' is a trusted realtor. `sources` holds up to three public source links the classification rests on.
ALTER TABLE platform.listing_registry_signals
  ADD COLUMN IF NOT EXISTS category VARCHAR(16)
    CHECK (category IS NULL OR category IN ('hidden_agent', 'flagged', 'trusted')),
  ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;
