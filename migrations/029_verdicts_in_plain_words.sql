-- Verdicts in the words a person says (phase 1.G)
--
-- The one-tap call on how an introduction went shipped as 'good-call' and
-- 'not-for-me'. Both are protocol spellings rather than answers: an agent that
-- reads either one back has said a hyphenated code out loud, and in the run-7
-- rehearsal one did. They are also only two answers to a question that has
-- three, so every introduction that was simply all right had to be filed as a
-- rejection, and a rejection mutes the pairing for good.
--
-- The three words are the ones the human already uses:
--
--   'good' — the old 'good-call'. Worth having. Relaxes their own threshold
--            a little, so more like it come through.
--   'fine' — new, and the missing one. Recorded and nothing else: no mute, no
--            decline, no nudge either way. Neutral in the reliability signal.
--   'bad'  — everything 'not-for-me' did. Mutes the pairing, declines the
--            introduction if it is still open, and nudges their threshold up.
--
-- Rows written under the old words are rewritten here, so the column holds one
-- vocabulary and nothing downstream has to know two. The old words stay
-- readable on the wire for one manual version (the tool maps them and logs
-- nothing), which is why this migration is safe to run before that deploy.
UPDATE match_verdicts SET verdict = 'good' WHERE verdict = 'good-call';
UPDATE match_verdicts SET verdict = 'bad' WHERE verdict = 'not-for-me';

ALTER TABLE match_verdicts DROP CONSTRAINT IF EXISTS match_verdicts_verdict_check;
ALTER TABLE match_verdicts
  ADD CONSTRAINT match_verdicts_verdict_check CHECK (verdict IN ('good', 'fine', 'bad'));
