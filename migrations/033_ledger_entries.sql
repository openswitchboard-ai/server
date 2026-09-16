-- The ledger: thirty days, written by a server that cannot read it back
-- (docs/trust-and-safety.md, step 2 of the build sequence)
--
-- WHAT THIS TABLE IS FOR. Everything one person hands the switchboard for
-- another person to see now goes through one pipe, and what passed that pipe
-- is kept here for thirty days so that a report has evidence behind it and a
-- lawful request has something to be met with. It is the only store of what
-- people said to each other; messages themselves are still deleted the moment
-- they are collected.
--
-- WHO CAN READ IT. Nobody with access to this database. The body is encrypted
-- to a public key, and the private half of that key is not on this machine, in
-- this account, or in any backup: it is split three ways and two keyholders
-- have to come together to put it back (src/safety/shamir.ts). A full
-- compromise of the service gives an attacker the ability to write rows and
-- nothing else. That is the mechanism behind the promise the privacy page
-- already makes.
--
-- WHAT A REFUSED ITEM LEAVES. Sender, door, reason code, timestamp. Never the
-- content. An item that was turned back at the door was never delivered to
-- anybody, and keeping the words of it would be keeping a store of exactly the
-- material we refuse to carry.
--
-- THE THREE TIMESTAMPS.
--   created_at      when it went through the pipe.
--   expires_at      created_at + thirty days. The sweep deletes past this.
--   preserved_until null in the ordinary case. A preservation request from
--                   lawful process pushes it out past the window WITHOUT
--                   anybody reading anything, which is the whole point of
--                   having it as a separate column: freezing and reading are
--                   different acts with different authority behind them.

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  door              text NOT NULL,
  outcome           text NOT NULL,
  reason_code       text,
  sender_account    uuid NOT NULL,
  recipient_account uuid,
  match_id          uuid,
  intent_id         uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  preserved_until   timestamptz,
  -- Null together, and only on a refusal: no key, no body, nothing to read.
  wrapped_key       bytea,
  body_enc          bytea,
  nonce             bytea,
  -- The verdict's checks with the words taken out: name, outcome, reason code,
  -- and which model answered. No detail, no plain words, no error text — those
  -- can quote the item, and this column is readable by the server.
  checks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT ledger_entries_body_together CHECK (
    (wrapped_key IS NULL AND body_enc IS NULL AND nonce IS NULL)
    OR (wrapped_key IS NOT NULL AND body_enc IS NOT NULL AND nonce IS NOT NULL)
  ),
  CONSTRAINT ledger_entries_refused_holds_nothing CHECK (
    outcome <> 'refuse' OR body_enc IS NULL
  )
);

-- The sweep reads by expiry. The export and the report read by introduction,
-- newest first. Nothing else looks this table up, and deliberately: it is not
-- a place to answer questions about a person from.
CREATE INDEX IF NOT EXISTS ledger_entries_expiry_idx
  ON ledger_entries (expires_at);
CREATE INDEX IF NOT EXISTS ledger_entries_match_idx
  ON ledger_entries (match_id, created_at);

COMMENT ON TABLE ledger_entries IS
  'Thirty days of what passed the intake pipe, encrypted to a key whose private half is split between two keyholders and is never on a server. Refused items keep the reason code and nothing else.';
COMMENT ON COLUMN ledger_entries.preserved_until IS
  'Set by a preservation request under lawful process. Holds the row past the thirty days without anybody reading it.';
COMMENT ON COLUMN ledger_entries.checks IS
  'Reason codes only. Never the words of the item, and never a model note that might quote them.';
