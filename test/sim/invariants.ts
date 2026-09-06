/**
 * The universal properties the switchboard must hold, everywhere, always.
 *
 * Every scenario and every fuzz step funnels its agent-facing payloads through
 * here. A violation is a real defect — it fails loudly with a repro
 * description (what payload, what leaked) rather than being swallowed. These
 * are deliberately black-box: they read only what an agent can see over MCP.
 *
 *   I1  no price ceiling / floor / band in any agent-facing payload, ever
 *   I2  no first name / locality before BOTH stage-3 opt-ins
 *   I3  no MCP accept path (asserted against the live tools list + dispatch)
 *   I4  stage / `next` never moves backward for a match
 *   I5  declines are reasonless
 *   I6  archived matches stay retrievable but never resurface as actionable
 *   I7  no match score and no integer stage in any agent-facing payload
 *
 * And the money half — safe hands, where a wrong answer costs somebody real
 * currency. These five are checked against the DATABASE and STRIPE, never
 * against what an API call said about itself: every state that matters lands
 * from a signature-verified webhook, so a 200 from the counter proves only
 * that the request was accepted.
 *
 *   I8   a settlement reaches 'funded' only after BOTH humans approved, and
 *        the WORM consent log holds both approvals
 *   I9   no agent-reachable tool can approve, confirm, release or refund
 *   I10  the release transfer is the agreed amount EXACTLY, and the buyer's
 *        charge is the three persisted lines added up
 *   I11  a dispute refunds the buyer's whole total, once, with no transfer
 *   I12  a settle proposal from the wrong side or the wrong stage is refused
 */

export interface Violation {
  invariant: string;
  detail: string;
  where: string;
  /** enough to reproduce: the offending payload (truncated) */
  payload?: string;
}

/** Keys that carry a private price band or a card's negotiation box. `amount`
 *  and `ccy` are NOT here — a deliberate `ask` and an offer figure are meant to
 *  cross. */
const FORBIDDEN_PRICE_KEYS = new Set([
  'price',
  'band',
  'price_band',
  'budget',
  'reserve',
  'mandate',
  'negotiation_mode',
  'authored_by',
]);

/** Keys that expose a machine internal an agent must never be handed. */
const FORBIDDEN_MACHINE_KEYS = new Set(['score', 'stage_unlocked', 'threshold', 'embedding']);

function deepKeys(o: any, path: string, hit: (k: string, path: string, value: any) => void): void {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    hit(k, path, v);
    deepKeys(v, `${path}.${k}`, hit);
  }
}

/** I1 + I7: scan a raw payload for any forbidden price/negotiation key or any
 *  machine internal (score/stage). Applied to EVERYTHING an agent sees. */
export function scanForbidden(raw: string, where: string): Violation[] {
  const out: Violation[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out; // not JSON (should not happen on an MCP payload)
  }
  deepKeys(parsed, '$', (k, path, value) => {
    if (FORBIDDEN_PRICE_KEYS.has(k)) {
      out.push({ invariant: 'I1', detail: `forbidden price/negotiation key "${k}"`, where: `${where} at ${path}.${k}`, payload: raw.slice(0, 600) });
    }
    if (FORBIDDEN_MACHINE_KEYS.has(k)) {
      out.push({ invariant: 'I7', detail: `machine-internal key "${k}"`, where: `${where} at ${path}.${k}`, payload: raw.slice(0, 600) });
    }
    // An integer `stage` field in OUTPUT is a leak. Nothing an agent sends
    // carries one either any more — an unlock is asked for by name, on `step`
    // — so a number under this key can only have come from the inside.
    if (k === 'stage' && typeof value === 'number') {
      out.push({ invariant: 'I7', detail: 'integer stage in output', where: `${where} at ${path}.stage`, payload: raw.slice(0, 600) });
    }
  });
  return out;
}

/**
 * I2: identity must not appear before both opt-ins. `identityStrings` are the
 * real first names / areas on file across the run. If a payload is from a match
 * that has NOT reached both-sides-opted-in (and is not an archived record,
 * which legitimately retains the disclosed identity), none of them may appear,
 * and the structural keys first_name / locality / mutual must be absent.
 */
export function scanIdentityLeak(
  raw: string,
  identityStrings: string[],
  where: string,
): Violation[] {
  const out: Violation[] = [];
  for (const s of identityStrings) {
    if (s && raw.includes(`"${s}"`)) {
      out.push({ invariant: 'I2', detail: `identity string "${s}" present before both opt-ins`, where, payload: raw.slice(0, 600) });
    }
  }
  if (/"(first_name|locality|mutual)"\s*:/.test(raw)) {
    out.push({ invariant: 'I2', detail: 'first_name/locality/mutual key present before both opt-ins', where, payload: raw.slice(0, 600) });
  }
  return out;
}

/** I4: the ladder of `next` words, as a monotonic rank. `awaiting_your_human`
 *  sits at the stage-3 landing (one opt-in recorded, waiting on the human), so
 *  it ranks above details_unlocked and below ready_to_talk. */
const NEXT_RANK: Record<string, number> = {
  show_interest: 0,
  awaiting_other_side: 1,
  details_unlocked: 2,
  awaiting_your_human: 3,
  ready_to_talk: 4,
};

export class LadderTracker {
  private readonly high = new Map<string, { rank: number; word: string }>();

  /** Feed a match's current `next`. Returns a violation if it regressed. A
   *  terminal state (archived/declined → next undefined) is exempt. */
  observe(matchId: string, next: string | undefined, where: string): Violation | undefined {
    if (!next) return undefined;
    const rank = NEXT_RANK[next];
    if (rank === undefined) return undefined; // unknown word — not our ladder
    const prev = this.high.get(matchId);
    if (prev && rank < prev.rank) {
      return {
        invariant: 'I4',
        detail: `next moved backward: ${prev.word} (rank ${prev.rank}) -> ${next} (rank ${rank})`,
        where,
      };
    }
    if (!prev || rank > prev.rank) this.high.set(matchId, { rank, word: next });
    return undefined;
  }
}

/** I5: a decline response must carry nothing shaped like a reason. */
export function scanDeclineReasonless(raw: string, where: string): Violation[] {
  if (/reason/i.test(raw)) {
    return [{ invariant: 'I5', detail: 'a decline response mentions a reason', where, payload: raw.slice(0, 600) }];
  }
  return [];
}

/** I6: an archived match entry is retrievable (present, state archived) but is
 *  never offered as an actionable signal (no `next`, no `signal`). */
export function scanArchivedEntry(entry: any, where: string): Violation[] {
  const out: Violation[] = [];
  if (!entry) {
    out.push({ invariant: 'I6', detail: 'archived match not retrievable via check_in', where });
    return out;
  }
  if (entry.state !== 'archived') {
    out.push({ invariant: 'I6', detail: `archived match has state ${entry.state}`, where });
  }
  if (entry.next !== undefined) {
    out.push({ invariant: 'I6', detail: `archived match still carries an action word: ${entry.next}`, where });
  }
  if (entry.signal !== undefined) {
    out.push({ invariant: 'I6', detail: 'archived match still carries a stage-1 signal', where });
  }
  return out;
}

/** The canonical live tool set. I3: no accept tool exists on the surface. */
export const EXPECTED_TOOLS = [
  'amend_intent',
  'collect_messages',
  'send_message',
  'check_in',
  'list_intents',
  'open_conversation',
  'publish_intent',
  'respond',
  'settle',
  'standing_arrangement',
  'withdraw_intent',
].sort();

export function scanToolsForAccept(toolNames: string[], where: string): Violation[] {
  const out: Violation[] = [];
  const suspicious = toolNames.filter((n) => /accept|approve|confirm.*deal|finali[sz]e/i.test(n));
  for (const n of suspicious) {
    out.push({ invariant: 'I3', detail: `an accept-shaped tool exists on the MCP surface: ${n}`, where });
  }
  const missing = EXPECTED_TOOLS.filter((t) => !toolNames.includes(t));
  const extra = toolNames.filter((t) => !EXPECTED_TOOLS.includes(t));
  if (missing.length) out.push({ invariant: 'I3', detail: `tool surface missing: ${missing.join(', ')}`, where });
  if (extra.length) out.push({ invariant: 'I3', detail: `tool surface has unexpected tools: ${extra.join(', ')}`, where });
  return out;
}

// ===========================================================================
// THE MONEY INVARIANTS (I8–I12)
//
// Everything below takes FACTS the money group has already read out of the
// database and out of Stripe, and says whether they are allowed. Keeping the
// judgment here and the reading there means each rule is one readable
// comparison, and the rule can be unit-reasoned about without a sandbox.
// ===========================================================================

/**
 * I8 — funded means both humans said yes.
 *
 * Three separate readings have to agree, because each can fail on its own:
 * the two approval timestamps on the row, the state itself, and the WORM
 * consent log, which is the record that would be produced if anyone ever
 * asked who authorised this. A settlement that is funded with one approval
 * missing anywhere is the worst defect this suite can find.
 */
export interface FundedFacts {
  settlementId: string;
  state: string;
  buyerApprovedAt: string | null;
  sellerApprovedAt: string | null;
  /** Account ids with a 'settlement-approved' consent event in the WORM log. */
  consentApprovals: string[];
  buyerAccount: string;
  sellerAccount: string;
  /**
   * What the buyer's own pay route answered while only ONE approval stood.
   * 409 is the refusal we want; a 303 to Stripe would mean the money could
   * start moving on one signature.
   */
  payBeforeBothApprovalsStatus?: number;
}

export function checkFundedNeedsBothApprovals(f: FundedFacts, where: string): Violation[] {
  const out: Violation[] = [];
  const v = (detail: string) => out.push({ invariant: 'I8', detail, where });
  const past = ['funded', 'evidence-locked', 'confirmed', 'disputed', 'released', 'refunded'];
  if (past.includes(f.state)) {
    if (!f.buyerApprovedAt) v(`settlement ${f.settlementId} is '${f.state}' with no buyer approval timestamp`);
    if (!f.sellerApprovedAt) v(`settlement ${f.settlementId} is '${f.state}' with no seller approval timestamp`);
    const lower = f.consentApprovals.map((a) => a.toLowerCase());
    if (!lower.includes(f.buyerAccount.toLowerCase())) {
      v(`settlement ${f.settlementId} is '${f.state}' but the consent log holds no buyer approval`);
    }
    if (!lower.includes(f.sellerAccount.toLowerCase())) {
      v(`settlement ${f.settlementId} is '${f.state}' but the consent log holds no seller approval`);
    }
  }
  if (f.payBeforeBothApprovalsStatus !== undefined && f.payBeforeBothApprovalsStatus !== 409) {
    v(
      `the buyer's pay route answered ${f.payBeforeBothApprovalsStatus} while only one approval stood — ` +
        `payment must be refused until both humans have approved`,
    );
  }
  return out;
}

/**
 * I9 — nothing an agent can call moves money.
 *
 * Two halves. The tool SURFACE must carry no step named for a money move,
 * and the one settlement tool there is must refuse every attempt to drive a
 * human step through it. The second half is the one that matters: a tool can
 * be innocently named and still take an `action` nobody documented.
 *
 * An attempt counts as refused when the call came back an error OR came back
 * a plain read — what is never allowed is the state moving.
 */
export interface AgentMoveAttempt {
  label: string;
  /** Did the server refuse it (isError, or a read that changed nothing)? */
  refused: boolean;
  detail: string;
}

export interface AgentReachFacts {
  toolNames: string[];
  attempts: AgentMoveAttempt[];
  /** DB state before and after the whole batch of attempts. */
  stateBefore: string;
  stateAfter: string;
}

/** Tool names shaped like a money step a human owns. */
const FORBIDDEN_MONEY_TOOL = /approve|confirm|release|refund|dispute|payout|capture|transfer|charge/i;

export function checkNoAgentMoneyPath(f: AgentReachFacts, where: string): Violation[] {
  const out: Violation[] = [];
  const v = (detail: string) => out.push({ invariant: 'I9', detail, where });
  for (const n of f.toolNames.filter((t) => FORBIDDEN_MONEY_TOOL.test(t))) {
    v(`a money-step tool exists on the MCP surface: ${n}`);
  }
  for (const a of f.attempts.filter((x) => !x.refused)) {
    v(`an agent-reachable call was NOT refused: ${a.label} — ${a.detail}`);
  }
  if (f.stateBefore !== f.stateAfter) {
    v(
      `the settlement state moved while only an agent was calling: ` +
        `${f.stateBefore} -> ${f.stateAfter}`,
    );
  }
  return out;
}

/**
 * I10 — the arithmetic of a release.
 *
 * The seller receives the AGREED AMOUNT and not a cent less: the fee and the
 * processing line were the buyer's, paid as lines of their own, so nothing
 * comes off the transfer. And the buyer's charge is the three persisted
 * figures added up — persisted, because those are what the buyer was actually
 * shown on the hosted page, and a recomputation from today's config would
 * quietly bless a fee that moved since.
 */
export interface ReleaseFacts {
  settlementId: string;
  /** From the settlement row. */
  agreedMinor: number;
  feeMinor: number | null;
  processingMinor: number | null;
  buyerTotalMinor: number | null;
  /** From Stripe. */
  chargedMinor: number;
  transferMinor: number;
  transferGroup: string | null;
  transferDestination: string | null;
  sellerStripeAccount: string;
  /** Stripe's own view of where the charge sent the money. Both must be empty. */
  transferData: unknown;
  applicationFeeAmount: unknown;
  /** What actually landed on the seller's connected account. */
  destinationPaymentMinor?: number;
}

export function checkReleaseAmounts(f: ReleaseFacts, where: string): Violation[] {
  const out: Violation[] = [];
  const v = (detail: string) => out.push({ invariant: 'I10', detail, where });
  if (f.transferMinor !== f.agreedMinor) {
    v(`the release transfer was ${f.transferMinor} but the agreed amount is ${f.agreedMinor}`);
  }
  if (f.destinationPaymentMinor !== undefined && f.destinationPaymentMinor !== f.agreedMinor) {
    v(
      `the seller's connected account received ${f.destinationPaymentMinor}, ` +
        `not the agreed ${f.agreedMinor}`,
    );
  }
  if (f.feeMinor === null || f.processingMinor === null || f.buyerTotalMinor === null) {
    v(
      `the settlement row has no persisted breakdown (fee=${f.feeMinor} processing=${f.processingMinor} ` +
        `total=${f.buyerTotalMinor}); the buyer was charged against a figure nothing recorded`,
    );
  } else {
    const sum = f.agreedMinor + f.feeMinor + f.processingMinor;
    if (sum !== f.buyerTotalMinor) {
      v(
        `the persisted lines do not add up: ${f.agreedMinor} + ${f.feeMinor} + ${f.processingMinor} ` +
          `= ${sum}, but buyer_total_minor is ${f.buyerTotalMinor}`,
      );
    }
    if (f.chargedMinor !== f.buyerTotalMinor) {
      v(`Stripe took ${f.chargedMinor} from the buyer but the row says ${f.buyerTotalMinor}`);
    }
  }
  if (f.transferGroup !== f.settlementId) {
    v(`the transfer's transfer_group is ${f.transferGroup}, not the settlement id`);
  }
  if (f.transferDestination !== f.sellerStripeAccount) {
    v(`the transfer went to ${f.transferDestination}, not the seller's account ${f.sellerStripeAccount}`);
  }
  if (f.transferData) v('the charge carried transfer_data — money was routed away from the platform balance');
  if (f.applicationFeeAmount) v('the charge carried an application fee');
  return out;
}

/**
 * I11 — a dispute costs the buyer nothing, and costs them nothing twice.
 *
 * The refund is of the WHOLE buyer total, our fee included: a person who
 * disputes gets every cent back and the platform wears Stripe's cut on the
 * round trip. Pressing dispute again must add no second refund, and no
 * transfer may exist on a settlement that went back.
 */
export interface RefundFacts {
  settlementId: string;
  state: string;
  buyerTotalMinor: number | null;
  refundedMinor: number;
  /** How many refund objects Stripe holds against the charge. */
  refundCount: number;
  /** The settlement row's transfer id, which must still be null. */
  transferId: string | null;
  /** HTTP status of the second, idempotent dispute press. */
  secondDisputeStatus?: number;
}

export function checkRefundOnceAndWhole(f: RefundFacts, where: string): Violation[] {
  const out: Violation[] = [];
  const v = (detail: string) => out.push({ invariant: 'I11', detail, where });
  if (f.state !== 'refunded') v(`settlement ${f.settlementId} disputed but its state is '${f.state}'`);
  if (f.buyerTotalMinor === null) {
    v('the settlement row has no persisted buyer total, so "in full" cannot be checked');
  } else if (f.refundedMinor !== f.buyerTotalMinor) {
    v(`the buyer got ${f.refundedMinor} back, not their whole total of ${f.buyerTotalMinor}`);
  }
  if (f.refundCount !== 1) v(`Stripe holds ${f.refundCount} refunds against the charge; a dispute refunds once`);
  if (f.transferId) v(`a transfer (${f.transferId}) exists on a settlement that was refunded`);
  if (f.secondDisputeStatus !== undefined && f.secondDisputeStatus >= 500) {
    v(`the second, idempotent dispute press answered ${f.secondDisputeStatus} rather than settling quietly`);
  }
  return out;
}

/**
 * I12 — a proposal has to come from the right place.
 *
 * Settlement opens only once both humans can talk (stage 3) on an OPEN
 * introduction, and only to the two people on it. Every attempt listed here
 * is one that must come back refused; a proposal that got through is a row
 * on someone's ledger that nobody agreed to.
 */
export interface ProposalAttempt {
  label: string;
  refused: boolean;
  detail: string;
}

export function checkProposalGuards(attempts: ProposalAttempt[], where: string): Violation[] {
  return attempts
    .filter((a) => !a.refused)
    .map((a) => ({
      invariant: 'I12',
      detail: `a settle proposal that should have been refused got through: ${a.label} — ${a.detail}`,
      where,
    }));
}
