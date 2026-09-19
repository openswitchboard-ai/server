/**
 * WORD AGREEMENT: how much the two postings' own words for the thing agree,
 * weighted so the words that pin down WHICH thing count most.
 *
 * Input is `kind` plus every string/number attribute value (attribute KEYS are
 * ignored: "brand" and "model" are the same on every card and say nothing).
 * `condition`, `quantity` and a few other keys that describe the copy rather
 * than the thing are skipped entirely: "used" on both sides is not agreement.
 *
 * Each token gets a weight:
 *
 *   3    IDENTIFIER: any token from a brand/model/make/series/set/part-number
 *        style attribute, or any token that mixes letters and digits
 *        ("m8100", "tb303", "80017a", "v3", "skx007", "c65"). These are what
 *        make two postings the SAME thing rather than the same kind of thing.
 *   1    DISTINCTIVE WORD: an ordinary content word ("clarinet", "bezel",
 *        "derailleur", "sourdough", "harness").
 *   0.25 GENERIC NOUN or bare number/size: "spring", "part", "kit", "set",
 *        "case", "stand", "board", "pedal", "used", "black", "12", "0.4mm".
 *        These appear on both sides of many different-thing pairs (a fly reel
 *        and a film reel; a sim pedal spring and a trampoline spring), so they
 *        must not carry a pair on their own - but they are not worth zero,
 *        because "brake spring" vs "brake pad" is real information.
 *   0    stopwords ("for", "with", "and", "the", "of").
 *
 * A token that is an identifier on either side counts as an identifier.
 *
 * Normalisation: lowercase; hyphens and slashes inside alphanumeric runs are
 * removed ("sl-1200" -> "sl1200", "c6-5" -> "c65"); adjacent letter+number
 * tokens are also joined ("sl 1200" also yields "sl1200", "ms 250" ->
 * "ms250"), so spacing/hyphen variants of a model agree; a trailing plural
 * "s" is stripped from words over three letters.
 *
 * Score: weighted Dice, 2 * shared / (weight(A) + weight(B)), in [0, 1].
 * Dice (not containment) on purpose: a vague side ("fanatec spring") that is
 * fully contained in a specific side scores only moderately, which is what
 * POSSIBLE means - the words agree but one side has not said enough to be
 * sure. Joined bigram tokens are counted alongside their parts, so an exact
 * "sl 1200" = "sl 1200" match is rewarded twice; that is intended (the model
 * matched in full).
 */

const STOP = new Set(
  'a an and or the of for with to in on at by from my our your is it its this that as plus x per'.split(' '),
);

const GENERIC = new Set(
  (
    'spring springs part parts kit kits set sets used new good excellent fair worn condition ' +
    'original genuine replacement spare spares assorted mixed lot bundle pack box piece pieces pair ' +
    'case cover stand board pedal pedals motor pump dial knob reel starter grain grains reed reeds ' +
    'small medium large size black white blue red silver chrome colour color ' +
    'inch mm cm kg litre liter l gb tb w v ah wt ' +
    'vintage old older model models type style item thing stuff accessory accessories ' +
    'portable cordless electric manual full half only included not yes no working tested'
  ).split(' '),
);

/** Attribute keys whose values NAME the thing (identifier weight). */
const ID_KEYS = new Set([
  'brand', 'brands', 'make', 'model', 'models', 'series', 'line', 'set', 'set_number', 'part_number',
  'game', 'expansion', 'edition', 'card', 'faction', 'fits', 'engine', 'platform',
]);

/** Attribute keys that describe the copy or the deal, not the thing. */
const SKIP_KEYS = new Set(['condition', 'quantity', 'completeness', 'grade', 'notes', 'price', 'availability', 'when']);

export const TOKEN_WEIGHT = { identifier: 3, distinctive: 1, generic: 0.25, stop: 0 } as const;

function hasLetter(s: string): boolean {
  return /[a-z]/.test(s);
}
function hasDigit(s: string): boolean {
  return /[0-9]/.test(s);
}

function stem(t: string): string {
  if (hasDigit(t) || t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es') && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Split a phrase into normalised tokens, with letter+digit joins added. */
export function tokenize(text: string): string[] {
  const lowered = text
    .toLowerCase()
    .replace(/([a-z0-9])[-/.]([a-z0-9])/g, '$1$2') // sl-1200 -> sl1200, 4/102 -> 4102, 0.4 -> 04
    .replace(/([a-z0-9])[-/.]([a-z0-9])/g, '$1$2'); // second pass for runs like rd-m8100-sgs
  const raw = lowered.split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const out = [...raw];
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i];
    const b = raw[i + 1];
    const mixed = (hasLetter(a) && !hasDigit(a) && hasDigit(b)) || (hasDigit(a) && !hasLetter(a) && hasLetter(b) && b.length <= 3);
    if (mixed && !STOP.has(a) && a.length <= 6) out.push(a + b);
  }
  return out;
}

function classify(tok: string, fromIdKey: boolean): number {
  if (STOP.has(tok)) return TOKEN_WEIGHT.stop;
  if (hasLetter(tok) && hasDigit(tok)) {
    // A size/unit glued to a number ("128gb", "04mm", "16inch", "450lb") is still just a size.
    if (/^\d+(gb|tb|mb|mm|cm|m|l|kg|g|w|v|ah|lb|inch|in|wt|l)$/.test(tok)) return TOKEN_WEIGHT.generic;
    return TOKEN_WEIGHT.identifier;
  }
  if (!hasLetter(tok)) return fromIdKey ? TOKEN_WEIGHT.identifier : TOKEN_WEIGHT.generic; // bare number
  if (GENERIC.has(tok)) return TOKEN_WEIGHT.generic;
  if (fromIdKey) return TOKEN_WEIGHT.identifier;
  return TOKEN_WEIGHT.distinctive;
}

export interface Posting {
  category: string;
  kind?: string | null;
  attributes?: Record<string, unknown>;
}

/** token -> weight, taking the highest weight a token earns anywhere on the posting. */
export function weightedTokens(p: Posting): Map<string, number> {
  const m = new Map<string, number>();
  const add = (text: string, idKey: boolean) => {
    for (const t of tokenize(text)) {
      const w = classify(t, idKey);
      if (w <= 0) continue;
      m.set(t, Math.max(m.get(t) ?? 0, w));
    }
  };
  if (p.kind) add(p.kind, false);
  for (const [k, v] of Object.entries(p.attributes ?? {})) {
    if (SKIP_KEYS.has(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    add(String(v), ID_KEYS.has(k));
  }
  return m;
}

export interface WordAgreementDetail {
  score: number;
  shared: string[];
  sharedIdentifiers: string[];
}

export function wordAgreementDetail(a: Posting, b: Posting): WordAgreementDetail {
  const ta = weightedTokens(a);
  const tb = weightedTokens(b);
  // A token that is an identifier on either side is an identifier on both:
  // "fanatec" in one kind and in the other's brand is the same brand.
  const w = (t: string) => Math.max(ta.get(t) ?? 0, tb.get(t) ?? 0);
  let wa = 0;
  let wb = 0;
  for (const t of ta.keys()) wa += w(t);
  for (const t of tb.keys()) wb += w(t);
  let shared = 0;
  const sharedToks: string[] = [];
  for (const t of ta.keys()) {
    if (tb.has(t)) {
      shared += w(t);
      sharedToks.push(t);
    }
  }
  const score = wa + wb === 0 ? 0 : (2 * shared) / (wa + wb);
  return {
    score,
    shared: sharedToks,
    sharedIdentifiers: sharedToks.filter((t) => w(t) === TOKEN_WEIGHT.identifier),
  };
}

export function wordAgreement(a: Posting, b: Posting): number {
  return wordAgreementDetail(a, b).score;
}
