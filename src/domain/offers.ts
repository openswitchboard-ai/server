import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, sideOf } from './matches.js';
import { checkOfferRate } from './quotas.js';
import { OsbError, SCHEMA_VERSION, assertOutbound } from '../protocol.js';
import type { Config } from '../config.js';

export interface OfferRow {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  expiry: Date;
  state: 'proposed' | 'awaiting-human' | 'accepted-by-human' | 'declined' | 'withdrawn';
  message: any;
}

async function loadOffer(offerId: string): Promise<OfferRow> {
  const r = await getPool().query('SELECT * FROM offers WHERE id = $1', [offerId]);
  if (!r.rows[0]) throw Object.assign(new Error('offer not found'), { notFound: true });
  return r.rows[0];
}

export function serializeOffer(o: OfferRow) {
  const payload: any = {
    schema_version: SCHEMA_VERSION,
    kind: 'offer' as const,
    offer_id: o.id,
    match_id: o.match_id,
    amount: Number(o.amount),
    ccy: o.ccy,
    expiry: new Date(o.expiry).toISOString(),
    state: o.state,
  };
  if (o.message) payload.message = o.message;
  // Outbound-validated: the offer schema has additionalProperties:false, so a
  // decline reason (or anything else) is structurally impossible here.
  return assertOutbound('offer', payload);
}

export async function proposeOffer(
  cfg: Config,
  accountId: string,
  input: { match_id: string; amount: number; ccy: string; expiry: string; message?: string },
) {
  const m = await getMatch(input.match_id);
  if (!m) throw Object.assign(new Error('match not found'), { notFound: true });
  sideOf(m, accountId);
  if (m.state !== 'open') throw new OsbError('STAGE_LOCKED');
  if (m.stage < 2) {
    throw new OsbError('STAGE_LOCKED', {
      human_action: 'Offers open at stage 2, after both sides express interest.',
    });
  }
  await checkOfferRate(accountId, cfg.quotas);
  const message = input.message
    ? { text: input.message.slice(0, 2000), provenance: 'counterparty-untrusted' }
    : null;
  const r = await getPool().query(
    `INSERT INTO offers (match_id, proposer_account, amount, ccy, expiry, message)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.match_id, accountId, input.amount, input.ccy, input.expiry, message ? JSON.stringify(message) : null],
  );
  return serializeOffer(r.rows[0]);
}

/**
 * Agent-reachable offer transitions. The ONLY accept-flavoured transition an
 * agent can make is proposed -> awaiting-human ("send_to_human"): parking the
 * offer for its human. 'accepted-by-human' is reachable exclusively via
 * acceptOfferByHuman() below, which has NO public route.
 */
export async function agentOfferAction(
  cfg: Config,
  accountId: string,
  offerId: string,
  action: 'send_to_human' | 'decline_offer' | 'withdraw_offer',
) {
  const o = await loadOffer(offerId);
  const m = await getMatch(o.match_id);
  if (!m) throw new Error('match missing');
  const side = sideOf(m, accountId); // throws notFound if not a party
  void side;
  const isProposer = o.proposer_account === accountId;

  if (action === 'withdraw_offer') {
    if (!isProposer) throw Object.assign(new Error('only the proposer can withdraw'), { notFound: true });
    if (o.state !== 'proposed' && o.state !== 'awaiting-human') {
      throw new OsbError('STAGE_LOCKED');
    }
    const r = await getPool().query(
      `UPDATE offers SET state='withdrawn', updated_at=now() WHERE id=$1 RETURNING *`,
      [offerId],
    );
    return serializeOffer(r.rows[0]);
  }

  if (isProposer) {
    throw Object.assign(new Error('the proposer cannot respond to its own offer'), {
      notFound: true,
    });
  }

  if (action === 'decline_offer') {
    // Declines carry NO reason. The API accepts none and the schema forbids one.
    if (o.state !== 'proposed' && o.state !== 'awaiting-human') throw new OsbError('STAGE_LOCKED');
    const r = await getPool().query(
      `UPDATE offers SET state='declined', updated_at=now() WHERE id=$1 RETURNING *`,
      [offerId],
    );
    return serializeOffer(r.rows[0]);
  }

  // send_to_human: the sole agent-reachable "accept-direction" state.
  if (o.state !== 'proposed') throw new OsbError('STAGE_LOCKED');
  if (new Date(o.expiry) < new Date()) throw new OsbError('STAGE_LOCKED');
  const r = await getPool().query(
    `UPDATE offers SET state='awaiting-human', updated_at=now() WHERE id=$1 RETURNING *`,
    [offerId],
  );
  // 0.D: parking an offer for a human creates a counter approval link
  // (single-use, 15-min TTL, HMAC-bound to account/action/amount/counterparty)
  // and notifies the human by email. Blind mode strips all content.
  await notifyHumanOfOffer(cfg, r.rows[0]);
  return serializeOffer(r.rows[0]);
}

async function notifyHumanOfOffer(cfg: Config, o: OfferRow): Promise<void> {
  const { createApprovalLink } = await import('../counter/links.js');
  const { sendApprovalEmail } = await import('../counter/email.js');
  const { accountEmail } = await import('./counterOps.js');
  const m = await getMatch(o.match_id);
  if (!m) throw new Error('match missing');
  const humanAccount = o.proposer_account === m.account_want ? m.account_have : m.account_want;
  const { token } = await createApprovalLink({
    accountId: humanAccount,
    action: 'offer-accept',
    refId: o.id,
    amount: Number(o.amount),
    ccy: o.ccy,
    counterpartyAccount: o.proposer_account,
  });
  const acc = await getPool().query('SELECT blind_mode FROM accounts WHERE id = $1', [humanAccount]);
  const blind = !!acc.rows[0]?.blind_mode;
  const email = await accountEmail(humanAccount, 'approval-notification');
  if (email) {
    const summary = blind
      ? 'Something at the counter needs you.'
      : `An offer of ${Number(o.amount)} ${o.ccy} on your ${m.category} match is waiting for your decision.`;
    await sendApprovalEmail(cfg, email, token, summary);
  }
}

/**
 * INTERNAL-ONLY human acceptance. There is deliberately no HTTP route to this
 * function: in 0.C it is reachable only through the IAM-gated internal ops
 * queue (and tests); in 0.D the counter's human-approval UI becomes the
 * caller. Records the consent event in the WORM log first.
 */
export async function acceptOfferByHuman(
  offerId: string,
  humanAccountId: string,
  recordedVia: string,
) {
  const o = await loadOffer(offerId);
  if (o.state !== 'awaiting-human') {
    throw new Error(`offer ${offerId} is '${o.state}', not awaiting-human`);
  }
  const m = await getMatch(o.match_id);
  if (!m) throw new Error('match missing');
  const side = sideOf(m, humanAccountId);
  void side;
  if (o.proposer_account === humanAccountId) {
    throw new Error('the proposing side cannot accept its own offer');
  }
  await writeConsentEvent({
    event: 'offer-accepted-by-human',
    offer_id: offerId,
    match_id: o.match_id,
    account_id: humanAccountId,
    recorded_via: recordedVia,
  });
  await getPool().query(
    `INSERT INTO consent_tokens (match_id, account_id, kind, recorded_via)
     VALUES ($1,$2,'offer-accept',$3) ON CONFLICT (match_id, account_id, kind) DO NOTHING`,
    [o.match_id, humanAccountId, recordedVia],
  );
  const r = await getPool().query(
    `UPDATE offers SET state='accepted-by-human', updated_at=now() WHERE id=$1 RETURNING *`,
    [offerId],
  );
  return serializeOffer(r.rows[0]);
}

export async function listOffers(accountId: string, matchId: string) {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('match not found'), { notFound: true });
  sideOf(m, accountId);
  const r = await getPool().query(
    `SELECT * FROM offers WHERE match_id = $1 ORDER BY created_at ASC`,
    [matchId],
  );
  return (r.rows as OfferRow[]).map(serializeOffer);
}
