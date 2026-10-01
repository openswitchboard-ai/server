/**
 * AN ADDRESS OR A PHONE NUMBER NEVER TRAVELS IN THE WORDS (1 October 2026).
 * The rule and why are in domain/contactInWords.ts; this file only puts it at
 * the doors where one person writes free words to another.
 *
 * A refusal here keeps nothing: the ledger writes the sender, the door and the
 * reason code for a refused item and never its words (safety/ledger.ts), so an
 * address that was turned back is not sitting anywhere afterwards.
 *
 * The sentence a refused sender's assistant reads depends on which sort of
 * agent it is (domain/lanes.ts, contact_in_words), and a check does not know
 * that. So the check carries the lane-free version, and the two doors that
 * throw it (domain/channel.ts, domain/offers.ts) swap in the lane's own.
 */
import { CONTACT_IN_WORDS_REASON, contactDetailRule } from '../../domain/contactInWords.js';
import { passed, type Check, type CheckResult } from '../types.js';

/** The lane-free refusal, for a caller that knows nothing about the agent. */
export const CONTACT_IN_WORDS_ACTION =
  'This one has not gone. It carries an address, a phone number or an email, and those never go in a message. Fetch respond(request_send_contact) and hand your human the page: they type their details there themselves, and they go to the other person without either assistant seeing them. Send these words again without them.';

export const contactDetails: Check = {
  name: 'contactDetails',
  // The report door is deliberately NOT here: somebody reporting a stranger
  // may well quote the address they were sent, and a report is never refused
  // for its words (intake/pipe.ts, REFUSAL_FREE_DOORS).
  doors: ['message', 'offer_words'],
  async run(item, cfg): Promise<CheckResult> {
    // Off where the send-contact page is off (config.sealedContact): with no
    // page to point at, the words keep the older rule.
    if (!cfg?.sealedContact) return passed('contactDetails');
    const kind = item.text ? contactDetailRule(item.text) : undefined;
    if (!kind) return passed('contactDetails');
    return {
      name: 'contactDetails',
      outcome: 'refuse',
      reason_code: CONTACT_IN_WORDS_REASON,
      // Which kind of rule fired, and nothing of the words.
      detail: kind,
      plain_words: CONTACT_IN_WORDS_ACTION,
      field: 'text',
    };
  },
};
