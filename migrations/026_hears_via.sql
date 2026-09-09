-- How this person hears about their own switchboard (phase 1.D)
--
-- Every human on the network is reached through an agent, and agents come in
-- two shapes. Most of them only exist while someone is typing: the person
-- opens a chat, the agent wakes, and when the conversation ends the agent is
-- gone. A few can run between conversations — they wake themselves, keep a
-- cadence, and can reach their human out of band.
--
-- The difference decides who carries the news. For a person whose agent only
-- acts when spoken to, email IS the delivery path: an introduction, a reply, a
-- figure on the table and an acceptance all have to reach them by mail, or
-- they reach them the next time they happen to open a chat, which may be
-- never. For a person whose agent runs on its own, that same mail is a second
-- copy of what their agent already brought them.
--
--   'email'     — the person's assistant only acts when spoken to. The
--                 switchboard emails them about anything that needs them.
--   'assistant' — an always-on agent brings the news. Email stays as a backup
--                 for the transactional things (approvals, security), and the
--                 conversational nudges stay quiet.
--
-- The default is 'email', which is the safe one: a person nobody has told us
-- about gets told rather than left in silence. It moves to 'assistant' when an
-- agent saves a standing arrangement that says it runs on its own AND gives a
-- checking cadence (domain/arrangement.ts), and the person can set it back on
-- their own page. Every change goes through domain/accounts.ts, which writes
-- the consent event first.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS hears_via text NOT NULL DEFAULT 'email';

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_hears_via_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_hears_via_check CHECK (hears_via IN ('email', 'assistant'));
