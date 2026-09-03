/**
 * The number an agent brought back from a refusal.
 *
 * A card on "Pass on" refuses respond(propose_offer) outright: the agent may
 * not author a figure at all (see negotiation.ts). What it may do is carry one
 * — its human said "offer them five hundred" in a chat somewhere, and the
 * agent tried to send it. Before this module, that figure died with the
 * refusal, and the person arrived at their own offer box with nothing in it.
 *
 * So the refused figure is parked for a day against the match and the account,
 * and the human's box opens prefilled with it. Three things this deliberately
 * is not:
 *
 *  - it is not an offer. Nothing crosses to the counterparty, nothing appears
 *    in list_offers, and the draft has no state of its own;
 *  - it is not readable by any agent. There is no tool that returns one, and
 *    the only reader is the page class the human signs in to;
 *  - it is not durable. A price a day old is a different price, so a draft
 *    that has passed its expiry is treated as absent and swept.
 *
 * The figure never travels in a URL: the page reads it back by match id.
 */
import { getPool } from '../db.js';

/** How long a carried figure stays worth prefilling. */
export const OFFER_DRAFT_TTL_HOURS = 24;

export interface OfferDraft {
  amount: number;
  ccy: string;
  note?: string;
  createdAt: Date;
}

/** The draft as a page renders it: strings, ready for form values. */
export interface OfferDraftFields {
  amount: string;
  ccy: string;
  note?: string;
}

export function draftToFields(d: OfferDraft): OfferDraftFields {
  return {
    amount: String(d.amount),
    ccy: d.ccy,
    ...(d.note ? { note: d.note } : {}),
  };
}

/**
 * Park a refused figure. Called from the offer gate on a Pass-on refusal and
 * from nowhere else. Anything the human's own box would refuse — a figure that
 * is not money, a currency that is not a code — is dropped rather than stored,
 * because a draft that cannot be submitted is worse than an empty box.
 */
export async function saveOfferDraft(
  accountId: string,
  matchId: string,
  input: { amount: number; ccy: string; note?: string },
): Promise<void> {
  const amount = Number(input.amount);
  const ccy = String(input.ccy ?? '').trim().toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return;
  if (!/^[A-Z]{3}$/.test(ccy)) return;
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
  await getPool().query(
    `INSERT INTO offer_drafts (account_id, match_id, amount, ccy, note, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [accountId, matchId, Math.round(amount * 100) / 100, ccy, note, OFFER_DRAFT_TTL_HOURS],
  );
}

/**
 * The newest live draft for this account on this match. An expired row is not
 * a draft: the expiry is in the WHERE clause, so a stale figure can never be
 * prefilled however long it has sat there.
 */
export async function newestOfferDraft(
  accountId: string,
  matchId: string,
): Promise<OfferDraft | undefined> {
  const r = await getPool().query(
    `SELECT amount, ccy, note, created_at FROM offer_drafts
     WHERE account_id = $1 AND match_id = $2 AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [accountId, matchId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    amount: Number(row.amount),
    ccy: row.ccy,
    ...(row.note ? { note: row.note } : {}),
    createdAt: new Date(row.created_at),
  };
}

/**
 * The newest live draft on any match belonging to one of this account's cards.
 * The card's own numbers page shows it, because that is where the other half
 * of the refusal points its reader.
 */
export async function newestOfferDraftForCard(
  accountId: string,
  cardId: string,
): Promise<(OfferDraft & { matchId: string }) | undefined> {
  const r = await getPool().query(
    `SELECT d.amount, d.ccy, d.note, d.created_at, d.match_id FROM offer_drafts d
     JOIN matches m ON m.id = d.match_id
     WHERE d.account_id = $1 AND d.expires_at > now()
       AND (m.card_want = $2 OR m.card_have = $2)
     ORDER BY d.created_at DESC LIMIT 1`,
    [accountId, cardId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    amount: Number(row.amount),
    ccy: row.ccy,
    ...(row.note ? { note: row.note } : {}),
    createdAt: new Date(row.created_at),
    matchId: row.match_id,
  };
}

/** Sending a figure settles the question the draft was asking. */
export async function clearOfferDrafts(accountId: string, matchId: string): Promise<void> {
  await getPool().query('DELETE FROM offer_drafts WHERE account_id = $1 AND match_id = $2', [
    accountId,
    matchId,
  ]);
}
