/**
 * Safe-hands settlements: the escrow state machine (phase 1.A).
 *
 *   proposed -> approved-by-buyer / approved-by-seller -> approved
 *            -> funded -> evidence-locked -> confirmed -> released
 *                                         -> disputed  -> resolution-proposed
 *                                                      -> resolved -> settled-split
 *                                                      -> refunded
 *   either human may decline while unfunded; declined / released / refunded /
 *   settled-split are TERMINAL.
 *
 * 'evidence-locked' is the seller declaring handover, and it starts the
 * buyer's window: SETTLEMENT_AUTO_RELEASE_DAYS to confirm receipt or dispute.
 * Confirming and disputing both end the window. Silence ends it too, and the
 * held payment goes to the seller — the same road confirmReceipt takes, walked
 * by the sweep in workers/settlementAutoRelease.ts.
 *
 * A DISPUTE FREEZES THE PAYMENT. It does not send the money back. Either human
 * can raise one while the payment is held, and they say why: 'not_arrived' for
 * a posted item that never turned up, 'not_as_described' for one that turned up
 * wrong — which is also the ground for anything handed over in person, since
 * there is no parcel to go astray. Three roads lead out, and every one of them
 * moves the AGREED AMOUNT or part of it and never a fee:
 *
 *   by agreement  either human proposes a split (refund_minor + release_minor,
 *                 which always add up to the agreed amount) and the settlement
 *                 sits in 'resolution-proposed' until the other approves the
 *                 same pair; then 'resolved' while the two legs move, then
 *                 'settled-split' when the provider's events report them.
 *   by return     the buyer marks it sent back with a tracking reference; the
 *                 seller confirms receipt, or goes quiet for
 *                 SETTLEMENT_RETURN_SILENCE_DAYS, and the agreed amount is
 *                 refunded.
 *   by the rule   at deadlock_at the default rule follows whichever side can
 *                 show where the parcel went: delivery tracking and no return
 *                 sent releases to the seller, a tracked return refunds the
 *                 buyer, and neither refunds the buyer.
 *
 * WHY EVERY AGREED RESOLUTION ENDS AT 'settled-split', even one that sends the
 * whole amount one way. The terminal state then says how the settlement ended —
 * the two of them agreed — rather than merely which direction the money went,
 * and 'released' keeps its single meaning: the buyer confirmed, or the clock
 * did it for them. One rule, no branch on the figures, and the settle-once
 * guard treats released, refunded and settled-split alike.
 *
 * deadlock_at is measured from disputed_at and never restarted. The terms say
 * "after fourteen days in dispute", so a seller adding delivery tracking on day
 * six leaves eight days on the clock rather than winding it back to fourteen.
 *
 * STRUCTURAL RULE (tested in test/unit/settlements.test.ts): every state
 * change flows through applyTransition(), the single place that writes
 * `UPDATE settlements ... state`, and applyTransition demands a transition
 * context minted in THIS module. There are three kinds and no more:
 *   - a human-action context (counterAction), minted only by the approval
 *     page's session-authenticated routes;
 *   - a webhook context (webhookAction), minted only by the verified Stripe
 *     webhook handler after signature verification;
 *   - a scheduled context (scheduledAction), minted only by the sweep in
 *     workers/settlementAutoRelease.ts, and good for exactly TWO steps, both
 *     of them a clock running out with nobody having pressed anything:
 *     evidence-locked -> confirmed (the buyer's window) and
 *     disputed / resolution-proposed -> confirmed (the default rule releasing
 *     to a seller who can show delivery). applyTransition refuses it for
 *     anything else. The rule's REFUNDS need no scheduled step at all: the
 *     sweep moves the money and 'refunded' still lands from the verified
 *     charge.refunded event, exactly as it does on a human's road.
 * There is no admin or agent code path that can mint any of the three; the
 * agent-facing surface (proposeSettlement / settlement reads) never
 * transitions past 'proposed'.
 */
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, sideOf, type MatchRow } from './matches.js';
import { OsbError, SCHEMA_VERSION, assertOutbound, assertReasonless } from '../protocol.js';
import { formatMinor, fromMinorUnits, settlementBreakdown, toMinorUnits } from '../stripe.js';
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

/**
 * Every step a scheduled context can take, and there are two. Both are a clock
 * running out with nobody having pressed anything: the buyer's window, and the
 * default rule releasing to a seller who can show delivery. Widening this list
 * is a deliberate edit with a test to match (test/unit/settlements.test.ts
 * pins it), never a side effect of adding a transition somewhere.
 */
const SCHEDULED_STEPS: { from: SettlementState[]; to: SettlementState }[] = [
  { from: ['evidence-locked'], to: 'confirmed' },
  { from: ['disputed', 'resolution-proposed'], to: 'confirmed' },
];

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

/** Mint a scheduled context. Call ONLY from the settlement sweep. It is good
 *  for the two steps in SCHEDULED_STEPS above and applyTransition refuses it
 *  for anything else. */
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
  | 'resolution-proposed'
  | 'resolved'
  | 'released'
  | 'refunded'
  | 'settled-split'
  | 'declined';

export const TERMINAL_STATES: SettlementState[] = [
  'released',
  'refunded',
  'settled-split',
  'declined',
];

/**
 * The states a frozen payment sits in while the two of them work it out. A
 * split on the table does not thaw anything: the return steps, the tracking
 * steps and the default rule all still apply, which is what the terms mean by
 * "fourteen days in dispute with no AGREED resolution".
 */
export const IN_DISPUTE: SettlementState[] = ['disputed', 'resolution-proposed'];

/** The dispute grounds, in the words the human picks on their own page. */
export type DisputeGround = 'not_arrived' | 'not_as_described';

/**
 * Which way the default rule falls, from the record alone. No judgment of the
 * item, and nobody pleads a case: it follows whichever side can show where the
 * parcel went. Exported because it is the whole of the rule, and it is worth
 * being able to read it in one place and test it without a database.
 */
export function deadlockOutcome(s: {
  returned_at: Date | null;
  delivery_tracking: string | null;
}): 'release' | 'refund' {
  // A tracked return sent: the item is on its way back, so the money goes back
  // with it. This beats delivery tracking, because both can be true at once.
  if (s.returned_at) return 'refund';
  // Delivery tracking and no return: the seller can show where it went.
  if (s.delivery_tracking) return 'release';
  // Neither: refunded to the buyer, because posting tracked is the seller's
  // responsibility.
  return 'refund';
}

/**
 * A split is two figures that add up to the agreed amount, and never a cent
 * more. Either may be zero; both may not be. Throws a validation error the
 * approval page renders as it stands.
 */
export function validateSplit(
  agreedMinor: number,
  refundMinor: number,
  releaseMinor: number,
): void {
  const bad = (msg: string) => Object.assign(new Error(msg), { validation: true });
  for (const n of [refundMinor, releaseMinor]) {
    if (!Number.isInteger(n) || n < 0) throw bad('Both figures have to be whole amounts of money, and neither can be less than nothing.');
  }
  if (refundMinor + releaseMinor !== agreedMinor) {
    throw bad('The two figures have to add up to exactly what was agreed. Only that amount is held.');
  }
}

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
  /** True when a clock, rather than a person, released the payment. */
  auto_released: boolean;
  /** Why the payment was frozen, chosen by the human who froze it. */
  dispute_ground: DisputeGround | null;
  disputed_by: string | null;
  disputed_at: Date | null;
  /** The live clock on a dispute: when the default rule decides. Set as the
   *  dispute lands, NULL again the moment the dispute ends. */
  deadlock_at: Date | null;
  /** What each side can show about where the parcel went. Human-typed text; a
   *  record, never a lookup. */
  delivery_tracking: string | null;
  return_tracking: string | null;
  returned_at: Date | null;
  return_received_at: Date | null;
  /** The two figures: a split while one is on the table, the record of what
   *  moved once anything has. They always add up to the agreed amount, and
   *  neither has ever included a fee. */
  refund_minor: number | null;
  release_minor: number | null;
  split_proposed_by: string | null;
  split_buyer_approved_at: Date | null;
  split_seller_approved_at: Date | null;
  /** The refund object, the way stripe_transfer_id records the transfer. */
  stripe_refund_id: string | null;
  /** Each leg of a split, stamped when the verified event reports it. */
  refund_leg_at: Date | null;
  release_leg_at: Date | null;
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
  // The dispute's own shape, so an agent can tell its human what is waiting on
  // them. Every one of these is a read; none of them is an agent action.
  if (s.dispute_ground) payload.dispute_ground = s.dispute_ground;
  if (s.deadlock_at) payload.deadlock_at = new Date(s.deadlock_at).toISOString();
  // Tracking references are typed by the other side's human, so they cross
  // labelled as what they are: text to show a person, never an instruction.
  if (s.delivery_tracking) {
    payload.delivery_tracking = { text: s.delivery_tracking, provenance: 'counterparty-untrusted' };
  }
  if (s.return_tracking) {
    payload.return_tracking = { text: s.return_tracking, provenance: 'counterparty-untrusted' };
  }
  // The split, while one is on the table or once it has moved. Gated on a
  // human having PROPOSED it: the sweep's rules write the same two columns
  // when they decide a settlement, and "the rule sent it back" is not a
  // resolution the two of them agreed, so it does not go out wearing that
  // word.
  if (s.split_proposed_by
      && s.refund_minor !== null && s.refund_minor !== undefined
      && s.release_minor !== null && s.release_minor !== undefined) {
    payload.resolution = {
      refund_to_buyer: fromMinorUnits(s.refund_minor, s.ccy),
      release_to_seller: fromMinorUnits(s.release_minor, s.ccy),
      approved_by_buyer: !!s.split_buyer_approved_at,
      approved_by_seller: !!s.split_seller_approved_at,
    };
  }
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

/**
 * The switchboard's own words about a frozen payment, for the agent to relay.
 *
 * ONE RULE runs through every sentence below: it says what is waiting on the
 * agent's human and where they do it, and it never suggests the agent can do
 * any of it. Raising a problem, adding a tracking reference, marking something
 * sent back, agreeing a split — all of them are the human's, on their own
 * approval page, the same as every other gate on the switchboard.
 *
 * `link` is the human's page for this settlement, so the sentence can end
 * somewhere they can actually go.
 */
export function disputeNote(
  s: SettlementRow,
  side: 'buyer' | 'seller',
  link: string,
): string | undefined {
  if (!IN_DISPUTE.includes(s.state)) return undefined;
  const by = s.deadlock_at ? plainDate(new Date(s.deadlock_at)) : undefined;
  const money = (minor: number | null) =>
    minor === null || minor === undefined ? '' : formatMinor(minor, s.ccy);
  const tail = by
    ? ` If the two of them agree on nothing by ${by}, the payment goes to whichever side can show where the item went.`
    : '';
  const page = ` It happens on their own approval page: ${link}.`;

  // A split is on the table and it is this human's turn to say yes or no.
  const mine = side === 'buyer' ? s.split_buyer_approved_at : s.split_seller_approved_at;
  if (s.state === 'resolution-proposed' && !mine) {
    return (
      `A way to settle this is on the table: ${money(s.refund_minor)} back to the buyer and ` +
      `${money(s.release_minor)} to the seller. Only your human can accept it, and the money ` +
      `moves once they both have.${page}${tail}`
    );
  }
  if (s.state === 'resolution-proposed' && mine) {
    return (
      `Your human has agreed to ${money(s.refund_minor)} back to the buyer and ` +
      `${money(s.release_minor)} to the seller. Nothing moves until the other side agrees to the ` +
      `same two figures.${tail}`
    );
  }
  // A return is under way.
  if (s.returned_at && !s.return_received_at) {
    return side === 'seller'
      ? `The buyer says they have sent it back. Once your human says they have it, the agreed amount goes back to the buyer; if they say nothing, it goes back on its own after a week.${page}`
      : `You have said it is on its way back. The agreed amount goes back to your human once the seller says they have it, or after a week of them saying nothing.${tail}`;
  }
  // Nothing arrived, and the seller has a short while to show it was sent.
  if (s.dispute_ground === 'not_arrived' && !s.delivery_tracking) {
    return side === 'seller'
      ? `The buyer says it never arrived. Your human has seven days from the day this came up to add the tracking that shows it was delivered, and the agreed amount goes back to the buyer if nothing is added.${page}`
      : `You have said it never arrived. The seller has seven days to add tracking showing it was delivered; with nothing added, the agreed amount comes back to your human.${tail}`;
  }
  // The general frozen case.
  return (
    'The payment is frozen while the two of them sort this out. Your human can propose how to ' +
    'split what is held, agree to a split the other side has proposed, or say they have sent the ' +
    `item back.${page}${tail}`
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
  // The scheduled context buys the clocks their steps and nothing else.
  // Widening SCHEDULED_STEPS is a deliberate edit with a test to match, never
  // a side effect of adding a transition somewhere.
  if (ctx.kind === 'scheduled') {
    const allowed = SCHEDULED_STEPS.some(
      (step) =>
        step.to === to &&
        step.from.length === from.length &&
        step.from.every((f, i) => from[i] === f),
    );
    if (!allowed) {
      throw new Error(
        'a scheduled context allows only the steps in SCHEDULED_STEPS: ' +
          SCHEDULED_STEPS.map((s) => `${s.from.join('/')} -> ${s.to}`).join(', '),
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
    'resolution_proposed_at',
    'resolved_at',
    'settled_split_at',
  ];
  if (stamp && !allowedStamps.includes(stamp)) throw new Error(`bad stamp ${stamp}`);
  const stampSql = stamp ? `, ${stamp} = now()` : '';
  // Both clocks live and die here, alongside the state they hang off, so there
  // is never a moment where the state says a window is over and a clock says
  // it is still running.
  //
  //  - the buyer's window ends at 'confirmed' or 'disputed';
  //  - the dispute's window ends wherever the dispute ends: released through
  //    'confirmed' by the default rule, refunded, or settled by agreement.
  //
  // 'confirmed' also records WHICH road it took, and the scheduled context has
  // two: the buyer's window running out, and the default rule releasing to a
  // seller who could show delivery. Both are the clock rather than a person,
  // so both set auto_released.
  const scheduledVia = from.includes('evidence-locked') ? 'auto-release' : 'deadlock';
  const clockSql =
    to === 'confirmed'
      ? ctx.kind === 'scheduled'
        ? `, auto_release_at = NULL, deadlock_at = NULL, confirmed_via = '${scheduledVia}', auto_released = true`
        : `, auto_release_at = NULL, deadlock_at = NULL, confirmed_via = 'buyer-confirm'`
      : to === 'disputed'
        ? ', auto_release_at = NULL'
        : to === 'refunded' || to === 'settled-split'
          ? ', deadlock_at = NULL'
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
  // One FINISHED protected payment per introduction, ever. The terms put it
  // plainly: after a protected payment has been released or refunded, no
  // further protected payment can be opened on the same introduction. That
  // covers a settlement that went one way ('released'), one that went the
  // other ('refunded' — by return, or by the default rule) and one the two of
  // them divided between themselves ('settled-split'). A DECLINED one leaves
  // the door open, because nothing was ever paid.
  const finished = await getPool().query(
    `SELECT id FROM settlements
     WHERE match_id = $1 AND state IN ('released','refunded','settled-split') LIMIT 1`,
    [input.match_id],
  );
  if (finished.rowCount) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'A protected payment on this introduction has already finished. There is nothing further to settle on it, so anything else the two of them arrange is between them.',
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
  cfg: Config,
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
  return (r.rows as SettlementRow[]).map((row) => withNote(cfg, row, accountId));
}

/**
 * The live settlement on each of these introductions, for the check_in sweep,
 * keyed by introduction. One statement for the whole sweep rather than one per
 * introduction.
 *
 * "Live" means not finished: a settlement that has been released, refunded,
 * split or declined is history, and the sweep is about what is waiting on
 * somebody. The note beside each one says exactly that, in the plain register,
 * and always points at the human's own page.
 */
export async function liveSettlementsForSweep(
  cfg: Config,
  accountId: string,
  matchIds: string[],
): Promise<Map<string, ReturnType<typeof withNote>>> {
  const out = new Map<string, ReturnType<typeof withNote>>();
  if (!matchIds.length) return out;
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE match_id = ANY($1::uuid[])
       AND (buyer_account = $2 OR seller_account = $2)
       AND state <> ALL($3::text[])
     ORDER BY created_at DESC`,
    [matchIds, accountId, TERMINAL_STATES],
  );
  for (const row of r.rows as SettlementRow[]) {
    // Newest first, and one per introduction: only one settlement is ever live
    // on an introduction, so the first is the only.
    if (!out.has(row.match_id)) out.set(row.match_id, withNote(cfg, row, accountId));
  }
  return out;
}

export async function getSettlementForAgent(
  cfg: Config,
  accountId: string,
  settlementId: string,
) {
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  partyOf(s, accountId);
  return withNote(cfg, s, accountId);
}

/** The human's own page for this settlement — the one place any of these
 *  steps happens, and the address the agent relays rather than invents. */
export function settlementPageLink(cfg: Config, settlementId: string): string {
  return `${cfg.counterOrigin}/settlements/${settlementId}`;
}

/** The wire payload, plus the switchboard's plain sentence about whatever is
 *  waiting on this agent's human: the clock while one is running, and what a
 *  frozen payment needs from them while it is frozen. The note rides beside
 *  the validated payload rather than inside it: it is the switchboard talking
 *  to the agent about the settlement, and the settlement message itself stays
 *  exactly what the schema says it is. */
export function withNote(cfg: Config, s: SettlementRow, accountId: string) {
  const payload = serializeSettlement(s);
  let side: 'buyer' | 'seller' | undefined;
  try {
    side = partyOf(s, accountId);
  } catch {
    side = undefined;
  }
  const text =
    autoReleaseNote(s) ??
    (side ? disputeNote(s, side, settlementPageLink(cfg, s.id)) : undefined);
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

/**
 * Either human freezes a held payment: funded/evidence-locked -> disputed.
 *
 * IT FREEZES; IT DOES NOT REFUND. Nothing moves here. The money sits exactly
 * where it was and the two of them get room to sort it out, on the three roads
 * described in this file's header. The old behaviour — the whole buyer total
 * straight back, our fee and Stripe's cut with it — gave a buyer who had the
 * item in their hands a free way to keep it, and cost the platform the
 * processing on every round trip.
 *
 * The ground is the disputer's word for what went wrong. An in-person handover
 * has no parcel to go astray, so it disputes as 'not_as_described'.
 *
 * A dispute inside the buyer's window wins: the transition clears
 * auto_release_at as it lands, so the sweep can never find a frozen settlement
 * to release on the handover clock. In its place it starts the dispute's own
 * clock, deadlock_at, written in the same guarded statement as the ground.
 */
export async function openDispute(
  ctx: HumanCtx,
  settlementId: string,
  ground: DisputeGround,
  deadlockDays: number,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  // Checked before any database access: the window is interpolated into SQL as
  // an integer, so it is a whole number of days in a sane range or the dispute
  // does not happen at all.
  if (!Number.isInteger(deadlockDays) || deadlockDays < 1 || deadlockDays > 90) {
    throw new Error(`bad dispute window ${deadlockDays}`);
  }
  if (ground !== 'not_arrived' && ground !== 'not_as_described') {
    throw Object.assign(new Error('a dispute says which of the two things went wrong'), {
      validation: true,
    });
  }
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const party = partyOf(s, ctx.accountId);
  if (IN_DISPUTE.includes(s.state)) return s; // idempotent: already frozen
  await writeConsentEvent({
    event: 'settlement-disputed',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party,
    ground,
    deadlock_days: deadlockDays,
    recorded_via: ctx.recordedVia,
  });
  await getPool().query(
    `UPDATE settlements SET dispute_ground = $2, disputed_by = $3,
       deadlock_at = now() + make_interval(days => $4::int), updated_at = now()
     WHERE id = $1 AND state IN ('funded','evidence-locked')`,
    [settlementId, ground, ctx.accountId, deadlockDays],
  );
  return applyTransition(
    ctx,
    settlementId,
    ['funded', 'evidence-locked'],
    'disputed',
    'disputed_at',
  );
}

/**
 * The seller's tracking reference for sending the item. It can arrive at the
 * handover, before anything has gone wrong, or inside a dispute as the answer
 * to "it never arrived".
 *
 * Adding it changes the GROUND, not the clock. A 'not_arrived' dispute becomes
 * 'not_as_described' — the argument is now about the item rather than the
 * post — and deadlock_at stays exactly where it was, because the terms say
 * "after fourteen days in dispute" and that is measured from the day the
 * dispute landed.
 *
 * Moves no state, so it needs no transition beyond the human context that
 * proves whose hand this is.
 */
export async function addDeliveryTracking(
  ctx: HumanCtx,
  settlementId: string,
  tracking: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const reference = trackingReference(tracking);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'seller') {
    throw Object.assign(new Error('the seller is the one who posted it'), { notFound: true });
  }
  await writeConsentEvent({
    event: 'settlement-delivery-tracking-added',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party: 'seller',
    tracking: reference,
    recorded_via: ctx.recordedVia,
  });
  const r = await getPool().query(
    `UPDATE settlements SET delivery_tracking = $2,
       dispute_ground = CASE WHEN dispute_ground = 'not_arrived' THEN 'not_as_described'
                             ELSE dispute_ground END,
       updated_at = now()
     WHERE id = $1 AND state IN ('funded','evidence-locked','disputed','resolution-proposed')
     RETURNING *`,
    [settlementId, reference],
  );
  return afterSideWrite(r, settlementId);
}

/**
 * The buyer says the item is on its way back, with the reference that shows
 * it. This is the second road out of a dispute: when the seller confirms they
 * have it, or goes quiet for SETTLEMENT_RETURN_SILENCE_DAYS, the agreed amount
 * goes back to the buyer.
 *
 * Tracking is required here and it is required for a reason worth saying to a
 * person: the default rule follows whoever can show where the parcel went, and
 * an untracked return shows nothing.
 */
export async function markReturned(
  ctx: HumanCtx,
  settlementId: string,
  tracking: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const reference = trackingReference(tracking);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'buyer') {
    throw Object.assign(new Error('the buyer is the one sending it back'), { notFound: true });
  }
  await writeConsentEvent({
    event: 'settlement-returned',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party: 'buyer',
    tracking: reference,
    recorded_via: ctx.recordedVia,
  });
  const r = await getPool().query(
    `UPDATE settlements SET return_tracking = $2,
       returned_at = COALESCE(returned_at, now()), updated_at = now()
     WHERE id = $1 AND state IN ('disputed','resolution-proposed')
     RETURNING *`,
    [settlementId, reference],
  );
  return afterSideWrite(r, settlementId);
}

/**
 * The seller says the returned item is back with them. The agreed amount then
 * goes to the buyer: this function records the figures and the receipt, and
 * the route that called it moves the money. 'refunded' still lands from the
 * verified charge.refunded event, the same as on every other refunding road.
 */
export async function confirmReturnReceived(
  ctx: HumanCtx,
  settlementId: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (partyOf(s, ctx.accountId) !== 'seller') {
    throw Object.assign(new Error('the seller is the one receiving it back'), { notFound: true });
  }
  if (!s.returned_at) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'The buyer has not said they sent it back yet.',
    });
  }
  await writeConsentEvent({
    event: 'settlement-return-received',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party: 'seller',
    amount: Number(s.amount),
    ccy: s.ccy,
    recorded_via: ctx.recordedVia,
  });
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  const r = await getPool().query(
    `UPDATE settlements SET return_received_at = COALESCE(return_received_at, now()),
       refund_minor = $2, release_minor = 0, updated_at = now()
     WHERE id = $1 AND state IN ('disputed','resolution-proposed')
     RETURNING *`,
    [settlementId, agreedMinor],
  );
  return afterSideWrite(r, settlementId);
}

/**
 * Either human puts a way out on the table: two figures that add up to the
 * agreed amount. disputed -> resolution-proposed, and proposing is agreeing,
 * so the proposer's own approval is stamped here.
 *
 * A COUNTER-PROPOSAL REPLACES WHAT WAS THERE. Proposing from
 * 'resolution-proposed' overwrites both figures and clears the other side's
 * approval, because nobody has agreed to a pair of numbers they have not seen.
 * Only the same two figures, approved by both, ever move money.
 */
export async function proposeResolution(
  ctx: HumanCtx,
  settlementId: string,
  refundMinor: number,
  releaseMinor: number,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const party = partyOf(s, ctx.accountId);
  validateSplit(toMinorUnits(Number(s.amount), s.ccy), refundMinor, releaseMinor);
  await writeConsentEvent({
    event: 'settlement-resolution-proposed',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party,
    refund_minor: refundMinor,
    release_minor: releaseMinor,
    ccy: s.ccy,
    recorded_via: ctx.recordedVia,
  });
  await getPool().query(
    `UPDATE settlements SET refund_minor = $2, release_minor = $3, split_proposed_by = $4,
       split_buyer_approved_at  = CASE WHEN $5 = 'buyer'  THEN now() ELSE NULL END,
       split_seller_approved_at = CASE WHEN $5 = 'seller' THEN now() ELSE NULL END,
       updated_at = now()
     WHERE id = $1 AND state IN ('disputed','resolution-proposed')`,
    [settlementId, refundMinor, releaseMinor, ctx.accountId, party],
  );
  return applyTransition(
    ctx,
    settlementId,
    ['disputed', 'resolution-proposed'],
    'resolution-proposed',
    'resolution_proposed_at',
  );
}

/**
 * The other human agrees to the SAME two figures: resolution-proposed ->
 * resolved. The route that called this then moves both legs; 'settled-split'
 * lands once the provider's verified events report them.
 *
 * The figures are passed back in so that agreeing is agreeing to what was
 * shown. A split that changed between the page rendering and the button being
 * pressed is refused rather than quietly approved.
 */
export async function approveResolution(
  ctx: HumanCtx,
  settlementId: string,
  sawRefundMinor: number,
  sawReleaseMinor: number,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const party = partyOf(s, ctx.accountId);
  if (s.state === 'resolved' || s.state === 'settled-split') return s; // idempotent
  if (s.refund_minor === null || s.release_minor === null) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'There is no way out on the table to agree to yet.',
    });
  }
  if (s.refund_minor !== sawRefundMinor || s.release_minor !== sawReleaseMinor) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'The two figures changed while you were looking at them. Open the page again and check what is on the table now.',
    });
  }
  if (s.split_proposed_by === ctx.accountId) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'You are the one who proposed this. It is waiting on the other side now.',
    });
  }
  await writeConsentEvent({
    event: 'settlement-resolution-approved',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: ctx.accountId,
    party,
    refund_minor: s.refund_minor,
    release_minor: s.release_minor,
    ccy: s.ccy,
    recorded_via: ctx.recordedVia,
  });
  await getPool().query(
    `UPDATE settlements SET
       split_buyer_approved_at  = COALESCE(split_buyer_approved_at,  CASE WHEN $2 = 'buyer'  THEN now() END),
       split_seller_approved_at = COALESCE(split_seller_approved_at, CASE WHEN $2 = 'seller' THEN now() END),
       updated_at = now()
     WHERE id = $1 AND state IN ('resolution-proposed')`,
    [settlementId, party],
  );
  return applyTransition(ctx, settlementId, ['resolution-proposed'], 'resolved', 'resolved_at');
}

/**
 * A tracking reference as a person typed it: trimmed, capped, and refused when
 * empty. It is a record to show the other human, never a lookup — the
 * switchboard calls no courier about it — so nothing here validates a format
 * that varies by country and carrier.
 */
function trackingReference(raw: string): string {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!t) {
    throw Object.assign(new Error('a tracking reference is needed here'), { validation: true });
  }
  return t.slice(0, 200);
}

/** The row after a write that touches everything but the state. An empty
 *  result means the settlement had moved on, and that is the same news
 *  applyTransition gives, in the same words. */
async function afterSideWrite(
  r: { rows: SettlementRow[] },
  settlementId: string,
): Promise<SettlementRow> {
  if (r.rows[0]) return r.rows[0];
  const cur = await getSettlement(settlementId);
  if (!cur) throw Object.assign(new Error('settlement not found'), { notFound: true });
  throw new OsbError('NOT_UNLOCKED_YET', {
    human_action: `This settlement is '${cur.state}'; that step does not apply now.`,
  });
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
// The dispute clocks, for the same sweep.
//
// Three rules, three working sets. None of them judges anything: each one is a
// question about what the two people did and when, answered in SQL.
//
// The DAY COUNTS are interpolated as integers after a range check, exactly as
// the handover window is, because they come from config rather than from
// anybody's input.
// ---------------------------------------------------------------------------

function wholeDays(days: number, what: string): number {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error(`bad ${what} ${days}`);
  return days;
}

/**
 * The buyer marked a tracked return and the seller has said nothing since.
 * After SETTLEMENT_RETURN_SILENCE_DAYS the agreed amount goes back.
 *
 * A settlement whose refund has already been sent (stripe_refund_id written as
 * the API returned) is out of the set, so a slow webhook never buys a second
 * refund. The refund's idempotency key is the belt to that brace.
 */
export async function settlementsDueForReturnRefund(
  silenceDays: number,
  limit = 50,
): Promise<SettlementRow[]> {
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE state IN ('disputed','resolution-proposed')
       AND returned_at IS NOT NULL
       AND return_received_at IS NULL
       AND stripe_refund_id IS NULL
       AND returned_at + make_interval(days => $1::int) <= now()
     ORDER BY returned_at
     LIMIT $2`,
    [wholeDays(silenceDays, 'return silence window'), limit],
  );
  return r.rows;
}

/**
 * A dispute on the ground that a posted item never arrived, with no delivery
 * tracking added inside SETTLEMENT_TRACKING_GRACE_DAYS. The agreed amount goes
 * back to the buyer, because posting with tracking is the seller's
 * responsibility.
 *
 * Adding tracking moves the ground to 'not_as_described', so a seller who
 * answered is out of this set by construction and the tracking check is the
 * belt to that brace.
 */
export async function settlementsDueForNeverArrivedRefund(
  graceDays: number,
  limit = 50,
): Promise<SettlementRow[]> {
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE state IN ('disputed','resolution-proposed')
       AND dispute_ground = 'not_arrived'
       AND delivery_tracking IS NULL
       AND returned_at IS NULL
       AND stripe_refund_id IS NULL
       AND disputed_at IS NOT NULL
       AND disputed_at + make_interval(days => $1::int) <= now()
     ORDER BY disputed_at
     LIMIT $2`,
    [wholeDays(graceDays, 'tracking grace window'), limit],
  );
  return r.rows;
}

/**
 * A dispute the two of them never resolved. deadlock_at is the live clock: it
 * is written as the dispute lands and cleared the moment the dispute ends,
 * whichever way it ended, so a settlement that moved on is already out of this
 * set and the state check is the belt to that brace.
 *
 * A settlement with a refund already sent is out too — the return road and the
 * never-arrived road both fire before this one and both leave that mark.
 */
export async function settlementsDueForDeadlock(limit = 50): Promise<SettlementRow[]> {
  const r = await getPool().query(
    `SELECT * FROM settlements
     WHERE state IN ('disputed','resolution-proposed')
       AND deadlock_at IS NOT NULL
       AND deadlock_at <= now()
       AND stripe_refund_id IS NULL
     ORDER BY deadlock_at
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * The default rule released it: disputed / resolution-proposed -> confirmed,
 * on the clock rather than on anyone's word, for a seller who could show
 * delivery with no return sent against it. From here the sweep transfers the
 * agreed amount and 'released' lands from transfer.created, exactly as it does
 * when a buyer confirms.
 *
 * The row records which road it took — auto_released, confirmed_via
 * 'deadlock' — so a settlement read afterwards says plainly that nobody
 * pressed anything and which rule decided it.
 */
export async function deadlockReleaseSettlement(
  ctx: ScheduledCtx,
  settlementId: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  // Belt to applyTransition's brace: this road is the clock's alone, so a
  // human or webhook context is refused at the door rather than at the UPDATE.
  if (ctx.kind !== 'scheduled') {
    throw new Error('the default rule requires a scheduled context');
  }
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  if (s.state === 'confirmed') return s; // idempotent: transfer retry path
  if (deadlockOutcome(s) !== 'release') {
    throw new Error('the default rule does not release this settlement');
  }
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  await writeConsentEvent({
    event: 'settlement-deadlock-released',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: s.seller_account,
    party: 'seller',
    amount: Number(s.amount),
    ccy: s.ccy,
    disputed_at: s.disputed_at ? new Date(s.disputed_at).toISOString() : null,
    deadlock_at: s.deadlock_at ? new Date(s.deadlock_at).toISOString() : null,
    delivery_tracking: s.delivery_tracking,
    recorded_via: ctx.job,
  });
  await getPool().query(
    `UPDATE settlements SET refund_minor = 0, release_minor = $2, updated_at = now()
     WHERE id = $1 AND state IN ('disputed','resolution-proposed')`,
    [settlementId, agreedMinor],
  );
  return applyTransition(
    ctx,
    settlementId,
    ['disputed', 'resolution-proposed'],
    'confirmed',
    'confirmed_at',
  );
}

/**
 * The two figures a refunding rule is about to move, written down BEFORE the
 * money moves so the row says what was meant even if the refund fails. The
 * refund is always of the agreed amount here — the fees stay paid, in every
 * outcome, because the processor keeps its own fee on a refund.
 *
 * This moves no state: 'refunded' still lands from the verified charge event.
 */
export async function recordRuleRefund(
  ctx: ScheduledCtx,
  settlementId: string,
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  if (ctx.kind !== 'scheduled') throw new Error('a rule refund requires a scheduled context');
  const s = await getSettlement(settlementId);
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  await writeConsentEvent({
    event: 'settlement-rule-refunded',
    settlement_id: settlementId,
    match_id: s.match_id,
    account_id: s.buyer_account,
    party: 'buyer',
    amount: Number(s.amount),
    ccy: s.ccy,
    ground: s.dispute_ground,
    returned_at: s.returned_at ? new Date(s.returned_at).toISOString() : null,
    delivery_tracking: s.delivery_tracking,
    recorded_via: ctx.job,
  });
  const r = await getPool().query(
    `UPDATE settlements SET refund_minor = $2, release_minor = 0, updated_at = now()
     WHERE id = $1 AND state IN ('disputed','resolution-proposed')
     RETURNING *`,
    [settlementId, agreedMinor],
  );
  return afterSideWrite(r, settlementId);
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

/** charge.refunded on a frozen payment: disputed / resolution-proposed ->
 *  refunded. This is the end of the return road and of the default rule's
 *  refunding half; what came back is the agreed amount, recorded in
 *  refund_minor before the refund was sent. The fees stay paid. */
export async function markRefunded(ctx: WebhookCtx, settlementId: string): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  return applyTransition(
    ctx,
    settlementId,
    ['disputed', 'resolution-proposed'],
    'refunded',
    'refunded_at',
  );
}

/**
 * One leg of an agreed split has landed: charge.refunded for the buyer's part,
 * transfer.created for the seller's. The settlement reaches 'settled-split'
 * once every leg that had money in it is stamped — a leg of zero is skipped
 * rather than sent, so it is never waited for.
 *
 * The stamp and the check are one statement apart on purpose: the stamp is the
 * fact the event carries, and the transition is a compare-and-swap on
 * 'resolved', so two events arriving together settle the settlement once.
 */
export async function markSplitLeg(
  ctx: WebhookCtx,
  settlementId: string,
  leg: 'refund' | 'release',
): Promise<SettlementRow> {
  assertTransitionContext(ctx);
  const column = leg === 'refund' ? 'refund_leg_at' : 'release_leg_at';
  const stamped = await getPool().query(
    `UPDATE settlements SET ${column} = COALESCE(${column}, now()), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [settlementId],
  );
  const s: SettlementRow | undefined = stamped.rows[0];
  if (!s) throw Object.assign(new Error('settlement not found'), { notFound: true });
  const owed = (minor: number | null, at: Date | null) => (minor ?? 0) > 0 && !at;
  if (owed(s.refund_minor, s.refund_leg_at) || owed(s.release_minor, s.release_leg_at)) {
    return s; // the other leg is still on its way
  }
  return applyTransition(ctx, settlementId, ['resolved'], 'settled-split', 'settled_split_at');
}

/** Registry the property suite enumerates: every exported function that can
 *  change settlement state, with the context class it demands. */
export const SETTLEMENT_TRANSITIONS: Record<string, 'human' | 'webhook' | 'scheduled'> = {
  approveSettlement: 'human',
  declineSettlement: 'human',
  lockEvidence: 'human',
  confirmReceipt: 'human',
  openDispute: 'human',
  proposeResolution: 'human',
  approveResolution: 'human',
  autoReleaseSettlement: 'scheduled',
  deadlockReleaseSettlement: 'scheduled',
  markFunded: 'webhook',
  markReleased: 'webhook',
  markRefunded: 'webhook',
  markSplitLeg: 'webhook',
};

/**
 * The exported functions that write a settlement's record without touching its
 * state — tracking, a return, a receipt, the figures a rule is about to move.
 * They still demand a minted context, so the same rule holds as everywhere
 * else: nothing an agent or an operator can reach writes any of this.
 */
export const SETTLEMENT_RECORD_WRITERS: Record<string, 'human' | 'scheduled'> = {
  addDeliveryTracking: 'human',
  markReturned: 'human',
  confirmReturnReceived: 'human',
  recordRuleRefund: 'scheduled',
};
