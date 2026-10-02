-- AN ACCEPT IS ONLY EVER A HUMAN'S PRESS (N4, 30 September 2026).
--
-- consent_tokens holds the two consents a human gives on their own page: the
-- names opt-in (stage3-optin) and taking a figure (offer-accept). Both are
-- written only by the press on the human's own page, and the code has always
-- recorded that as recorded_via = 'counter' (recordStage3OptIn refused
-- anything else; acceptOfferByHuman now does too). The internal ops queue
-- used to be able to write an offer-accept with 'internal-ops' or whatever
-- value the message carried. That path is gone, and this constraint makes the
-- rule the database's as well as the code's.
--
-- NOT VALID: new rows are checked; rows written before today (on dev, by the
-- integration suite and the ops CLI through the old path) are left as the
-- history they are rather than rewritten.
ALTER TABLE consent_tokens DROP CONSTRAINT IF EXISTS consent_tokens_recorded_via_press;
ALTER TABLE consent_tokens ADD CONSTRAINT consent_tokens_recorded_via_press
  CHECK (recorded_via = 'counter') NOT VALID;
