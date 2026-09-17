import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import type { Quotas } from '../config.js';

/**
 * A wait, in words an agent can hand straight to its human. A bare
 * retry_after invites the model to do clock arithmetic out loud ("around
 * 10:10 UTC"), so every throttle error carries the rough, relative phrase
 * alongside the machine-readable seconds.
 */
export function roughWait(seconds: number): string {
  if (seconds <= 120) return 'in a minute or two';
  if (seconds <= 50 * 60) return `in about ${Math.max(5, Math.round(seconds / 300) * 5)} minutes`;
  if (seconds <= 90 * 60) return 'in about an hour';
  return 'in a few hours';
}

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
      human_action: `You have ${open.rows[0].n} open wants and haves (limit ${q.maxOpenCards}). Withdraw one to post another.`,
    });
  }
  const day = await pool.query(
    `SELECT count(*)::int AS n FROM publish_events
     WHERE account_id = $1 AND created_at > now() - interval '24 hours'`,
    [accountId],
  );
  if (day.rows[0].n >= q.maxPublishesPerDay) {
    throw new OsbError('QUOTA_EXCEEDED', {
      retry_after: 3600,
      human_action: `That is the day's posting done. Try again ${roughWait(3600)} — nothing your human needs to do, and no clock time to pass on.`,
    });
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
    throw new OsbError('RATE_LIMITED_OFFERS', {
      retry_after: 3600,
      human_action: `Offers are paced. Send the next one ${roughWait(3600)} — nothing your human needs to do.`,
    });
  }
}

/**
 * One ceiling shared by the read tools — check_in, channel_receive and
 * list_intents — of 60 calls per account per rolling hour, all three together.
 * Held in the database because prod runs several tasks: a per-process window
 * would be a per-process ceiling and the account would get one per replica.
 *
 * One statement: prune what has fallen out of the window, count what is still
 * in it, and record this call only if it fits. The CTEs share one snapshot, so
 * the count is of the window rather than of the table.
 */
export const MAX_READS_PER_HOUR = 60;

export async function checkReadRate(accountId: string): Promise<void> {
  const r = await getPool().query(
    `WITH pruned AS (
       DELETE FROM read_calls
        WHERE account_id = $1 AND called_at <= now() - interval '1 hour'
     ), live AS (
       SELECT count(*)::int AS n, min(called_at) AS oldest
         FROM read_calls
        WHERE account_id = $1 AND called_at > now() - interval '1 hour'
     ), recorded AS (
       INSERT INTO read_calls (account_id)
       SELECT $1 FROM live WHERE live.n < $2
     )
     SELECT n, oldest FROM live`,
    [accountId, MAX_READS_PER_HOUR],
  );
  if (r.rows[0].n < MAX_READS_PER_HOUR) return;
  // The window frees as its oldest call ages out, so that is when to come back.
  const oldest = new Date(r.rows[0].oldest).getTime();
  const retry = Math.max(1, Math.ceil((oldest + 3_600_000 - Date.now()) / 1000));
  throw new OsbError('RATE_LIMITED', {
    retry_after: retry,
    human_action: `Checking is paced. Come back ${roughWait(retry)} — quietly, with nothing to tell your human and no clock time to pass on.`,
  });
}

/**
 * AND ONE SHARED CEILING OVER THE WRITE TOOLS (2026-09-17 audit).
 *
 * Migration 011 capped reading and nothing capped writing. Every write tool had
 * a limit of its own, and every one of those limits was scoped to something
 * smaller than the account: offers per hour per account, publishes per day,
 * messages per channel per hour. An agent holding introductions on ten
 * conversations could send six hundred messages an hour inside the rules —
 * every one of them a model call and a ledger row — and nothing anywhere was
 * counting the ACCOUNT.
 *
 * This sits above the per-thing limits rather than replacing any of them: how
 * fast one conversation may move is a different question from how much one
 * account may do in an hour. It is deliberately generous, so that only a
 * runaway meets it and nobody doing something a human asked for ever does.
 *
 * `wait_for_press` is not counted, for the reason it is not counted against the
 * read ceiling either (see READ_TOOLS in src/mcp/tools.ts); what stops a
 * thousand waits is a different rail, and it is in that file.
 *
 * Same one statement as checkReadRate: prune what has fallen out of the window,
 * count what is still in it, record this call only if it fits.
 */
export const MAX_WRITES_PER_HOUR = 300;

export async function checkWriteRate(accountId: string, q?: Quotas): Promise<void> {
  const cap = q?.maxWritesPerHour ?? MAX_WRITES_PER_HOUR;
  const r = await getPool().query(
    `WITH pruned AS (
       DELETE FROM write_calls
        WHERE account_id = $1 AND called_at <= now() - interval '1 hour'
     ), live AS (
       SELECT count(*)::int AS n, min(called_at) AS oldest
         FROM write_calls
        WHERE account_id = $1 AND called_at > now() - interval '1 hour'
     ), recorded AS (
       INSERT INTO write_calls (account_id)
       SELECT $1 FROM live WHERE live.n < $2
     )
     SELECT n, oldest FROM live`,
    [accountId, cap],
  );
  // The aggregate above always returns exactly one row against a real
  // database, so no row at all means there is no window here to count — a
  // stood-in pool in the suite. Read as empty rather than as full: a rail that
  // shut every door whenever its own table was unreachable would be a worse
  // failure than the one it guards against.
  const n = Number(r.rows[0]?.n ?? 0);
  if (n < cap) return;
  const oldest = new Date(r.rows[0].oldest).getTime();
  const retry = Math.max(1, Math.ceil((oldest + 3_600_000 - Date.now()) / 1000));
  throw new OsbError('RATE_LIMITED', {
    retry_after: retry,
    human_action: `That is a great deal of activity on this account in one hour, so the switchboard is pacing it. Come back ${roughWait(retry)} — nothing your human needs to do.`,
  });
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
    throw new OsbError('RATE_LIMITED_OFFERS', {
      retry_after: retry,
      human_action: `That introduction has had its offers for now. Try again ${roughWait(retry)}.`,
    });
  }
}
