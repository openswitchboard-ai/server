/**
 * The pipe. Everything one person hands the switchboard for another person to
 * see goes through here: intake -> checks -> verdict -> ledger -> deliver
 * (docs/trust-and-safety.md).
 *
 * WHAT STEP ONE IS. The checks that already existed, in one place, deciding
 * exactly what they decided before. The wire-level answers at the three doors
 * that have callers — a posting refused for its category, a message refused
 * for carrying a figure, a photo refused because the page could not clean it —
 * are the same answers, word for word. The suite is the proof.
 */
import { denyListPath } from './checks/denyListPath.js';
import { modelScreen } from './checks/modelScreen.js';
import { moneyFigure } from './checks/moneyFigure.js';
import { photoMetadata } from './checks/photoMetadata.js';
import { photoModeration } from './checks/photoModeration.js';
import { noLedger, type Check, type CheckResult, type IntakeItem, type Ledger, type Verdict } from './types.js';
import type { Config } from '../config.js';

/**
 * Every check, in the order they run. Cheap and deterministic before slow and
 * paid for: a category the deny list already refuses never costs a model call.
 */
export const CHECKS: Check[] = [
  denyListPath,
  modelScreen,
  moneyFigure,
  photoMetadata,
  photoModeration,
];

/** The checks that stand at one door. */
export function checksForDoor(door: IntakeItem['door'], checks: Check[] = CHECKS): Check[] {
  return checks.filter((c) => c.doors.includes(door));
}

export interface IntakeOptions {
  ledger?: Ledger;
  /** For the suite: run against a different set of checks. */
  checks?: Check[];
}

/**
 * Run the checks for this item's door and fold them into one verdict.
 *
 *  - The first refusal ends it. Nothing after a refusal can change the answer,
 *    and running it would spend money on an item that is already going back.
 *  - A check that THROWS is a HOLD, never a pass. A screen that could not
 *    reach its model has not said the item is fine, and the difference between
 *    "looked and found nothing" and "could not look" is the whole point.
 *  - Otherwise, any hold holds, and silence from every check is a pass.
 */
export async function runIntake(
  cfg: Config | undefined,
  item: IntakeItem,
  opts: IntakeOptions = {},
): Promise<Verdict> {
  const ledger = opts.ledger ?? noLedger;
  const results: CheckResult[] = [];
  for (const check of checksForDoor(item.door, opts.checks ?? CHECKS)) {
    let result: CheckResult;
    try {
      result = await check.run(item, cfg);
    } catch (e: any) {
      result = {
        name: check.name,
        outcome: 'hold',
        reason_code: 'check-failed',
        detail: e?.message ? String(e.message) : 'the check threw',
        error: e,
      };
    }
    results.push(result);
    if (result.outcome === 'refuse') break;
  }
  const decisive =
    results.find((r) => r.outcome === 'refuse') ?? results.find((r) => r.outcome === 'hold');
  const verdict: Verdict = {
    outcome: decisive?.outcome ?? 'pass',
    ...(decisive?.reason_code ? { reason_code: decisive.reason_code } : {}),
    ...(decisive?.plain_words ? { plain_words: decisive.plain_words } : {}),
    checks: results,
  };
  // A no-op until step two builds the thirty-day ledger behind it. It can
  // never change the verdict, so it is awaited and its own failure swallowed.
  try {
    await ledger.recordVerdict(item, verdict);
  } catch {
    /* the verdict stands */
  }
  return verdict;
}

/** The check that decided the verdict, where one did. */
export function decidingCheck(verdict: Verdict): CheckResult | undefined {
  return (
    verdict.checks.find((r) => r.outcome === 'refuse') ??
    verdict.checks.find((r) => r.outcome === 'hold')
  );
}

export * from './types.js';
