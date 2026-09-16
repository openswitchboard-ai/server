/**
 * A FIGURE NEVER TRAVELS IN THE WORDS (run 8, 13 September 2026 — see
 * domain/moneyInWords.ts for the rules and for why). The check is the one that
 * was already there; this file only puts it at the door with the others.
 */
import { FIGURE_IN_WORDS_ACTION, moneyFigureRule } from '../../domain/moneyInWords.js';
import { passed, type Check } from '../types.js';

export const moneyFigure: Check = {
  name: 'moneyFigure',
  doors: ['message'],
  async run(item) {
    const rule = typeof item.text === 'string' ? moneyFigureRule(item.text) : undefined;
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
