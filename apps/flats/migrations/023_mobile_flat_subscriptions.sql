CREATE SCHEMA IF NOT EXISTS subscriptions;

CREATE TABLE IF NOT EXISTS subscriptions.mobile_devices (
  device_id VARCHAR(80) PRIMARY KEY,
  push_token TEXT NOT NULL DEFAULT '',
  platform VARCHAR(16) NOT NULL DEFAULT 'android',
  language VARCHAR(8) NOT NULL DEFAULT 'ru',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions.mobile_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(80) NOT NULL REFERENCES subscriptions.mobile_devices(device_id) ON DELETE CASCADE,
  preset_id VARCHAR(80) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'flats' CHECK (kind = 'flats'),
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  UNIQUE (device_id, preset_id)
);

CREATE TABLE IF NOT EXISTS subscriptions.mobile_subscription_seen (
  subscription_id BIGINT NOT NULL REFERENCES subscriptions.mobile_subscriptions(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, item_key)
);

CREATE TABLE IF NOT EXISTS subscriptions.mobile_deliveries (
  device_id VARCHAR(80) NOT NULL REFERENCES subscriptions.mobile_devices(device_id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL,
  item_key TEXT NOT NULL,
  first_subscription_id BIGINT REFERENCES subscriptions.mobile_subscriptions(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, kind, item_key)
);

CREATE INDEX IF NOT EXISTS mobile_subscriptions_enabled_idx
  ON subscriptions.mobile_subscriptions(enabled, id);
CREATE INDEX IF NOT EXISTS mobile_subscriptions_device_idx
  ON subscriptions.mobile_subscriptions(device_id, id);
CREATE INDEX IF NOT EXISTS mobile_subscription_seen_seen_idx
  ON subscriptions.mobile_subscription_seen(subscription_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS mobile_deliveries_sent_idx
  ON subscriptions.mobile_deliveries(sent_at DESC);
