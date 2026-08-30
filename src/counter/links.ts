/**
 * Approval links: single-use, 15-minute TTL, HMAC-signed, bound to
 * {account, action, amount, counterparty}.
 *
 * Token shape: `<link-id>.<base64url(hmac-sha256(key, binding))>` where the
 * binding string is `id|account_id|action|ref_id|amount|ccy|counterparty`.
 * The DB stores only sha256(token); verification recomputes the HMAC from
 * the stored row, so a link cannot be re-pointed at a different account,
 * action, amount or counterparty without failing verification.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { counterKeys } from './keys.js';

export const APPROVAL_LINK_TTL_MINUTES = 15;

export type ApprovalAction = 'offer-accept' | 'stage3-disclosure';

export interface ApprovalLinkRow {
  id: string;
  account_id: string;
  action: ApprovalAction;
  ref_id: string;
  amount: string | null;
  ccy: string | null;
  counterparty_account: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  decision: string | null;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function bindingString(row: {
  id: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | number | null;
  ccy: string | null;
  counterparty_account: string;
}): string {
  const amt = row.amount === null || row.amount === undefined ? '' : String(Number(row.amount));
  return [row.id, row.account_id, row.action, row.ref_id, amt, row.ccy ?? '', row.counterparty_account].join('|');
}

export function signLink(row: Parameters<typeof bindingString>[0], key?: Buffer): string {
  const mac = createHmac('sha256', key ?? counterKeys().linkHmacKey)
    .update(bindingString(row))
    .digest('base64url');
  return `${row.id}.${mac}`;
}

/** Create an approval link for a human. Returns the emailable token. */
export async function createApprovalLink(input: {
  accountId: string;
  action: ApprovalAction;
  refId: string;
  amount?: number | null;
  ccy?: string | null;
  counterpartyAccount: string;
}): Promise<{ token: string; id: string }> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO approval_links (token_hash, account_id, action, ref_id, amount, ccy, counterparty_account, expires_at)
     VALUES ('pending', $1,$2,$3,$4,$5,$6, now() + make_interval(mins => ${APPROVAL_LINK_TTL_MINUTES}))
     RETURNING id`,
    [
      input.accountId,
      input.action,
      input.refId,
      input.amount ?? null,
      input.ccy ?? null,
      input.counterpartyAccount,
    ],
  );
  const id = r.rows[0].id as string;
  const token = signLink({
    id,
    account_id: input.accountId,
    action: input.action,
    ref_id: input.refId,
    amount: input.amount ?? null,
    ccy: input.ccy ?? null,
    counterparty_account: input.counterpartyAccount,
  });
  await pool.query('UPDATE approval_links SET token_hash = $2 WHERE id = $1', [
    id,
    sha256hex(token),
  ]);
  return { token, id };
}

export interface LinkCheck {
  ok: boolean;
  reason?: 'not-found' | 'bad-signature' | 'expired' | 'used';
  row?: ApprovalLinkRow;
}

/**
 * Verify a token WITHOUT consuming it: row lookup by token hash, HMAC
 * recomputation over the stored binding, TTL and single-use checks.
 */
export async function verifyLinkToken(token: string): Promise<LinkCheck> {
  const id = token.split('.')[0];
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) return { ok: false, reason: 'not-found' };
  const r = await getPool().query('SELECT * FROM approval_links WHERE id = $1', [id]);
  const row: (ApprovalLinkRow & { token_hash: string }) | undefined = r.rows[0];
  if (!row) return { ok: false, reason: 'not-found' };
  const expectedToken = signLink(row);
  const a = Buffer.from(sha256hex(token), 'utf8');
  const b = Buffer.from(sha256hex(expectedToken), 'utf8');
  const c = Buffer.from(row.token_hash, 'utf8');
  if (!(a.length === b.length && timingSafeEqual(a, b) && b.length === c.length && timingSafeEqual(b, c))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (row.used_at) return { ok: false, reason: 'used', row };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired', row };
  return { ok: true, row };
}

/** Consume a link (single-use). Returns false if it was already consumed. */
export async function consumeLink(id: string): Promise<boolean> {
  const r = await getPool().query(
    'UPDATE approval_links SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
    [id],
  );
  return !!r.rowCount;
}

export async function recordLinkDecision(id: string, decision: 'approved' | 'declined'): Promise<void> {
  await getPool().query('UPDATE approval_links SET decision = $2 WHERE id = $1', [id, decision]);
}
