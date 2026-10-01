-- WRITTEN LINES THE SELLER'S HUMAN CONFIRMS (founder, 2 October 2026;
-- src/domain/confirmLines.ts).
--
-- The switchboard introduces people and keeps records; it never referees. A
-- record of what was agreed already goes to both people when an offer is
-- accepted (src/domain/receipt.ts). What it could not hold was anything said in
-- conversation, because a conversation is carried and then let go. So a claim
-- that matters is put on the deal as a short written line: the buying side
-- asks it, the SELLER'S HUMAN confirms it with their own press, and the record
-- lists the confirmed ones.
--
-- 1. THE LINES. One row per line asked on one introduction.
--
--   line          the words, stored the way an offer note is stored: a jsonb
--                 { text, provenance: 'counterparty-untrusted' }. Nullable, so
--                 account deletion can take the words off and keep the row.
--   state         asked      nobody has answered it yet
--                 confirmed  the seller's human ticked it and pressed
--                 declined   the seller's human pressed with it left unticked
--                 withdrawn  the side that asked took it off
--   answered_*    who pressed, when, how the press was recorded, and which
--                 page it was on. A line is only ever answered by a press on
--                 the human's own page, and the check below makes that the
--                 database's rule as well as the code's (as 061 did for an
--                 accept): no row can say confirmed or declined without one.
CREATE TABLE IF NOT EXISTS confirm_lines (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     uuid        NOT NULL REFERENCES matches(id),
  asked_by     uuid        NOT NULL REFERENCES accounts(id),
  line         jsonb,
  state        text        NOT NULL DEFAULT 'asked'
    CHECK (state IN ('asked', 'confirmed', 'declined', 'withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  answered_by  uuid        REFERENCES accounts(id),
  answered_via text,
  answered_on  text
    CHECK (answered_on IS NULL OR answered_on IN ('offer-accept', 'offer-send', 'lines-confirm')),
  withdrawn_at timestamptz,
  CONSTRAINT confirm_lines_answer_is_a_press CHECK (
    state NOT IN ('confirmed', 'declined')
    OR (answered_at IS NOT NULL AND answered_by IS NOT NULL AND answered_via = 'counter')
  )
);
CREATE INDEX IF NOT EXISTS confirm_lines_match_idx ON confirm_lines (match_id, created_at);
COMMENT ON TABLE confirm_lines IS
  'Short written lines the buying side asked the seller''s human to confirm on one introduction. Confirmed or declined only by a press on the seller''s own page. Kept with the introduction, as offers are.';

-- 2. THE FINGERPRINT ON THE OFFER. The SHA-256 of the record that was built
-- when this offer was accepted, set in the same statement that marks it
-- accepted. Null on an offer that was never accepted, on one accepted before
-- today, and on the rare acceptance whose record could not be built. It is
-- what lets the wrap-up say "a record has been sent" only where one was.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS receipt_sha256 text;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_receipt_sha256_hex;
ALTER TABLE offers ADD CONSTRAINT offers_receipt_sha256_hex
  CHECK (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[0-9a-f]{64}$');

-- 3. THE PAGE WHERE THE SELLER CONFIRMS WITH A PRESS OF ITS OWN is a link
-- action like every other page a human presses, so the check on
-- approval_links.action learns its name. Rewritten in full, as 063 did;
-- test/unit/linkActionsMigrated.test.ts holds this list to the one in
-- src/counter/links.ts.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN (
    'offer-accept',
    'stage3-disclosure',
    'settlement-approve',
    'offer-send',
    'collection-close',
    'negotiation-auto',
    'conversation-photo',
    'report',
    'conversation-renew',
    'shelf-pick',
    'contact-send',
    'lines-confirm'
  ));

-- 4. A THIRD THING A PRESS CAN COME TO. A seller who presses Accept with a
-- line left unticked has pressed, their answers are saved, and nothing is
-- agreed. That is neither 'approved' nor 'declined' (which is Not now), and
-- an assistant holding the line on that press is owed the true answer.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_decision_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_decision_check
  CHECK (decision IN ('approved', 'declined', 'not-agreed'));
