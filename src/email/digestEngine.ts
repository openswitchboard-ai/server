/**
 * Digest engine (phase 0.E): assembles per-user email from real rows.
 *
 *  - Match summons: immediate sends fire per match (notifyMatchCreated, via
 *    the ops queue); daily/weekly settings batch the count on the matching
 *    tick; 'off' sends nothing.
 *  - Activity digest: per open card, movement in that card's (category, geo)
 *    cell — new opposite-side cards and the card's own near-misses — since
 *    the account's last digest. Cell-level counts are stated ONLY when the
 *    cell is materialised in pulse_aggregates, i.e. it clears the k-anonymity
 *    floor (k >= 10, see domain/pulse.ts). Quiet default: no activity, no
 *    email.
 *  - "Still true?" renewal: lands once per card expiry, 7 days before the
 *    account's next expiry batch. Cards whose expiry moves (amend/renew) get
 *    their notification stamp cleared and qualify again next cycle.
 *
 * Every send goes through email/send.ts (idempotent dedupe keys, suppression,
 * lint, configuration set). Counts are SQL counts — emails only ever state
 * true things from real rows.
 */
import { getPool } from '../db.js';
import { categoryLeafLabel } from '../domain/matchRules.js';
import { accountEmail } from '../domain/counterOps.js';
import {
  renderDigest,
  renderRenewal,
  renderSummons,
  type DigestItem,
  type RenewalCardItem,
} from './templates.js';
import { emailAccountContext, sendEmail } from './send.js';
import { signEmailToken } from './tokens.js';
import type { Config } from '../config.js';

export const RENEWAL_LEAD_DAYS = 7;

type Cadence = 'daily' | 'weekly';

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function isoWeekKey(d = new Date()): string {
  // ISO 8601 week number (UTC).
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const periodKey = (cadence: Cadence) => (cadence === 'daily' ? dayKey() : isoWeekKey());

/**
 * Per-account isolation for the tick loops. One account whose send throws
 * (SES quota exhausted, throttle, bad row) must not starve every account
 * after it in the loop — in the 2026-09-01 dev incident a quota error on an
 * early account aborted the whole tick, so later accounts never even reached
 * sendEmail. Each loop catches per account, then rethrows AFTER the loop so
 * the queue job still redelivers and the failed sends retry (their 'failed'
 * rows are reclaimable — see email/send.ts), while accounts that already
 * succeeded are protected by their dedupe keys.
 */
function tickFailure(label: string, failures: number): void {
  if (failures) throw new Error(`${label}: ${failures} account(s) failed (will redeliver)`);
}

function logAccountFailure(label: string, accountId: string, e: any): void {
  // eslint-disable-next-line no-console
  console.error(
    `${label}: account ${accountId} failed (retries on redelivery): ${e?.message ?? e}`,
  );
}

// ---------------------------------------------------------------------------
// Immediate match summons (ops op 'match-notify', enqueued by the matcher).
// ---------------------------------------------------------------------------
export async function notifyMatchCreated(cfg: Config, matchId: string): Promise<void> {
  const r = await getPool().query(
    `SELECT account_want, account_have, category FROM matches WHERE id = $1`,
    [matchId],
  );
  const m = r.rows[0];
  if (!m) return; // match vanished (withdrawn card cleanup) — nothing to say
  let failures = 0;
  for (const accountId of [m.account_want, m.account_have]) {
    try {
      const ctx = await emailAccountContext(cfg, accountId);
      if (ctx.freqMatches !== 'immediate') continue; // batched or off, by choice
      const to = await accountEmail(accountId, 'match-summons');
      if (!to) continue;
      await sendEmail(cfg, {
        to,
        accountId,
        template: 'summons',
        kind: 'bulk',
        dedupeKey: `summons:${matchId}:${accountId}`,
        content: renderSummons(
          {
            count: 1,
            categoryLabel: ctx.blind ? undefined : categoryLeafLabel(m.category),
            blind: ctx.blind,
            counterUrl: `${cfg.counterOrigin}/`,
          },
          ctx.links,
        ),
      });
    } catch (e: any) {
      failures++;
      logAccountFailure('match-notify', accountId, e);
    }
  }
  tickFailure('match-notify', failures);
}

// ---------------------------------------------------------------------------
// Batched summons for accounts on daily/weekly match frequency.
// ---------------------------------------------------------------------------
export async function runSummonsBatch(cfg: Config, cadence: Cadence): Promise<number> {
  const pool = getPool();
  const accounts = await pool.query(
    `SELECT id FROM accounts WHERE status = 'active' AND email_freq_matches = $1`,
    [cadence],
  );
  let sent = 0;
  let failures = 0;
  for (const { id: accountId } of accounts.rows) {
    try {
      const since = await pool.query(
        `SELECT COALESCE(email_last_summons_batch_at, created_at) AS since
         FROM accounts WHERE id = $1`,
        [accountId],
      );
      const c = await pool.query(
        `SELECT count(*)::int AS n FROM matches
         WHERE (account_want = $1 OR account_have = $1)
           AND state = 'open' AND created_at > $2`,
        [accountId, since.rows[0].since],
      );
      const n: number = c.rows[0].n;
      if (n === 0) continue; // quiet default
      const ctx = await emailAccountContext(cfg, accountId);
      const to = await accountEmail(accountId, 'match-summons-batch');
      if (!to) continue;
      const outcome = await sendEmail(cfg, {
        to,
        accountId,
        template: 'summons',
        kind: 'bulk',
        dedupeKey: `summons-batch:${cadence}:${accountId}:${periodKey(cadence)}`,
        content: renderSummons(
          { count: n, blind: ctx.blind, counterUrl: `${cfg.counterOrigin}/` },
          ctx.links,
        ),
      });
      if (outcome.status === 'sent' || outcome.status === 'sandbox-rejected' || outcome.status === 'duplicate') {
        await pool.query(`UPDATE accounts SET email_last_summons_batch_at = now() WHERE id = $1`, [
          accountId,
        ]);
        if (outcome.status === 'sent') sent++;
      }
    } catch (e: any) {
      failures++;
      logAccountFailure(`summons-batch:${cadence}`, accountId, e);
    }
  }
  tickFailure(`summons-batch:${cadence}`, failures);
  return sent;
}

// ---------------------------------------------------------------------------
// Activity digest.
// ---------------------------------------------------------------------------
async function assembleDigestItems(
  accountId: string,
  since: Date,
): Promise<DigestItem[]> {
  const pool = getPool();
  const cards = await pool.query(
    `SELECT id, type, category, geo->>'bucket' AS geo_bucket
     FROM cards
     WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
       AND NOT paused_by_kill_switch
     ORDER BY created_at`,
    [accountId],
  );
  const items: DigestItem[] = [];
  for (const card of cards.rows) {
    const opposite = card.type === 'WANT' ? 'HAVE' : 'WANT';
    // K-FLOOR: state a cell-level count only when the cell is materialised
    // in pulse_aggregates (>= K_ANON open cards). Absent cell -> null.
    const cell = await pool.query(
      `SELECT 1 FROM pulse_aggregates WHERE category = $1 AND geo_bucket = $2`,
      [card.category, card.geo_bucket],
    );
    let newOpposite: number | null = null;
    if (cell.rowCount) {
      const c = await pool.query(
        `SELECT count(*)::int AS n FROM cards
         WHERE lifecycle_state = 'PUBLISHED' AND expires_at > now()
           AND NOT paused_by_kill_switch
           AND type = $1 AND category = $2 AND geo->>'bucket' = $3
           AND account_id <> $4 AND created_at > $5`,
        [opposite, card.category, card.geo_bucket, accountId, since],
      );
      newOpposite = c.rows[0].n;
    }
    const nm = await pool.query(
      `SELECT count(*)::int AS n FROM near_misses
       WHERE (card_want = $1 OR card_have = $1) AND created_at > $2`,
      [card.id, since],
    );
    const nearMisses: number = nm.rows[0].n;
    if ((newOpposite ?? 0) > 0 || nearMisses > 0) {
      items.push({ type: card.type, categoryLabel: categoryLeafLabel(card.category), newOpposite, nearMisses });
    }
  }
  return items;
}

export async function runDigestTick(cfg: Config, cadence: Cadence): Promise<number> {
  const pool = getPool();
  const accounts = await pool.query(
    `SELECT id, COALESCE(email_last_digest_at, created_at) AS since
     FROM accounts WHERE status = 'active' AND email_freq_digests = $1`,
    [cadence],
  );
  let sent = 0;
  let failures = 0;
  for (const row of accounts.rows) {
    try {
      const items = await assembleDigestItems(row.id, row.since);
      if (items.length === 0) continue; // nothing happened -> no digest
      const ctx = await emailAccountContext(cfg, row.id);
      const to = await accountEmail(row.id, 'activity-digest');
      if (!to) continue;
      const outcome = await sendEmail(cfg, {
        to,
        accountId: row.id,
        template: 'digest',
        kind: 'bulk',
        dedupeKey: `digest:${cadence}:${row.id}:${periodKey(cadence)}`,
        content: renderDigest(
          { cadence, items, blind: ctx.blind, counterUrl: `${cfg.counterOrigin}/` },
          ctx.links,
        ),
      });
      if (outcome.status === 'sent' || outcome.status === 'sandbox-rejected' || outcome.status === 'duplicate') {
        await pool.query(`UPDATE accounts SET email_last_digest_at = now() WHERE id = $1`, [row.id]);
        if (outcome.status === 'sent') sent++;
      }
    } catch (e: any) {
      failures++;
      logAccountFailure(`digest:${cadence}`, row.id, e);
    }
  }
  tickFailure(`digest:${cadence}`, failures);
  return sent;
}

// ---------------------------------------------------------------------------
// "Still true?" renewal — 7 days before the account's next expiry batch.
// ---------------------------------------------------------------------------
export async function runRenewalTick(cfg: Config): Promise<number> {
  const pool = getPool();
  const due = await pool.query(
    `SELECT DISTINCT account_id FROM cards
     WHERE lifecycle_state = 'PUBLISHED'
       AND expires_at > now()
       AND expires_at <= now() + make_interval(days => ${RENEWAL_LEAD_DAYS})
       AND renewal_notified_at IS NULL`,
  );
  let sent = 0;
  let failures = 0;
  for (const { account_id: accountId } of due.rows) {
    try {
      const status = await pool.query(`SELECT status FROM accounts WHERE id = $1`, [accountId]);
      if (status.rows[0]?.status !== 'active') continue;
      const cards = await pool.query(
        `SELECT id, type, category, expires_at,
                (expires_at <= now() + make_interval(days => ${RENEWAL_LEAD_DAYS})) AS expiring_soon
         FROM cards
         WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
         ORDER BY expires_at`,
        [accountId],
      );
      const expiring = cards.rows.filter((c: any) => c.expiring_soon);
      if (!expiring.length) continue;
      const ctx = await emailAccountContext(cfg, accountId);
      const to = await accountEmail(accountId, 'renewal');
      if (!to) continue;
      const items: RenewalCardItem[] = cards.rows.map((c: any) => ({
        type: c.type,
        categoryLabel: categoryLeafLabel(c.category),
        expiresAt: new Date(c.expires_at),
        expiringSoon: !!c.expiring_soon,
      }));
      const renewAllUrl = `${cfg.counterOrigin}/renew?t=${encodeURIComponent(
        signEmailToken(accountId, 'renew-all'),
      )}`;
      const outcome = await sendEmail(cfg, {
        to,
        accountId,
        template: 'renewal',
        kind: 'bulk',
        dedupeKey: `renewal:${accountId}:${expiring[0].id}`,
        content: renderRenewal(
          { cards: items, renewAllUrl, blind: ctx.blind, counterUrl: `${cfg.counterOrigin}/` },
          ctx.links,
        ),
      });
      if (outcome.status !== 'failed') {
        await pool.query(
          `UPDATE cards SET renewal_notified_at = now()
           WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED'
             AND expires_at > now()
             AND expires_at <= now() + make_interval(days => ${RENEWAL_LEAD_DAYS})
             AND renewal_notified_at IS NULL`,
          [accountId],
        );
        if (outcome.status === 'sent') sent++;
      }
    } catch (e: any) {
      failures++;
      logAccountFailure('renewal', accountId, e);
    }
  }
  tickFailure('renewal', failures);
  return sent;
}
