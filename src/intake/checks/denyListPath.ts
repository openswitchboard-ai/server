/**
 * The cheap first pass on a posting: the deny-list's category globs
 * (src/denylist.ts, seeded from the schema repo). It catches a thing posted
 * under the name of a family that stays off the switchboard everywhere it
 * runs, and it costs nothing to run, which is why it stands in front of the
 * model.
 *
 * It does NOT catch a prohibited thing posted under an innocent category —
 * that is the prohibited-by-meaning check, step three of the build sequence.
 */
import { categoryDenied, heldBackReason } from '../../denylist.js';
import { passed, type Check } from '../types.js';

export const denyListPath: Check = {
  name: 'denyListPath',
  doors: ['posting', 'amendment'],
  async run(item) {
    const category = item.fields?.category;
    if (!category) return passed('denyListPath');
    const denied = categoryDenied(category);
    if (!denied) return passed('denyListPath');
    const plain = heldBackReason(denied.reason_code);
    return {
      name: 'denyListPath',
      outcome: 'refuse',
      reason_code: denied.reason_code,
      detail: 'deny-list category match',
      // A family held back because of the law around it says why, in the one
      // sentence its seed entry carries (denylist.ts, heldBackReason); a
      // family that is simply off the switchboard says nothing here, and the
      // door's own refusal carries it. Never the dotted path.
      ...(plain ? { plain_words: plain } : {}),
    };
  },
};
