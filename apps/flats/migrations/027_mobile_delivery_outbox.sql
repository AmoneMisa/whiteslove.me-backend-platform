-- Turn the existing per-device delivery ledger into a small durable outbox.
-- Historical rows already represent successful sends and therefore become
-- status='sent'. New notifications are first claimed as 'sending'; only the
-- owner of the lease token may mark them sent/failed.

ALTER TABLE subscriptions.mobile_deliveries
  ALTER COLUMN sent_at DROP NOT NULL,
  ALTER COLUMN sent_at DROP DEFAULT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lock_token UUID,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE subscriptions.mobile_deliveries
SET status = 'sent',
    sent_at = COALESCE(sent_at, NOW()),
    updated_at = NOW()
WHERE status IS DISTINCT FROM 'sent';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mobile_deliveries_status_check'
      AND conrelid = 'subscriptions.mobile_deliveries'::regclass
  ) THEN
    ALTER TABLE subscriptions.mobile_deliveries
      ADD CONSTRAINT mobile_deliveries_status_check
      CHECK (status IN ('sending', 'sent', 'failed'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS mobile_deliveries_sending_lease_idx
  ON subscriptions.mobile_deliveries(locked_until, device_id, item_key)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS mobile_deliveries_status_updated_idx
  ON subscriptions.mobile_deliveries(status, updated_at DESC);

ANALYZE subscriptions.mobile_deliveries;
