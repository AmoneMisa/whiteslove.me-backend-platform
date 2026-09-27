-- Accounts: "Sign in with Google" joins a phone and a browser so they share
-- saved flats, sorted collections and presets (with their notification flags).
--
-- Only Google's stable subject id is kept -- no email, name or photo. It is
-- what identifies the same person on the next sign-in, and nothing else is
-- needed for that.
--
-- An account's saved state lives under one synthetic installation,
-- 'acct:<account_id>', so the saved-state tables and their limits need no
-- account-aware copy: an installation linked to an account reads and writes
-- the account's rows instead of its own. That installation row has no usable
-- secret (its hash is of random bytes nobody holds) and client device ids
-- starting with 'acct:' are rejected, so it can only be reached by linking.
--
-- installations.account_id (migration 044) was reserved for exactly this.

CREATE TABLE IF NOT EXISTS user_data.accounts (
  account_id VARCHAR(40) PRIMARY KEY,
  google_sub VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sign_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deleting an account unlinks its devices; they keep working anonymously.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'installations_account_fk'
  ) THEN
    ALTER TABLE user_data.installations
      ADD CONSTRAINT installations_account_fk
      FOREIGN KEY (account_id) REFERENCES user_data.accounts(account_id)
      ON DELETE SET NULL;
  END IF;
END $$;
