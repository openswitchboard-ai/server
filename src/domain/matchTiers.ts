/**
 * SEARCH AND SHELF, TIERED (Lachlan, 20 September 2026).
 *
 * Until today the shelf was a gate: two postings on shelves the tree called
 * incompatible were never compared at all. That made filing the whole game,
 * and the first people on the switchboard are expected to post exactly the
 * obscure things a catalogue files worst. So the matcher now also searches the
 * whole board by meaning, and every pair it looks at — on the shelf or found by
 * search — is put in one of three tiers by the pure function in this file:
 *
 *   SURE      an introduction exactly as before.
 *   POSSIBLE  an introduction marked certainty 'possible'. Everything about it
 *             works the same, and every answer and email that names it tells
 *             the assistant it may or may not be the same thing: show the
 *             details, ask, and never call it the thing they asked for.
 *   NOTHING   no introduction. The band just under POSSIBLE on a compatible
 *             shelf is still a near miss, exactly as before.
 *
 * TWO SIGNALS DECIDE IT, beside the hard rules (geo, price, urgency, mutes,
 * own account), which have not moved:
 *
 *   MEANING: the cosine between the two postings' projection embeddings.
 *
 *   WORD AGREEMENT (wordAgreement below): the distinctive words of the two
 *   postings, their `kind` and their attribute values, compared token by
 *   token as a weighted Dice. Brand and model words weigh most, the poster's
 *   own words for the thing next, everything else least, and stopwords,
 *   condition words and generic nouns ("spring", "part", "kit", "used") never
 *   count at all. A model is one token however it is punctuated (TB-303,
 *   TB303, "tb 303"). Two more things are read off it: whether the two named
 *   brands conflict (only where neither brand appears anywhere in the other
 *   posting, so Vorwerk and Thermomix do not), and whether the two HEAD NOUNS
 *   agree — the thing each posting is actually about, "case" in "iPhone 13
 *   case", compared on stems so "dog walker" and "dog walking" are one thing,
 *   and never a number, a unit or a size. A head the other posting never
 *   mentions is the plainest sign two postings are about different things
 *   however close their embeddings sit, and it is what keeps a SURE honest.
 *
 *   The BLEND (matchRules.ts evaluatePair) is still computed, with the shelf
 *   as a contributor rather than a gate: it is the fit an introduction
 *   stores, where the geo and price hard rules live, and what a near miss is
 *   judged on.
 *
 * PART AGAINST WHOLE defeats both signals (a chainsaw chain beside the
 * chainsaw, a bezel insert beside the watch): see isPartOrAccessoryOf on
 * PairFacts for where a pair judge would plug in.
 *
 * THE LINES ARE PROVISIONAL. The numbers below were fitted on a labelled
 * calibration set of hand-written pairs (the method is test/calibration; the
 * set itself is evaluation data kept outside this repository; run with
 * `npm run calibrate-tiers`, and read test/calibration/README.md for what
 * such a set does not cover). They live here
 * and only here so that script can import them, and they must be re-tuned on
 * real runs before anyone trusts them further. The POSSIBLE line on shared
 * words is a product decision still pending with the founder.
 *
 * Everything in this file is pure: no I/O, no clock, no randomness.
 */
import {
  NEAR_MISS_FLOOR,
  categoryCloseness,
  categoryCompatible,
  evaluatePair,
  otherWordsOf,
  type GeoBucket,
  type PairEval,
  type PriceBand,
} from './matchRules.js';

// ---------------------------------------------------------------------------
// The lines. PROVISIONAL, pending calibration (see the header).
// ---------------------------------------------------------------------------

/**
 * SURE: the embedding cosine the pair must reach, AND the word agreement
 * (wordAgreement().score, a weighted Dice), AND no head-noun or brand conflict.
 * Fitted on test/calibration; the conflict check is what held false SUREs at
 * zero across twenty held-out seeds (four to seven without it).
 */
export const SURE_MIN_COSINE = 0.7;
export const SURE_MIN_WORDS = 0.58;
/** POSSIBLE on meaning alone: this cosine or above. Fitted on test/calibration. */
export const POSSIBLE_MIN_COSINE = 0.81;
/**
 * POSSIBLE on shared words: any distinctive word in common AND this cosine.
 * PROVISIONAL AT 0.50 pending the founder's decision on how many false maybes
 * one real one is worth (test/calibration README, the POSSIBLE trade-off).
 */
export const POSSIBLE_WORDS_MIN_COSINE = 0.5;
/** Near miss, on a compatible shelf only, exactly as before. */
export const NEAR_MISS_MIN_BLEND = NEAR_MISS_FLOOR;

/** How much each kind of word weighs in the overlap. */
export const WORD_WEIGHTS = { brand: 3, model: 3, kind: 2, other: 1 } as const;

/** How many postings from anywhere on the board join each run's candidates. */
export const CROSS_SHELF_TOP_N = 10;

/** How many POSSIBLE introductions one posting may be given in a day, to limit fishing. */
export const POSSIBLE_PER_POSTING_PER_DAY = 3;

export type Tier = 'sure' | 'possible' | 'near-miss' | 'nothing';

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

/** Attribute keys whose values are a brand. */
const BRAND_KEYS = new Set(['brand', 'make', 'manufacturer', 'maker', 'label']);
/** Attribute keys whose values name a model, a part or what it fits. */
const MODEL_KEYS = new Set([
  'model',
  'model_number',
  'series',
  'variant',
  'version',
  'edition',
  'part',
  'part_number',
  'part_no',
  'sku',
  'set',
  'set_number',
  'fits',
  'compatible_with',
  'suits',
  'for',
]);
/** Attribute keys that describe the state of the thing rather than what it is. */
const SKIP_KEYS = new Set([
  'condition',
  'colour',
  'color',
  'quantity',
  'qty',
  'age',
  'year',
  'notes',
  'price',
  'format',
  'availability',
]);

/** Words that carry no meaning about the thing. */
const STOP = new Set(
  (
    'a an the and or of for with to from in on at by into onto off my your our their its this that ' +
    'some any one two pair wanted want looking after need needed have has sale sell selling offer ' +
    'please thanks x'
  ).split(' '),
);
/** Words about the state of the thing, never about what it is. */
const CONDITION = new Set(
  (
    'used new secondhand second hand good great excellent fair poor working mint condition like ' +
    'spare old barely boxed unboxed clean tidy near perfect ok okay decent'
  ).split(' '),
);
/**
 * Nouns too general to show two postings agree on anything by themselves. They
 * still count as a head noun, because "spring" is what a brake spring IS, and
 * they still sit in a posting's words for the head check; they never count as
 * overlap.
 */
const GENERIC = new Set(
  (
    'spring part kit set item thing piece accessory unit bundle lot stuff gear equipment ' +
    'tool supplies supply bits bit component replacement upgrade upgraded spares'
  ).split(' '),
);
/** Generic words that say what a thing comes in rather than what it is. */
const CONTAINERS = new Set(['kit', 'set', 'bundle', 'lot', 'pack', 'box', 'collection']);
/** The few equivalents a first cut needs; each side is rewritten to the right-hand words. */
const ALIASES: Record<string, string[]> = {
  dualsense: ['playstation', 'controller'],
  ps5: ['playstation'],
  ps4: ['playstation'],
  ps: ['playstation'],
  engine: ['motor'],
  engines: ['motor'],
  tutoring: ['tutor'],
  tuition: ['tutor'],
  lessons: ['lesson'],
  handed: ['hand'],
  telly: ['tv'],
  television: ['tv'],
  pushchair: ['stroller'],
  pram: ['stroller'],
  bicycle: ['bike'],
  synthesizer: ['synthesiser'],
  synth: ['synthesiser'],
  mobile: ['phone'],
  cellphone: ['phone'],
  smartphone: ['phone'],
};
/** Words that end the head phrase of a posting's own words: "spring FOR fanatec pedals". */
const HEAD_BREAK = new Set([
  'for', 'with', 'to', 'from', 'of', 'in', 'on', 'off', 'suits', 'fits', 'that', 'and', 'plus', 'or',
]);
/** Units and sizes: never the thing itself, so never the head ("iPhone 13 128 GB"). */
const UNITS = new Set(['gb', 'tb', 'mb', 'mm', 'cm', 'm', 'kg', 'g', 'ml', 'l', 'in', 'inch', 'v', 'w', 'ah', 'lb', 'wt']);
const SIZE = /^\d+(\.\d+)?(gb|tb|mb|mm|cm|m|kg|g|ml|l|in|inch|v|w|ah|lb|wt)?$/;
/** Not a head: a bare number, a unit, or a size ("13", "gb", "128gb"). */
const notAHead = (t: string) => SIZE.test(t) || UNITS.has(t) || ORDINAL.test(t) || QUALIFIERS.has(t);
/** "11th", "2nd": a generation, never the thing. */
const ORDINAL = /^\d+(st|nd|rd|th)$/;
/** Words that say which generation, never what: "11th gen". */
const QUALIFIERS = new Set(['gen', 'generation']);

/**
 * The stem two heads are compared on, so an inflection is never a
 * disagreement: walker, walking, walks and walked are all "walk".
 */
export function headStem(t: string): string {
  if (/\d/.test(t) || t.length <= 4) return t;
  for (const suffix of ['ings', 'ing', 'ers', 'er', 'ed']) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 3) return t.slice(0, -suffix.length);
  }
  return t;
}

/** Fold, split and singularise, and rewrite through the aliases. */
export function tokensOf(text: unknown, opts: { joins?: boolean } = {}): string[] {
  if (typeof text !== 'string' && typeof text !== 'number') return [];
  const raw = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // A MODEL IS ONE TOKEN HOWEVER IT IS PUNCTUATED: "TB-303", "TB303" and
    // "c6-5" lose the mark inside the run (twice, for runs like rd-m8100-sgs).
    .replace(/([a-z0-9])[-/.]([a-z0-9])/g, '$1$2')
    .replace(/([a-z0-9])[-/.]([a-z0-9])/g, '$1$2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // And spaced: "tb 303" also yields "tb303", so all three spellings agree.
  for (let i = 0, n = opts.joins === false ? 0 : raw.length; i + 1 < n; i++) {
    const [a, b] = [raw[i], raw[i + 1]];
    if (/^[a-z]{1,6}$/.test(a) && !STOP.has(a) && /^\d+[a-z]{0,3}$/.test(b) && !(SIZE.test(b) && /[a-z]/.test(b))) raw.push(a + b);
  }
  const out: string[] = [];
  for (const w of raw) {
    const alias = ALIASES[w];
    if (alias) {
      out.push(...alias);
      continue;
    }
    const single = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !/\d/.test(w) ? w.slice(0, -1) : w;
    out.push(ALIASES[single]?.[0] ?? single);
  }
  return out;
}

/** A token that says something about what the thing is. */
const meaningful = (t: string) => !STOP.has(t) && !CONDITION.has(t) && (t.length > 1 || /\d/.test(t));

/** What one posting says about itself, sorted by how much each word counts. */
export interface PostingWords {
  kind?: string | null;
  /**
   * THE HUMAN'S OTHER WORDS FOR THE SAME THING (migration 050): the trade name,
   * the part number, "BPK", "die-spring mod". They weigh exactly what `kind`
   * weighs, because that is what they are — the same thing said again — and
   * they are what lets two postings that reached for different spellings agree.
   * They never become the head noun: the head is what the posting is ABOUT, and
   * the posting says that once, in `kind`.
   */
  also_called?: unknown;
  /**
   * THE PHRASES THE HUMAN SAYS IT IS NOT: "elastomer kit", "whole pedal set".
   * A NEGATIVE WORD SIGNAL and nothing else. A candidate whose own words are
   * dominated by one of these can never be sure and loses its word agreement —
   * but it is never filtered out, and it is never hidden from the human. They
   * hear about it as a maybe and they decide, which is the founder's rule.
   */
  not_these?: unknown;
  attributes?: unknown;
}

interface WordBag {
  /** Distinctive tokens, each at the heaviest weight it appeared at. */
  weights: Map<string, number>;
  /** Every meaningful token, generic ones included: what the head check reads. */
  all: Set<string>;
  brand: Set<string>;
  model: Set<string>;
  head?: string;
}

/**
 * A CONTAINER word says what the thing comes in, and the word before it says
 * what the thing is: "pedal spring kit" is springs, "elastomer kit" is
 * elastomers. Read the same way wherever a head is taken, so that the phrase a
 * human writes under `not_these` is read exactly as a posting's own words are.
 */
function throughTheContainer(head: string | undefined, phrase: string[]): string | undefined {
  return head && CONTAINERS.has(head) && phrase.length > 1 ? phrase[phrase.length - 2] : head;
}

function bagOf(p: PostingWords): WordBag {
  const weights = new Map<string, number>();
  const all = new Set<string>();
  const brand = new Set<string>();
  const model = new Set<string>();
  const add = (tokens: string[], w: number, into?: Set<string>) => {
    for (const t of tokens) {
      if (!meaningful(t)) continue;
      all.add(t);
      if (GENERIC.has(t)) continue;
      into?.add(t);
      if ((weights.get(t) ?? 0) < w) weights.set(t, w);
    }
  };
  const kindTokens = tokensOf(p.kind ?? '');
  add(kindTokens, WORD_WEIGHTS.kind);
  // The same thing said again, in the human's other words for it. Same weight
  // as `kind`, and no effect at all on the head noun below.
  for (const phrase of otherWordsOf(p.also_called)) add(tokensOf(phrase), WORD_WEIGHTS.kind);
  const attrs =
    p.attributes && typeof p.attributes === 'object' ? (p.attributes as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!['string', 'number'].includes(typeof v)) continue;
    const key = k.toLowerCase();
    if (SKIP_KEYS.has(key)) continue;
    if (BRAND_KEYS.has(key)) add(tokensOf(v), WORD_WEIGHTS.brand, brand);
    else if (MODEL_KEYS.has(key)) add(tokensOf(v), WORD_WEIGHTS.model, model);
    else add(tokensOf(v), WORD_WEIGHTS.other);
  }
  // THE HEAD NOUN: the last word of the posting's own words before anything
  // that starts a qualifier ("brake spring for Fanatec pedals" -> spring).
  // Where that word is generic and something more telling stands before it,
  // the telling one is the head ("Fanatec elastomer kit" -> elastomer).
  const phrase: string[] = [];
  // Read in order, without the joined spellings the overlap adds.
  for (const t of tokensOf(p.kind ?? '', { joins: false })) {
    if (HEAD_BREAK.has(t) && phrase.length) break;
    if (meaningful(t) && !notAHead(t)) phrase.push(t);
  }
  let head: string | undefined = phrase[phrase.length - 1];
  head = throughTheContainer(head, phrase);
  // A head that is only the brand says nothing about which thing: "Fanatec".
  if (head && brand.has(head) && phrase.length === 1) head = undefined;
  return { weights, all, brand, model, head };
}

export type Agreement = 'agree' | 'conflict' | 'unknown';

export interface WordAgreement {
  /** Weighted Dice over the distinctive words, 0..1. */
  score: number;
  /** Share of the SPARSER side's distinctive weight the other side holds, 0..1. */
  coverage: number;
  /** Both named a brand: do they share one? */
  brand: Agreement;
  /** Both named a model, part or fit: do they share a word of it? */
  model: Agreement;
  /** Do the two head nouns each appear in the other posting's words? */
  head: Agreement;
  /** Both sides said something distinctive at all. */
  distinctive: boolean;
  /**
   * They share a distinctive word besides their head nouns: "yoga mat" and
   * "mouse mat" share only the thing they both are, which says nothing.
   */
  sharedBeyondHead: boolean;
  /** Any distinctive word in common at all (generic nouns never count). */
  sharedDistinctive: boolean;
  /**
   * One side said outright that the thing is NOT this, and the other side's
   * words are the thing they named (migration 050, `not_these`). It costs the
   * pair its word agreement and it bars a sure one; it never bars the pair.
   */
  negated: boolean;
  /**
   * The details both postings stated under the SAME attribute key: 'conflict'
   * where any one of them differs (a 56cm frame against a 54cm one), 'agree'
   * where at least one is shared and none differs, 'unknown' where the two
   * never state the same detail. See attributeAgreement. A conflict bars a
   * sure one and nothing else.
   */
  attributes: Agreement;
}

/**
 * THE DETAILS BOTH SIDES STATED, COMPARED (27 September 2026).
 *
 * Until today an attribute VALUE was only ever a bag of words: "56cm" on one
 * side and "54cm" on the other were two distinctive words that failed to
 * overlap, which lowered the score a little and nothing more. Two postings
 * that both state a frame size, and state different ones, are not the same
 * thing, and the covered rule below (THE WANT IS COVERED) would otherwise
 * call them sure on everything else they share.
 *
 * DELIBERATELY NARROW, because calling a conflict that is not one costs a
 * real pair its sure. A conflict is called only where both sides use the SAME
 * key (compared case-folded, and never a brand, model or skipped key: brands
 * and models have their own checks, and condition, colour, year and the rest
 * describe the copy, not the thing), and then only:
 *
 *   - NUMBERS: both values are a plain number with at most a unit ("56cm",
 *     "56 cm", "56"), the units are the same or one side gave none, and the
 *     numbers differ. "56cm" against "22 inch" is a different unit and is
 *     never called; "54-56cm" or "56cm or larger" is not a plain number and
 *     is never called.
 *   - WORDS: neither value holds a digit, both say something meaningful, and
 *     they share no word, no stem and no five-letter start ("aluminium" and
 *     "aluminum" agree). "flat" against "clipless" is a conflict.
 *
 * A value that says the human does not mind ("any", "either", "not fussy")
 * is never compared at all.
 */
const NO_PREFERENCE = new Set(
  'any either whatever unsure unknown flexible open fussy na n/a none nope anything'.split(' '),
);
const UNIT_OF: Record<string, string> = {
  cm: 'cm', mm: 'mm', m: 'm', in: 'inch', inch: 'inch', inches: 'inch', '"': 'inch',
  gb: 'gb', tb: 'tb', kg: 'kg', g: 'g', l: 'l', ml: 'ml', v: 'v', w: 'w', ah: 'ah', lb: 'lb', lbs: 'lb',
};
const PLAIN_NUMBER = /^(\d+(?:\.\d+)?)\s*(cm|mm|m|inches|inch|in|"|gb|tb|kg|g|ml|l|v|w|ah|lbs|lb)?$/;

function valueAgreement(x: unknown, y: unknown): Agreement {
  if (!['string', 'number'].includes(typeof x) || !['string', 'number'].includes(typeof y)) return 'unknown';
  const [sx, sy] = [String(x).trim().toLowerCase(), String(y).trim().toLowerCase()];
  const [tx, ty] = [tokensOf(sx, { joins: false }), tokensOf(sy, { joins: false })];
  if (tx.some((t) => NO_PREFERENCE.has(t)) || ty.some((t) => NO_PREFERENCE.has(t))) return 'unknown';
  const [nx, ny] = [PLAIN_NUMBER.exec(sx), PLAIN_NUMBER.exec(sy)];
  if (nx && ny) {
    const [ux, uy] = [nx[2] ? UNIT_OF[nx[2]] : undefined, ny[2] ? UNIT_OF[ny[2]] : undefined];
    if (ux && uy && ux !== uy) return 'unknown';
    return Number(nx[1]) === Number(ny[1]) ? 'agree' : 'conflict';
  }
  if (/\d/.test(sx) || /\d/.test(sy)) return 'unknown';
  const [wx, wy] = [tx.filter(meaningful), ty.filter(meaningful)];
  if (!wx.length || !wy.length) return 'unknown';
  const close = (a: string, b: string) =>
    a === b || headStem(a) === headStem(b) || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
  return wx.some((a) => wy.some((b) => close(a, b))) ? 'agree' : 'conflict';
}

/** Attributes as a plain object keyed case-folded, or empty. */
function attrsOf(p: PostingWords): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (p.attributes && typeof p.attributes === 'object') {
    for (const [k, v] of Object.entries(p.attributes as Record<string, unknown>)) out.set(k.toLowerCase(), v);
  }
  return out;
}

/** The comparable keys: never a brand, a model or a skipped key. */
const comparableKey = (k: string) => !SKIP_KEYS.has(k) && !BRAND_KEYS.has(k) && !MODEL_KEYS.has(k);

/** The details both postings stated under the same key: see the block above. */
export function attributeAgreement(a: PostingWords, b: PostingWords): Agreement {
  const [A, B] = [attrsOf(a), attrsOf(b)];
  let out: Agreement = 'unknown';
  for (const [k, v] of A) {
    if (!comparableKey(k) || !B.has(k)) continue;
    const said = valueAgreement(v, B.get(k));
    if (said === 'conflict') return 'conflict';
    if (said === 'agree') out = 'agree';
  }
  return out;
}

/**
 * IS THE OTHER POSTING THE VERY THING THIS ONE SAID IT IS NOT?
 *
 * "Dominated by the phrase" is deliberately narrow, because the cost of getting
 * it wrong is a real pair losing its word agreement. One of two things has to
 * be true of a phrase the human wrote under `not_these`:
 *
 *   - the other posting's HEAD NOUN is the phrase's own head, on stems — they
 *     said "it is not an elastomer kit" and the other posting is about
 *     elastomers; or
 *   - every distinctive word of the phrase appears in the other posting's
 *     words, and the phrase said more than one thing — "whole pedal set"
 *     against a posting carrying pedal, set and whole.
 *
 * A single generic word ("kit") can never dominate anything on its own: the
 * phrase's distinctive words are what count, and the generic nouns are dropped
 * from that reading exactly as they are everywhere else in this file.
 */
function negatedBy(phrases: unknown, other: WordBag): boolean {
  for (const phrase of otherWordsOf(phrases)) {
    const tokens = tokensOf(phrase, { joins: false }).filter(meaningful);
    if (!tokens.length) continue;
    const distinctive = tokens.filter((t) => !GENERIC.has(t));
    const headable = tokens.filter((t) => !notAHead(t));
    const phraseHead = throughTheContainer(headable[headable.length - 1], headable);
    if (
      phraseHead &&
      other.head &&
      headStem(phraseHead) === headStem(other.head) &&
      // A head alone is enough only where the phrase says something distinctive
      // somewhere: "it is not a kit" names no thing at all.
      distinctive.length > 0
    ) {
      return true;
    }
    if (distinctive.length > 1 && distinctive.every((t) => other.all.has(t))) return true;
  }
  return false;
}

function setAgreement(a: Set<string>, b: Set<string>): Agreement {
  if (!a.size || !b.size) return 'unknown';
  for (const t of a) if (b.has(t)) return 'agree';
  return 'conflict';
}

/**
 * How far two postings' own words agree about what the thing is. Symmetric in
 * everything but name: wordAgreement(a, b) and wordAgreement(b, a) are equal.
 */
export function wordAgreement(a: PostingWords, b: PostingWords): WordAgreement {
  const A = bagOf(a);
  const B = bagOf(b);
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [, w] of A.weights) totalA += w;
  for (const [, w] of B.weights) totalB += w;
  let sharedBeyondHead = false;
  let sharedDistinctive = false;
  for (const [t, wa] of A.weights) {
    const wb = B.weights.get(t);
    if (wb === undefined) continue;
    sharedDistinctive = true;
    shared += Math.max(wa, wb);
    if (t !== A.head && t !== B.head) sharedBeyondHead = true;
  }
  const distinctive = totalA > 0 && totalB > 0;
  // THE NEGATIVE SIGNAL, read both ways: either human may have said what the
  // thing is not. It costs the pair the whole of its word agreement, which is
  // what bars a sure one (SURE_MIN_WORDS is above zero). Everything else about
  // the pair is untouched: the cosine still stands, a maybe is still reachable,
  // and nothing is filtered away.
  const negated = negatedBy(a.not_these, B) || negatedBy(b.not_these, A);
  const raw = distinctive ? Math.min(1, (2 * shared) / (totalA + totalB)) : 0;
  const score = negated ? 0 : raw;
  const coverage = negated || !distinctive ? 0 : Math.min(1, shared / Math.min(totalA, totalB));
  // THE HEADS agree when each appears in the other posting's words, compared
  // on their stems ("dog walker" and "dog walking" are one service). A
  // conflict is only called between two heads that share no stem.
  let head: Agreement = 'unknown';
  if (A.head && B.head) {
    const stems = (bag: WordBag) => new Set([...bag.all].map(headStem));
    const [ha, hb] = [headStem(A.head), headStem(B.head)];
    // A CONTAINER WORD IS TRANSPARENT. "Fanatec brake pedal spring upgrade
    // kit" against "Fanatec brake performance spring", both on the sim racing
    // shelf, was called a conflict of "kit" against "spring" and blocked a
    // pair that plainly is the same thing (dev, 20 September 2026). Where one
    // head is a kit, a set or a bundle and the other side's head is named
    // inside it, the two agree. Opening the rule wider than this — any head
    // found anywhere in the other's words — let two different things through
    // as SURE on the labelled set, which is the one error worth nothing.
    const contains = (container: string, inner: string, bag: WordBag) =>
      CONTAINERS.has(container) && bag.all.has(inner);
    head =
      ha === hb ||
      (stems(B).has(ha) && stems(A).has(hb)) ||
      contains(ha, hb, A) ||
      contains(hb, ha, B)
        ? 'agree'
        : 'conflict';
  }
  // THE BRANDS conflict only where neither side's brand appears anywhere in
  // the other side's words: Vorwerk makes the Thermomix, and a posting that
  // says "Thermomix" beside the brand Vorwerk is the same brand.
  let brand = setAgreement(A.brand, B.brand);
  if (brand === 'conflict') {
    const crosses =
      [...A.brand].some((t) => B.all.has(t)) || [...B.brand].some((t) => A.all.has(t));
    if (crosses) brand = 'agree';
  }
  return {
    score: round(score),
    coverage: round(coverage),
    brand,
    model: setAgreement(A.model, B.model),
    head,
    distinctive,
    sharedBeyondHead,
    sharedDistinctive,
    negated,
    attributes: attributeAgreement(a, b),
  };
}

/**
 * THE WANT IS COVERED (27 September 2026).
 *
 * Found on production: a want for "a used road bike", 56cm frame, flat pedals,
 * up to $400, did not meet a Giant Contend 2 road bike, 56cm, $300, on the
 * same shelf. The two projection embeddings sat at a cosine of about 0.45,
 * because a posting that says a great deal and a posting that says very
 * little embed far apart even when one is exactly the other, and the Dice
 * score (0.48) is pulled down the same way: every word the richer side adds
 * counts against it. So the most common case on a marketplace — someone
 * wants "a road bike", someone has a particular one — came back a near miss.
 *
 * The principle: a want is a description, and a have that fits every word of
 * that description is the thing wanted, however much more it says about
 * itself. The extra words are answers to questions the want never asked. So
 * this reads the pair in ONE DIRECTION, want into have, and it is sure when:
 *
 *   - the two shelves are the same, or one sits directly above the other
 *     (categoryCloseness >= COVERED_MIN_CLOSENESS; siblings are not enough,
 *     which is what keeps a road bike want off a mountain bike);
 *   - every word the want uses for the thing itself — its kind, its other
 *     words, its brand and its model — appears in the have's words;
 *   - no attribute the two both state disagrees (attributeAgreement);
 *   - a detail the want states under a key the have never uses ("pedals:
 *     flat" against a have that says nothing about pedals) is unknown, not a
 *     contradiction: it is a question for the conversation, and it neither
 *     counts for the pair nor against it. But only COVERED_MAX_UNSTATED such
 *     details: a want with two or more the have never answers describes
 *     something the have has not shown it is, and that is a maybe;
 *   - of everything else the want says, the have holds at least
 *     COVERED_MIN_SHARE of the distinctive weight (a detail under a key both
 *     use, stated partly differently, counts against it here);
 *   - the heads agree, and where the want says anything beyond its head the
 *     two share a word beyond it; a want that is ONLY its head ("ukulele")
 *     is covered only on the very same shelf;
 *   - A PART IS COVERED ONLY WHERE THE WANT SAYS WHAT IT FITS. Where either
 *     side is a part (a part, part number or fits key, or "for"/"fits" in its
 *     own words), the want must itself say which model or what it fits, and
 *     then those words must be in the have like every other. "Gaggia steam
 *     wand" against a steam wand for the Classic Pro is the question "does it
 *     fit mine?" not yet asked, and the labelled set calls it a maybe
 *     (p01, p02, p29 — found by the first calibration run of this rule);
 *   - and the cosine is not below COVERED_MIN_COSINE, a floor that says only
 *     that the two are not unrelated.
 *
 * The OTHER direction is not covered, and must not be: a have for "Vandoren
 * clarinet reeds" against a want for V12s may or may not be V12s, and the
 * labelled set calls that a maybe. That is why tierFor has to be told which
 * side is the want (PairFacts.wantIs); where it is not told — a swap, where
 * both sides want — this rule does not run.
 *
 * Everything that bars a sure anywhere still bars it here: a hard rule, a
 * head or brand conflict, a model the have does not share, a `not_these`,
 * a conflicting stated detail.
 */
export const COVERED_MIN_CLOSENESS = 0.85;
export const COVERED_MIN_SHARE = 0.75;
export const COVERED_MAX_UNSTATED = 1;
export const COVERED_MIN_COSINE = 0.35;

/** Keys that say a posting is a part of something else. */
const PART_KEYS = new Set(['part', 'part_number', 'part_no', 'fits', 'compatible_with', 'suits', 'for']);
/** Keys that say which model, or what a part fits. */
const FIT_KEYS = new Set(['fits', 'compatible_with', 'suits', 'for', 'model', 'model_number', 'series', 'variant', 'version']);
const FIT_WORDS = new Set(['for', 'fits', 'fit', 'suits', 'suit']);
const kindSaysFor = (p: PostingWords) => tokensOf(p.kind ?? '', { joins: false }).some((t) => FIT_WORDS.has(t));
const isAPart = (p: PostingWords) => [...attrsOf(p).keys()].some((k) => PART_KEYS.has(k)) || kindSaysFor(p);
const saysWhatItFits = (p: PostingWords) =>
  [...attrsOf(p).entries()].some(([k, v]) => FIT_KEYS.has(k) && tokensOf(v).some(meaningful)) || kindSaysFor(p);

/**
 * THE PARTS GUARD, on its own, for the borderline judge (jevJudge.ts): the
 * same test wantCoveredBy applies. Where either side is a part (a part, part
 * number or fits key, or "for"/"fits" in its own words), the want must itself
 * say which model or what it fits before a pair can be SURE. False means cap
 * the pair at POSSIBLE.
 */
export function partsGuardAllowsSure(want: PostingWords, have: PostingWords): boolean {
  return !((isAPart(want) || isAPart(have)) && !saysWhatItFits(want));
}

export interface Covered {
  covered: boolean;
  /** The first reason it is not, for a log line or a calibration table. */
  why: string;
}

export function wantCoveredBy(want: PostingWords, have: PostingWords, closeness: number): Covered {
  const W = bagOf(want);
  const H = bagOf(have);
  const no = (why: string): Covered => ({ covered: false, why });
  if (closeness < COVERED_MIN_CLOSENESS) return no('shelves not close enough');
  if (!W.head || !H.head) return no('no head noun');
  if ((isAPart(want) || isAPart(have)) && !saysWhatItFits(want)) return no('a part, and the want never says what it fits');
  const haveStems = new Set([...H.all].map(headStem));
  const inHave = (t: string) => H.all.has(t) || haveStems.has(headStem(t));
  // The want's own words for the thing: kind, other words, brand and model.
  const own = [
    ...tokensOf(want.kind ?? ''),
    ...otherWordsOf(want.also_called).flatMap((p) => tokensOf(p)),
    ...W.brand,
    ...W.model,
  ].filter((t) => meaningful(t) && !GENERIC.has(t));
  const missing = [...new Set(own)].filter((t) => !inHave(t));
  if (missing.length) return no(`the have never says: ${missing.join(', ')}`);
  // The details the want states under a key the have never uses: unknown,
  // so their words are set aside, and there may be only a few of them.
  const haveAttrs = attrsOf(have);
  const unstated = [...attrsOf(want).entries()].filter(
    ([k, v]) => comparableKey(k) && !haveAttrs.has(k) && tokensOf(v).some((t) => meaningful(t) && !GENERIC.has(t)),
  );
  if (unstated.length > COVERED_MAX_UNSTATED) return no('too many details the have never answers');
  const ownSet = new Set(own);
  const setAside = new Set(
    unstated.flatMap(([, v]) => tokensOf(v)).filter((t) => !ownSet.has(t) && !inHave(t)),
  );
  // How much of the rest of the want's distinctive weight the have holds.
  let total = 0;
  let held = 0;
  for (const [t, w] of W.weights) {
    if (setAside.has(t)) continue;
    total += w;
    if (inHave(t)) held += w;
  }
  if (!total || held / total < COVERED_MIN_SHARE) return no('too little of the want is answered');
  const beyondHead = [...W.weights.keys()].filter((t) => headStem(t) !== headStem(W.head!));
  if (beyondHead.length) {
    if (!beyondHead.some(inHave)) return no('nothing shared beyond the head');
  } else if (closeness < 1) {
    return no('a want that is only its head, on another shelf');
  }
  return { covered: true, why: 'covered' };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// The tier.
// ---------------------------------------------------------------------------

/** Everything the tier is decided on, for one pair, with the bands already decrypted. */
export interface PairFacts {
  /** Raw cosine between the two projection embeddings. */
  semantic: number;
  categoryA: string;
  categoryB: string;
  geoA: GeoBucket;
  geoB: GeoBucket;
  /** The two postings' own words and attributes. */
  a: PostingWords;
  b: PostingWords;
  wantBand?: PriceBand;
  haveBand?: PriceBand;
  /** Each owner's reputation bump (matchRules.ts, PERSONAL THRESHOLD NUDGE). */
  bumpWant?: number;
  bumpHave?: number;
  /**
   * Which of a and b is the WANT, for the one rule that reads a pair in one
   * direction (THE WANT IS COVERED). Left out — a swap, where both sides
   * want — that rule does not run and every other rule is unchanged.
   */
  wantIs?: 'a' | 'b';
  /**
   * THE HOOK FOR A PAIR JUDGE, NOT CALLED YET. Part against whole (a chainsaw
   * chain against the chainsaw, a bezel insert against the watch) defeats both
   * the cosine and the word overlap, and only something that reads the two
   * postings can tell. When one exists it answers here: true means one is a
   * part or accessory of the other. tierFor is pure and synchronous, so the
   * matcher would await this beside tierFor (matcher.ts, where the tier is
   * decided) and demote a SURE or POSSIBLE it answers true for. Unused today.
   */
  isPartOrAccessoryOf?: (a: PostingWords, b: PostingWords) => Promise<boolean | undefined>;
}

export interface TierParts {
  semantic: number;
  words: WordAgreement;
  shelvesCompatible: boolean;
  categoryCloseness: number;
  /** The blend, with the shelf as a contributor. 0 where a hard rule failed. */
  blend: number;
  hardRulesPass: boolean;
  failed?: PairEval['failed'];
  /** Which rule decided the tier, for a log line or a calibration table. */
  why: string;
  /** The same, as a fixed word a caller can branch on (jevJudge.ts reads it). */
  rule: TierRule;
  weights?: PairEval['weights'];
  thinness?: number;
}

export type TierRule =
  | 'hard-rule'
  | 'sure-close'
  | 'sure-covered'
  | 'possible-meaning'
  | 'possible-words'
  | 'near-miss'
  | 'nothing';

export interface TierResult {
  tier: Tier;
  /** The blend, which is what an introduction stores as its fit. */
  score: number;
  parts: TierParts;
}

/**
 * Which tier a pair is in. Pure: the same facts give the same answer, always.
 *
 * In order, with the lines fitted on test/calibration:
 *   - a hard rule failed (geo, price): nothing.
 *   - SURE: cosine >= SURE_MIN_COSINE, word agreement >= SURE_MIN_WORDS, and
 *     neither a head-noun conflict nor a brand conflict nor a stated detail
 *     that differs. Never on the blend alone, and whatever the shelves.
 *   - SURE, too, where the want is covered by the have (THE WANT IS COVERED,
 *     27 September 2026): same or parent shelf, every word the want uses for
 *     the thing in the have, heads agree, nothing contradicts. On any cosine
 *     over COVERED_MIN_COSINE, because a thin want and a rich have embed far
 *     apart even when the have is exactly what was asked for.
 *   - POSSIBLE: cosine >= POSSIBLE_MIN_COSINE, or any distinctive word in
 *     common with cosine >= POSSIBLE_WORDS_MIN_COSINE.
 *   - near miss: a compatible shelf and the old floor on the blend.
 *   - nothing.
 *
 * Each owner's reputation bump (matchRules.ts, PERSONAL THRESHOLD NUDGE) is
 * added to every cosine line, which is where the old threshold's bump went.
 *
 * The blend is still computed: it is the fit an introduction stores, what the
 * near miss is judged on, and where the geo and price hard rules live.
 */
/**
 * WHICH SPECIFICS AGREE AND WHICH DO NOT, in a sentence, for a maybe.
 *
 * A human deciding whether a maybe is their thing wants to know WHERE the two
 * descriptions meet and where they part. The signals already say it, and until
 * now they stayed inside the engine.
 *
 * THE HARD BOUNDARY (the founder, 20 September 2026). It names only WHICH KINDS
 * OF DETAIL agree or differ. No number of any sort crosses it: no figure, no
 * percentage, no bound, no tier, and nothing at all about any other posting or
 * any other person. Where a signal cannot be said without a figure, it is left
 * out. It is pure and it reads nothing but the agreement it is handed.
 */
export function agreementSentence(w: WordAgreement): string {
  const LABELS: [keyof WordAgreement, string][] = [
    ['brand', 'the make'],
    ['model', 'the model or part number'],
    ['head', 'what the thing is called'],
  ];
  const agree: string[] = [];
  const differ: string[] = [];
  for (const [key, label] of LABELS) {
    if (w[key] === 'agree') agree.push(label);
    else if (w[key] === 'conflict') differ.push(label);
  }
  // A stated detail that differs (attributeAgreement) is named where it
  // differs and nowhere else: agreeing details are what the other two already
  // say, and naming them would change every sentence written before it.
  if (w.attributes === 'conflict') differ.push('a detail you both gave');
  const list = (xs: string[]) =>
    xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0];
  let sentence: string;
  if (agree.length && differ.length) {
    sentence = `What the two of you wrote agrees on ${list(agree)}, and differs on ${list(differ)}.`;
  } else if (agree.length) {
    sentence = `What the two of you wrote agrees on ${list(agree)}.`;
  } else if (differ.length) {
    sentence = `What the two of you wrote differs on ${list(differ)}.`;
  } else {
    sentence =
      'Neither posting says enough about the make or the model to hold the two side by side.';
  }
  // The one thing worth saying beyond the three: their human wrote down that it
  // is not this sort of thing, and here it is anyway, as a maybe, for them.
  if (w.negated) {
    sentence += ' One of you wrote down that the thing is not this sort of thing.';
  }
  return sentence;
}

export function tierFor(f: PairFacts): TierResult {
  const words = wordAgreement(f.a, f.b);
  const shelvesCompatible = categoryCompatible(f.categoryA, f.categoryB);
  const ev = evaluatePair({
    semantic: f.semantic,
    categoryA: f.categoryA,
    categoryB: f.categoryB,
    geoA: f.geoA,
    geoB: f.geoB,
    attributesA: f.a.attributes,
    attributesB: f.b.attributes,
    wantBand: f.wantBand,
    haveBand: f.haveBand,
    shelfGate: false,
  });
  const semantic = Math.max(0, Math.min(1, Number(f.semantic) || 0));
  const parts: Omit<TierParts, 'why' | 'rule'> = {
    semantic,
    words,
    shelvesCompatible,
    categoryCloseness: categoryCloseness(f.categoryA, f.categoryB),
    blend: ev.score,
    hardRulesPass: ev.hardRulesPass,
    ...(ev.failed ? { failed: ev.failed } : {}),
    ...(ev.weights ? { weights: ev.weights } : {}),
    ...(ev.thinness !== undefined ? { thinness: ev.thinness } : {}),
  };
  const out = (tier: Tier, why: string, rule: TierRule): TierResult => ({
    tier,
    score: ev.score,
    parts: { ...parts, why, rule },
  });
  if (!ev.hardRulesPass) return out('nothing', `hard rule: ${ev.failed}`, 'hard-rule');

  const bump = Math.max(Number(f.bumpWant ?? 0), Number(f.bumpHave ?? 0));
  const conflict =
    words.head === 'conflict' || words.brand === 'conflict' || words.negated || words.attributes === 'conflict';
  if (!conflict && semantic >= SURE_MIN_COSINE + bump && words.score >= SURE_MIN_WORDS) {
    return out('sure', 'close in meaning, the words agree, nothing contradicts', 'sure-close');
  }
  // THE WANT IS COVERED: see the block over wantCoveredBy. One direction only,
  // and only where the caller said which side is the want.
  if (
    f.wantIs &&
    !conflict &&
    words.head === 'agree' &&
    words.model !== 'conflict' &&
    semantic >= COVERED_MIN_COSINE + bump &&
    (f.wantIs === 'a'
      ? wantCoveredBy(f.a, f.b, parts.categoryCloseness)
      : wantCoveredBy(f.b, f.a, parts.categoryCloseness)
    ).covered
  ) {
    return out('sure', 'everything the want asks for, the have says, and nothing contradicts', 'sure-covered');
  }
  if (semantic >= POSSIBLE_MIN_COSINE + bump) {
    return out(
      'possible',
      conflict ? 'very close in meaning, the words disagree' : 'very close in meaning',
      'possible-meaning',
    );
  }
  if (words.sharedDistinctive && semantic >= POSSIBLE_WORDS_MIN_COSINE + bump) {
    return out('possible', 'a distinctive word in common, close enough in meaning', 'possible-words');
  }
  const nearMiss =
    shelvesCompatible && ev.score >= NEAR_MISS_MIN_BLEND
      ? out('near-miss', 'compatible shelf, over the near-miss floor', 'near-miss')
      : undefined;
  return nearMiss ?? out('nothing', 'below every line', 'nothing');
}
