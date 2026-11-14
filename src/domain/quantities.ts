/**
 * QUANTITIES THAT COME DOWN (founder, 14 November 2026; migration 074).
 *
 * A list item carries how many of it there are, a detail its owner gave. Until
 * today nothing lowered it, so an item with one copy could be sold to two
 * people. Now an ACCEPTED SALE of a list item takes one of them. The count of
 * what has gone sits beside the item (cards.quantity_gone) rather than in its
 * details, so the owner's own words are never rewritten; what is left is the
 * quantity less what has gone.
 *
 * WHEN NONE ARE LEFT the item comes down, the way withdraw_intent takes a
 * posting down, with the reason (cards.withdrawn_because 'none_left'): nobody
 * new is introduced to it, introductions on it that never reached a
 * conversation are filed away with a sentence saying the last one went in
 * another deal and their open figures close with them, and a conversation
 * already going stays open.
 *
 * THE MANUAL SAYS "TAKE NOTHING DOWN UNASKED", and the page says so before the
 * press: the seller's page to accept a figure, or to send one, on a list item
 * says that it takes one off their list, and how many are left after it, or
 * that it is the last one. The human pressing is the human asking.
 *
 * Only list items. An ordinary posting has no quantity on the switchboard's
 * books, and an accept on one changes nothing here.
 */
import { getPool } from '../db.js';
import type { Config } from '../config.js';
import { OsbError } from '../protocol.js';
import { endingClosesOffers } from './introductionEnds.js';

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** The quantity a posting's details give, 1 where they give none. Pure. */
export function quantityOf(attributes: unknown): number {
  const q = (attributes as Record<string, unknown> | null | undefined)?.quantity;
  return typeof q === 'number' && Number.isInteger(q) && q >= 1 ? q : 1;
}

/** What is left of a list item. Pure. */
export function leftOf(row: { attributes?: unknown; quantity_gone?: unknown }): number {
  return Math.max(0, quantityOf(row.attributes) - Number(row.quantity_gone ?? 0));
}

/** The refusal where an accept would take one that is no longer there. */
export const NONE_LEFT_WORDS =
  'There are none of these left: the last one has gone in another deal, so this figure can no longer be taken.';

/**
 * Take one unit of a list item for an accepted sale, inside the accept's own
 * transaction. Nothing happens for an ordinary posting. Throws NONE_LEFT_WORDS
 * where nothing is left, so the accept rolls back and nothing is recorded.
 * Returns what is left after it, or undefined for an ordinary posting.
 */
export async function takeOneForSale(db: Queryable, haveCardId: string): Promise<number | undefined> {
  const r = await db.query(
    `UPDATE cards SET quantity_gone = quantity_gone + 1, updated_at = now()
      WHERE id = $1 AND list_id IS NOT NULL
        AND quantity_gone < (CASE WHEN jsonb_typeof(attributes->'quantity') = 'number'
                                  THEN GREATEST((attributes->>'quantity')::numeric::int, 1) ELSE 1 END)
      RETURNING attributes, quantity_gone`,
    [haveCardId],
  );
  if (r.rows[0]) return leftOf(r.rows[0]);
  const c = await db.query(`SELECT list_id, attributes, quantity_gone FROM cards WHERE id = $1`, [haveCardId]);
  const row = c.rows[0];
  if (row?.list_id && leftOf(row) <= 0) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: NONE_LEFT_WORDS });
  }
  return undefined;
}

/**
 * Take n units of a list item for an accepted trade (domain/trades.ts),
 * inside the accept's own transaction: one guarded statement, so a trade that
 * asks for more than is left takes nothing. Throws NOT_ENOUGH_LEFT_WORDS where
 * there are not n left, so the accept rolls back and nothing is recorded.
 * Returns what is left after it. Only list items are ever traded.
 */
export async function takeUnits(db: Queryable, cardId: string, n: number): Promise<number> {
  const units = Number.isInteger(n) && n >= 1 ? n : 1;
  const r = await db.query(
    `UPDATE cards SET quantity_gone = quantity_gone + $2, updated_at = now()
      WHERE id = $1 AND list_id IS NOT NULL AND lifecycle_state = 'PUBLISHED'
        AND quantity_gone + $2 <= (CASE WHEN jsonb_typeof(attributes->'quantity') = 'number'
                                        THEN GREATEST((attributes->>'quantity')::numeric::int, 1) ELSE 1 END)
      RETURNING attributes, quantity_gone`,
    [cardId, units],
  );
  if (r.rows[0]) return leftOf(r.rows[0]);
  throw new OsbError('NOT_UNLOCKED_YET', { human_action: NOT_ENOUGH_LEFT_WORDS });
}

/** The refusal where a trade would take more of something than is left. */
export const NOT_ENOUGH_LEFT_WORDS =
  'Something in this trade has fewer left than it asks for now, or has come off its list, so the trade can no longer be taken as it stands.';

/** Why the switchboard took an item down itself (cards.withdrawn_because). */
export type TakenDownBecause = 'none_left' | 'traded';

/**
 * None left: the item comes down with its reason, and the introductions on it
 * that never reached a conversation are filed away in one statement with
 * their open figures. The introduction the deal was agreed on is left exactly
 * as it is, and so is any other with an agreed figure, and the anchor of an
 * open pairing (domain/pairings.ts), whose item simply stops counting.
 * Pairings count again, and the people whose room that frees get their next.
 * Every trade that needed it closes with them (domain/trades.ts).
 */
export async function takeDownNoneLeft(
  cardId: string,
  keepMatchId: string,
  cfg?: Config,
  because: TakenDownBecause = 'none_left',
): Promise<number> {
  const down = await getPool().query(
    `UPDATE cards SET lifecycle_state = 'WITHDRAWN', withdrawn_because = $2, updated_at = now()
      WHERE id = $1 AND lifecycle_state IN ('PENDING_SCREENING', 'PUBLISHED')
      RETURNING id`,
    [cardId, because],
  );
  if (!down.rowCount) return 0;
  const r = await getPool().query(
    endingClosesOffers(
      `UPDATE matches
        SET state = 'archived', archived_at = now(), archived_via = 'none_left',
            live = false, updated_at = now()
      WHERE (card_want = $1 OR card_have = $1) AND state = 'open' AND id <> $2
        AND (channel_id IS NULL OR stage < 4)
        AND NOT EXISTS (SELECT 1 FROM offers o
                         WHERE o.match_id = matches.id AND o.state = 'accepted-by-human')
        AND NOT EXISTS (SELECT 1 FROM pairings p
                         WHERE p.anchor_match_id = matches.id AND p.state = 'open')
      RETURNING id`,
    ),
    [cardId, keepMatchId],
  );
  const ids = (r.rows as { id: string }[]).map((x) => x.id);
  // A figure still open on a conversation kept going can no longer be met.
  await getPool().query(
    `UPDATE offers o SET state = 'withdrawn', closed_with_introduction = true, updated_at = now()
       FROM matches m
      WHERE o.match_id = m.id AND (m.card_want = $1 OR m.card_have = $1) AND m.id <> $2
        AND o.state IN ('proposed', 'awaiting-human')`,
    [cardId, keepMatchId],
  );
  if (ids.length) {
    await getPool().query(
      `UPDATE channel_messages SET expires_at = now() WHERE match_id = ANY($1::uuid[]) AND expires_at > now()`,
      [ids],
    );
  }
  const { pairingsOnCard, reconcilePairings } = await import('./pairings.js');
  const grouped = await pairingsOnCard(cardId);
  if (grouped.length) await reconcilePairings(grouped, cfg);
  const { closeUnmeetableTrades } = await import('./trades.js');
  await closeUnmeetableTrades([cardId]);
  const { resequenceAround } = await import('./sequencer.js');
  for (const id of ids) await resequenceAround(id, cfg);
  return ids.length;
}

/** What a list item has left, for the page that is about to take one. */
export async function listItemLeft(cardId: string): Promise<number | undefined> {
  const r = await getPool().query(
    `SELECT list_id, attributes, quantity_gone FROM cards WHERE id = $1`,
    [cardId],
  );
  const row = r.rows[0];
  return row?.list_id ? leftOf(row) : undefined;
}

/**
 * The line on the seller's page to accept a figure on a list item, said
 * before the press. Undefined for an ordinary posting. Pure.
 */
export function acceptQuantityLine(left: number | undefined): string | undefined {
  if (left === undefined) return undefined;
  if (left <= 1) return 'This is the last one on your list, so it comes off your list once you accept.';
  return `This takes one off your list: ${left - 1} left after this.`;
}

/** The same, on the seller's page to send a figure that the buyer may take. Pure. */
export function sendQuantityLine(left: number | undefined): string | undefined {
  if (left === undefined) return undefined;
  if (left <= 1) return 'This is the last one on your list, so it comes off your list if they accept.';
  return `If they accept, one comes off your list: ${left - 1} left after that.`;
}
