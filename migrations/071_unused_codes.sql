-- CODES NOBODY USES STOP GOING OUT (founder, November 2026;
-- src/counter/verification.ts unusedCodesHeld).
--
-- Every spam complaint prod email has drawn was on a sign-in or sign-up code,
-- sent to an address that never opened an account: somebody typed an address
-- that was not theirs, or used the door to mail a stranger. The sixth one
-- paused prod email for five days. So after three codes in a week that were
-- sent and never used, an address gets no more from the sign-in or sign-up
-- door until one of them ages out of the week.
--
-- sent_at is when the email actually went out. A code whose send failed (an
-- SES pause, a full queue) never reached anybody's inbox and does not count,
-- and nor does any row written before this column existed.
ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS sent_at timestamptz;
CREATE INDEX IF NOT EXISTS email_verifications_hash_sent_idx
  ON email_verifications (email_hash, sent_at) WHERE sent_at IS NOT NULL;
