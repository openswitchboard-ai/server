-- A DIRECTORY REVIEWER SIGNS IN WITH A PASSPHRASE (founder, October 2026;
-- src/counter/reviewerSignIn.ts).
--
-- OpenAI's plugin review needs credentials a stranger can use with no emailed
-- code, no text code and no magic link, and every account here signs in with
-- an emailed code or a passkey. So one account at a time can be marked as a
-- reviewer account: its address, typed at the sign-in page, asks for a long
-- passphrase instead of sending a code.
--
-- Nothing else about the account changes. Presses still need its PIN, and a
-- passphrase sign-in opens no PIN window of its own. A row stops working at
-- enabled_until, and is deleted outright when the review is over
-- (`npm run ops -- reviewer-sign-in --disable`). Only the argon2id hash of
-- the passphrase is stored; it is made on the founder's own machine and only
-- the hash crosses the ops queue.
CREATE TABLE IF NOT EXISTS reviewer_sign_ins (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  passphrase_hash  text NOT NULL,
  label            text NOT NULL,
  enabled_until    timestamptz NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  uses             integer NOT NULL DEFAULT 0,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
