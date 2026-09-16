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
import { SUSPENDED_REASON_CODE, suspended } from './checks/suspended.js';
import { ledgerFromConfig } from '../safety/ledger.js';
import { type Check, type CheckResult, type IntakeItem, type Ledger, type Verdict } from './types.js';
import type { Config } from '../config.js';

/**
 * Every check, in the order they run. Cheap and deterministic before slow and
 * paid for: a category the deny list already refuses never costs a model call.
 *
 * `suspended` is FIRST, at every door. It is the one check whose answer does
 * not depend on the item at all, and an account the operator has stopped must
 * not cost the switchboard a category lookup, let alone a model call.
 */
export const CHECKS: Check[] = [
  suspended,
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

/**
 * The doors where a refusal becomes a HOLD (docs/trust-and-safety.md, step 5).
 *
 * One door is on this list, and the reason it is here rather than being an
 * exception buried in the report code: a report is never refused for its
 * words. The money-figure rule and the personal-details screen are worth
 * RUNNING on a report — somebody frightened enough to report a stranger may
 * well type a phone number or a price into the box — but the answer to either
 * of them is to hold the words for a person to read, never to hand the report
 * back and ask them to phrase it better. Refusing a report is the one refusal
 * this system must not make.
 *
 * A hold keeps the body in the ledger, where a refusal would have kept only
 * the reason code; so the words are still there to be read under the ordinary
 * two-keyholder ceremony, which is exactly where the words of a report belong.
 */
export const REFUSAL_FREE_DOORS: ReadonlySet<IntakeItem['door']> = new Set(['report']);

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
  // The thirty-day ledger where this deployment has a safety public key, and
  // nothing at all where it does not (src/safety/ledger.ts).
  const ledger = opts.ledger ?? ledgerFromConfig(cfg);
  const results: CheckResult[] = [];
  // At a refusal-free door a check that refuses is heard as a hold instead,
  // before anything else reads the result — so the run does not stop, the
  // verdict is a hold, and the ledger keeps the body.
  //
  // The one thing it does not soften is a suspended account: that refusal is
  // about who is at the door rather than about what they wrote, and a door
  // shut to an account is shut to its report as well.
  const soften = (r: CheckResult): CheckResult =>
    REFUSAL_FREE_DOORS.has(item.door) &&
    r.outcome === 'refuse' &&
    r.reason_code !== SUSPENDED_REASON_CODE
      ? { ...r, outcome: 'hold' }
      : r;
  for (const check of checksForDoor(item.door, opts.checks ?? CHECKS)) {
    let result: CheckResult;
    try {
      result = soften(await check.run(item, cfg));
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
  // The ledger can never change the verdict, so it is awaited and its own
  // failure swallowed: losing evidence is bad, and refusing to carry something
  // because the evidence store hiccuped is worse.
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
