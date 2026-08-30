/**
 * Signed email action tokens: unsubscribe (RFC 8058 one-click) and renew-all.
 * Stateless HMAC (the counter link key), bound to account + purpose + expiry:
 *   osb_em_<base64url(accountId|purpose|expEpoch)>.<base64url(hmac)>
 * The unsubscribe token gets a long life (60 days — the life of the emails it
 * rides in); renew-all lives 14 days. Tokens do nothing beyond their single
 * purpose and the actions they gate are themselves idempotent.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { counterKeys } from '../counter/keys.js';

export type EmailTokenPurpose = 'unsubscribe' | 'renew-all';

const TTL_DAYS: Record<EmailTokenPurpose, number> = {
  unsubscribe: 60,
  'renew-all': 14,
};

function mac(payload: string): Buffer {
  return createHmac('sha256', counterKeys().linkHmacKey)
    .update(`email-token|${payload}`)
    .digest();
}

export function signEmailToken(accountId: string, purpose: EmailTokenPurpose): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS[purpose] * 86400;
  const payload = `${accountId}|${purpose}|${exp}`;
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `osb_em_${body}.${mac(payload).toString('base64url')}`;
}

export function verifyEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
): { ok: boolean; accountId?: string; reason?: 'invalid' | 'expired' } {
  if (!token.startsWith('osb_em_')) return { ok: false, reason: 'invalid' };
  const [body, sig] = token.slice('osb_em_'.length).split('.');
  if (!body || !sig) return { ok: false, reason: 'invalid' };
  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const [accountId, tokenPurpose, expStr] = payload.split('|');
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
  return { ok: true, accountId };
}
