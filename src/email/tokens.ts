/**
 * Signed email action tokens: unsubscribe (RFC 8058 one-click) and renew-all.
 * Stateless HMAC (the counter link key), bound to account + purpose + expiry:
 *   osb_em_<base64url(accountId|purpose|expEpoch[|jti])>.<base64url(hmac)>
 * The unsubscribe token gets a long life (60 days — the life of the emails it
 * rides in); renew-all lives 14 days.
 *
 * ONE OF THEM IS SINGLE USE. Unsubscribing twice is unsubscribing once, so
 * that token stays stateless and keeps working however often a mail client
 * tries it. Renewing is not like that: it restarts the clock on every want and
 * have the account holds, so fourteen days of unlimited presses was fourteen
 * days in which a forwarded email could keep somebody's postings alive without
 * them. A renew-all token carries a jti, and the press spends it.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { counterKeys } from '../counter/keys.js';

export type EmailTokenPurpose = 'unsubscribe' | 'renew-all';

const TTL_DAYS: Record<EmailTokenPurpose, number> = {
  unsubscribe: 60,
  'renew-all': 14,
};

/** The purposes whose tokens may be pressed exactly once. */
const SINGLE_USE: EmailTokenPurpose[] = ['renew-all'];

function mac(payload: string): Buffer {
  return createHmac('sha256', counterKeys().linkHmacKey)
    .update(`email-token|${payload}`)
    .digest();
}

export function signEmailToken(accountId: string, purpose: EmailTokenPurpose): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS[purpose] * 86400;
  const jti = SINGLE_USE.includes(purpose) ? `|${randomUUID()}` : '';
  const payload = `${accountId}|${purpose}|${exp}${jti}`;
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `osb_em_${body}.${mac(payload).toString('base64url')}`;
}

export function verifyEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
): { ok: boolean; accountId?: string; jti?: string; expiresAt?: Date; reason?: 'invalid' | 'expired' } {
  if (!token.startsWith('osb_em_')) return { ok: false, reason: 'invalid' };
  const [body, sig] = token.slice('osb_em_'.length).split('.');
  if (!body || !sig) return { ok: false, reason: 'invalid' };
  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const [accountId, tokenPurpose, expStr, jti] = payload.split('|');
  if (!accountId || tokenPurpose !== purpose || !expStr) return { ok: false, reason: 'invalid' };
  const expected = mac(payload);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  if (Number(expStr) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, accountId, jti, expiresAt: new Date(Number(expStr) * 1000) };
}

/**
 * Spend a single-use token. True the first time and false every time after.
 *
 * A token with no jti was minted before they existed and is let through: the
 * renew-all link lives fourteen days, so the ones already in people's inboxes
 * age out on their own rather than dying the day this ships.
 */
export async function consumeEmailToken(v: {
  accountId?: string;
  jti?: string;
  expiresAt?: Date;
  purpose: EmailTokenPurpose;
}): Promise<boolean> {
  if (!v.jti) return true;
  const r = await getPool().query(
    `INSERT INTO consumed_email_tokens (jti, purpose, account_id, expires_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT (jti) DO NOTHING RETURNING jti`,
    [v.jti, v.purpose, v.accountId ?? null, v.expiresAt ?? new Date()],
  );
  return !!r.rowCount;
}
