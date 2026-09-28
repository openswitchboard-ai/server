/**
 * Anomaly lines for the pages where a person decides. Rules (0.D):
 *  - amount anomaly: offer amount > 3x the median amount of the account's
 *    other historical offers (either side of its matches);
 *  - counterparty anomaly: counterparty account is younger than 7 days.
 * Anomalies never block. Each one is said in one plain sentence under the
 * question, in the same place as the rest of the detail.
 *
 * WHEN THE NEW-ACCOUNT LINE SHOWS (28 September 2026). At launch every
 * account is new, so a warning that fired on every offer would teach people
 * to skip it. It shows on a payment approval always, on accepting a figure
 * only when the figure is also out of the ordinary, and never on sharing
 * names.
 */
import { getPool } from '../db.js';

export interface AmountAnomaly {
  kind: 'amount';
  /** How many times the usual amount, as a person says it: "4", "4.5". */
  times: string;
}

export async function offerAmountAnomaly(
  accountId: string,
  offerId: string,
  amount: number,
): Promise<AmountAnomaly | undefined> {
  const r = await getPool().query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.amount) AS med
     FROM offers o JOIN matches m ON m.id = o.match_id
     WHERE (m.account_want = $1 OR m.account_have = $1) AND o.id <> $2`,
    [accountId, offerId],
  );
  const med = r.rows[0]?.med === null || r.rows[0]?.med === undefined ? undefined : Number(r.rows[0].med);
  if (med === undefined || med <= 0) return undefined;
  if (amount > 3 * med) {
    return { kind: 'amount', times: (amount / med).toFixed(1).replace(/\.0$/, '') };
  }
  return undefined;
}

/** True when the account on the other side opened in the last seven days. */
export async function counterpartyIsNew(counterpartyAccountId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT (created_at > now() - interval '7 days') AS young FROM accounts WHERE id = $1`,
    [counterpartyAccountId],
  );
  return !!r.rows[0]?.young;
}

/**
 * The one sentence on the page that accepts a figure, or none. A new account
 * alone says nothing here; it is only worth a line beside a figure that is
 * already out of the ordinary.
 */
export function acceptAnomalyLine(amount: AmountAnomaly | undefined, isNew: boolean): string | undefined {
  if (!amount) return undefined;
  const figure = `this figure is ${amount.times} times your usual`;
  return isNew
    ? `This is their first week on OpenSwitchboard, and ${figure}.`
    : `${figure[0].toUpperCase()}${figure.slice(1)}.`;
}

/** The one sentence on a payment approval, or none. */
export function settlementAnomalyLine(isNew: boolean): string | undefined {
  return isNew ? 'The other side of this payment joined this week.' : undefined;
}
