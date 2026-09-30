/**
 * The shared count behind the limiters in src/abuseLimit.ts (N11, migration
 * 062). One row per limiter and hashed key; one statement records a hit and
 * says how many hits the live window holds, so two tasks pressing the same
 * row at once are serialised by the row lock and neither loses a count.
 *
 * The window is the one the in-memory limiter always had: it opens at the
 * first hit, runs for windowMs, and the first hit after it closes opens a new
 * one at 1. The database clock decides, so every task agrees on it.
 *
 * NEVER A RAW KEY. What is stored is HMAC-SHA256 of the IP (or account id)
 * under a key HKDF-derived from the counter's link key with its own info
 * string — the same construction as the email pepper (domain/accounts.ts) and
 * independent of it. A copy of the table cannot be walked back to addresses
 * without the key, and the key is not in the database.
 *
 * RETENTION: a row outlives its window only until the next ttl-expiry tick,
 * which deletes every row whose window has closed (sweepRateLimitWindows).
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { getPool } from './db.js';
import { counterKeys } from './counter/keys.js';
import type { LimiterStore } from './abuseLimit.js';

let keyFor: { key: Buffer; hmacKey: Buffer } | undefined;

function rateLimitKey(): Buffer {
  const { linkHmacKey } = counterKeys();
  if (keyFor?.key === linkHmacKey) return keyFor.hmacKey;
  const hmacKey = Buffer.from(
    hkdfSync('sha256', linkHmacKey, Buffer.alloc(0), 'rate-limit-key-v1', 32),
  );
  keyFor = { key: linkHmacKey, hmacKey };
  return hmacKey;
}

/** The stored form of a limiter key. Bound to the limiter, so one IP's rows cannot be joined across limiters. */
export function rateLimitKeyHash(limiter: string, key: string): string {
  return createHmac('sha256', rateLimitKey()).update(`${limiter}\u0000${key}`).digest('hex');
}

/**
 * Record one hit and return the count in the live window. The CASE arms read
 * the row as it was before this statement, so an expired window is replaced
 * whole (start, count and end together) and a live one only counts up. The
 * count is capped so a flood cannot overflow the column.
 */
export const RATE_LIMIT_HIT_SQL = `INSERT INTO rate_limit_windows (limiter, key_hash, window_start, expires_at, n)
VALUES ($1, $2, now(), now() + $3::double precision * interval '1 millisecond', 1)
ON CONFLICT (limiter, key_hash) DO UPDATE SET
  window_start = CASE WHEN rate_limit_windows.expires_at <= now()
                      THEN EXCLUDED.window_start ELSE rate_limit_windows.window_start END,
  expires_at   = CASE WHEN rate_limit_windows.expires_at <= now()
                      THEN EXCLUDED.expires_at ELSE rate_limit_windows.expires_at END,
  n            = CASE WHEN rate_limit_windows.expires_at <= now()
                      THEN 1 ELSE LEAST(rate_limit_windows.n + 1, 1000000) END
RETURNING n`;

/** The live window's count, recording nothing. No row, or a closed window, is 0. */
export const RATE_LIMIT_COUNT_SQL = `SELECT n FROM rate_limit_windows
WHERE limiter = $1 AND key_hash = $2 AND expires_at > now()`;

export const postgresLimiterStore: LimiterStore = {
  async hit(limiter: string, key: string, windowMs: number): Promise<number> {
    const r = await getPool().query(RATE_LIMIT_HIT_SQL, [
      limiter,
      rateLimitKeyHash(limiter, key),
      windowMs,
    ]);
    return Number(r.rows[0]?.n);
  },
  async count(limiter: string, key: string): Promise<number> {
    const r = await getPool().query(RATE_LIMIT_COUNT_SQL, [limiter, rateLimitKeyHash(limiter, key)]);
    return r.rows.length ? Number(r.rows[0].n) : 0;
  },
};

/** The ttl-expiry sweep: every row whose window has closed. Counts only. */
export async function sweepRateLimitWindows(): Promise<{ rate_limit_windows: number }> {
  const r = await getPool().query('DELETE FROM rate_limit_windows WHERE expires_at <= now()');
  return { rate_limit_windows: r.rowCount ?? 0 };
}
