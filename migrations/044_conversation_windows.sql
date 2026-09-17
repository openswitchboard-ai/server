-- The conversation budget: consent to talk runs out instead of being given
-- once (docs/trust-and-safety.md).
--
-- Until now one press at the names step opened a conversation that two agents
-- could then carry on forever, unattended. A window is one human's press,
-- measured on their own side only: so many messages sent by that side, or so
-- many days, whichever ends first. When it is spent that side's send_message
-- stops and asks its human whether to keep going. The other side is told
-- nothing, so nothing here leaks what the counterparty has or has not done.
--
-- One row per party per introduction. The primary key is what makes the spend
-- a single statement: the send path increments and enforces the budget in one
-- UPDATE, so two agents sending at once cannot both slip past the last message.
CREATE TABLE IF NOT EXISTS conversation_windows (
  match_id      uuid NOT NULL REFERENCES matches(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  messages_sent integer NOT NULL DEFAULT 0,
  -- What opened this window: the names press that started the conversation,
  -- the renewal page, or the backfill below.
  granted_via   text,
  PRIMARY KEY (match_id, account_id)
);

-- NOTHING LIVE PAUSES ON DEPLOY. Every party of every introduction that
-- already has a conversation open starts with a full window from now, so two
-- people in the middle of arranging a handover are not cut off by a rule that
-- did not exist when they started talking. They reach the question the
-- ordinary way, once they have spent this one.
INSERT INTO conversation_windows (match_id, account_id, started_at, messages_sent, granted_via)
SELECT m.id, a.account_id, now(), 0, 'backfill'
  FROM matches m
  CROSS JOIN LATERAL (VALUES (m.account_want), (m.account_have)) AS a(account_id)
 WHERE m.channel_id IS NOT NULL
ON CONFLICT (match_id, account_id) DO NOTHING;

-- And the renewal page is a link action, so the check on approval_links.action
-- has to know about it. The check is rewritten by whichever migration last
-- touched it (039 was the last), and test/unit/linkActionsMigrated.test.ts
-- holds this list to the one in src/counter/links.ts.
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
    'conversation-renew'
  ));
