-- AGREEING TO THE TERMS (22 November 2026; src/counter/terms.ts).
--
-- Until now no account page asked anyone to agree to the terms of use or the
-- privacy policy. A new account now agrees on the consent page; an existing
-- one is asked once, on its way to its main page or to connecting an
-- assistant. The agreement itself goes to the tamper-evident consent log;
-- these columns only say which version this account last agreed to and when,
-- so the pages know whether to ask.
--
--   terms_version      the TERMS_VERSION agreed to; NULL where none yet.
--   terms_accepted_at  when.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
