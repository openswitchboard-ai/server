-- THE POSTING'S OWN NUMBER, MINTED AT FIRST CONTACT.
--
-- THE DEFECT (three times in one day of rehearsals, 21 September 2026). A
-- posting that comes back with a question was remembered by a fingerprint built
-- out of the agent's own prose — the poster's words for the thing, plus the
-- amounts on it. The other questions in the same flow ask the agent to REWORD
-- that very thing. So:
--
--   the agent posts "upgraded Fanatec pedal spring, $10";
--   the switchboard asks whether the ten dollars is the human's own figure;
--   the agent asks, is told yes, and posts again — now worded "Fanatec
--     ClubSport V3 brake performance spring, $10", because the detail question
--     beside it asked for exactly that;
--   the switchboard does not recognise it and asks the same question again.
--
-- Four rounds, and then the agent told its human the thing was posted when
-- nothing had been posted at all. Two mechanisms, each sensible alone, that
-- together make a posting impossible.
--
-- THE FIX. A reference number, minted the first time the switchboard says
-- anything back about a posting attempt, carried by every question after it and
-- sent back by the agent on its next attempt. Every "have I already asked this?"
-- decision keys on the reference and on nothing else: no name, no amounts, no
-- time window. No reference means a genuinely new attempt, and the questions are
-- asked — that is the whole of the fallback, and it is correct.
--
-- THE REFERENCE IS THE POSTING'S ID. It is minted here as a uuid and, when the
-- posting finally goes up, it is the id that posting is given, so the number an
-- agent was handed with the first question is the number it holds for the
-- conversations that follow. There is never a moment where two numbers mean the
-- same want or have. An amend needs none of its own: the posting already has
-- one, and an amend already travels with it.
--
-- WHAT IT HOLDS, AND WHAT IT CANNOT. The account, and the names of the gates
-- that have already asked — 'detail', 'reach', 'figure'. Nothing about the
-- thing and no figure of any kind, which is strictly less than the table it
-- replaces held: that one carried the poster's own words for the thing, because
-- the words WERE the key. What somebody will pay for a thing is theirs, and a
-- refusal on the way to a row is no place to write it down.
--
-- WHOSE IT IS. Every read is by reference AND account, so a reference minted
-- for somebody else matches nothing and reads as no reference at all: a new
-- attempt, and the questions are asked. It is a version-4 uuid, so there is
-- nothing to guess at either.
--
-- HOW LONG IT LIVES. Until the attempt it belongs to succeeds, and no longer:
-- the row is deleted the moment the posting goes up or the amend goes through,
-- which is also what stops a reference excusing a question for ever. An attempt
-- nobody came back for is swept after a week, which is long enough for "I'll ask
-- him when he's home tomorrow" and short enough that the table stays a working
-- set rather than a record. The table is disposable: truncating it costs one
-- extra round of questions.
CREATE TABLE IF NOT EXISTS posting_references (
  reference   uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  -- The gates that have asked on this attempt: 'detail', 'reach', 'figure'.
  asked       text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS posting_references_opened_idx ON posting_references (opened_at);

COMMENT ON TABLE posting_references IS
  'One row per posting attempt that came back with a question, from the first question until the posting goes up. The reference becomes the posting''s own id. Holds the account and the names of the gates that have asked, and nothing about the thing or its figures. Safe to truncate.';

-- AND THE PROSE-DERIVED MEMORY GOES.
--
-- posting_detail_asks keyed on the account and the poster's own handful of words
-- for the thing (migrations/048). That key is the defect above: the questions
-- ask for sharper words, sharper words are a different key, and the same
-- question comes back for ever. Everything that read it now reads the reference.
-- Dropped rather than left standing, because a table nothing reads is a trap for
-- the next person to find it.
DROP TABLE IF EXISTS posting_detail_asks;
