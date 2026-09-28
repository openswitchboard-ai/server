-- DELETE MY ACCOUNT (founder decision, 28 September 2026).
--
-- A person can close their own account from the Settings page. What that does,
-- table by table, is written out in src/domain/accountDeletion.ts. This
-- migration only gives the accounts row a way to say it is gone:
--
--   status 'deleted' — the account can never sign in again, no digest or
--                      notice is sent to it, and every door treats it as
--                      holding nothing;
--   deleted_at       — when it was deleted.
--
-- The row itself stays, because reports, settlements, introductions and the
-- consent tokens point at it. What it held about the person is overwritten in
-- the same act: the email hash is replaced with 'deleted:<id>' (so a fresh
-- registration on the same address starts a new account), email_hash_v2 is
-- emptied, and the name, suburb and address are re-sealed as empty strings.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('pending','active','suspended','deleted'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN accounts.deleted_at IS
  'Set when the person deleted their own account. Identity fields are erased at that moment; see src/domain/accountDeletion.ts for what is kept and why.';
