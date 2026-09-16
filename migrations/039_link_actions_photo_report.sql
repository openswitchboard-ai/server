-- Two one-question pages arrived without widening the check on the action
-- column: the photo page (032) and the report page (035). The code in
-- src/counter/links.ts has allowed both since they shipped, and the unit
-- suite covers them there; on a real database the INSERT was refused by the
-- constraint 027 wrote. Found by the adversary harness on 17 September 2026.
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
    'report'
  ));
