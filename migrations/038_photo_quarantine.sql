-- A photo refused for sexual content is HELD, not destroyed
-- (docs/trust-and-safety.md, the "Sexual content" row; docs/safety.md, Photos)
--
-- WHY THIS TABLE EXISTS. Until now the sexual-content refusal in
-- src/intake/checks/photoModeration.ts deleted the object in the same breath.
-- For every other refused label that is still right. For the sexual family it
-- is wrong in law: under s 474.25 of the Criminal Code (Cth) a host that
-- becomes aware of child abuse material must refer it to the Australian
-- Federal Police, and Rekognition cannot tell an adult from a child. Deleting
-- on sight destroys the very thing that must be referred, and does it fastest
-- in exactly the cases that matter most.
--
-- SO THE OBJECT MOVES INSTEAD OF DYING. It is copied to
-- conversation-photos/quarantine/<introduction>/<name> in the same bucket and
-- the original is deleted, and this row is what says where it went. The
-- sender's assistant reads the same plain sentence it read before; nothing
-- about quarantine reaches any user, either side.
--
-- WHAT IS IN THE ROW AND WHAT IS NOT. Where the bytes are, whose press put
-- them there, which introduction, and which labels fired. NOBODY LOOKS AT THE
-- PICTURE to fill this in and no path in this repository displays or fetches
-- one: scripts/safety/quarantine.mts prints ids, labels and ages, and says so
-- in its own banner.
--
-- THE THREE STATES.
--   held     nobody has decided yet. This is where every row starts, and the
--            sweep will NEVER delete one — it logs it as overdue past ninety
--            days and leaves it exactly where it is. A person decides.
--   referred an operator has referred it to the AFP/ACCCE. The referral is the
--            operator's act, not this software's. Never swept, never deleted:
--            the bytes have to still be there when they are asked for.
--   cleared  an operator looked at what there was to look at and said no. The
--            object goes at that moment and the row goes at its expiry.
CREATE TABLE IF NOT EXISTS photo_quarantine (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       uuid,
  sender_account uuid,
  -- Where the bytes now sit: the photo bucket, and the quarantine key inside
  -- it. Not the key the sender uploaded to — that one is gone.
  bucket         text NOT NULL,
  key            text NOT NULL,
  -- The moderation labels that fired, and only those. Never a caption, never
  -- a description of the image, which nobody here has seen.
  labels         text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'held',
  resolved_at    timestamptz,
  -- Ninety days, the same number a report and a safety review hold for.
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '90 days',
  CONSTRAINT photo_quarantine_status_known CHECK (status IN ('held', 'referred', 'cleared'))
);

-- The two reads: what is waiting for a person (oldest first), and what the
-- sweep may take.
CREATE INDEX IF NOT EXISTS photo_quarantine_status_idx ON photo_quarantine (status, created_at);
CREATE INDEX IF NOT EXISTS photo_quarantine_expiry_idx ON photo_quarantine (status, expires_at);

COMMENT ON TABLE photo_quarantine IS
  'A photo refused for a sexual-content label, moved to a quarantine prefix rather than deleted, so that anything that must be referred to the AFP under s 474.25 still exists to be referred. No content is here, and nobody has looked at the image.';
COMMENT ON COLUMN photo_quarantine.status IS
  'held (nobody has decided; never swept, logged as overdue past expiry), referred (an operator referred it; never swept, never deleted), cleared (an operator said no; object deleted at that moment, row swept at expiry).';
COMMENT ON COLUMN photo_quarantine.labels IS
  'The Rekognition moderation labels that fired. Never a caption or a description of the image.';
