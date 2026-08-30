import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import type { Quotas } from '../config.js';

/** Throws QUOTA_EXCEEDED when a publish would exceed newcomer quotas. */
export async function checkPublishQuota(accountId: string, q: Quotas): Promise<void> {
  const pool = getPool();
  const open = await pool.query(
    `SELECT count(*)::int AS n FROM cards
     WHERE account_id = $1 AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')`,
    [accountId],
  );
  if (open.rows[0].n >= q.maxOpenCards) {
    throw new OsbError('QUOTA_EXCEEDED', {
      human_action: `You have ${open.rows[0].n} open intents (limit ${q.maxOpenCards}). Withdraw one to post another.`,
    });
  }
  const day = await pool.query(
    `SELECT count(*)::int AS n FROM publish_events
     WHERE account_id = $1 AND created_at > now() - interval '24 hours'`,
    [accountId],
  );
  if (day.rows[0].n >= q.maxPublishesPerDay) {
    throw new OsbError('QUOTA_EXCEEDED', { retry_after: 3600 });
  }
}

/** Throws RATE_LIMITED_OFFERS when the account exceeds the hourly offer rate. */
export async function checkOfferRate(accountId: string, q: Quotas): Promise<void> {
  const r = await getPool().query(
    `SELECT count(*)::int AS n FROM offers
     WHERE proposer_account = $1 AND created_at > now() - interval '1 hour'`,
    [accountId],
  );
  if (r.rows[0].n >= q.maxOffersPerHour) {
    throw new OsbError('RATE_LIMITED_OFFERS', { retry_after: 3600 });
  }
}

/** Anti-probing rail: max 3 offers per side per MATCH per rolling 24h. */
export const MAX_OFFERS_PER_MATCH_PER_DAY = 3;

export async function checkPerMatchOfferRate(accountId: string, matchId: string): Promise<void> {
  const r = await getPool().query(
    `SELECT count(*)::int AS n,
            min(created_at) AS oldest
     FROM offers
     WHERE proposer_account = $1 AND match_id = $2
       AND created_at > now() - interval '24 hours'`,
    [accountId, matchId],
  );
  if (r.rows[0].n >= MAX_OFFERS_PER_MATCH_PER_DAY) {
    const oldest = new Date(r.rows[0].oldest).getTime();
    const retry = Math.max(60, Math.ceil((oldest + 86_400_000 - Date.now()) / 1000));
    throw new OsbError('RATE_LIMITED_OFFERS', { retry_after: retry });
  }
}
