/**
 * The auto-release sweep: the only place a settlement moves without a human
 * or Stripe saying so.
 *
 * The seller declares handover; the buyer gets SETTLEMENT_AUTO_RELEASE_DAYS to
 * confirm receipt or dispute. A buyer who does neither used to leave the
 * seller's money parked with nobody able to move it, so silence now ends the
 * window the same way a confirmation does: evidence-locked -> confirmed, a
 * transfer of the agreed amount to the seller, and 'released' from the
 * transfer.created webhook. It is the road confirmReceipt walks, walked here
 * by the clock instead.
 *
 * PROVENANCE. This file is the only place scheduledAction() is called, and the
 * context it mints is good for exactly one transition — applyTransition
 * refuses it for anything else. The unit suite pins both halves by source
 * scan. The ops worker calls runAutoReleaseSweep and mints nothing itself.
 *
 * SAFE UNDER CONCURRENT SWEEPS, twice over. The transition is a
 * compare-and-swap on the settlement's state, so of two sweeps looking at the
 * same row exactly one wins; and the release transfer carries the settlement
 * id as its idempotency key, so a transfer attempted twice pays the seller
 * once. The order here is the same as the human route's: move the state
 * first, then move the money, so a settlement whose transfer fails is left at
 * 'confirmed' with nothing moved — visible, and picked up again on the next
 * pass. That retry is the first half of the sweep: a buyer who confirms has a
 * retry button on their own page, and a release the clock made has nobody to
 * press it.
 */
import {
  autoReleaseSettlement,
  autoReleasesAwaitingTransfer,
  scheduledAction,
  settlementsDueForAutoRelease,
} from '../domain/settlements.js';
import { transferToSellerForSettlement } from '../domain/settlementStripe.js';
import { OsbError } from '../protocol.js';
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
  };
  // A deployment with payments switched off has no clock to run and no way to
  // move money if it had one.
  if (!settlementsConfigured(cfg)) return result;
  // First, the ones an earlier pass confirmed and could not pay: the buyer's
  // own confirmation has a retry on their page and an auto-release has
  // nobody to press it, so the sweep is that retry.
  for (const stuck of await autoReleasesAwaitingTransfer()) {
    try {
      await transferToSellerForSettlement(cfg, stuck);
      result.recovered += 1;
      log('settlement auto-release transfer recovered', { settlement_id: stuck.id });
    } catch (e: any) {
      result.failed += 1;
      log('settlement auto-release transfer still failing; nothing moved', {
        settlement_id: stuck.id,
        error: e?.message,
      });
    }
  }
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
      throw e;
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
      // The confirmation stands and the money simply did not move. Both
      // humans still have the retry on the settlement page.
      result.failed += 1;
      log('settlement auto-release transfer failed; nothing moved', {
        settlement_id: s.id,
        error: e?.message,
      });
    }
  }
  return result;
}
