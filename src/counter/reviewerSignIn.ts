/**
 * Directory-reviewer sign-in: an email address and a long passphrase, for the
 * one account a directory's reviewer is given (migration 070).
 *
 * WHY IT EXISTS. OpenAI's plugin review needs credentials that work with no
 * emailed code, text code or magic link, and every other way in here is an
 * emailed code or a passkey.
 *
 * WHAT KEEPS IT NARROW.
 * - Only an account with a live row answers to it; every other address at the
 *   sign-in page is sent a code exactly as before.
 * - A row stops working at enabled_until and is deleted when the review ends.
 * - Five wrong passphrases lock it for fifteen minutes, on top of the per-IP
 *   limit at the door.
 * - Signing in this way opens no PIN window: the account's PIN still approves
 *   every press, and the assistant authorisation page still asks for it.
 * - Every sign-in and every wrong passphrase is logged by the route.
 */
import argon2 from 'argon2';
import { getPool } from '../db.js';
import { findAccountByEmail } from '../domain/accounts.js';

export const REVIEWER_MAX_FAILURES = 5;
export const REVIEWER_LOCK_MINUTES = 15;
/** Shorter than this and it is not a passphrase a stranger could not guess. */
export const REVIEWER_PASSPHRASE_MIN = 24;

export interface ReviewerAccount {
  accountId: string;
  label: string;
}

/** The reviewer account behind this address, if it has a row still in date. */
export async function reviewerFor(email: string): Promise<ReviewerAccount | undefined> {
  const account = await findAccountByEmail(email);
  if (!account) return undefined;
  const r = await getPool().query(
    `SELECT account_id, label FROM reviewer_sign_ins WHERE account_id = $1 AND enabled_until > now()`,
    [(account as any).id],
  );
  const row = r.rows[0];
  return row ? { accountId: row.account_id, label: row.label } : undefined;
}

export type ReviewerCheck = { ok: true } | { ok: false; reason: 'locked' | 'wrong' | 'gone' };

/**
 * Check a passphrase. A wrong one counts towards the lock; a right one clears
 * the count and is recorded as a use.
 */
export async function checkReviewerPassphrase(accountId: string, passphrase: string): Promise<ReviewerCheck> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT passphrase_hash, locked_until FROM reviewer_sign_ins
      WHERE account_id = $1 AND enabled_until > now()`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'gone' };
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, reason: 'locked' };
  const right =
    passphrase.length >= REVIEWER_PASSPHRASE_MIN &&
    passphrase.length <= 200 &&
    (await argon2.verify(row.passphrase_hash, passphrase).catch(() => false));
  if (!right) {
    await pool.query(
      `UPDATE reviewer_sign_ins
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2
                                  THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE account_id = $1`,
      [accountId, REVIEWER_MAX_FAILURES, REVIEWER_LOCK_MINUTES],
    );
    return { ok: false, reason: 'wrong' };
  }
  await pool.query(
    `UPDATE reviewer_sign_ins
        SET failed_attempts = 0, locked_until = NULL, uses = uses + 1, last_used_at = now()
      WHERE account_id = $1`,
    [accountId],
  );
  return { ok: true };
}

/**
 * Mark an existing account as a reviewer account until `days` from now, or
 * renew it with a new passphrase hash. The hash is made by the caller: the
 * passphrase itself never reaches the server this way.
 */
export async function enableReviewer(
  email: string,
  passphraseHash: string,
  label: string,
  days: number,
): Promise<{ accountId: string } | { error: string }> {
  if (!passphraseHash.startsWith('$argon2id$')) return { error: 'not an argon2id hash' };
  if (!(days > 0 && days <= 60)) return { error: 'days must be between 1 and 60' };
  const account = await findAccountByEmail(email);
  if (!account) return { error: 'no account under that address' };
  const accountId = (account as any).id as string;
  await getPool().query(
    `INSERT INTO reviewer_sign_ins (account_id, passphrase_hash, label, enabled_until)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     ON CONFLICT (account_id) DO UPDATE
        SET passphrase_hash = EXCLUDED.passphrase_hash, label = EXCLUDED.label,
            enabled_until = EXCLUDED.enabled_until, failed_attempts = 0, locked_until = NULL`,
    [accountId, passphraseHash, label.slice(0, 60), days],
  );
  return { accountId };
}

/** End it: the row is deleted, so the address goes back to emailed codes. */
export async function disableReviewer(email: string): Promise<boolean> {
  const account = await findAccountByEmail(email);
  if (!account) return false;
  const r = await getPool().query(`DELETE FROM reviewer_sign_ins WHERE account_id = $1`, [(account as any).id]);
  return (r.rowCount ?? 0) > 0;
}
