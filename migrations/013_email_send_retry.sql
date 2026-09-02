-- Email send retry (post-mortem of the 2026-09-01 dev SES quota exhaustion).
--
-- 'sending' becomes the in-flight marker (previously 'failed' with detail
-- 'send in flight'), so 'failed' now always means a TERMINAL failure — an SES
-- rejection such as "Daily message quota exceeded". A terminal failure no
-- longer consumes its dedupe key forever: send.ts reclaims a 'failed' row —
-- or a 'sending' row stale by 15+ minutes (a crash mid-send) — on the next
-- attempt (ON CONFLICT ... DO UPDATE, refreshing created_at), so a throttled
-- digest/renewal/summons eventually goes out instead of being silently
-- swallowed as a 'duplicate'. FRESH 'sending' rows are never reclaimed — the
-- insert/reclaim remains the idempotency lock, and a concurrent redelivery
-- still reads 'duplicate'.
ALTER TABLE email_sends DROP CONSTRAINT IF EXISTS email_sends_status_check;
ALTER TABLE email_sends ADD CONSTRAINT email_sends_status_check
  CHECK (status IN ('sent','sandbox-rejected','suppressed','failed','sending'));
