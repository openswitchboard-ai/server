/**
 * The settlement sweep: the only place a settlement moves without a human or
 * Stripe saying so. Four clocks run through here, and every one of them is the
 * same shape — a stretch of time went by and nobody did the thing.
 *
 * 1. THE BUYER'S WINDOW. The seller declares handover; the buyer gets
 *    SETTLEMENT_AUTO_RELEASE_DAYS to confirm receipt or raise a problem. A
 *    buyer who does neither used to leave the seller's money parked with
 *    nobody able to move it, so silence now ends the window the same way a
 *    confirmation does: evidence-locked -> confirmed, a transfer of the agreed
 *    amount, and 'released' from the transfer.created webhook.
 *
 * 2. A RETURN THE SELLER NEVER ACKNOWLEDGED. The buyer marked the item sent
 *    back with tracking; the seller has said nothing for
 *    SETTLEMENT_RETURN_SILENCE_DAYS. The agreed amount goes back to the buyer.
 *
 * 3. A PARCEL NOBODY CAN SHOW. The dispute's ground is that it never arrived
 *    and the seller has added no delivery tracking inside
 *    SETTLEMENT_TRACKING_GRACE_DAYS. The agreed amount goes back to the buyer,
 *    because posting with tracking is the seller's responsibility.
 *
 * 4. THE DEFAULT RULE, at deadlock_at: the two of them agreed nothing in
 *    SETTLEMENT_DISPUTE_DEADLOCK_DAYS. The payment goes to whichever side can
 *    show where the item went — delivery tracking and no return sent releases
 *    to the seller, anything else refunds the buyer.
 *
 * THE TWO SHAPES, and the difference matters. A RELEASE needs a state move
 * first (-> 'confirmed') because that is the state a transfer goes out of, and
 * that move is the whole reason a scheduled context exists. A REFUND needs no
 * state move at all: the sweep records the figures, sends the refund, and
 * 'refunded' lands from the verified charge.refunded event exactly as it does
 * when a human's own step caused it. So the scheduled context buys two steps
 * and no more, and every refund on this file's roads still gets its state from
 * Stripe.
 *
 * FEES NEVER COME BACK. Every refund below is of the AGREED AMOUNT. The $1 and
 * the processing line the buyer paid stay paid in every outcome, which is what
 * the public terms promise and why refundAgreedAmountForSettlement always
 * carries an explicit amount.
 *
 * PROVENANCE. This file is the only place scheduledAction() is called, and the
 * context it mints is good for exactly the steps in SCHEDULED_STEPS —
 * applyTransition refuses it for anything else. The unit suite pins both halves
 * by source scan. The ops worker calls runAutoReleaseSweep and mints nothing
 * itself.
 *
 * SAFE UNDER CONCURRENT SWEEPS, twice over. Every transition is a
 * compare-and-swap on the settlement's state, so of two sweeps looking at the
 * same row exactly one wins; and both money legs carry the settlement id as
 * their idempotency key, so a transfer or a refund attempted twice moves money
 * once. The order is the same as a human route's: move the state first, then
 * move the money, so a settlement whose payment fails is left visible and is
 * picked up again on the next pass.
 */
import {
  autoReleaseSettlement,
  autoReleasesAwaitingTransfer,
  deadlockOutcome,
  deadlockReleaseSettlement,
  recordRuleRefund,
  scheduledAction,
  settlementsDueForAutoRelease,
  settlementsDueForDeadlock,
  settlementsDueForNeverArrivedRefund,
  settlementsDueForReturnRefund,
  type SettlementRow,
} from '../domain/settlements.js';
import {
  refundAgreedAmountForSettlement,
  transferToSellerForSettlement,
} from '../domain/settlementStripe.js';
import { OsbError } from '../protocol.js';
import { toMinorUnits } from '../stripe.js';
import { settlementsConfigured, type Config } from '../config.js';

export interface AutoReleaseSweepResult {
  /** Settlements whose window had run out when the sweep looked. */
  due: number;
  /** Settlements this sweep moved to 'confirmed' and paid out. */
  released: number;
  /** Settlements another sweep, a confirmation or a dispute got to first. */
  skipped: number;
  /** Settlements confirmed by the clock whose transfer did not go through,
   *  on this pass or an earlier one. Retried on every pass. */
  failed: number;
  /** Earlier auto-releases whose transfer went through on this pass. */
  recovered: number;
  /** Frozen payments the return-silence rule sent back on this pass. */
  returnRefunded: number;
  /** Frozen payments the never-arrived rule sent back on this pass. */
  neverArrivedRefunded: number;
  /** Frozen payments the default rule decided on this pass, either way. */
  deadlockReleased: number;
  deadlockRefunded: number;
}

export async function runAutoReleaseSweep(
  cfg: Config,
  log: (msg: string, extra?: any) => void,
): Promise<AutoReleaseSweepResult> {
  const result: AutoReleaseSweepResult = {
    due: 0,
    released: 0,
    skipped: 0,
    failed: 0,
    recovered: 0,
    returnRefunded: 0,
    neverArrivedRefunded: 0,
    deadlockReleased: 0,
    deadlockRefunded: 0,
  };
  // A deployment with payments switched off has no clock to run and no way to
  // move money if it had one.
  if (!settlementsConfigured(cfg)) return result;

  /**
   * A refunding rule, walked. The figures go on the row first, so a refund
   * that fails still leaves a settlement that says what was meant; then the
   * agreed amount goes back, and 'refunded' lands from the verified event.
   */
  const refundByRule = async (s: SettlementRow, rule: string): Promise<boolean> => {
    let recorded: SettlementRow;
    try {
      recorded = await recordRuleRefund(scheduledAction(), s.id);
    } catch (e: any) {
      if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
        // Somebody got there first — a concurrent sweep, or the two of them
        // agreeing between the query and now. Nothing to do and nothing wrong.
        result.skipped += 1;
        return false;
      }
      result.failed += 1;
      log(`${rule}: could not record the refund; the settlement stands`, {
        settlement_id: s.id,
        error: e?.message,
      });
      return false;
    }
    try {
      await refundAgreedAmountForSettlement(recorded, toMinorUnits(Number(s.amount), s.ccy));
      log(`${rule}: the agreed amount went back to the buyer`, { settlement_id: s.id });
      return true;
    } catch (e: any) {
      result.failed += 1;
      log(`${rule}: the refund did not go through; nothing moved`, {
        settlement_id: s.id,
        error: e?.message,
      });
      return false;
    }
  };

  // First, the ones an earlier pass confirmed and could not pay: the buyer's
  // own confirmation has a retry on their page and a release the clock made
  // has nobody to press it, so the sweep is that retry. It covers a deadlock
  // release too — both roads reach 'confirmed' with auto_released set.
  for (const stuck of await autoReleasesAwaitingTransfer()) {
    try {
      await transferToSellerForSettlement(cfg, stuck, stuck.release_minor ?? undefined);
      result.recovered += 1;
      log('settlement release transfer recovered', { settlement_id: stuck.id });
    } catch (e: any) {
      result.failed += 1;
      log('settlement release transfer still failing; nothing moved', {
        settlement_id: stuck.id,
        error: e?.message,
      });
    }
  }

  // --- 1. the buyer's window ------------------------------------------------
  const due = await settlementsDueForAutoRelease();
  result.due = due.length;
  for (const s of due) {
    let confirmed;
    try {
      confirmed = await autoReleaseSettlement(scheduledAction(), s.id);
    } catch (e: any) {
      if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
        // Somebody got there first — a concurrent sweep, the buyer's own
        // confirmation, a dispute. Nothing to do and nothing wrong.
        result.skipped += 1;
        continue;
      }
      // Anything else is this settlement's problem and not the sweep's: the
      // row stays in 'evidence-locked' with its clock still past, so the next
      // tick tries again, and the others in this batch are not held up by it.
      result.failed += 1;
      log('settlement auto-release refused; the settlement stands', {
        settlement_id: s.id,
        error: e?.message,
      });
      continue;
    }
    try {
      await transferToSellerForSettlement(cfg, confirmed);
      result.released += 1;
      log('settlement auto-released: the buyer\'s window ran out', {
        settlement_id: s.id,
        handed_over_at: s.handed_over_at,
        auto_release_at: s.auto_release_at,
      });
    } catch (e: any) {
      // The confirmation stands and the money simply did not move. The next
      // pass picks it up in the retry above.
      result.failed += 1;
      log('settlement auto-release transfer failed; nothing moved', {
        settlement_id: s.id,
        error: e?.message,
      });
    }
  }

  // --- 2. a return the seller never acknowledged ----------------------------
  for (const s of await settlementsDueForReturnRefund(cfg.settlementReturnSilenceDays)) {
    if (await refundByRule(s, 'return sent back and nothing said')) result.returnRefunded += 1;
  }

  // --- 3. a parcel nobody can show -----------------------------------------
  for (const s of await settlementsDueForNeverArrivedRefund(cfg.settlementTrackingGraceDays)) {
    if (await refundByRule(s, 'it never arrived and no tracking was added')) {
      result.neverArrivedRefunded += 1;
    }
  }

  // --- 4. the default rule -------------------------------------------------
  for (const s of await settlementsDueForDeadlock()) {
    if (deadlockOutcome(s) === 'refund') {
      if (await refundByRule(s, 'the default rule sent it back')) result.deadlockRefunded += 1;
      continue;
    }
    let confirmed;
    try {
      confirmed = await deadlockReleaseSettlement(scheduledAction(), s.id);
    } catch (e: any) {
      if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
        result.skipped += 1;
        continue;
      }
      result.failed += 1;
      log('the default rule was refused; the settlement stands', {
        settlement_id: s.id,
        error: e?.message,
      });
      continue;
    }
    try {
      await transferToSellerForSettlement(cfg, confirmed, confirmed.release_minor ?? undefined);
      result.deadlockReleased += 1;
      log('the default rule released the payment: the seller could show delivery', {
        settlement_id: s.id,
        disputed_at: s.disputed_at,
        deadlock_at: s.deadlock_at,
      });
    } catch (e: any) {
      result.failed += 1;
      log('the default rule\'s transfer failed; nothing moved', {
        settlement_id: s.id,
        error: e?.message,
      });
    }
  }
  return result;
}
