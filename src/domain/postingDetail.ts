/**
 * DOES THE POSTING SAY ENOUGH TO DESCRIBE THE THING TO A STRANGER?
 *
 * The rehearsal that bought this (19 September 2026). A human said they had an
 * upgraded Fanatec pedal spring going spare. Their assistant put up "upgraded
 * Fanatec pedal spring" with NO attributes at all — it never asked which pedal
 * set the spring came off, which model, what condition it was in or what came
 * with it — invented the path 'goods.sim-racing.pedal-parts', and left. The
 * founder's words: "we need the user's AI to ask questions until it understands
 * everything fully, something it is failing to do at present."
 *
 * We cannot make an assistant curious. What we can do is decline to go along
 * with a posting that says nothing, and hand back the questions it should have
 * asked — which is exactly what the switchboard already does with a place name
 * several towns answer to (LOCATION_AMBIGUOUS in geo/normalise.ts: "'X' names
 * more than one place. Ask your human which…"). This is that pattern applied to
 * the thing itself.
 *
 * THE RULE IS DELIBERATELY DETERMINISTIC. No model reads the posting here. A
 * model would have to be right about what "enough" means for every errand
 * anybody ever has, and it would be wrong quietly. Counting stated facts is a
 * rule an author can read, reproduce and argue with:
 *
 *   goods, offering     kind, AND two identifying facts, AND the condition.
 *   goods, looking_for  kind, AND one identifying fact. Lighter on purpose:
 *                       somebody looking for a thing may not know its model,
 *                       and that is what they are asking other people for.
 *   services / social   kind, AND one fact about what, when or how. Lighter
 *                       still: an errand is mostly words, and the words are
 *                       in `kind`.
 *   anything else       untouched.
 *
 * Since 26 September 2026 "identifying" is any fact about the thing rather
 * than about the arrangement (see ARRANGEMENT_KEY below), food and shares are
 * asked for no make, model or condition, and nothing lent or hired is asked
 * for a maker. And a second attempt carrying the reference the first refusal
 * handed over is never asked the same questions again (domain/cards.ts).
 *
 * The keys are real ones. `attributes` is an open bag at the schema level
 * (lower_snake_case, identity and sensitive keys forbidden), so "identifying"
 * cannot be read off the schema; it is read off the taxonomy instead — the
 * common_attributes every node inherits plus every per-node attribute in
 * taxonomy.v2.json — with a short list of the plain words posting assistants
 * actually write for the same facts (make, fits, quantity, variant).
 *
 * AMEND NEVER COMES HERE. An amend only ever adds to a posting that is already
 * up, and refusing one would take a thing off the board for being what it
 * already was.
 *
 * WHAT WAS ASKED IS REMEMBERED ELSEWHERE, on the attempt's own reference number
 * (domain/postingRef.ts). It used to be remembered here, keyed on the poster's
 * own words for the thing — and the questions below ask for sharper words, so
 * the key moved every time an assistant did as it was told. This file decides
 * what a posting is short of and says it in plain words; it remembers nothing.
 */
import { onLostPetShelf } from './shelfRules.js';

/**
 * The facts that say WHICH ONE it is. Ordered by how often a posting has one,
 * which only matters for the questions below.
 *
 * `condition` is deliberately NOT here: on something offered it is asked for in
 * its own right, and letting it count towards the two would let "good, and
 * nothing else" through.
 */
export const IDENTIFYING_KEYS: readonly string[] = [
  // common_attributes, which every node inherits.
  'brand',
  'model',
  'colour',
  'year',
  // The plain words assistants write for the same facts. None of these is in
  // the taxonomy; all four turn up in real postings.
  'make',
  'type',
  'variant',
  'material',
  'quantity',
  'compatible_with',
  'fits',
  'size',
  // Per-node attributes in taxonomy.v2.json, which are all measurements of
  // which-one-is-it.
  'frame_size',
  'clothing_size',
  'shoe_size',
  'bed_size',
  'wheel_size_in',
  'screen_in',
  'storage_gb',
  'ram_gb',
  'battery_wh',
  'width_cm',
  'height_cm',
  'depth_cm',
  'seats',
  'suspension',
  'lens_mount',
  'shutter_count',
  'handedness',
  'unlocked',
  'expiry_year',
];

/**
 * The facts that say WHAT, WHEN or HOW on an errand or something social. Every
 * one of them is a taxonomy key: common_attributes has the first seven, and
 * `level` is services.tutoring's own.
 */
export const CONTEXT_KEYS: readonly string[] = [
  'format',
  'frequency',
  'day_part',
  'duration_min',
  'group_size',
  'language',
  'proficiency',
  'experience',
  'level',
];

/** The word for the condition of a thing, as the taxonomy spells it. */
export const CONDITION_KEY = 'condition';

/** How many identifying facts something offered has to state. */
export const OFFERING_IDENTIFYING_MIN = 2;
/** And something wanted. Lighter, because they are asking rather than telling. */
export const WANT_IDENTIFYING_MIN = 1;

/** The most questions one refusal carries. Past four it is a form to fill in. */
export const MAX_QUESTIONS = 4;

/** A stated fact: a scalar with something in it. Same reading as projectionText. */
function stated(attributes: unknown, key: string): boolean {
  if (!attributes || typeof attributes !== 'object') return false;
  const v = (attributes as Record<string, unknown>)[key];
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  return typeof v === 'string' && v.trim().length > 0;
}

function statedKeys(attributes: unknown, keys: readonly string[]): string[] {
  return keys.filter((k) => stated(attributes, k));
}

// ---------------------------------------------------------------------------
// WHAT ELSE COUNTS, AND WHAT NEVER DOES (26 September 2026).
//
// An edge-case probe on dev posted the things people really post, and the
// rule above turned most of them back for want of a brand. A black adjustable
// office chair in good condition; a pine bookshelf with five shelves; a box of
// croissants and danishes left over at close; a Spanish want for "bicicleta de
// paseo o híbrida, talla mediana". Every one of those says plainly what the
// thing is, and every one came back because its facts were written under keys
// the list above had never heard of — `shelves`, `types`, `tipo`, `adjustable`.
// The Spanish one came back twice, with the same questions, after its assistant
// had done exactly what it was asked.
//
// The list above was only ever a way of saying "a fact about which one it is".
// So a fact under any other key counts too, with one exception, written down
// here: the keys that are about the ARRANGEMENT rather than the thing — when,
// where, how it changes hands, what it costs, what is swapped for it. "Pick up
// today, free, swap for a bike" says nothing a stranger could recognise the
// thing by, and a posting made of those still comes back. The pedal spring the
// gate was built for, with nothing at all under `attributes`, still comes back
// exactly as it did.
//
// Deterministic, as the rest of this file is: a key is matched on its spelling
// and nothing reads its value.
// ---------------------------------------------------------------------------

/** Keys about the arrangement rather than the thing. Never identifying. */
const ARRANGEMENT_KEY =
  /^(free|free_only|pick_?up\w*|can_pick_up|collect\w*|deliver\w*|postage|posting|ship\w*|price\w*|cost\w*|budget\w*|rate\w*|payment\w*|pay|swap\w*|trade\w*|in_exchange|exchange\w*|when|date|dates|day|days|time|start\w*|end\w*|until|available\w*|availability|duration\w*|return\w*|order_closes|deadline|urgen\w*|arrangement|seller|buyer|negotiable|location|place|area|suburb|contact\w*|phone|email|slots|spots)$/;

/** Every key on the posting that says something about WHICH thing it is. */
function identifyingFacts(attributes: unknown): string[] {
  if (!attributes || typeof attributes !== 'object') return [];
  return Object.keys(attributes as Record<string, unknown>).filter(
    (k) =>
      stated(attributes, k) &&
      k !== CONDITION_KEY &&
      (IDENTIFYING_KEYS.includes(k) || !ARRANGEMENT_KEY.test(k)),
  );
}

/**
 * Every key on an errand or something social that says WHAT, WHEN or HOW. The
 * context keys, and anything else a poster wrote about it except the money:
 * a hiking group on "Saturday 4 October, 8am, moderate, 12 km" was asked
 * whether it was in person or online, and a lost kelpie with a red collar how
 * often it would suit. Both had said what they were.
 */
function contextFacts(attributes: unknown): string[] {
  if (!attributes || typeof attributes !== 'object') return [];
  return Object.keys(attributes as Record<string, unknown>).filter(
    (k) =>
      stated(attributes, k) &&
      (CONTEXT_KEYS.includes(k) ||
        !/^(price\w*|cost\w*|budget\w*|rate\w*|payment\w*|pay|contact\w*|phone|email)$/.test(k)),
  );
}

// ---------------------------------------------------------------------------
// A MAKE AND MODEL IS A QUESTION ABOUT A PRODUCT.
//
// The same probe asked "What make and model is the share of bulk coffee
// order?", "…the leftover pastries?", "…the surfboard hire?" and "…the
// extension ladder to borrow?". Food has no model; a share of an order is not
// a thing with a maker; somebody after a ladder for a Saturday wants one that
// is tall enough, and which factory made it is beside the point. So the
// question is asked only of something that is a product in the ordinary sense,
// and it is decided, like everything else here, on the words: the shelf, the
// poster's own name for the thing, and the arrangement where they said one.
//
// Food and shares also carry no condition. "What condition is the leftover
// pastries in?" is not a question anybody could answer, and the answer the
// switchboard would want there (made today, sealed, how many) is a fact about
// the thing, which the count above already reads.
// ---------------------------------------------------------------------------

/** Words for something eaten, used up, or split between people. */
const CONSUMABLE_WORDS =
  /\b(share|shares|leftovers?|surplus|bulk|food|groceries|produce|pastr(y|ies)|bread|cakes?|biscuits|fruit|veg|vegetables|eggs|honey|jam|preserves)\b/i;

/** Words for a thing lent or hired rather than handed over for good. */
const LENDING_WORDS = /\b(hire|hiring|borrow|borrowing|lend|lending|loan|rent|rental|renting)\b/i;

/** The shelf of things that are eaten. */
const FOOD_SHELF = /^goods\.food(\.|$)/;

/** Something eaten or split between people: no make, no model, no condition. */
function isConsumable(card: { category?: unknown; kind?: unknown }): boolean {
  if (FOOD_SHELF.test(String(card.category ?? ''))) return true;
  return typeof card.kind === 'string' && CONSUMABLE_WORDS.test(card.kind);
}

/** Lent or hired: the maker is beside the point, the condition still matters. */
function isLending(card: { kind?: unknown; attributes?: unknown }): boolean {
  if (typeof card.kind === 'string' && LENDING_WORDS.test(card.kind)) return true;
  const a = card.attributes as Record<string, unknown> | undefined;
  const arrangement = a && typeof a === 'object' ? a.arrangement : undefined;
  return typeof arrangement === 'string' && LENDING_WORDS.test(arrangement);
}

/** The poster's own words, where they gave any, for echoing back in a question. */
function thingWords(kind: unknown): string | undefined {
  const k = typeof kind === 'string' ? kind.trim() : '';
  return k ? k : undefined;
}

/**
 * The thing, as a question can name it: the poster's own words where they gave
 * any, and "it" otherwise. NEVER a guess at what the thing is — echoing what
 * they wrote is the whole of what this may do.
 */
const naming = (kind: unknown): string => {
  const words = thingWords(kind);
  return words ? `the ${words}` : 'it';
};

export interface DetailShortfall {
  /** What to ask the human, in plain words, at most MAX_QUESTIONS of them. */
  questions: string[];
  /** Which line tells the assistant what to do with them: goods or not. */
  human_action: string;
}

/**
 * What a posting is short of, or undefined where it says enough.
 *
 * `category` is the path as the assistant wrote it, because the top level is
 * what decides which rule applies and the top level of an invented path is
 * still the assistant's own word for the kind of thing it is.
 */
export function detailShortfall(card: {
  category?: unknown;
  type?: unknown;
  kind?: unknown;
  attributes?: unknown;
}): DetailShortfall | undefined {
  const top = String(card.category ?? '').split('.')[0];
  const offering = card.type === 'offering';
  const kind = thingWords(card.kind);
  const thing = naming(card.kind);

  if (top === 'goods') {
    const identifying = identifyingFacts(card.attributes);
    const hasCondition = stated(card.attributes, CONDITION_KEY);
    const consumable = isConsumable(card);
    // A product in the ordinary sense: something with a maker, handed over.
    const product = !consumable && !isLending(card);
    const needsCondition = offering && !consumable;
    const need = offering ? OFFERING_IDENTIFYING_MIN : WANT_IDENTIFYING_MIN;
    const enough = kind && identifying.length >= need && (!needsCondition || hasCondition);
    if (enough) return undefined;

    // One question per thing that is missing, in the order a person would ask
    // them. Each one is generic to the field; the only thing taken from the
    // posting is the poster's own words for the thing.
    const questions: string[] = [];
    if (!kind) questions.push('What is it, in a few plain words?');
    const named = statedKeys(card.attributes, ['brand', 'make', 'model']).length > 0;
    const short = identifying.length < need;
    // The maker is asked for only where the facts are short and the thing is
    // a product. A bookshelf with its material and its shelves counted, and
    // short only of its condition, is asked about its condition and nothing
    // else.
    if (short && product && !named) questions.push(`What make and model is ${thing}?`);
    if (short) {
      questions.push(
        product
          ? `Which one is ${thing} exactly — the size, the type, or what it fits?`
          : `Can you say a bit more about ${thing}: what sort, and how much or how many?`,
      );
    }
    if (needsCondition && !hasCondition) questions.push(`What condition is ${thing} in?`);
    if (offering && product && identifying.length === 0) questions.push('What comes with it?');
    return { questions: questions.slice(0, MAX_QUESTIONS), human_action: DETAIL_HUMAN_ACTION };
  }

  // A LOST OR FOUND PET is described by what it looks like and where it went
  // missing or turned up (26 September 2026). The social questions below ask
  // whether a thing is in person or online and how often it would suit, which
  // is nonsense asked of a lost kelpie; a stranger recognises a pet by its
  // look and its whereabouts. Same bar as the rest of social: its own words and
  // one fact, under any key but the money.
  if (onLostPetShelf(String(card.category ?? ''))) {
    const facts = contextFacts(card.attributes);
    if (kind && facts.length >= 1) return undefined;
    const questions: string[] = [];
    if (!kind) questions.push('What kind of pet is it, in a few plain words?');
    if (facts.length === 0) {
      questions.push(
        'What does the pet look like: its colour, its size, and any collar, tag or markings?',
      );
      questions.push(offering ? 'Where and when was it found?' : 'Where and when was it lost?');
    }
    return { questions: questions.slice(0, MAX_QUESTIONS), human_action: DETAIL_LOST_PET_HUMAN_ACTION };
  }

  if (top === 'services' || top === 'social') {
    const context = contextFacts(card.attributes);
    if (kind && context.length >= 1) return undefined;
    const questions: string[] = [];
    if (!kind) questions.push('What is it, in a few plain words?');
    if (context.length === 0) {
      questions.push('Is this in person or online?');
      questions.push('How often, and when would suit?');
    }
    return {
      questions: questions.slice(0, MAX_QUESTIONS),
      human_action: DETAIL_CONTEXT_HUMAN_ACTION,
    };
  }

  return undefined;
}

/**
 * The one line telling the assistant what to do with the questions.
 *
 * IT NAMES THE KEYS, and that is the whole of the 20 September fix. The rule
 * counts stated facts under the keys above; the refusal used to describe them
 * only as "their answers", so an assistant had no way to tell which of the
 * things it already knew would count. Three transcripts in a row show the same
 * misreading of it — the seller's assistant went back to its human hunting for
 * a part number, a spring rate or a colour code for a second-hand pedal spring,
 * when `fits: ClubSport V3 pedals` alongside `brand: Fanatec` was sitting in
 * the conversation already and would have gone straight through. Naming the
 * keys, and saying outright that no part number is wanted, costs the gate
 * nothing: the bar is the same count of the same facts.
 *
 * Every key named here MUST be one the rule actually counts. The suite asserts
 * that, because a refusal that asks for a key the count ignores is the loop
 * this constant was rewritten to end.
 *
 * WHAT WAS CUT to make room, the cap being 300 characters: the old closing
 * line, "Put only the questions to them: that it came back, and how it is sent
 * again, is yours to handle quietly." The manual still carries that rule in
 * full (mcp/instructions.ts, the "posting" section), and it is about how the
 * assistant talks rather than about what the posting is short of.
 */
export const DETAIL_HUMAN_ACTION =
  'Ask your human these, then post again with the answers in `attributes`: brand, model, type, size, fits, material, condition. What it fits or what sort it is counts; no part number is wanted. Write in what you already know without asking. If they do not know, send it again with detail_unknown.';

/**
 * THE GOODS LINE WITH THE RADIUS QUESTION RIDING ON IT (26 September 2026).
 *
 * A goods posting that chose a radius is asked once whether it really is
 * pick-up only, and that question now comes back beside the detail questions
 * rather than on a round trip of its own (domain/cards.ts, the radius gate).
 * The last question's answer goes in a different field, so this line says so.
 * Room for that under the 300-character cap was made by dropping two clauses
 * the manual's posting section already carries in full: "write in what you
 * already know" and "what it fits or what sort it is counts". Every key it
 * names is still one the count reads, which the suite asserts.
 */
export const DETAIL_AND_RADIUS_HUMAN_ACTION =
  'Ask your human these, then post again with the answers in `attributes`: brand, model, type, size, fits, material, condition. The last one goes in `reach`: "country", or the same radius if pick-up only. No part number is wanted. If they do not know, send it again with detail_unknown.';

/**
 * THE SAME LINE FOR A SERVICE OR A SOCIAL POSTING.
 *
 * The goods line above was served to everything until 25 September 2026, when
 * the first production run posted a Spanish conversation partner and was told
 * to ask its human for a brand, a model and a condition. The questions that came
 * with it were right ("Is this in person or online?"); only this line was
 * written for a pedal spring. Same rule as above: every key it names is one
 * the count reads (CONTEXT_KEYS).
 */
export const DETAIL_CONTEXT_HUMAN_ACTION =
  'Ask your human these, then post again with the answers in `attributes`: format, frequency, day_part, language, level. In person or online, and how often, is what counts. Write in what you already know without asking. If they do not know, send it again with detail_unknown.';

/**
 * THE SAME LINE FOR A LOST OR FOUND PET (26 September 2026). Its keys are the
 * poster's to choose, and any of them counts (contextFacts reads every key but
 * the money), so the line names the facts rather than a fixed vocabulary, and
 * says outright that no price or reward goes on it: the door refuses both
 * (domain/shelfRules.ts).
 */
export const DETAIL_LOST_PET_HUMAN_ACTION =
  'Ask your human these, then post again with the answers in `attributes`: species, colour, markings, where and when. No price or reward goes on it. Write in what you already know without asking. If they do not know, send it again with detail_unknown.';

/**
 * And the one line for an assistant that DID reach for the escape hatch and
 * was refused anyway.
 *
 * The hatch used to be keyed on the poster's own words for the thing, so it
 * only recognised a second attempt that spelled the thing the same way — and
 * the questions above invite an assistant to sharpen exactly those words. A
 * posting that went from "upgraded Fanatec pedal spring" to "Fanatec ClubSport
 * V3 brake performance spring" was a first attempt again as far as the row was
 * concerned, and the loop closed. It is keyed on the attempt's reference now
 * (domain/postingRef.ts), which nothing the assistant writes can move, so this
 * sentence is only ever reached by an attempt that carried no reference at all
 * — a genuinely new one, or one whose reference was dropped along the way.
 *
 * The reference is machinery. The sentence names the field to send back and
 * never suggests saying it to anybody.
 */
export const DETAIL_UNKNOWN_UNMATCHED =
  'detail_unknown takes a posting as it stands only on a second try, once the questions have actually been put to your human. This one reads as a first try, because it carried no `reference` from a refusal. Ask them, then send it again with detail_unknown and the `reference` below.';

// ---------------------------------------------------------------------------
// THE ESCAPE HATCH, AND WHY IT TURNS ON A SECOND ATTEMPT.
//
// Somebody really may not know. A spring came off a pedal set they no longer
// own; a box of cables came out of a cupboard. Refusing that posting for ever
// would be the switchboard deciding it knows better than the person whose thing
// it is, so `detail_unknown` takes it as it stands.
//
// What the flag alone must not do is let an assistant skip the asking. So it
// only works on a SECOND attempt at the same thing: the reference the first
// refusal handed over, sent back. That is the shape of an assistant that put
// the questions to its human and was told nobody knows.
//
// The reference lives in a row rather than in this process because the process
// is one of several, and an agent that reaches a different replica on its
// second call would otherwise be trapped by a rule meant to stop nobody.
// ---------------------------------------------------------------------------
