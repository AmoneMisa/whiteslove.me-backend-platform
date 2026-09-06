CREATE SCHEMA IF NOT EXISTS user_data;

CREATE TABLE IF NOT EXISTS user_data.installations (
  device_id VARCHAR(80) PRIMARY KEY,
  sync_secret_hash CHAR(64) NOT NULL,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_data.saved_collections (
  device_id VARCHAR(80) NOT NULL REFERENCES user_data.installations(device_id) ON DELETE CASCADE,
  collection_id VARCHAR(80) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('favorites', 'sorted')),
  title VARCHAR(160) NOT NULL DEFAULT '',
  is_preset BOOLEAN NOT NULL DEFAULT FALSE,
  preset_name VARCHAR(160),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, collection_id)
);

CREATE TABLE IF NOT EXISTS user_data.saved_items (
  device_id VARCHAR(80) NOT NULL,
  collection_id VARCHAR(80) NOT NULL,
  item_key VARCHAR(320) NOT NULL,
  payload JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, collection_id, item_key),
  FOREIGN KEY (device_id, collection_id)
    REFERENCES user_data.saved_collections(device_id, collection_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_data.saved_presets (
  device_id VARCHAR(80) NOT NULL REFERENCES user_data.installations(device_id) ON DELETE CASCADE,
  preset_id VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, preset_id)
);

CREATE INDEX IF NOT EXISTS saved_collections_device_kind_idx
  ON user_data.saved_collections(device_id, kind, position, updated_at DESC);
CREATE INDEX IF NOT EXISTS saved_items_collection_position_idx
  ON user_data.saved_items(device_id, collection_id, position, updated_at DESC);
CREATE INDEX IF NOT EXISTS saved_presets_device_position_idx
  ON user_data.saved_presets(device_id, position, updated_at DESC);
CREATE INDEX IF NOT EXISTS installations_account_idx
  ON user_data.installations(account_id)
  WHERE account_id IS NOT NULL;
