/**
 * A FIGURE NEVER TRAVELS IN THE WORDS (run 8, 13 September 2026 — see
 * domain/moneyInWords.ts for the rules and for why). The check is the one that
 * was already there; this file only puts it at the door with the others.
 */
import { FIGURE_IN_WORDS_ACTION, moneyFigureRule } from '../../domain/moneyInWords.js';
import { passed, type Check } from '../types.js';

/**
 * WHAT THIS CHECK READS AT EACH DOOR. On a message it is the words, which is
 * the whole of what it ever read. On a posting it is `kind` and nothing else:
 * the agent's own plain words for the thing, which are free text that a person
 * typed and so are exactly where a figure would land by accident. The rest of
 * a posting is not read here, and deliberately: a price band is a field with a
 * number in it, an asking price is a number the protocol carries on purpose,
 * and neither is a figure smuggled into prose.
 */
const subject = (item: { door: string; text?: string; fields?: Record<string, string> }) =>
  item.door === 'posting' || item.door === 'amendment' ? item.fields?.kind : item.text;

export const moneyFigure: Check = {
  name: 'moneyFigure',
  // The report door too: somebody writing down what a stranger did to them is
  // exactly where a price lands by accident, and the pipe holds those words
  // rather than refusing the report (intake/pipe.ts, REFUSAL_FREE_DOORS).
  doors: ['message', 'posting', 'amendment', 'report'],
  async run(item) {
    const words = subject(item);
    const rule = typeof words === 'string' ? moneyFigureRule(words) : undefined;
    if (!rule) return passed('moneyFigure');
    return {
      name: 'moneyFigure',
      outcome: 'refuse',
      reason_code: 'money-figure-in-words',
      // The rule that fired, so a refusal is one a person can justify out loud.
      detail: rule,
      plain_words: FIGURE_IN_WORDS_ACTION,
    };
  },
};
