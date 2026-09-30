-- THE ABUSE LIMITERS, SHARED ACROSS TASKS (N11, 30 September 2026;
-- src/abuseLimit.ts, src/rateLimitStore.ts).
--
-- The per-IP (and per-account) limiters used to count in each process, so
-- with several tasks every limit was multiplied by the task count and reset on
-- every deploy. One row per limiter and key now holds the live window for all
-- of them.
--
-- key_hash is HMAC-SHA256 of the IP or account id under a key derived from
-- the counter's link key; no address is stored. A row is deleted by the
-- ttl-expiry sweep once expires_at has passed, so nothing outlives its window
-- by more than one tick.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  limiter      text        NOT NULL,
  key_hash     text        NOT NULL,
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  n            integer     NOT NULL CHECK (n >= 1),
  PRIMARY KEY (limiter, key_hash)
);
CREATE INDEX IF NOT EXISTS rate_limit_windows_expires_idx
  ON rate_limit_windows (expires_at);
