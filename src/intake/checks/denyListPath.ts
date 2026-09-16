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
import { categoryDenied } from '../../denylist.js';
import { passed, type Check } from '../types.js';

export const denyListPath: Check = {
  name: 'denyListPath',
  doors: ['posting', 'amendment'],
  async run(item) {
    const category = item.fields?.category;
    if (!category) return passed('denyListPath');
    const denied = categoryDenied(category);
    if (!denied) return passed('denyListPath');
    return {
      name: 'denyListPath',
      outcome: 'refuse',
      reason_code: denied.reason_code,
      detail: 'deny-list category match',
      // A family held back while the rules around it are settled says so; a
      // family that is simply off the switchboard says nothing here, and the
      // door's own refusal carries it.
      ...(denied.status === 'vertical-policy-pending'
        ? { plain_words: `The '${category}' vertical is not open yet (${denied.reason_code}).` }
        : {}),
    };
  },
};
