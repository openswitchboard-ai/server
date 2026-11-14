/**
 * AN INTRODUCTION THAT ENDS TAKES ITS OPEN OFFERS WITH IT (14 November 2026).
 *
 * An introduction ends in many ways: a decline, "not the thing", a bad-match
 * verdict, an archive, a posting taken down, a quiet slot lapsing, a best-offer
 * window closing on somebody who put no number in, the seller choosing someone
 * else, a report, a suspension, an account deleted. Every accept path already
 * refuses a figure on one that has ended (domain/offers.ts,
 * INTRODUCTION_ENDED_WORDS), but the figure itself stayed 'proposed' or
 * 'awaiting-human' for the rest of its month. So it went on counting as a
 * number in the seller's best-offer result, and any read of the table could
 * still call it open.
 *
 * Now the statement that ends the introduction closes its open figures in the
 * same breath. ONE STATEMENT: the ending UPDATE runs as a data-modifying CTE
 * and the offers UPDATE reads the ids it returned, so the two land together or
 * not at all, and nothing can read the one without the other. Each caller
 * hands its own UPDATE over unchanged, with `RETURNING id` on the end.
 *
 * WHICH STATE. 'withdrawn': off the table, and nobody's judgement on the
 * figure. The protocol's offer states are a fixed list (schemas/offer.json) and
 * there is no "ended" among them; 'declined' would tell a buyer their number
 * was turned down when nobody looked at it, which is exactly the kind of price
 * signal a reasonless decline exists to avoid. Every reader already treats
 * 'withdrawn' as a figure that no longer counts. `closed_with_introduction`
 * (migration 072) says which withdrawals were this, so the human's own page
 * can say "closed when this one ended" rather than "you withdrew it".
 *
 * An accepted figure is never touched: only 'proposed' and 'awaiting-human'
 * close. A figure being accepted at the same moment is settled by the row
 * locks: the accept reads the introduction FOR SHARE under its own lock
 * (offers.ts, acceptOfferByHuman), so either the ending waits for the accept
 * to commit and then finds the figure accepted, or the accept sees the ending.
 */

/** The offer states that are still on the table. */
export const OPEN_OFFER_STATES = ['proposed', 'awaiting-human'] as const;

/**
 * Wrap an UPDATE of `matches` that ends introductions (and ends `RETURNING
 * id`) so the open offers on every introduction it ended are closed in the
 * same statement. The result rows are the ended ids, exactly as the UPDATE on
 * its own would have returned them. Placeholders in `endSql` are untouched.
 */
export function endingClosesOffers(endSql: string): string {
  if (!/RETURNING\s+(\w+\.)?id\s*$/i.test(endSql.trim())) {
    throw new Error('endingClosesOffers: the ending statement must end RETURNING id');
  }
  return `WITH ended AS (${endSql.trim()}),
     closed_offers AS (
       UPDATE offers
          SET state = 'withdrawn', closed_with_introduction = true, updated_at = now()
        WHERE match_id IN (SELECT id FROM ended)
          AND state IN ('proposed', 'awaiting-human')
        RETURNING id)
   SELECT ended.id FROM ended`;
}
