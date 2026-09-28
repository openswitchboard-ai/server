-- WHAT OPENED THE WINDOW, AND A PIN SET BY EMAIL THAT WAITS (28 September 2026).
--
-- counter_sessions.elevated_via records which ceremony opened the current
-- five-minute window: 'passkey', 'pin', or 'code' (an emailed code on an
-- account that holds a passkey and no PIN). An emailed code is the account's
-- recovery, and anyone who can read the inbox can produce one, so it may carry
-- the everyday presses and never a credential change, an agent key or an
-- authorisation. Those read this column. A row elevated before this column
-- existed reads NULL and counts as the weaker kind.
--
-- accounts.pin_money_from is set when a PIN is set through the lost-passkey
-- recovery path, which only an emailed code stands behind. Until that moment
-- the PIN counts the way the emailed code does: money presses refuse it, and
-- so do credential changes, agent keys and authorisations. The passkey keeps
-- working throughout, and a security notice goes out at once.
ALTER TABLE counter_sessions ADD COLUMN IF NOT EXISTS elevated_via text;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pin_money_from timestamptz;

COMMENT ON COLUMN counter_sessions.elevated_via IS
  'Which ceremony opened the pin_ok_until window: passkey, pin, or code. NULL counts as code.';

COMMENT ON COLUMN accounts.pin_money_from IS
  'A PIN set by emailed-code recovery counts only as the emailed code until this moment.';
