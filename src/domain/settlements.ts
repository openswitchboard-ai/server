/**
 * Safe-hands settlements: the escrow state machine (phase 1.A).
 *
 *   proposed -> approved-by-buyer / approved-by-seller -> approved
 *            -> funded -> evidence-locked -> confirmed -> released
 *                                         -> disputed  -> refunded
 *   either human may decline while unfunded; declined / released / refunded
 *   are TERMINAL.
 *
 * STRUCTURAL RULE (tested in test/unit/settlements.test.ts): every state
 * change flows through applyTransition(), the single place that writes
 * `UPDATE settlements ... state`, and applyTransition demands a transition
 * context minted in THIS module: either
 *   - a human-action context (counterAction), minted only by the approval
 *     page's session-authenticated routes, or
 *   - a webhook context (webhookAction), minted only by the verified Stripe
 *     webhook handler after signature verification.
 * There is no ops-queue, admin or agent code path that can mint either; the
 * agent-facing surface (proposeSettlement / settlement reads) never
 * transitions past 'proposed'.
 */
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, sideOf, type MatchRow } from './matches.js';
import { OsbError, SCHEMA_VERSION, assertOutbound, assertReasonless } from '../protocol.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Transition contexts. The brand symbols never leave this module, so a
// context cannot be forged with an object literal: only counterAction() and
// webhookAction() can mint one, and the unit suite asserts (by source scan)
// that those constructors are called only from the counter route class and
// the verified webhook handler respectively.
// ---------------------------------------------------------------------------
const HUMAN_BRAND = Symbol('osb-settlement-human-action');
const WEBHOOK_BRAND = Symbol('osb-settlement-webhook-event');

export interface HumanCtx {
  kind: 'human';
  accountId: string;
  recordedVia: string;
}

export interface WebhookCtx {
  kind: 'webhook';
  eventId: string;
  eventType: string;
}

export type TransitionCtx = HumanCtx | WebhookCtx;

/** Mint a human-action context. Call ONLY from the human page routes with a
 *  session-authenticated human. */
export function counterAction(accountId: string): HumanCtx {
  const ctx: HumanCtx = { kind: 'human', accountId, recordedVia: 'counter' };
  Object.defineProperty(ctx, HUMAN_BRAND, { value: true, enumerable: false });
  return ctx;
}

/** Mint a webhook context. Call ONLY from the Stripe webhook handler, AFTER
 *  signature verification. */
export function webhookAction(eventId: string, eventType: string): WebhookCtx {
  const ctx: WebhookCtx = { kind: 'webhook', eventId, eventType };
  Object.defineProperty(ctx, WEBHOOK_BRAND, { value: true, enumerable: false });
  return ctx;
}

function assertTransitionContext(ctx: unknown): asserts ctx is TransitionCtx {
  const branded =
    !!ctx &&
    typeof ctx === 'object' &&
    ((ctx as any)[HUMAN_BRAND] === true || (ctx as any)[WEBHOOK_BRAND] === true);
  if (!branded) {
    throw new Error(
      'settlement transition requires a human-action or verified-webhook context',
    );
  }
}

// ---------------------------------------------------------------------------
// Rows and reads.
// ---------------------------------------------------------------------------
export type SettlementState =
  | 'proposed'
  | 'approved-by-buyer'
  | 'approved-by-seller'
  | 'approved'
  | 'funded'
  | 'evidence-locked'
  | 'confirmed'
  | 'disputed'
  | 'released'
  | 'refunded'
  | 'declined';

export const TERMINAL_STATES: SettlementState[] = ['released', 'refunded', 'declined'];

export interface SettlementRow {
  id: string;
  match_id: string;
  proposer_account: string;
  buyer_account: string;
  seller_account: string;
  amount: string;
  ccy: string;
  description: any;
  state: SettlementState;
  fee_amount_minor: number;
  buyer_approved_at: Date | null;
  seller_approved_at: Date | null;
  stripe_checkout_session: string | null;
  stripe_payment_intent: string | null;
  evidence_manifest_key: string | null;
}

export async function getSettlement(id: string): Promise<SettlementRow | undefined> {
  const r = await getPool().query('SELECT * FROM settlements WHERE id = $1', [id]);
  return r.rows[0];
}

export async function getSettlementByPaymentIntent(
  pi: string,
): Promise<SettlementRow | undefined> {
  const r = await getPool().query(
    'SELECT * FROM settlements WHERE stripe_payment_intent = $1',
    [pi],
  );
  return r.rows[0];
}

export function partyOf(s: SettlementRow, accountId: string): 'buyer' | 'seller' {
  if (s.buyer_account === accountId) return 'buyer';
  if (s.seller_account === accountId) return 'seller';
  throw Object.assign(new Error('settlement not found'), { notFound: true });
}

export function serializeSettlement(s: SettlementRow) {
  const payload: any = {
    schema_version: SCHEMA_VERSION,
    kind: 'settlement' as const,
    settlement_id: s.id,
    intro_id: s.match_id,
    amount: Number(s.amount),
    ccy: s.ccy,
    state: s.state,
  };
  if (s.description) payload.description = s.description;
  // Outbound-validated; declines stay reason-less as a server invariant on
  // top of the schema's additionalProperties:false.
  return assertReasonless(assertOutbound('settlement', payload));
}

// ---------------------------------------------------------------------------
// THE single state writer. Every transition goes through here; nothing else
// in the codebase writes settlements.state.
// ---------------------------------------------------------------------------
async function applyTransition(
  ctx: TransitionCtx,
  settlementId: string,
  from: SettlementState[],
  to: SettlementState,
  stamp?: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const allowedStamps = [
    'buyer_approved_at',
    'seller_approved_at',
    'funded_at',
    'evidence_locked_at',
    'confirmed_at',
    'disputed_at',
    'released_at',
    'refunded_at',
    'declined_at',
  ];
  if (stamp && !allowedStamps.includes(stamp)) throw new Error(`bad stamp ${stamp}`);
  const stampSql = stamp ? `, ${stamp} = now()` : '';
  const r = await getPool().query(
    `UPDATE settlements SET state = $2, updated_at = now()${stampSql}
     WHERE id = $1 AND state = ANY($3::text[])
     RETURNING *`,
    [settlementId, to, from],
  );
  if (!r.rows[0]) {
    const cur = await getSettlement(settlementId);
    if (!cur) throw Object.assign(new Error('settlement not found'), { notFound: true });
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: `This settlement is '${cur.state}'; that step does not apply now.`,
    });
  }
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Agent-facing: propose + read. Nothing here moves past 'proposed'.
// ---------------------------------------------------------------------------
export async function proposeSettlement(
  cfg: Config,
  accountId: string,
  input: { match_id: string; amount: number; ccy: string; description?: string },
): Promise<{ settlement: ReturnType<typeof serializeSettlement>; row: SettlementRow; match: MatchRow }> {
  const m = await getMatch(input.match_id);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  if (m.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET');
  if (m.stage < 3) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'Settlement opens once both humans have shared their first names and can talk.',
    });
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw Object.assign(new Error('amount must be a positive number'), { validation: true });
  }
  if (!/^[A-Z]{3}$/.test(input.ccy ?? '')) {
    throw Object.assign(new Error('ccy must be a three-letter currency code'), {
      validation: true,
    });
  }
  // One live settlement per match: a second proposal while one is in flight
  // would double-charge the buyer.
  const live = await getPool().query(
    `SELECT id FROM settlements WHERE match_id = $1 AND state <> ALL($2::text[])`,
    [input.match_id, TERMINAL_STATES],
  );
  if (live.rowCount) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'A settlement is already under way on this introduction. Check its state first.',
    });
  }
  const description = input.description
    ? { text: String(input.description).slice(0, 2000), provenance: 'counterparty-untrusted' }
    : null;
  const r = await getPool().query(
    `INSERT INTO settlements
       (match_id, proposer_account, buyer_account, seller_account, amount, ccy, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.match_id,
      accountId,
      m.account_want, // the WANT side's human pays
      m.account_have, // the HAVE side's human is paid
      input.amount,
      input.ccy,
      description ? JSON.stringify(description) : null,
    ],
  );
  const row: SettlementRow = r.rows[0];
  await notifyHumansOfProposal(cfg, row, m);
  return { settlement: serializeSettlement(row), row, match: m };
}

export async function listSettlementsForAgent(
  accountId: string,
  matchId?: string,
): Promise<ReturnType<typeof serializeSettlement>[]> {
  const params: any[] = [accountId];
  let filter = '';
  if (matchId) {
    filter = 'AND match_id = $2';
    params.push(matchId);
  }
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE (buyer_account = $1 OR seller_account = $1) ${filter}
     ORDER BY created_at DESC LIMIT 50`,
    params,
  );
  return (r.rows as SettlementRow[]).map(serializeSettlement);
}

export async function getSettlementForAgent(accountId: string, settlementId: string) {
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, accountId);
  return serializeSettlement(s);
}

async function notifyHumansOfProposal(
  cfg: Config,
  s: SettlementRow,
  m: MatchRow,
): Promise<void> {
  const { createApprovalLink } = await import('../counter/links.js');
  const { sendSettlementEmail } = await import('../counter/email.js');
  const { accountEmail } = await import('./counterOps.js');
  const { categoryLeafLabel } = await import('./matchRules.js');
  for (const [accountId, counterparty] of [
    [s.buyer_account, s.seller_account],
    [s.seller_account, s.buyer_account],
  ] as const) {
    const { token, id: linkId } = await createApprovalLink({
      accountId,
      action: 'settlement-approve',
      refId: s.id,
      amount: Number(s.amount),
      ccy: s.ccy,
      counterpartyAccount: counterparty,
    });
    const email = await accountEmail(accountId, 'settlement-approval-notification');
    if (email) {
      // Best-effort: the approval also appears on the person's approval page;
      // a failed email must not roll back the proposed settlement.
      try {
      await sendSettlementEmail(cfg, {
        to: email,
        accountId,
        template: 'settlement-proposed',
        settlementId: s.id,
        linkToken: token,
        linkId,
        summary: `A settlement of ${Number(s.amount)} ${s.ccy} on your ${categoryLeafLabel(m.category)} match is waiting for your approval.`,
      });
      } catch (err) {
        console.warn('settlement-proposed email failed; settlement stands', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Human transitions (approval page only).
// ---------------------------------------------------------------------------

/** Approve, from either human. Both approvals => 'approved'. */
export async function approveSettlement(
  ctx: HumanCtx,
  settlementId: string,
): Promise<{ row: SettlementRow; bothApproved: boolean }> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const party = partyOf(s, ctx.accountId);
  const already = party === 'buyer' ? s.buyer_approved_at : s.seller_approved_at;
  if (already) {
    // Idempotent: this human already approved.
    return { row: s, bothApproved: !!s.buyer_approved_at && !!s.seller_approved_at };
  }
  await writeConsentEvent({
    event: 'settlement-approved',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party,
    amount: Number(s.amount),
    ccy: s.ccy,
    recorded_via: ctx.recordedVia,
  });
  const otherApproved = party === 'buyer' ? !!s.seller_approved_at : !!s.buyer_approved_at;
  const to: SettlementState = otherApproved
    ? 'approved'
    : party === 'buyer'
      ? 'approved-by-buyer'
      : 'approved-by-seller';
  const row = await applyTransition(
    ctx,
    settlementId,
    ['proposed', 'approved-by-buyer', 'approved-by-seller'],
    to,
    party === 'buyer' ? 'buyer_approved_at' : 'seller_approved_at',
  );
  return { row, bothApproved: to === 'approved' };
}

/** Decline, from either human, while unfunded. Reason-less, as always. */
export async function declineSettlement(ctx: HumanCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, ctx.accountId);
  await writeConsentEvent({
    event: 'settlement-declined',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    recorded_via: ctx.recordedVia,
  });
  return applyTransition(
    ctx,
    settlementId,
    ['proposed', 'approved-by-buyer', 'approved-by-seller', 'approved'],
    'declined',
    'declined_at',
  );
}

/** Seller freezes the handover evidence: funded -> evidence-locked. */
export async function lockEvidence(
  ctx: HumanCtx,
  settlementId: string,
  manifestKey: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'seller') {
    throw Object.assign(new Error('only the seller locks evidence'), { notFound: true });
  }
  await writeConsentEvent({
    event: 'settlement-evidence-locked',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    manifest_key: manifestKey,
    recorded_via: ctx.recordedVia,
  });
  await getPool().query(
    `UPDATE settlements SET evidence_manifest_key = $2, updated_at = now() WHERE id = $1`,
    [settlementId, manifestKey],
  );
  return applyTransition(ctx, settlementId, ['funded'], 'evidence-locked', 'evidence_locked_at');
}

/** Buyer confirms receipt: evidence-locked -> confirmed. The capture that
 *  follows is initiated by the same signed request; 'released' is recorded
 *  only when Stripe's webhook confirms the capture. */
export async function confirmReceipt(ctx: HumanCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'buyer') {
    throw Object.assign(new Error('only the buyer confirms receipt'), { notFound: true });
  }
  if (s.state === 'confirmed') return s; // idempotent: capture retry path
  await writeConsentEvent({
    event: 'settlement-receipt-confirmed',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    amount: Number(s.amount),
    ccy: s.ccy,
    recorded_via: ctx.recordedVia,
  });
  return applyTransition(ctx, settlementId, ['evidence-locked'], 'confirmed', 'confirmed_at');
}

/** Either human disputes a held payment: funded/evidence-locked -> disputed.
 *  The money then flows BACK to the buyer (the safe direction); 'refunded'
 *  is recorded only from Stripe's webhook. */
export async function openDispute(ctx: HumanCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, ctx.accountId);
  if (s.state === 'disputed') return s; // idempotent: cancel retry path
  await writeConsentEvent({
    event: 'settlement-disputed',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    recorded_via: ctx.recordedVia,
  });
  return applyTransition(
    ctx,
    settlementId,
    ['funded', 'evidence-locked'],
    'disputed',
    'disputed_at',
  );
}

// ---------------------------------------------------------------------------
// Webhook transitions (verified Stripe events only).
// ---------------------------------------------------------------------------

/** The buyer's hold landed (checkout.session.completed or
 *  payment_intent.amount_capturable_updated): approved -> funded. The
 *  webhook handler verifies the payment matches the settlement first. */
export async function markFunded(
  ctx: WebhookCtx,
  settlementId: string,
  refs: { checkoutSession?: string; paymentIntent: string },
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  await getPool().query(
    `UPDATE settlements SET stripe_checkout_session = COALESCE($2, stripe_checkout_session),
       stripe_payment_intent = $3, updated_at = now() WHERE id = $1`,
    [settlementId, refs.checkoutSession ?? null, refs.paymentIntent],
  );
  return applyTransition(ctx, settlementId, ['approved'], 'funded', 'funded_at');
}

/** payment_intent.succeeded (capture landed): confirmed -> released. */
export async function markReleased(ctx: WebhookCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  return applyTransition(ctx, settlementId, ['confirmed'], 'released', 'released_at');
}

/** payment_intent.canceled / charge.refunded: disputed -> refunded. */
export async function markRefunded(ctx: WebhookCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  return applyTransition(ctx, settlementId, ['disputed'], 'refunded', 'refunded_at');
}

/** Registry the property suite enumerates: every exported function that can
 *  change settlement state, with the context class it demands. */
export const SETTLEMENT_TRANSITIONS: Record<string, 'human' | 'webhook'> = {
  approveSettlement: 'human',
  declineSettlement: 'human',
  lockEvidence: 'human',
  confirmReceipt: 'human',
  openDispute: 'human',
  markFunded: 'webhook',
  markReleased: 'webhook',
  markRefunded: 'webhook',
};
