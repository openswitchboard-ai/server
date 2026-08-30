/**
 * PIN handling: argon2id at rest, 6+ digits, rate-limited — 5 wrong tries
 * lock the account's PIN with exponential backoff (1, 2, 4, ... minutes,
 * capped at 60). Verification is a sensitive-action ceremony: success grants
 * the counter session a short PIN-elevated window.
 */
import argon2 from 'argon2';
import { getPool } from '../db.js';

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_ELEVATION_MINUTES = 5;

export function pinFormatOk(pin: string): boolean {
  return /^[0-9]{6,12}$/.test(pin);
}

export async function hashPin(pin: string): Promise<string> {
  return argon2.hash(pin, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/** Backoff minutes for a given failed-attempt count (>= PIN_MAX_ATTEMPTS). */
export function lockoutMinutes(failedAttempts: number): number {
  const over = Math.max(0, failedAttempts - PIN_MAX_ATTEMPTS);
  return Math.min(60, 2 ** over);
}

export interface PinCheck {
  ok: boolean;
  locked?: boolean;
  /** When locked: seconds until another attempt is allowed. */
  retryAfterS?: number;
}

/**
 * Verify a PIN attempt for an account, enforcing lockout state in the DB.
 * On success the failure counter resets. On the 5th consecutive failure the
 * PIN locks (backoff grows with each further failure once the lock expires).
 */
export async function verifyPinAttempt(accountId: string, pin: string): Promise<PinCheck> {
  const pool = getPool();
  const r = await pool.query(
    'SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM accounts WHERE id = $1',
    [accountId],
  );
  const row = r.rows[0];
  if (!row?.pin_hash) return { ok: false };
  if (row.pin_locked_until && new Date(row.pin_locked_until) > new Date()) {
    return {
      ok: false,
      locked: true,
      retryAfterS: Math.ceil((new Date(row.pin_locked_until).getTime() - Date.now()) / 1000),
    };
  }
  const ok = pinFormatOk(pin) && (await argon2.verify(row.pin_hash, pin).catch(() => false));
  if (ok) {
    await pool.query(
      'UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1',
      [accountId],
    );
    return { ok: true };
  }
  const attempts = Number(row.pin_failed_attempts) + 1;
  const lockMinutes = attempts >= PIN_MAX_ATTEMPTS ? lockoutMinutes(attempts) : 0;
  await pool.query(
    `UPDATE accounts SET pin_failed_attempts = $2,
       pin_locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(mins => $3::int) ELSE NULL END
     WHERE id = $1`,
    [accountId, attempts, lockMinutes],
  );
  if (lockMinutes > 0) return { ok: false, locked: true, retryAfterS: lockMinutes * 60 };
  return { ok: false };
}
