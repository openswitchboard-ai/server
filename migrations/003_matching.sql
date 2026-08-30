-- OpenSwitchboard matching engine (phase 0.F)

-- ---------------------------------------------------------------------------
-- Cards: pgvector ANN index for candidate retrieval, plus the contested-match
-- collection window. The window lives on the CARD (the contested side): it is
-- stamped when the card first has >= 2 concurrently-open matches, and closed
-- either by the timer or by the holder's explicit early-close. Once closed it
-- never reopens (terminal). collect_window_minutes is the per-card override;
-- it may only SHORTEN the default (6h goods / 15min urgency=today).
-- ---------------------------------------------------------------------------
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS collect_window_minutes integer CHECK (collect_window_minutes >= 1),
  ADD COLUMN IF NOT EXISTS collect_until       timestamptz,
  ADD COLUMN IF NOT EXISTS collect_closed_at   timestamptz;

CREATE INDEX IF NOT EXISTS cards_embedding_hnsw
  ON cards USING hnsw (embedding vector_cosine_ops);

-- Business accounts qualify as "fast enough" for urgency=today routing even
-- without a recently-seen agent token. Stub flag; later phases populate it.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_business boolean NOT NULL DEFAULT false;

-- Urgency routing input: when an access token was last presented. Updated
-- (throttled) by the MCP auth path; "agent seen in the last hour" reads this.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Reputation grows the anti-probing flag counter and the personal-threshold
-- nudge (see matchRules.ts for the documented model).
ALTER TABLE reputation
  ADD COLUMN IF NOT EXISTS probing_flags  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS threshold_bump real    NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Near-misses: scored pairs in [near_miss_floor, create_threshold) that pass
-- every hard rule. STORED ONLY - consumed by the 0.E digest engine; nothing
-- here is ever sent to either party by 0.F.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS near_misses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_want   uuid NOT NULL REFERENCES cards(id),
  card_have   uuid NOT NULL REFERENCES cards(id),
  score       real NOT NULL,
  category    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_want, card_have)
);

-- ---------------------------------------------------------------------------
-- Match-quality verdicts: one per human per match ('good-call' | 'not-for-me').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_verdicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     uuid NOT NULL REFERENCES matches(id),
  account_id   uuid NOT NULL REFERENCES accounts(id),
  verdict      text NOT NULL CHECK (verdict IN ('good-call','not-for-me')),
  recorded_via text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, account_id)
);

-- 'not-for-me' mutes the account pairing: the matcher never again pairs these
-- two accounts (in either direction) while a mute row exists.
CREATE TABLE IF NOT EXISTS match_mutes (
  account_id    uuid NOT NULL REFERENCES accounts(id),
  muted_account uuid NOT NULL REFERENCES accounts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, muted_account)
);

-- ---------------------------------------------------------------------------
-- Demand-pulse aggregates (data layer for 0.E digests / 0.G trends).
-- Materialised by the worker every 15 minutes. EVERY row already satisfies
-- the k-anonymity floor (k >= 10 open cards in the cell); cells under the
-- floor are ABSENT, never zeroed. Sub-metrics (matches_created / median
-- time-to-match) are NULL unless they independently clear the same floor.
-- NO public exposure in 0.F: read via src/domain/pulse.ts only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pulse_aggregates (
  category                 text NOT NULL,
  geo_bucket               text NOT NULL,
  open_want_count          integer NOT NULL,
  open_have_count          integer NOT NULL,
  matches_created          integer,
  median_seconds_to_match  double precision,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, geo_bucket)
);
