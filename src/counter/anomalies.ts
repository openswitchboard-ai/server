/**
 * Anomaly emphasis for approval pages. Rules (0.D):
 *  - amount anomaly: offer amount > 3x the median amount of the account's
 *    other historical offers (either side of its matches);
 *  - counterparty anomaly: counterparty account is younger than 7 days.
 * Anomalies never block — they make the page LOUDER.
 */
import { getPool } from '../db.js';

export interface Anomaly {
  kind: 'amount' | 'new-counterparty';
  text: string;
}

export async function offerAmountAnomaly(
  accountId: string,
  offerId: string,
  amount: number,
): Promise<Anomaly | undefined> {
  const r = await getPool().query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.amount) AS med
     FROM offers o JOIN matches m ON m.id = o.match_id
     WHERE (m.account_want = $1 OR m.account_have = $1) AND o.id <> $2`,
    [accountId, offerId],
  );
  const med = r.rows[0]?.med === null || r.rows[0]?.med === undefined ? undefined : Number(r.rows[0].med);
  if (med === undefined || med <= 0) return undefined;
  if (amount > 3 * med) {
    const mult = (amount / med).toFixed(1).replace(/\.0$/, '');
    return { kind: 'amount', text: `${mult}× your usual amount` };
  }
  return undefined;
}

export async function newCounterpartyAnomaly(
  counterpartyAccountId: string,
  action: 'offer-accept' | 'stage3-disclosure',
): Promise<Anomaly | undefined> {
  const r = await getPool().query(
    `SELECT (created_at > now() - interval '7 days') AS young FROM accounts WHERE id = $1`,
    [counterpartyAccountId],
  );
  if (!r.rows[0]?.young) return undefined;
  return {
    kind: 'new-counterparty',
    text:
      action === 'stage3-disclosure'
        ? 'first disclosure to a brand-new account'
        : 'this offer comes from a brand-new account',
  };
}
