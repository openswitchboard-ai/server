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
 * THE LINES ARE PROVISIONAL. The numbers below were fitted on the labelled
 * calibration set in test/calibration (pairs.json, 144 pairs written by one
 * agent in one session; run with `npm run calibrate-tiers`, and read
 * test/calibration/README.md for what the set does not cover). They live here
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
  // A CONTAINER word says what the thing comes in, and the word before it says
  // what the thing is: "pedal spring kit" is springs, "elastomer kit" is
  // elastomers.
  if (head && CONTAINERS.has(head) && phrase.length > 1) head = phrase[phrase.length - 2];
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
  const score = distinctive ? Math.min(1, (2 * shared) / (totalA + totalB)) : 0;
  const coverage = distinctive ? Math.min(1, shared / Math.min(totalA, totalB)) : 0;
  // THE HEADS agree when each appears in the other posting's words, compared
  // on their stems ("dog walker" and "dog walking" are one service). A
  // conflict is only called between two heads that share no stem.
  let head: Agreement = 'unknown';
  if (A.head && B.head) {
    const stems = (bag: WordBag) => new Set([...bag.all].map(headStem));
    const [ha, hb] = [headStem(A.head), headStem(B.head)];
    head = ha === hb || (stems(B).has(ha) && stems(A).has(hb)) ? 'agree' : 'conflict';
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
  };
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
  weights?: PairEval['weights'];
  thinness?: number;
}

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
 *     neither a head-noun conflict nor a brand conflict. Never on the blend
 *     alone, and whatever the shelves.
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
  const parts: Omit<TierParts, 'why'> = {
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
  const out = (tier: Tier, why: string): TierResult => ({
    tier,
    score: ev.score,
    parts: { ...parts, why },
  });
  if (!ev.hardRulesPass) return out('nothing', `hard rule: ${ev.failed}`);

  const bump = Math.max(Number(f.bumpWant ?? 0), Number(f.bumpHave ?? 0));
  const conflict = words.head === 'conflict' || words.brand === 'conflict';
  if (!conflict && semantic >= SURE_MIN_COSINE + bump && words.score >= SURE_MIN_WORDS) {
    return out('sure', 'close in meaning, the words agree, nothing contradicts');
  }
  if (semantic >= POSSIBLE_MIN_COSINE + bump) {
    return out('possible', conflict ? 'very close in meaning, the words disagree' : 'very close in meaning');
  }
  if (words.sharedDistinctive && semantic >= POSSIBLE_WORDS_MIN_COSINE + bump) {
    return out('possible', 'a distinctive word in common, close enough in meaning');
  }
  const nearMiss =
    shelvesCompatible && ev.score >= NEAR_MISS_MIN_BLEND
      ? out('near-miss', 'compatible shelf, over the near-miss floor')
      : undefined;
  return nearMiss ?? out('nothing', 'below every line');
}
