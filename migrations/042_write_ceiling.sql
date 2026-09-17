-- One shared ceiling across the agent's WRITE tools (2026-09-17 audit)
--
-- Migration 011 put a ceiling on reading. Nothing capped writing. Every write
-- tool had a limit of its own — offers per hour, publishes per day, messages
-- per channel per hour — and every one of those limits was scoped to something
-- smaller than the account: an agent with introductions on ten conversations
-- could send six hundred messages an hour inside the rules, each one a Bedrock
-- call and a ledger row, and nothing anywhere was counting the account.
--
-- So: one ceiling over send_message, publish_intent, respond and settle
-- together, per account, per rolling hour. It sits ABOVE the per-thing limits
-- rather than replacing any of them — a ceiling on the account is a different
-- question from how fast one conversation may move — and it is generous enough
-- that only a runaway meets it.
--
-- Same shape and same reasons as read_calls: the window has to hold across
-- replicas, so it lives here rather than in a process. One row per write call,
-- counted over the trailing hour and pruned past it.
CREATE TABLE IF NOT EXISTS write_calls (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  called_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS write_calls_account_time
  ON write_calls (account_id, called_at DESC);
