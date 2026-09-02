-- One shared ceiling across the agent's read tools (phase 1.E)
--
-- check_matches, channel_receive and list_intents are the three calls an
-- unattended agent can make in a loop for nothing, and a loop is exactly what
-- a scheduled agent is. Sixty of them an hour, per account, across all three
-- together, is generous for anything a human actually asked for and mean to a
-- runaway.
--
-- The window has to hold across replicas — prod runs two Fargate tasks and
-- scales to ten — so it lives here rather than in a process. One row per read
-- call, counted over the trailing hour and pruned past it; an account at the
-- ceiling holds sixty rows and no more.
CREATE TABLE IF NOT EXISTS read_calls (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  called_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS read_calls_account_time
  ON read_calls (account_id, called_at DESC);
