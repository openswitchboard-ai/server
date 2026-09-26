/**
 * SHELF RULES, READ FROM THE DATA (27 September 2026).
 *
 * The catalogue is a deny list (schema SPEC §2): a path decides whether a
 * family is open, and the model screen decides whether the thing itself is one
 * the switchboard carries. Some shelves need a rule of their own on top of
 * that, about WHAT KIND of thing sits on an open shelf or whether money may
 * change hands there. Those rules are written on the taxonomy node, in the
 * schema repo, never here (SPEC §2, "Shelf rules live in the data"):
 *
 *   no_money      nothing on the shelf carries a price, an ask, a best offer,
 *                 money words, a figure, an offer, a link or a settlement.
 *   not_allowed   things the shelf does not take, each { what, reason_code,
 *                 words }: `words` are the triggers, `what` is the plain name
 *                 the one sentence below says, `reason_code` is what is
 *                 recorded.
 *   consumable    and `thing`, read by the detail questions (postingDetail.ts)
 *                 and, for `thing`, by the swap rule (swaps.ts).
 *   screen_note   read by the model screen beside the shelf's labels.
 *
 * Every rule is inherited: a node's rule holds for everything filed beneath
 * it, including a leaf the catalogue has never heard of. The founder's rule
 * (27 September 2026) is that no code is written for any particular goods or
 * services; this file names none, and every sentence in it is the same on
 * every shelf, apart from the plain words the data supplies.
 *
 * DETERMINISTIC, as the other cheap refusals at the door are. It reads words,
 * it can be argued with, and it runs at publish (on the path as sent and again
 * on the shelf the door files it under), at amend (on the posting as it will
 * stand), and in the screening worker as a backstop.
 */
import { nodesOnPath, taxonomyNodes } from '../denylist.js';

/** One thing a shelf does not take, as the taxonomy writes it. */
interface NotAllowedRule {
  what: string;
  reason_code: string;
  words: string[];
}

/** The rules the taxonomy holds for this path, gathered down its length. */
export interface ShelfPolicy {
  no_money: boolean;
  consumable: boolean;
  thing: boolean;
  not_allowed: { what: string; reason_code: string; pattern: RegExp }[];
  screen_notes: string[];
}

const compiled = new Map<string, RegExp>();

/** The rule's trigger words as one case-insensitive whole-word pattern. */
function patternOf(rule: NotAllowedRule): RegExp {
  const key = rule.words.join('\u0000');
  let re = compiled.get(key);
  if (!re) {
    re = new RegExp(`\\b(?:${rule.words.map((w) => `(?:${w})`).join('|')})\\b`, 'i');
    compiled.set(key, re);
  }
  return re;
}

/** Every rule on this path and above it. An unknown leaf inherits its parents'. */
export function shelfPolicy(category: string | null | undefined): ShelfPolicy {
  const out: ShelfPolicy = {
    no_money: false,
    consumable: false,
    thing: false,
    not_allowed: [],
    screen_notes: [],
  };
  for (const node of nodesOnPath(category)) {
    if (node.no_money === true) out.no_money = true;
    if (node.consumable === true) out.consumable = true;
    if (node.thing === true) out.thing = true;
    if (typeof node.screen_note === 'string') out.screen_notes.push(node.screen_note);
    for (const r of (node.not_allowed ?? []) as NotAllowedRule[]) {
      if (r && typeof r.what === 'string' && typeof r.reason_code === 'string' && Array.isArray(r.words)) {
        out.not_allowed.push({ what: r.what, reason_code: r.reason_code, pattern: patternOf(r) });
      }
    }
  }
  return out;
}

/** Is this a shelf where no money may change hands? */
export function noMoneyOnShelf(category: string | null | undefined): boolean {
  return shelfPolicy(category).no_money;
}

/** What the rules read: the path, the poster's words, and the money fields. */
export interface ShelfRuleCard {
  category?: unknown;
  kind?: unknown;
  also_called?: unknown;
  attributes?: unknown;
  ask?: unknown;
  price?: unknown;
  sale?: unknown;
}

/** The reason code for money on a no-money shelf. */
export const NO_MONEY_REASON = 'no-money-on-this-shelf';

export interface ShelfRuleRefusal {
  /** The reason code, for the row and the ledger. Never said aloud. */
  reason_code: string;
  /** The sentence the human hears. */
  human_action: string;
  /** The field to fix, where the refusal is about one. */
  field?: string;
}

/** THE ONE SENTENCE for a thing a shelf does not take. `what` is the data's. */
export function notAllowedSentence(what: string): string {
  return `That can't go up on this shelf: it takes no ${what}.`;
}

/** THE ONE SENTENCE for money on a shelf that carries none. */
export const NO_MONEY_POSTING_SENTENCE =
  'Nothing on this shelf carries money: no price, no reward and no offer. Take that off and it can go up.';

/**
 * The sentence for a reason code a shelf rule records, found in the data, or
 * undefined where no shelf rule records that code.
 */
export function shelfReasonSentence(reasonCode: string): string | undefined {
  if (reasonCode === NO_MONEY_REASON) return NO_MONEY_POSTING_SENTENCE;
  for (const node of taxonomyNodes()) {
    for (const r of (node.not_allowed ?? []) as NotAllowedRule[]) {
      if (r?.reason_code === reasonCode && typeof r.what === 'string') return notAllowedSentence(r.what);
    }
  }
  return undefined;
}

/** Every word the poster wrote about the thing: kind, other names, values. */
function postersWords(card: ShelfRuleCard): string {
  const out: string[] = [];
  if (typeof card.kind === 'string') out.push(card.kind);
  if (Array.isArray(card.also_called)) {
    for (const p of card.also_called) if (typeof p === 'string') out.push(p);
  }
  const a = card.attributes;
  if (a && typeof a === 'object') {
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      out.push(k.replace(/_/g, ' '));
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
    }
  }
  return out.join(' \n ').toLowerCase();
}

/** Money in the poster's own words, figure or none. General money words only. */
const MONEY_WORDS = /\b(?:reward|price|paid|payment|fee|cost|cash)\b/;

/**
 * The refusal this posting earns on the shelf it is filed under, or undefined
 * where it may go up. Order: the thing itself first (not_allowed), then the
 * money, because taking a price off a thing the shelf does not take would
 * still leave a thing the shelf does not take.
 */
export function shelfRuleRefusal(card: ShelfRuleCard): ShelfRuleRefusal | undefined {
  const category = typeof card.category === 'string' ? card.category : '';
  const policy = shelfPolicy(category);
  if (!policy.no_money && !policy.not_allowed.length) return undefined;
  const words = postersWords(card);
  for (const rule of policy.not_allowed) {
    if (rule.pattern.test(words)) {
      return { reason_code: rule.reason_code, human_action: notAllowedSentence(rule.what) };
    }
  }
  if (policy.no_money) {
    const field = card.price
      ? 'price'
      : card.ask
        ? 'ask'
        : card.sale === 'best-offer'
          ? 'sale'
          : MONEY_WORDS.test(words)
            ? 'attributes'
            : undefined;
    if (field) return { reason_code: NO_MONEY_REASON, human_action: NO_MONEY_POSTING_SENTENCE, field };
  }
  return undefined;
}

let consumableCache: RegExp | undefined;

/**
 * The words that mark a posting as consumable by its own `kind`, wherever it
 * is filed: every `consumable_words` list in the taxonomy, as one whole-word
 * pattern. Plain words, so each is escaped.
 */
export function consumableWords(): RegExp {
  if (!consumableCache) {
    const words = new Set<string>();
    for (const node of taxonomyNodes()) {
      for (const w of node.consumable_words ?? []) if (typeof w === 'string' && w) words.add(w);
    }
    const alts = [...words].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    consumableCache = alts.length ? new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i') : /(?!)/;
  }
  return consumableCache;
}
