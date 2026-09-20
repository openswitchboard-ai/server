/**
 * A FIGURE NEVER TRAVELS IN THE WORDS (run 8, 13 September 2026 — see
 * domain/moneyInWords.ts for the rules and for why). The check is the one that
 * was already there; this file only puts it at the door with the others.
 */
import {
  FIGURE_IN_WORDS_ACTION,
  attributeFigureRule,
  figureInAttributeAction,
  moneyFigureRule,
} from '../../domain/moneyInWords.js';
import { passed, type Check, type CheckResult, type IntakeItem } from '../types.js';

/**
 * WHAT THIS CHECK READS AT EACH DOOR.
 *
 * ON A MESSAGE it is the words, which is the whole of what it ever read.
 *
 * ON A POSTING OR AN AMENDMENT it is two things, and only two.
 *
 *   `kind`, the agent's own plain words for the thing: free text that a person
 *   typed, and so exactly where a figure would land by accident.
 *
 *   EVERY ATTRIBUTE, key and value together (20 September 2026). `attributes`
 *   is free-form — any key the agent invents, a string or a number under it —
 *   and every value on it CROSSES to the counterparty at the details step
 *   (domain/matches.ts, buildAttributes). An assistant that writes
 *   `budget: 25` on its human's want has therefore put that human's ceiling in
 *   front of the person they are about to haggle with, and until this was
 *   added nothing looked. It is the best-offer floor leak of the same week
 *   (domain/cards.ts assertFloorStaysPrivate) arriving by a different road.
 *
 *   The attribute rule is NARROWER than the one on the open conversation, and
 *   domain/moneyInWords.ts says why in full: only a value that NAMES money
 *   ($25, 25 AUD, twenty five dollars, asking 450) or a number under a key
 *   that is named for money (`budget`, `max_price`, `hourly_rate`) is a
 *   figure. A bare number under `frame_size`, `year`, `ram_gb` or
 *   `shutter_count` is a spec and goes up untouched.
 *
 * THE REST OF A POSTING IS STILL NOT READ HERE, and deliberately: a price band
 * is a field with a number in it, an asking price is a number the protocol
 * carries on purpose, and neither is a figure smuggled into prose. Both have
 * their own door (domain/postingFigure.ts reads them back to the human whose
 * figures they are).
 *
 * WHERE THE ATTRIBUTES COME FROM. `fields` is a flat map of strings, so each
 * attribute arrives under its key with ATTRIBUTE_FIELD_PREFIX in front of it —
 * see attributeFields below, which is what domain/cards.ts calls at both
 * doors. The screening worker (domain/screening.ts) passes no attribute fields
 * and nothing changes for it: a posting that reaches screening has already
 * been through this door.
 */
const subject = (item: IntakeItem) =>
  item.door === 'posting' || item.door === 'amendment' ? item.fields?.kind : item.text;

/**
 * How an attribute rides in `fields`. A colon cannot appear in an attribute
 * key (the schema's propertyNames pattern is lower_snake_case), so the prefix
 * can never be confused with a key of its own, and `category` and `kind` can
 * never be mistaken for attributes.
 */
export const ATTRIBUTE_FIELD_PREFIX = 'attribute:';

/** The attributes off a posting, in the shape the pipe carries fields in. */
export function attributeFields(
  attributes: Record<string, unknown> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    // Booleans carry no figure and a missing value is nothing to read. Numbers
    // are stringified here so that `budget: 25` and `budget: "25"` are the
    // same attribute written two ways by the time the rule sees them.
    if (typeof value === 'string') out[`${ATTRIBUTE_FIELD_PREFIX}${key}`] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) {
      out[`${ATTRIBUTE_FIELD_PREFIX}${key}`] = String(value);
    }
  }
  return out;
}

/** The first attribute on the item that carries a figure, if any does. */
function attributeWithFigure(item: IntakeItem): { key: string; rule: string } | undefined {
  for (const [field, value] of Object.entries(item.fields ?? {})) {
    if (!field.startsWith(ATTRIBUTE_FIELD_PREFIX)) continue;
    const key = field.slice(ATTRIBUTE_FIELD_PREFIX.length);
    const rule = attributeFigureRule(key, value);
    if (rule) return { key, rule };
  }
  return undefined;
}

export const moneyFigure: Check = {
  name: 'moneyFigure',
  // The report door too: somebody writing down what a stranger did to them is
  // exactly where a price lands by accident, and the pipe holds those words
  // rather than refusing the report (intake/pipe.ts, REFUSAL_FREE_DOORS).
  doors: ['message', 'posting', 'amendment', 'report'],
  async run(item) {
    const refusal = (detail: string, plain: string, field: string): CheckResult => ({
      name: 'moneyFigure',
      outcome: 'refuse',
      reason_code: 'money-figure-in-words',
      // The rule that fired, so a refusal is one a person can justify out loud.
      detail,
      plain_words: plain,
      field,
    });
    const words = subject(item);
    const rule = typeof words === 'string' ? moneyFigureRule(words) : undefined;
    // The words for the thing come first. They are read at every door, they
    // are the oldest half of this check, and on a posting they are the one
    // field an assistant must fix before anything else about it matters.
    if (rule) {
      return refusal(
        rule,
        FIGURE_IN_WORDS_ACTION,
        item.door === 'posting' || item.door === 'amendment' ? 'kind' : 'text',
      );
    }
    const attribute = attributeWithFigure(item);
    if (attribute) {
      return refusal(
        `attribute ${attribute.key}: ${attribute.rule}`,
        figureInAttributeAction(attribute.key),
        `attributes.${attribute.key}`,
      );
    }
    return passed('moneyFigure');
  },
};
