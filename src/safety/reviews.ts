/**
 * What a flagged message does, and what it deliberately does not do
 * (docs/trust-and-safety.md, "The checks" — grooming, exploitation, threats —
 * and step 7 of the build sequence).
 *
 * The classifier in intake/checks/messageSafety.ts has said a message may be
 * grooming, exploitation, a threat, a conversation with a child in it, or a
 * sender at risk. Three things happen here, and one thing does not.
 *
 *   ROW      a `safety_reviews` row is opened: the introduction, the sender,
 *            the ledger entry holding the words, and the flag names. Never the
 *            words themselves.
 *   PRESERVE every ledger entry behind that introduction is held ninety days,
 *            by the same helper a report uses, for the same reason: the
 *            evidence has to outlive the thirty-day sweep and still be there
 *            when a person gets to it.
 *   TELL     one line at warn, carrying the review id and the introduction id
 *            and nothing else — the same shape the report path logs
 *            (src/safety/reports.ts, reportLogLine). No words, ever.
 *
 * AND THE MESSAGE IS STILL DELIVERED. That is the thing this file does not do.
 * A hold at the message door is a flag for review, never a stall: the person
 * on the other side is waiting for a reply, the fast screen is wrong far more
 * often than it is right at this door, and silently ghosting a conversation on
 * its word would be its own harm. The send path (domain/channel.ts) throws on
 * a refusal and carries on through a hold, which is exactly the behaviour this
 * step wants and the reason this check never refuses.
 *
 * NOTHING HERE READS ANYTHING. Like the preserve half of a lawful request, it
 * moves dates and writes ids. The words are read only through the two-keyholder
 * export ceremony (scripts/safety/export.mts).
 */
import { getPool } from '../db.js';
import { preserveEntriesForMatch } from './ledger.js';
import {
  SAFETY_REVIEW_REASON,
  flagsFromDetail,
  type SafetyFlagName,
} from '../intake/checks/messageSafety.js';
import type { IntakeItem, Verdict } from '../intake/types.js';

/**
 * The same ninety days a report holds for, and the same helper. A flag raised
 * by a machine and a flag raised by a frightened human are the same kind of
 * thing to the evidence store, and there is one number for both.
 */
export const REVIEW_PRESERVE_DAYS = 90;

/** The line the operator gets. No content, ever — an id and an id. */
export function safetyReviewLogLine(reviewId: string, matchId: string | null): string {
  return JSON.stringify({ event: 'safety-review', review_id: reviewId, match_id: matchId });
}

const uuidOrNull = (v: string | undefined): string | null =>
  v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

export interface ReviewOutcome {
  review_id: string;
  flags: SafetyFlagName[];
  preserved: number;
}

/** Whether this verdict is the one this file exists for. */
export function isSafetyReviewVerdict(verdict: Verdict): boolean {
  return verdict.outcome === 'hold' && verdict.reason_code === SAFETY_REVIEW_REASON;
}

/**
 * Open one. Called from the pipe, straight after the ledger write, because the
 * ledger entry id is the one thing this row needs that only the pipe has.
 *
 * It throws nothing back at its caller that the caller should act on: the
 * message is already through, and there is nothing useful to do with a failure
 * here except say so. The pipe swallows it for the same reason it swallows a
 * ledger failure — losing a flag is bad, and refusing to carry a conversation
 * because the flag would not insert is worse.
 */
export async function openSafetyReview(
  item: IntakeItem,
  verdict: Verdict,
  ledgerEntryId: string | undefined,
  opts: { warn?: (line: string) => void } = {},
): Promise<ReviewOutcome> {
  const deciding = verdict.checks.find(
    (c) => c.outcome === 'hold' && c.reason_code === SAFETY_REVIEW_REASON,
  );
  const flags = flagsFromDetail(deciding?.detail);

  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO safety_reviews (match_id, sender_account, ledger_entry_id, flags)
     VALUES ($1, $2, $3, $4::text[])
     RETURNING id`,
    [
      uuidOrNull(item.match_id),
      uuidOrNull(item.sender_account),
      uuidOrNull(ledgerEntryId),
      flags,
    ],
  );
  const reviewId = inserted.rows[0].id as string;

  // PRESERVE. A date moves; nothing is read, and no keyholder is involved.
  let preserved = 0;
  if (item.match_id) {
    const until = new Date(Date.now() + REVIEW_PRESERVE_DAYS * 24 * 60 * 60 * 1000);
    ({ preserved } = await preserveEntriesForMatch(item.match_id, until));
  }

  // TELL THE OPERATOR. Two ids at warn, and not one word of what was said.
  (opts.warn ?? ((line: string) => console.warn(line)))(
    safetyReviewLogLine(reviewId, item.match_id ?? null),
  );

  return { review_id: reviewId, flags, preserved };
}

// ---------------------------------------------------------------------------
// What the operator's script reads and writes (scripts/safety/reviews.mts).
// Ids, flags and ages. There is no content here to return and no query in this
// module that could reach any.

export interface OpenReviewRow {
  id: string;
  match_id: string | null;
  sender_account: string | null;
  ledger_entry_id: string | null;
  flags: string[];
  created_at: Date;
}

/** Oldest first: what has been waiting longest for a person is what matters. */
export async function listOpenReviews(limit = 50): Promise<OpenReviewRow[]> {
  const r = await getPool().query(
    `SELECT id, match_id, sender_account, ledger_entry_id, flags, created_at
       FROM safety_reviews WHERE status = 'open'
      ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return r.rows as OpenReviewRow[];
}

/** Close one, either way. No resolution words: this table holds no free text. */
export async function resolveReview(
  id: string,
  status: 'reviewed' | 'dismissed',
): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE safety_reviews SET status = $2, resolved_at = now()
      WHERE id = $1 AND status = 'open'`,
    [id, status],
  );
  return (r.rowCount ?? 0) > 0;
}
