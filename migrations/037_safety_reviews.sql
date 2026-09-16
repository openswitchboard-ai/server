-- Grooming, exploitation and threats: the flag a person looks at
-- (docs/trust-and-safety.md, "The checks" and step 7 of the build sequence)
--
-- WHAT A ROW HERE IS. A message went through the classifier
-- (src/intake/checks/messageSafety.ts) and the classifier said it may be one
-- of the things this network must never carry quietly: a child in the
-- conversation, grooming, sextortion, a threat of harm, or a sender who
-- sounds at risk themselves. The message WAS STILL DELIVERED. This row is the
-- flag that says a person should read it, not a stall.
--
-- WHY IT DOES NOT STALL. The person on the other side of a held message is
-- waiting for a reply. Holding it back would ghost them silently, on the word
-- of a fast model, in the overwhelming majority of cases where the answer is
-- that two adults are haggling bluntly over a bike. The evidence is kept and a
-- person is told; the conversation keeps going while they look. That is the
-- opposite of the photo rule, where an unseen picture must never go out, and
-- the difference is that a picture cannot be unseen and a conversation can be
-- read afterwards.
--
-- WHAT IS IN THE ROW AND WHAT IS NOT. Which introduction, who sent it, which
-- ledger entry holds the words, and which flags fired. NEVER THE WORDS. The
-- words live in the ledger, encrypted, and a person reads them only through
-- the two-keyholder export ceremony (scripts/safety/export.mts). Nothing on
-- this table and nothing in scripts/safety/reviews.mts shows content.
CREATE TABLE IF NOT EXISTS safety_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid,
  sender_account  uuid,
  -- The ledger entry holding the message body, where the ledger is on in this
  -- deployment. NULL on a deployment with no SAFETY_PUBLIC_KEY: the flag still
  -- stands, there is simply nothing kept behind it to read.
  ledger_entry_id uuid,
  -- The classifier's flag names, and only those: minor_involved, grooming,
  -- sexual_exploitation, threat, self_harm_risk. Never the model's note, which
  -- can quote the message.
  flags           text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'open',
  resolved_at     timestamptz,
  CONSTRAINT safety_reviews_status_known CHECK (status IN ('open', 'reviewed', 'dismissed'))
);

-- The one read the operator makes: what is still waiting to be looked at,
-- oldest first. The second is "everything about this introduction".
CREATE INDEX IF NOT EXISTS safety_reviews_status_idx ON safety_reviews (status, created_at);
CREATE INDEX IF NOT EXISTS safety_reviews_match_idx ON safety_reviews (match_id);

COMMENT ON TABLE safety_reviews IS
  'A message the grooming/exploitation/threat classifier flagged. The message was still delivered; this is a flag for review, never a stall. No content is here — the words are in the encrypted ledger entry this row points at.';
COMMENT ON COLUMN safety_reviews.flags IS
  'Flag names only (minor_involved, grooming, sexual_exploitation, threat, self_harm_risk). Never the model note, which can quote the message.';
COMMENT ON COLUMN safety_reviews.ledger_entry_id IS
  'The encrypted ledger entry holding the words, or NULL where this deployment keeps no ledger. Read only through the two-keyholder ceremony.';
