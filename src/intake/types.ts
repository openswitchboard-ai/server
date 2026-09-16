/**
 * One shape for anything a person hands the switchboard for another person to
 * see (docs/trust-and-safety.md). A posting, an amendment, a message, a photo,
 * the wording on an offer, the first name and suburb somebody chose to share:
 * four doors becoming one, so that a new check is one file rather than four
 * edits, and so that the answer a refused sender's assistant reads is the same
 * answer at every door.
 *
 * Step one of the build sequence moves the checks that already exist into this
 * shape and changes nothing about what they decide. The ledger, the
 * prohibited-by-meaning check and the photo checks come after.
 */
import type { Config } from '../config.js';

/** The doors. One per kind of thing a person can hand over. */
export type Door =
  | 'posting'
  | 'amendment'
  | 'message'
  | 'photo'
  | 'offer_words'
  | 'shared_identity';

/**
 * What arrived, normalised. `text` is free words the sender wrote; `fields`
 * carries the named facts a check needs about the item (the category behind a
 * posting, whether a photo says its hidden details were taken out) as strings,
 * so that one shape covers every door without growing a branch per door.
 */
export interface IntakeItem {
  door: Door;
  sender_account: string;
  recipient_account?: string;
  match_id?: string;
  intent_id?: string;
  text?: string;
  fields?: Record<string, string>;
  object?: { bucket: string; key: string; content_type: string };
}

/** pass, hold for review, or refuse with plain words back to the sender. */
export type Outcome = 'pass' | 'hold' | 'refuse';

/**
 * One check's answer. `detail` stays internal — it is the model's own note or
 * the name of the rule that fired; `plain_words` is the sentence the sender's
 * assistant is allowed to read, and is set only where the check has one.
 *
 * `model_id` and `error` are the two things a caller sometimes has to see
 * behind the verdict: which model made the call, and the error a check threw
 * before it could answer.
 */
export interface CheckResult {
  name: string;
  outcome: Outcome;
  reason_code?: string;
  detail?: string;
  plain_words?: string;
  model_id?: string;
  error?: unknown;
}

/** The fold of every check that ran, in the one shape every door answers in. */
export interface Verdict {
  outcome: Outcome;
  reason_code?: string;
  plain_words?: string;
  checks: CheckResult[];
}

/** A check is one file: which doors it stands at, and what it decides. */
export interface Check {
  name: string;
  doors: Door[];
  run(item: IntakeItem, cfg: Config | undefined): Promise<CheckResult>;
}

/**
 * Where a verdict is written down. A no-op for now, and deliberately so: step
 * two of the build sequence puts the encrypted thirty-day ledger behind this
 * one method, and nothing in the callers changes when it does.
 */
export interface Ledger {
  recordVerdict(item: IntakeItem, verdict: Verdict): Promise<void> | void;
}

/** The ledger until there is a ledger. It keeps nothing. */
export const noLedger: Ledger = {
  recordVerdict() {
    /* step two */
  },
};

/** Shorthand for a check that found nothing. */
export const passed = (name: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  name,
  outcome: 'pass',
  ...extra,
});
