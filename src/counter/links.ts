/**
 * Approval links: single-use, 15-minute TTL, HMAC-signed, bound to
 * {account, action, ref, amount, counterparty, payload}.
 *
 * Token shape: `<link-id>.<base64url(hmac-sha256(key, binding))>` where the
 * binding string is
 * `id|account_id|action|ref_id|amount|ccy|counterparty|payload`.
 * The DB stores only sha256(token); verification recomputes the HMAC from
 * the stored row, so a link cannot be re-pointed at a different account,
 * action, amount, counterparty or set of figures without failing.
 *
 * `payload` is the canonical JSON of the figures a one-question page asks
 * about — the amount and currency of a number about to be sent, the opening
 * figure and limit about to be switched on. It is stored as the exact text
 * that was signed, so a question a person answers is the question that was
 * minted for them and nothing else.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db.js';
import { counterKeys } from './keys.js';

export const APPROVAL_LINK_TTL_MINUTES = 15;

export type ApprovalAction =
  | 'offer-accept'
  | 'stage3-disclosure'
  | 'settlement-approve'
  | 'offer-send'
  | 'collection-close'
  | 'negotiation-auto'
  /** Put a photo into one open conversation. Bound to that conversation when
   *  it is minted, so the page never asks a person to choose one. */
  | 'conversation-photo'
  /** Report the person on the other side of one introduction, and close it
   *  (docs/trust-and-safety.md). Bound to that introduction at mint time, so
   *  there is nobody on the page to pick by mistake. */
  | 'report';

/**
 * The actions whose link opens a one-question page: one sentence, two buttons,
 * and the press itself is what consumes the link. The one left open opens the
 * approval page instead, which burns its link on the first authenticated view.
 *
 * conversation-photo is deliberately NOT one of them. It is still one page and
 * still one press, but the person picks a file before they press, so it has a
 * page of its own (counter/pages.ts, photoPage) with its own route. It is not
 * the approval page either: the fall-through below burns a link on the first
 * authenticated view, and a link burnt before the photo was chosen would be a
 * page that dies while somebody is looking for the picture.
 *
 * stage3-disclosure joined them on 2026-09-12, when sharing a first name and an
 * area became a press the human makes every time rather than something an agent
 * could attest to. The "Waiting for you" list still reaches the same decision by
 * its own session-authorized route, so there are two roads to one question.
 */
export const ONE_QUESTION_ACTIONS: ApprovalAction[] = [
  'offer-send',
  'offer-accept',
  'stage3-disclosure',
  'collection-close',
  'negotiation-auto',
  // Reporting joined them on 2026-09-17. It is the same page with one box on
  // it — a short line of the person's own words — and it takes the same
  // credential every other press on this page takes. Built credential-free on
  // 17 September; the same day Lachlan decided a report is a formal press like
  // the others, because a browser-driving assistant could otherwise complete it
  // alone. A passkey is the one thing an assistant cannot press for its human,
  // and closing somebody's conversation and muting the pairing for good is
  // exactly the kind of press that has to be the human's own.
  'report',
];

export function isOneQuestionAction(a: string): a is ApprovalAction {
  return (ONE_QUESTION_ACTIONS as string[]).includes(a);
}

export interface ApprovalLinkRow {
  id: string;
  account_id: string;
  action: ApprovalAction;
  ref_id: string;
  amount: string | null;
  ccy: string | null;
  counterparty_account: string;
  /** Canonical JSON of the figures this link is bound to, or null. */
  payload: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  decision: string | null;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * One string for one set of figures. Keys are sorted so the same payload
 * always signs the same way, whatever order a caller wrote it in.
 */
export function canonicalPayload(p: Record<string, unknown> | null | undefined): string | null {
  if (p === null || p === undefined) return null;
  const keys = Object.keys(p)
    .filter((k) => p[k] !== undefined)
    .sort();
  if (!keys.length) return null;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, p[k]])));
}

/** The figures back out of a stored link, or undefined when it carries none. */
export function readPayload(row: { payload?: string | null }): Record<string, any> | undefined {
  if (!row.payload) return undefined;
  try {
    const v = JSON.parse(row.payload);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function bindingString(row: {
  id: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | number | null;
  ccy: string | null;
  counterparty_account: string;
  payload?: string | null;
}): string {
  const amt = row.amount === null || row.amount === undefined ? '' : String(Number(row.amount));
  return [
    row.id,
    row.account_id,
    row.action,
    row.ref_id,
    amt,
    row.ccy ?? '',
    row.counterparty_account,
    row.payload ?? '',
  ].join('|');
}

export function signLink(row: Parameters<typeof bindingString>[0], key?: Buffer): string {
  const mac = createHmac('sha256', key ?? counterKeys().linkHmacKey)
    .update(bindingString(row))
    .digest('base64url');
  return `${row.id}.${mac}`;
}

/** Create an approval link for a human. Returns the token to hand over. */
export async function createApprovalLink(input: {
  accountId: string;
  action: ApprovalAction;
  refId: string;
  amount?: number | null;
  ccy?: string | null;
  /** The account's own id where the action has no other side. */
  counterpartyAccount: string;
  /** The figures the question is about, bound into the signature. */
  payload?: Record<string, unknown> | null;
}): Promise<{ token: string; id: string }> {
  const pool = getPool();
  const payload = canonicalPayload(input.payload);
  const r = await pool.query(
    `INSERT INTO approval_links (token_hash, account_id, action, ref_id, amount, ccy, counterparty_account, payload, expires_at)
     VALUES ('pending', $1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => ${APPROVAL_LINK_TTL_MINUTES}))
     RETURNING id`,
    [
      input.accountId,
      input.action,
      input.refId,
      input.amount ?? null,
      input.ccy ?? null,
      input.counterpartyAccount,
      payload,
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
    payload,
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
