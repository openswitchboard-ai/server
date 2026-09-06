/**
 * Safe-hands settlements: the escrow state machine (phase 1.A).
 *
 *   proposed -> approved-by-buyer / approved-by-seller -> approved
 *            -> funded -> evidence-locked -> confirmed -> released
 *                                         -> disputed  -> refunded
 *   either human may decline while unfunded; declined / released / refunded
 *   are TERMINAL.
 *
 * 'evidence-locked' is the seller declaring handover, and it starts the
 * buyer's window: SETTLEMENT_AUTO_RELEASE_DAYS to confirm receipt or dispute.
 * Confirming and disputing both end the window. Silence ends it too, and the
 * held payment goes to the seller — the same road confirmReceipt takes, walked
 * by the sweep in workers/settlementAutoRelease.ts.
 *
 * STRUCTURAL RULE (tested in test/unit/settlements.test.ts): every state
 * change flows through applyTransition(), the single place that writes
 * `UPDATE settlements ... state`, and applyTransition demands a transition
 * context minted in THIS module. There are three kinds and no more:
 *   - a human-action context (counterAction), minted only by the approval
 *     page's session-authenticated routes;
 *   - a webhook context (webhookAction), minted only by the verified Stripe
 *     webhook handler after signature verification;
 *   - a scheduled context (scheduledAction), minted only by the auto-release
 *     sweep in workers/settlementAutoRelease.ts, and good for exactly ONE
 *     transition, evidence-locked -> confirmed, when the buyer's window has
 *     run out. applyTransition refuses it for anything else, so the third
 *     kind buys the clock its single step and buys nothing else.
 * There is no admin or agent code path that can mint any of the three; the
 * agent-facing surface (proposeSettlement / settlement reads) never
 * transitions past 'proposed'.
 */
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, sideOf, type MatchRow } from './matches.js';
import { OsbError, SCHEMA_VERSION, assertOutbound, assertReasonless } from '../protocol.js';
import { settlementBreakdown, toMinorUnits } from '../stripe.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Transition contexts. The brand symbols never leave this module, so a
// context cannot be forged with an object literal: only counterAction(),
// webhookAction() and scheduledAction() can mint one, and the unit suite
// asserts (by source scan) that those constructors are called only from the
// counter route class, the verified webhook handler and the auto-release
// sweep respectively.
// ---------------------------------------------------------------------------
const HUMAN_BRAND = Symbol('osb-settlement-human-action');
const WEBHOOK_BRAND = Symbol('osb-settlement-webhook-event');
const SCHEDULED_BRAND = Symbol('osb-settlement-scheduled-action');

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

export interface ScheduledCtx {
  kind: 'scheduled';
  job: 'auto-release';
}

export type TransitionCtx = HumanCtx | WebhookCtx | ScheduledCtx;

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

/** Mint a scheduled context. Call ONLY from the auto-release sweep. It is
 *  good for one transition — evidence-locked -> confirmed, once the buyer's
 *  window has run out — and applyTransition refuses it for anything else. */
export function scheduledAction(): ScheduledCtx {
  const ctx: ScheduledCtx = { kind: 'scheduled', job: 'auto-release' };
  Object.defineProperty(ctx, SCHEDULED_BRAND, { value: true, enumerable: false });
  return ctx;
}

function assertTransitionContext(ctx: unknown): asserts ctx is TransitionCtx {
  const branded =
    !!ctx &&
    typeof ctx === 'object' &&
    ((ctx as any)[HUMAN_BRAND] === true ||
      (ctx as any)[WEBHOOK_BRAND] === true ||
      (ctx as any)[SCHEDULED_BRAND] === true);
  if (!branded) {
    throw new Error(
      'settlement transition requires a human-action, verified-webhook or scheduled context',
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
  /** Our introductory fee, in minor units. The buyer pays it. */
  fee_amount_minor: number;
  /** The card-processing line the buyer was shown, in minor units. Written
   *  with the Checkout Session; null until one exists. */
  processing_fee_minor: number | null;
  /** The three lines added up: what the buyer was actually charged. Written
   *  with the Checkout Session, and the figure the funding webhook checks the
   *  payment against. */
  buyer_total_minor: number | null;
  buyer_approved_at: Date | null;
  seller_approved_at: Date | null;
  stripe_checkout_session: string | null;
  stripe_payment_intent: string | null;
  /** The release transfer to the seller, recorded when it is created. */
  stripe_transfer_id: string | null;
  evidence_manifest_key: string | null;
  /** When the seller declared the handover (the evidence-lock step). */
  handed_over_at: Date | null;
  /** The live clock: when the held payment goes to the seller on its own.
   *  Set at handover, and NULL again the moment the window ends, whichever
   *  way it ended — confirmed, disputed, or auto-released. */
  auto_release_at: Date | null;
  /** Which road this settlement took to 'confirmed': 'buyer-confirm' or
   *  'auto-release'. Null until it gets there. */
  confirmed_via: string | null;
  /** True when the window ran out and the clock released the payment. */
  auto_released: boolean;
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
  // The live clock, while there is one. It is NULL on every settlement whose
  // window has ended, so the field's presence is the window itself.
  if (s.auto_release_at) payload.auto_release_at = new Date(s.auto_release_at).toISOString();
  // Outbound-validated; declines stay reason-less as a server invariant on
  // top of the schema's additionalProperties:false.
  return assertReasonless(assertOutbound('settlement', payload));
}

/** A date an agent can say out loud: "Saturday 13 September". */
function plainDate(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * The switchboard's own words about the clock, for the agent to relay. Written
 * here so every read of a settlement in its window says the same thing, and
 * undefined when no window is running.
 */
export function autoReleaseNote(s: SettlementRow): string | undefined {
  if (!s.auto_release_at || !s.handed_over_at) return undefined;
  return (
    `Handed over on ${plainDate(new Date(s.handed_over_at))}; ` +
    'unless your human confirms or raises a problem, the payment releases to the seller on ' +
    `${plainDate(new Date(s.auto_release_at))}. Confirming and raising a problem both happen ` +
    'on their own approval page.'
  );
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
  // The scheduled context buys the clock exactly one step and nothing else.
  // Widening this is a deliberate edit with a test to match, never a side
  // effect of adding a transition somewhere.
  if (ctx.kind === 'scheduled') {
    const onlyStep = to === 'confirmed' && from.length === 1 && from[0] === 'evidence-locked';
    if (!onlyStep) {
      throw new Error(
        'a scheduled context allows only evidence-locked -> confirmed',
      );
    }
  }
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
  // The auto-release clock lives and dies here, alongside the state it hangs
  // off. Reaching 'confirmed' or 'disputed' ends the buyer's window, so the
  // clock is cleared in the same statement that ends it: there is no moment
  // where the state says the window is over and the clock says it is running.
  const clockSql =
    to === 'confirmed'
      ? ctx.kind === 'scheduled'
        ? `, auto_release_at = NULL, confirmed_via = 'auto-release', auto_released = true`
        : `, auto_release_at = NULL, confirmed_via = 'buyer-confirm'`
      : to === 'disputed'
        ? ', auto_release_at = NULL'
        : '';
  const r = await getPool().query(
    `UPDATE settlements SET state = $2, updated_at = now()${stampSql}${clockSql}
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
  // A settlement has to be worth more than the fee riding on it, or the
  // three lines the buyer sees make no sense. Refused here, before a row
  // exists, rather than at the Checkout Session.
  try {
    settlementBreakdown(toMinorUnits(input.amount, input.ccy), cfg);
  } catch {
    throw Object.assign(
      new Error('the amount is too small to settle through the switchboard'),
      { validation: true },
    );
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
  // One PAID settlement per match, ever: an introduction is one thing changing
  // hands once, so a fresh proposal after a release would ask the buyer to
  // pay for it twice. A declined or refunded one leaves the door open — the
  // two may have sorted it out and want to try again.
  const paid = await getPool().query(
    `SELECT id FROM settlements WHERE match_id = $1 AND state = 'released' LIMIT 1`,
    [input.match_id],
  );
  if (paid.rowCount) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'This introduction has already been paid and released. There is nothing further to settle on it.',
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
  return (r.rows as SettlementRow[]).map(withAutoReleaseNote);
}

export async function getSettlementForAgent(accountId: string, settlementId: string) {
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, accountId);
  return withAutoReleaseNote(s);
}

/** The wire payload, plus the switchboard's plain sentence about the clock
 *  when one is running. The note rides beside the validated payload rather
 *  than inside it: it is the switchboard talking to the agent about the
 *  settlement, and the settlement message itself stays exactly what the
 *  schema says it is. */
function withAutoReleaseNote(s: SettlementRow) {
  const payload = serializeSettlement(s);
  const text = autoReleaseNote(s);
  return text ? { ...payload, note: { text, provenance: 'switchboard-system' as const } } : payload;
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

/**
 * The seller declares the handover: funded -> evidence-locked. Photos are
 * welcome and optional; what the step means is "this changed hands", and it
 * is what starts the buyer's clock.
 *
 * handed_over_at and auto_release_at are written in the same statement as the
 * manifest key, immediately before the state moves, so a settlement that
 * reaches 'evidence-locked' always has a clock on it. autoReleaseDays comes
 * from config (SETTLEMENT_AUTO_RELEASE_DAYS) and is interpolated as an
 * integer number of days after a range check — never as free text.
 *
 * The state name stays 'evidence-locked'. Only the label the humans read
 * changed.
 */
export async function lockEvidence(
  ctx: HumanCtx,
  settlementId: string,
  manifestKey: string,
  autoReleaseDays: number,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  // Checked before any database access: the window is interpolated into SQL
  // as an integer, so it is a whole number of days in a sane range or the
  // handover does not happen at all.
  if (!Number.isInteger(autoReleaseDays) || autoReleaseDays < 1 || autoReleaseDays > 90) {
    throw new Error(`bad auto-release window ${autoReleaseDays}`);
  }
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
    auto_release_days: autoReleaseDays,
    recorded_via: ctx.recordedVia,
  });
  await getPool().query(
    `UPDATE settlements SET evidence_manifest_key = $2, handed_over_at = now(),
       auto_release_at = now() + make_interval(days => $3::int), updated_at = now()
     WHERE id = $1 AND state = 'funded'`,
    [settlementId, manifestKey, autoReleaseDays],
  );
  return applyTransition(ctx, settlementId, ['funded'], 'evidence-locked', 'evidence_locked_at');
}

/** Buyer confirms receipt: evidence-locked -> confirmed. The transfer to the
 *  seller is started by the same signed request; 'released' is recorded only
 *  when Stripe's webhook reports the transfer. */
export async function confirmReceipt(ctx: HumanCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'buyer') {
    throw Object.assign(new Error('only the buyer confirms receipt'), { notFound: true });
  }
  if (s.state === 'confirmed') return s; // idempotent: transfer retry path
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
 *  is recorded only from Stripe's webhook.
 *
 *  A dispute inside the buyer's window wins: this path is unchanged by the
 *  auto-release clock, and the transition clears auto_release_at as it lands,
 *  so the sweep can never find a disputed settlement to release. */
export async function openDispute(ctx: HumanCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, ctx.accountId);
  if (s.state === 'disputed') return s; // idempotent: refund retry path
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
// Scheduled transition (the auto-release sweep only).
// ---------------------------------------------------------------------------

/**
 * Settlements whose window has run out: 'evidence-locked', a clock that is
 * past, and a payment still sitting in the platform balance. A dispute or a
 * confirmation clears auto_release_at as it lands, so a settlement that moved
 * on is already out of this set by construction and the state check is the
 * belt to that brace.
 *
 * SKIP LOCKED is not what makes this safe under concurrent sweeps. The
 * transition itself is: applyTransition's `WHERE state = ANY(...)` is a
 * compare-and-swap, so of two sweeps looking at the same row exactly one wins
 * and the other is told the settlement is no longer 'evidence-locked'. On top
 * of that the release transfer carries the settlement id as its idempotency
 * key, so even a transfer attempted twice pays the seller once.
 */
export async function settlementsDueForAutoRelease(limit = 50): Promise<SettlementRow[]> {
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE state = 'evidence-locked'
       AND auto_release_at IS NOT NULL
       AND auto_release_at <= now()
     ORDER BY auto_release_at
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * Auto-releases whose transfer did not go through: 'confirmed', the clock's
 * doing, and no transfer recorded. The buyer's own confirmation has a retry
 * on their settlement page; an auto-release has nobody to press it, so the
 * sweep picks these up again on its next pass. No state changes here — the
 * settlement is already 'confirmed' — so this needs no transition context;
 * it is the money half alone, and the release's idempotency key means a
 * transfer that did in fact go out is never sent twice.
 */
export async function autoReleasesAwaitingTransfer(limit = 50): Promise<SettlementRow[]> {
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE state = 'confirmed' AND auto_released = true AND stripe_transfer_id IS NULL
     ORDER BY confirmed_at
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * The buyer's window ran out: evidence-locked -> confirmed, on the clock
 * rather than on anyone's word. The release transfer is started by the sweep
 * right after this, exactly as the buyer's own confirm route does it, and
 * 'released' still lands only from the transfer.created webhook.
 *
 * The row records which road it took — auto_released, confirmed_via — so a
 * settlement read afterwards says plainly that nobody pressed the button.
 */
export async function autoReleaseSettlement(
  ctx: ScheduledCtx,
  settlementId: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  // Belt to applyTransition's brace: this road is the clock's alone, so a
  // human or webhook context is refused at the door rather than at the
  // UPDATE. Checked before any database access.
  if (ctx.kind !== 'scheduled') {
    throw new Error('auto-release requires a scheduled context');
  }
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (s.state === 'confirmed') return s; // idempotent: transfer retry path
  await writeConsentEvent({
    event: 'settlement-auto-released',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: s.buyer_account,
    party: 'buyer',
    amount: Number(s.amount),
    ccy: s.ccy,
    handed_over_at: s.handed_over_at ? new Date(s.handed_over_at).toISOString() : null,
    auto_release_at: s.auto_release_at ? new Date(s.auto_release_at).toISOString() : null,
    recorded_via: ctx.job,
  });
  return applyTransition(ctx, settlementId, ['evidence-locked'], 'confirmed', 'confirmed_at');
}

// ---------------------------------------------------------------------------
// Webhook transitions (verified Stripe events only).
// ---------------------------------------------------------------------------

/** The buyer's money landed in the platform balance
 *  (checkout.session.completed / async_payment_succeeded): approved ->
 *  funded. The webhook handler verifies the payment matches the settlement
 *  first. */
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

/** transfer.created (the seller's money left the platform balance):
 *  confirmed -> released. */
export async function markReleased(ctx: WebhookCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  return applyTransition(ctx, settlementId, ['confirmed'], 'released', 'released_at');
}

/** charge.refunded: disputed -> refunded. */
export async function markRefunded(ctx: WebhookCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  return applyTransition(ctx, settlementId, ['disputed'], 'refunded', 'refunded_at');
}

/** Registry the property suite enumerates: every exported function that can
 *  change settlement state, with the context class it demands. */
export const SETTLEMENT_TRANSITIONS: Record<string, 'human' | 'webhook' | 'scheduled'> = {
  approveSettlement: 'human',
  declineSettlement: 'human',
  lockEvidence: 'human',
  confirmReceipt: 'human',
  openDispute: 'human',
  autoReleaseSettlement: 'scheduled',
  markFunded: 'webhook',
  markReleased: 'webhook',
  markRefunded: 'webhook',
};
