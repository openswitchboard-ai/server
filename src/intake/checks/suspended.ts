/**
 * SUSPENDED SENDER OR RECIPIENT: nothing in, nothing out
 * (docs/trust-and-safety.md, the checks table, "Every door").
 *
 * It stands at every door and runs first of all, ahead of the cheap
 * deterministic checks, because a suspended account's item must not cost the
 * switchboard so much as a category lookup — and because the answer does not
 * depend on anything in the item.
 *
 * BOTH SIDES. A suspended sender may hand nothing in, and a suspended
 * recipient may be handed nothing: an account that has been stopped does not
 * keep receiving what strangers are still writing to it, and the person on the
 * other end is not left talking into a room nobody may enter.
 *
 * The tools answer SUSPENDED long before anything reaches this check, and the
 * connect block says it earlier still. This is the floor under both: one place
 * where the rule is true whatever route the item came in by.
 */
import { isSuspended } from '../../safety/suspend.js';
import { passed, type Check, type CheckResult } from '../types.js';

/** The reason code a refusal here carries, and the protocol code beside it. */
export const SUSPENDED_REASON_CODE = 'SUSPENDED';

/**
 * The sentence, in one place, so the check, the tools and the connect block
 * all say the same thing. It is written to an AGENT rather than to a human:
 * what has happened, that there is nothing left to try, and the one thing the
 * switchboard cannot do for itself — get the fact into that agent's own memory,
 * because it is served at connect and on every call and still reaches nobody if
 * the agent does not keep it.
 */
export const SUSPENDED_WORDS =
  'This account has been suspended from the switchboard. Nothing more can be posted, sent or collected from it. Tell your human, and keep it in your own memory so you do not try again.';

export const suspended: Check = {
  name: 'suspended',
  doors: ['posting', 'amendment', 'message', 'photo', 'offer_words', 'shared_identity', 'report'],
  async run(item): Promise<CheckResult> {
    const refuse = (): CheckResult => ({
      name: 'suspended',
      outcome: 'refuse',
      reason_code: SUSPENDED_REASON_CODE,
      // No detail: which of the two accounts it was is not something either
      // side's agent is told, and the operator has the account itself.
      plain_words: SUSPENDED_WORDS,
    });
    if (await isSuspended(item.sender_account)) return refuse();
    if (item.recipient_account && (await isSuspended(item.recipient_account))) return refuse();
    return passed('suspended');
  },
};
