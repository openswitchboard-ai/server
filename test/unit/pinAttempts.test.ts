/**
 * THE PIN LOCKOUT HOLDS UNDER A BURST (28 September 2026).
 *
 * The count used to be read, the PIN checked, and the count written back, so
 * ten guesses sent at once all read the same count and all ten were checked.
 * Each attempt now takes its place in the count first, in one statement that
 * also refuses while a lock stands, and the attempt that reaches the fifth
 * failure sets the lock in the same write.
 *
 * The fake below runs that statement the way PostgreSQL would: each call is
 * one atomic step against one row.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import {
  COUNT_PIN_ATTEMPT_SQL,
  PIN_MAX_ATTEMPTS,
  RESET_PIN_ATTEMPTS_SQL,
  hashPin,
  lockoutMinutes,
  verifyPinAttempt,
} from '../../src/counter/pin.js';

const ACCOUNT = 'acct-pin';
const PIN = '739104';
let hash: string;

interface Row {
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
  pin_money_from: Date | null;
}
let row: Row;
let statements: string[];

function fakePool() {
  return {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql === COUNT_PIN_ATTEMPT_SQL) {
        // One atomic step: refuse while locked, else count and maybe lock.
        if (!row.pin_hash) return { rows: [], rowCount: 0 };
        if (row.pin_locked_until && row.pin_locked_until > new Date()) return { rows: [], rowCount: 0 };
        row.pin_failed_attempts += 1;
        if (row.pin_failed_attempts >= PIN_MAX_ATTEMPTS) {
          row.pin_locked_until = new Date(
            Date.now() + lockoutMinutes(row.pin_failed_attempts) * 60_000,
          );
        }
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql === RESET_PIN_ATTEMPTS_SQL) {
        row.pin_failed_attempts = 0;
        row.pin_locked_until = null;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT pin_hash, pin_locked_until FROM accounts/.test(sql)) {
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as any;
}

beforeAll(async () => {
  hash = await hashPin(PIN);
});

beforeEach(() => {
  row = { pin_hash: hash, pin_failed_attempts: 0, pin_locked_until: null, pin_money_from: null };
  statements = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

describe('the statement', () => {
  it('counts, locks and refuses in one write, and hands back what the check needs', () => {
    expect(COUNT_PIN_ATTEMPT_SQL).toMatch(/SET pin_failed_attempts = pin_failed_attempts \+ 1/);
    expect(COUNT_PIN_ATTEMPT_SQL).toMatch(/pin_locked_until = CASE/);
    expect(COUNT_PIN_ATTEMPT_SQL).toMatch(/AND \(pin_locked_until IS NULL OR pin_locked_until <= now\(\)\)/);
    expect(COUNT_PIN_ATTEMPT_SQL).toMatch(/RETURNING pin_hash, pin_failed_attempts, pin_locked_until, pin_money_from/);
    // The backoff in SQL is the backoff in code: 1, 2, 4 … capped at 60.
    expect(COUNT_PIN_ATTEMPT_SQL).toContain(`LEAST(60, power(2, GREATEST(0, pin_failed_attempts + 1 - ${PIN_MAX_ATTEMPTS})))`);
  });

  it('never reads the count and writes it back', async () => {
    await verifyPinAttempt(ACCOUNT, '000000');
    expect(statements.some((s) => /SELECT pin_hash, pin_failed_attempts/.test(s))).toBe(false);
    expect(statements.some((s) => /SET pin_failed_attempts = \$2/.test(s))).toBe(false);
  });
});

describe('a burst of guesses', () => {
  it('ten at once: five are checked, the fifth locks, and the rest never reach the PIN', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyPinAttempt(ACCOUNT, '000000')),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.filter((r) => r.locked).length).toBeGreaterThanOrEqual(6);
    expect(row.pin_failed_attempts).toBe(PIN_MAX_ATTEMPTS);
    expect(row.pin_locked_until).not.toBeNull();
  });

  it('the right PIN, once locked, waits like any other', async () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) await verifyPinAttempt(ACCOUNT, '000000');
    const r = await verifyPinAttempt(ACCOUNT, PIN);
    expect(r.ok).toBe(false);
    expect(r.locked).toBe(true);
    expect(r.retryAfterS).toBeGreaterThan(0);
  });

  it('the right PIN before the lock clears the count', async () => {
    await verifyPinAttempt(ACCOUNT, '000000');
    await verifyPinAttempt(ACCOUNT, '000000');
    const r = await verifyPinAttempt(ACCOUNT, PIN);
    expect(r.ok).toBe(true);
    expect(row.pin_failed_attempts).toBe(0);
    expect(row.pin_locked_until).toBeNull();
  });

  it('the right PIN on the fifth try still works, and leaves no lock behind', async () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) await verifyPinAttempt(ACCOUNT, '000000');
    const r = await verifyPinAttempt(ACCOUNT, PIN);
    expect(r.ok).toBe(true);
    expect(row.pin_locked_until).toBeNull();
  });

  it('says when a PIN set by an emailed code counts in full', async () => {
    row.pin_money_from = new Date(Date.now() + 3_600_000);
    const r = await verifyPinAttempt(ACCOUNT, PIN);
    expect(r.ok).toBe(true);
    expect(r.heldUntil).toEqual(row.pin_money_from);
  });

  it('an account with no PIN is refused and nothing is counted', async () => {
    row.pin_hash = null;
    const r = await verifyPinAttempt(ACCOUNT, PIN);
    expect(r).toEqual({ ok: false });
    expect(row.pin_failed_attempts).toBe(0);
  });
});
