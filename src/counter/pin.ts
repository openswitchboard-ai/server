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

/** How long a PIN set by emailed-code recovery waits before it counts in full. */
export const RECOVERED_PIN_HOLD_HOURS = 24;

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
  /** Set on a PIN that emailed-code recovery put on the account and that is
   *  still waiting: it counts only as the emailed code until this moment. */
  heldUntil?: Date;
}

/**
 * THE ATTEMPT IS COUNTED BEFORE THE PIN IS CHECKED, IN ONE STATEMENT.
 *
 * The count used to be read, the PIN checked, and the count written back. Ten
 * guesses sent at once all read the same count, so all ten were checked before
 * any of them was counted, and the lock came far too late.
 *
 * Now each attempt takes its place in the count first, atomically, and the
 * statement refuses outright while a lock stands. The attempt that reaches the
 * fifth failure sets the lock in the same write, so every attempt after it in a
 * burst finds the lock and is never checked at all. A correct PIN then clears
 * the count and the lock (RESET_PIN_ATTEMPTS_SQL). The backoff in SQL is
 * lockoutMinutes above, written out: 1, 2, 4 … minutes, capped at 60.
 *
 * The SQL is exported so a test can hold it to that shape.
 */
export const COUNT_PIN_ATTEMPT_SQL = `UPDATE accounts
   SET pin_failed_attempts = pin_failed_attempts + 1,
       pin_locked_until = CASE
         WHEN pin_failed_attempts + 1 >= ${PIN_MAX_ATTEMPTS}
           THEN now() + make_interval(mins => LEAST(60, power(2, GREATEST(0, pin_failed_attempts + 1 - ${PIN_MAX_ATTEMPTS})))::int)
         ELSE pin_locked_until END
 WHERE id = $1 AND pin_hash IS NOT NULL
   AND (pin_locked_until IS NULL OR pin_locked_until <= now())
 RETURNING pin_hash, pin_failed_attempts, pin_locked_until, pin_money_from`;

export const RESET_PIN_ATTEMPTS_SQL =
  'UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1';

/**
 * Verify a PIN attempt for an account, enforcing lockout state in the DB.
 * On success the failure counter resets. On the 5th consecutive failure the
 * PIN locks (backoff grows with each further failure once the lock expires).
 */
export async function verifyPinAttempt(accountId: string, pin: string): Promise<PinCheck> {
  const pool = getPool();
  const counted = await pool.query(COUNT_PIN_ATTEMPT_SQL, [accountId]);
  const row = counted.rows[0];
  if (!row) {
    // Nothing was counted: there is no PIN, or a lock is standing. Reading it
    // back only says which, and changes nothing.
    const r = await pool.query('SELECT pin_hash, pin_locked_until FROM accounts WHERE id = $1', [
      accountId,
    ]);
    const now = r.rows[0];
    if (now?.pin_hash && now.pin_locked_until && new Date(now.pin_locked_until) > new Date()) {
      return {
        ok: false,
        locked: true,
        retryAfterS: Math.ceil((new Date(now.pin_locked_until).getTime() - Date.now()) / 1000),
      };
    }
    return { ok: false };
  }
  const ok = pinFormatOk(pin) && (await argon2.verify(row.pin_hash, pin).catch(() => false));
  if (ok) {
    await pool.query(RESET_PIN_ATTEMPTS_SQL, [accountId]);
    const held = row.pin_money_from ? new Date(row.pin_money_from) : undefined;
    return held && held > new Date() ? { ok: true, heldUntil: held } : { ok: true };
  }
  const attempts = Number(row.pin_failed_attempts);
  if (attempts >= PIN_MAX_ATTEMPTS && row.pin_locked_until) {
    return {
      ok: false,
      locked: true,
      retryAfterS: Math.max(
        1,
        Math.ceil((new Date(row.pin_locked_until).getTime() - Date.now()) / 1000),
      ),
    };
  }
  return { ok: false };
}

/**
 * The moment a PIN set by emailed-code recovery counts in full, or undefined
 * when the account's PIN is not waiting.
 */
export async function pinHeldUntil(accountId: string): Promise<Date | undefined> {
  const r = await getPool().query('SELECT pin_money_from FROM accounts WHERE id = $1', [accountId]);
  const at = r.rows[0]?.pin_money_from ? new Date(r.rows[0].pin_money_from) : undefined;
  return at && at > new Date() ? at : undefined;
}

/**
 * Hold a PIN that emailed-code recovery is about to set. Written BEFORE the PIN
 * itself, so there is never a moment when the new PIN stands unheld; a hold on
 * an account whose PIN then failed to save holds nothing.
 */
export async function holdRecoveredPin(accountId: string): Promise<Date> {
  const r = await getPool().query(
    `UPDATE accounts SET pin_money_from = now() + make_interval(hours => $2::int)
      WHERE id = $1 RETURNING pin_money_from`,
    [accountId, RECOVERED_PIN_HOLD_HOURS],
  );
  return new Date(r.rows[0]?.pin_money_from ?? Date.now() + RECOVERED_PIN_HOLD_HOURS * 3_600_000);
}

/** A PIN set behind the account's own credential waits for nothing. */
export async function clearPinHold(accountId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET pin_money_from = NULL WHERE id = $1', [accountId]);
}
