/**
 * HOW LONG A REPORT AND A SAFETY FLAG ARE KEPT (founder decision, 28 September
 * 2026; migrations/059_safety_retention.sql).
 *
 * Twelve months from the day it was made. After that the daily sweep deletes
 * it, unless one of these is true:
 *
 *   referred      an operator wrote down that they referred it to police, or
 *                 the photo held behind the same introduction was referred.
 *   lawful hold   a preservation date is on the row itself, or on any ledger
 *                 entry behind the same introduction.
 *   suspension    it belongs to an active suspension: an account it names is
 *                 suspended right now. When the suspension is lifted, the
 *                 ordinary rule takes over again on the next sweep.
 *
 * DELETED RATHER THAN ANONYMISED. Nothing references either table by key: a
 * held photo and a ledger entry point at an introduction, never at a report or
 * a review. So the row goes whole, and nothing is left half-kept.
 *
 * What a report did when it was filed stays done. The pairing it muted stays
 * muted (match_mutes), and the introduction it closed stays closed: those are
 * the two people's own state, and this sweep is about the record of the
 * report.
 *
 * Counts only. The sweep reads ids and dates, and there are no words on a
 * review row to read in any case.
 */
import { getPool } from '../db.js';

/** Twelve months, as decided. */
export const SAFETY_RECORD_RETENTION_MONTHS = 12;

const AGE = `created_at < now() - interval '${SAFETY_RECORD_RETENTION_MONTHS} months'`;

/** A preservation date on any ledger entry behind the same introduction. */
const LEDGER_HOLD = (alias: string) => `EXISTS (SELECT 1 FROM ledger_entries l
      WHERE ${alias}.match_id IS NOT NULL AND l.match_id = ${alias}.match_id
        AND l.preserved_until IS NOT NULL AND l.preserved_until >= now())`;

/** The photo held behind the same introduction was referred. */
const PHOTO_REFERRED = (alias: string) => `EXISTS (SELECT 1 FROM photo_quarantine q
      WHERE ${alias}.match_id IS NOT NULL AND q.match_id = ${alias}.match_id
        AND q.status = 'referred')`;

/** What keeps a report past its twelve months. */
export const REPORT_KEEP_SQL = `(r.referred_at IS NOT NULL
    OR ${PHOTO_REFERRED('r')}
    OR (r.preserved_until IS NOT NULL AND r.preserved_until >= now())
    OR ${LEDGER_HOLD('r')}
    OR EXISTS (SELECT 1 FROM accounts a
                WHERE a.id IN (r.reported_account, r.reporter_account)
                  AND a.suspended_at IS NOT NULL))`;

/** What keeps a safety review past its twelve months. */
export const REVIEW_KEEP_SQL = `(s.referred_at IS NOT NULL
    OR ${PHOTO_REFERRED('s')}
    OR (s.preserved_until IS NOT NULL AND s.preserved_until >= now())
    OR ${LEDGER_HOLD('s')}
    OR EXISTS (SELECT 1 FROM accounts a
                WHERE a.suspended_at IS NOT NULL
                  AND (a.id = s.sender_account
                       OR a.id IN (SELECT m.account_want FROM matches m WHERE m.id = s.match_id
                                   UNION ALL
                                   SELECT m.account_have FROM matches m WHERE m.id = s.match_id))))`;

export const REPORTS_SWEEP_SQL = `DELETE FROM reports WHERE id IN (
   SELECT r.id FROM reports r WHERE r.${AGE} AND NOT ${REPORT_KEEP_SQL} LIMIT 1000)`;

export const REVIEWS_SWEEP_SQL = `DELETE FROM safety_reviews WHERE id IN (
   SELECT s.id FROM safety_reviews s WHERE s.${AGE} AND NOT ${REVIEW_KEEP_SQL} LIMIT 1000)`;

/** Past twelve months and kept: counted and said out loud, both tables. */
export const KEPT_PAST_RETENTION_SQL = `SELECT
   (SELECT count(*)::int FROM reports r WHERE r.${AGE} AND ${REPORT_KEEP_SQL}) AS reports,
   (SELECT count(*)::int FROM safety_reviews s WHERE s.${AGE} AND ${REVIEW_KEEP_SQL}) AS reviews`;

export interface SafetyRecordRow {
  created_at: Date;
  referred_at?: Date | null;
  preserved_until?: Date | null;
  /** The photo behind the same introduction was referred. */
  photo_referred?: boolean;
  /** A ledger entry behind the same introduction is under a preservation date. */
  has_ledger_hold?: boolean;
  /** An account the row names is suspended right now. */
  active_suspension?: boolean;
}

/** Twelve calendar months before `now`, the way Postgres counts them. */
export function retentionCutoff(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - SAFETY_RECORD_RETENTION_MONTHS);
  return d;
}

/** Whether something keeps this row past its twelve months. The same rule as the SQL. */
export function isKeptPastRetention(row: SafetyRecordRow, now: Date): boolean {
  if (row.referred_at || row.photo_referred) return true;
  if (row.preserved_until && row.preserved_until >= now) return true;
  return Boolean(row.has_ledger_hold || row.active_suspension);
}

/** The same rule as the sweep, in JavaScript, so the suite can state it against rows. */
export function isSafetyRecordDue(row: SafetyRecordRow, now: Date): boolean {
  if (row.created_at >= retentionCutoff(now)) return false;
  return !isKeptPastRetention(row, now);
}

function retentionLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * Delete what is past twelve months and may go; count what is past twelve
 * months and is kept. Counts only.
 */
export async function sweepSafetyRecords(): Promise<{
  reports: number;
  reviews: number;
  kept_reports: number;
  kept_reviews: number;
}> {
  const pool = getPool();
  const reports = (await pool.query(REPORTS_SWEEP_SQL)).rowCount ?? 0;
  const reviews = (await pool.query(REVIEWS_SWEEP_SQL)).rowCount ?? 0;
  if (reports || reviews) retentionLog('safety-records-swept', { reports, reviews });
  const kept = (await pool.query(KEPT_PAST_RETENTION_SQL)).rows[0] ?? {};
  const kept_reports = Number(kept.reports ?? 0);
  const kept_reviews = Number(kept.reviews ?? 0);
  if (kept_reports || kept_reviews) {
    retentionLog('safety-records-kept', { reports: kept_reports, reviews: kept_reviews });
  }
  return { reports, reviews, kept_reports, kept_reviews };
}

// ---------------------------------------------------------------------------
// The two marks an operator writes (scripts/safety/hold.mts). Dates and ids
// only; nothing is read.

export type SafetyRecordTable = 'reports' | 'safety_reviews';

/**
 * An operator has referred it to police. THE REFERRAL IS THEIR ACT: nothing
 * here contacts anybody, and this only writes down that a person did.
 */
export async function markReferred(table: SafetyRecordTable, id: string): Promise<boolean> {
  const t = table === 'reports' ? 'reports' : 'safety_reviews';
  const r = await getPool().query(
    `UPDATE ${t} SET referred_at = now() WHERE id = $1 AND referred_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** A lawful request asks for it to be kept. A date moves; nothing is read. */
export async function preserveSafetyRecord(
  table: SafetyRecordTable,
  id: string,
  until: Date,
): Promise<boolean> {
  const t = table === 'reports' ? 'reports' : 'safety_reviews';
  const r = await getPool().query(
    `UPDATE ${t} SET preserved_until = $2
      WHERE id = $1 AND (preserved_until IS NULL OR preserved_until < $2)`,
    [id, until],
  );
  return (r.rowCount ?? 0) > 0;
}
