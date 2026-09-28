-- Saved lists for the site's other sections under the same Google account:
-- jobs (vacancies) and cv (candidate profiles). One account covers flats, jobs
-- and CVs; flats keep their own richer tables (migration 044), these sections
-- need only flat lists of items.
--
-- Rows belong to an installation exactly like the flats tables, so linking,
-- signing out and deleting an account (migration 059, mobile-account.js) work
-- the same way: a linked installation reads and writes 'acct:<account_id>'.
--
--   domain  jobs | cv
--   list    favorites | hidden | recent | seen | presets
--   item_key the vacancy / profile id, or a preset's lower-cased name
--   payload  the item snapshot the page renders offline ({} for `seen`)
--
-- Each list is a bounded window: writing past its limit drops the oldest rows
-- (the same rule the browser's local copy follows), so no request fails for
-- being over a limit.

CREATE TABLE IF NOT EXISTS user_data.saved_list_items (
  device_id VARCHAR(80) NOT NULL REFERENCES user_data.installations(device_id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL CHECK (domain IN ('jobs', 'cv')),
  list VARCHAR(16) NOT NULL CHECK (list IN ('favorites', 'hidden', 'recent', 'seen', 'presets')),
  item_key VARCHAR(320) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, domain, list, item_key)
);

CREATE INDEX IF NOT EXISTS saved_list_items_window_idx
  ON user_data.saved_list_items(device_id, domain, list, updated_at DESC);
