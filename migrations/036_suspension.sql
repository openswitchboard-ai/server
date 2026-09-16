-- Suspension: nothing in, nothing out
-- (docs/trust-and-safety.md, "Enforcement" and "Telling their assistant"; step 6)
--
-- A suspended account is one the operator has stopped. Its wants and haves
-- come down, its open introductions are severed, and every door — posting,
-- amendment, message, photo, offer wording, the shared first name and suburb —
-- refuses it, in both directions: nothing may be handed in by it and nothing
-- may be handed to it.
--
-- THE REASON IS THE OPERATOR'S ALONE. It is written here so that whoever lifts
-- a suspension can see why it was put on, and it is never served to an agent,
-- never put in an email, and never shown on any page.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_reason text;

COMMENT ON COLUMN accounts.suspended_at IS
  'Set while this account is suspended. Every door refuses it, in both directions, and every tool call answers SUSPENDED.';
COMMENT ON COLUMN accounts.suspended_reason IS
  'Operator-facing only. Never served to an agent, never emailed, never shown on a page.';

-- The email hashes that may not open a new account.
--
-- Suspending somebody who can sign up again five minutes later is a gesture
-- rather than an enforcement, so the address is remembered. The hash is the
-- same one the accounts table keys on (sha256 of the trimmed, lower-cased
-- address — src/domain/accounts.ts emailHash), so nothing new about a person is
-- kept here that was not already kept: this table holds no address, and there
-- is nothing in it to read back.
--
-- Lifting a suspension deletes the row, so the door opens again in the same act.
CREATE TABLE IF NOT EXISTS suspended_emails (
  email_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE suspended_emails IS
  'Email hashes refused at onboarding because the account behind them was suspended. Same hash the accounts table keys on; no address is stored.';
