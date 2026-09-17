-- Email action tokens that may only be pressed once
--
-- The renew-all link in a lapsing-soon email restarts the clock on every want
-- and have an account holds. It was a stateless signature with a fourteen-day
-- life, which means it was fourteen days of unlimited presses: anyone who came
-- by the URL — a forwarded email, a shared screen, a mail archive — could keep
-- somebody's postings alive indefinitely without them.
--
-- So the token now carries a jti, and pressing it spends that jti here. The
-- unsubscribe token is deliberately NOT on this road: one-click unsubscribe
-- has to keep working every time a mail client tries it, and turning email off
-- twice is the same as turning it off once.
--
-- Rows are small and self-expiring: nothing needs a jti after its token's own
-- expiry, and the sweep takes them away then.
CREATE TABLE IF NOT EXISTS consumed_email_tokens (
  jti         text PRIMARY KEY,
  purpose     text NOT NULL,
  account_id  uuid REFERENCES accounts(id),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS consumed_email_tokens_expiry_idx
  ON consumed_email_tokens (expires_at);

COMMENT ON TABLE consumed_email_tokens IS
  'One row per email action token that has been pressed. A second press finds the row and is turned away.';
