-- Owner collections: advertisers with two or more distinct active properties.
--
-- An "owner" is one stored contact (E.164 phone or @username, normalised at
-- ingest). The worker refreshes this table with the listing lines, so the
-- owners tab is a cheap indexed page read instead of a GROUP BY over every
-- active listing per request.
--
-- owner_key is an opaque hash of the contact. URLs, logs and caches carry the
-- key, never the phone number itself.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.listing_owners (
  owner_key CHAR(24) PRIMARY KEY,
  contact TEXT NOT NULL,
  -- The country most of the owner's listings are in; the tab lists owners
  -- per selected country.
  country VARCHAR(8) NOT NULL,
  city TEXT,
  properties INTEGER NOT NULL CHECK (properties >= 2),
  listings INTEGER NOT NULL,
  line VARCHAR(16) CHECK (line IS NULL OR line IN ('steady', 'phantom_risk', 'multi_listing')),
  -- Newest listing, for the card's photo and title.
  sample_listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- One owner per contact, and the lookup the owner filter makes.
CREATE UNIQUE INDEX IF NOT EXISTS listing_owners_contact_idx
  ON platform.listing_owners (contact);

-- The owners tab: per country, largest first, keyset-paginated.
CREATE INDEX IF NOT EXISTS listing_owners_country_page_idx
  ON platform.listing_owners (country, properties DESC, owner_key);
