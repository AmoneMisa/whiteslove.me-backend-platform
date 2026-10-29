-- Registry signal per listing: the contact of an active listing appears in the imported legacy realtor registry.
--
-- Separate from platform.listing_lines on purpose: lines describe a listing's advertising history and have a closed
-- set of values clients already know. The registry signal is an additive, optional field about the listing's
-- contact, worded for the listing and never as a verdict on a person. A contact claimed by both a risk and a trusted
-- cluster, or whose subject restricted or objected to processing, gets no row.
CREATE TABLE IF NOT EXISTS platform.listing_registry_signals (
  listing_id BIGINT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  signal VARCHAR(8) NOT NULL CHECK (signal IN ('risk', 'trusted')),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);
