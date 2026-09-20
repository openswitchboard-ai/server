/**
 * Does this sentence carry a money figure? One question, one answer.
 *
 * RUN 8 (13 September 2026) is why this exists. A human told their assistant
 * "write to them and confirm $420". The assistant sent the words "Happy to
 * confirm $420 for it" across the open conversation and made no offer at all,
 * so there was a price in front of a stranger that nobody could accept and
 * nothing had checked. Nothing stopped it, because nothing had ever looked at
 * the words for a number.
 *
 * The rule the owner drew that day: A FIGURE NEVER TRAVELS IN THE WORDS. It
 * travels as an offer, which is the one road that runs through what the human
 * themselves wrote down — their opening figure, their limit, their walk-away —
 * so a number only leaves after their own rules have been read. In that first
 * instance $420 was the published asking price and nothing private got out;
 * the same move with a new number is an unchecked figure in front of somebody
 * the human has never met.
 *
 * "Figure" means digits AND words, because both say the same thing to a
 * person: $420, 420 AUD, four hundred and twenty dollars, four twenty, and
 * "how about 400" are one sentence written five ways.
 *
 * WHAT THIS DELIBERATELY LEAVES ALONE, because a refused message that had no
 * price in it is the whole cost of this check: times (4:20, see you at 4.20,
 * half four), dates and years (2019 model, the 14th), sizes and specs (29 inch
 * wheels, 21 speed, 15kg, size 10), addresses (42 Smith Street, unit 7),
 * distances (about 8km away) and plain counts (two kids, three bedrooms, I
 * have two of them). Each of those is a real sentence somebody arranging a
 * handover needs to send.
 *
 * Where a case is genuinely both — "two thirty" is half past two and it is
 * also two hundred and fifty — this refuses and lets the assistant say it
 * another way. A refused sentence costs one rewrite; an unchecked figure costs
 * the thing the switchboard is for.
 */

// ---------------------------------------------------------------------------
// The words numbers are spelled with.
// ---------------------------------------------------------------------------

/** one … nineteen: the words that can open a spoken price ("four twenty"). */
const UNIT =
  '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
/** twenty … ninety: the words that can close one ("two fifty"). */
const TENS = '(?:twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)';
/** Anything that can stand where a number stands, spelled out. */
const NUM_WORD = `(?:${UNIT}|${TENS}|hundred|thousand|million)`;
/** A number, however it is written. */
const NUMBER = `(?:\\d+(?:[.,]\\d+)*|${NUM_WORD})`;

/** The words that mean money on their own. */
const MONEY_WORD = '(?:dollars?|bucks?|quid|cents?|euros?|pounds?|pence|grand)';
/** Three-letter money codes an agent might reach for. */
const CCY = '(?:aud|usd|nzd|cad|sgd|gbp|eur|jpy|inr|chf|hkd|zar)';
/** A money sign, with room for the letters that qualify one: A$, AU$, US$. */
const SYMBOL = '(?:[a-z]{0,2}\\$|[€£¥₹])';

/**
 * Openings that mean a price is coming, whatever number follows them. These
 * are what turn a bare 400 into a figure: on its own 400 is a year or a part
 * number, and after "how about" it is money.
 */
const PRICE_LEAD_IN =
  '(?:how about|what about|how\'?s|how does .{0,20} sound|i could do|could do|i can do|can do|can you do|could you do|would you take|will you take|would you do|i\'?ll take|i will take|i\'?d take|i would take|happy to take|i\'?ll do|ill do|i will do|i\'?d do|id do|(?:i\'?ll |i will |i can |i could |happy to |we can |we could )?accept|let\'?s say|lets say|say|(?:best|lowest|highest|max|maximum|minimum|budget|limit|ceiling|top) (?:i can do )?is|call it|drop to|drop it to|come down to|go down to|knock it down to|knock off|could go to|can go to|go up to|come up to|stretch to|push to|meet you at|meet you in the middle at|meet in the middle at|split the difference at|settle at|settle on|land on|asking|i am asking|i\'m asking|offer(?:ing)? you|i\'ll offer|i will offer|offer|i\'ll pay|i will pay|i\'d pay|i would pay|pay you|the price is|price is|priced at|it\'s worth|worth|sell it for|let it go for|take it for|do it for)';

/** Words that close a price rather than open one: "400 firm", "400 cash". */
const PRICE_TAIL = '(?:firm|cash|ono|o\\.n\\.o\\.?|obo|or best offer|negotiable|neg)';

/**
 * Things a round spoken number is plainly NOT money for. "A hundred times
 * better" and "a couple of thousand words" are ordinary speech, and refusing
 * them would be the sloppiness this check cannot afford.
 */
const NOT_MONEY_AFTER =
  '(?:times|percent|%|years?|months?|weeks?|days?|hours?|minutes?|k?m|kms?|kilometres?|kilometers?|miles?|metres?|meters?|feet|foot|inch(?:es)?|kgs?|kilos?|grams?|pounds? of|litres?|liters?|people|words?|pages?|photos?|steps?|calories)';

/** Words that put a bare pair of numbers on a clock rather than on a price. */
const TIME_LEAD_IN = '(?:at|around|about|by|before|after|until|till|til|past|half|from)';

// ---------------------------------------------------------------------------
// The rules. Each one is named, so a failing test says which rule fired and a
// reader can judge it on its own.
// ---------------------------------------------------------------------------

interface Rule {
  name: string;
  test: (s: string) => boolean;
  /**
   * Is this rule one that fires because MONEY IS NAMED, rather than because a
   * number is the right shape or sits in the right place?
   *
   * A money sign, a currency code, a money word and the phrasing people wrap
   * a price in are all somebody saying "money" out loud; a thousands comma, a
   * pair of decimal places, a spoken round number and a number that opens a
   * sentence are all a GUESS from shape, and a good one on a sentence somebody
   * typed into a conversation.
   *
   * The distinction exists for attribute values (attributeFigureRule below),
   * where the shape rules are wrong far too often to use: `wheel_size_in`,
   * `ram_gb`, `shutter_count`, `year`, a model number like 1.10 and a frame
   * size are all bare numbers in fields built to hold bare numbers. Nothing
   * about the open conversation changes — every rule still runs there.
   */
  named: boolean;
}

const re = (src: string): RegExp => new RegExp(src, 'i');

/** `$420`, `$ 420`, `A$420`, `AU$ 420`, `€50`, `£50`, `$420ish`. */
const symbolThenNumber = re(`${SYMBOL}\\s*\\d`);
/** `420$`, `50 €`. */
const numberThenSymbol = re('\\d\\s*(?:\\$|[€£¥₹])');
/** `AUD 420`, `USD420`, `420 AUD`, `420AUD`. */
const codeBesideNumber = re(`(?:\\b${CCY}\\s*\\d|\\d\\s*${CCY}\\b)`);
/** `1,250` — a thousands comma is never a date or a size. */
const groupedThousands = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/;
/** `420.00` — three or more digits then exactly two places. */
const bigDecimal = /\b\d{3,}\.\d{2}\b/;
/**
 * `29.99` — two places on a small number is a price, UNLESS somebody has
 * written a clock: "see you at 4.20" is twenty past four.
 */
const smallDecimal = /(?:^|[^\d.])(\d{1,2})\.(\d{2})\b/;
const smallDecimalIsTime = (s: string): boolean => {
  for (const m of s.matchAll(/(?:^|[^\d.])(\d{1,2})\.(\d{2})\b/g)) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const before = s.slice(0, m.index ?? 0);
    const clockish = new RegExp(`\\b${TIME_LEAD_IN}\\s*$`, 'i').test(before);
    if (!(clockish && hour <= 24 && minute <= 59)) return false;
  }
  return true;
};
/** `420 dollars`, `twenty bucks`, `50 cents`, `a dollar`, `four hundred and twenty dollars`. */
const numberThenMoneyWord = re(
  `(?:\\d+|\\b(?:${NUM_WORD}|a|an|few|couple)\\b)[\\s-]*(?:and[\\s-]+)?${MONEY_WORD}\\b`,
);
/** `420 each`, `50c each` — a per-item number is a per-item price. */
const numberThenEach = re(`(?:\\d+|\\b${NUM_WORD}\\b)\\s+(?:each|apiece)\\b`);
/** `four hundred`, `fifteen hundred`, `a hundred and fifty`, `two grand`. */
const spelledMagnitude = re(
  // `\\d+` is in the alternation because "4 hundred" is the same sentence as
  // "four hundred" and the audit found it walking through.
  `\\b(?:\\d+|${NUM_WORD}|a|an|couple(?: of)?|few)[\\s-]+(?:hundred|thousand|grand)\\b(?!\\s+${NOT_MONEY_AFTER}\\b)`,
);
/** `four twenty`, `two fifty`, `four-twenty` — a spoken price, unless it is a clock. */
const spelledPairSrc = `\\b(${UNIT})[\\s-]+(${TENS})\\b`;
const spelledPair = (s: string): boolean => {
  for (const m of s.matchAll(new RegExp(spelledPairSrc, 'gi'))) {
    const before = s.slice(0, m.index ?? 0);
    // "see you at four twenty" is a clock. "I could do four twenty" is a price,
    // and the price openings are read first so that one still refuses.
    if (/\b(?:at|past|half)\s+$/i.test(before)) continue;
    // "two thirty minute slots" is a length of time counted twice over, and
    // no price at all.
    const after = s.slice((m.index ?? 0) + m[0].length);
    if (new RegExp(`^\\s+${NOT_MONEY_AFTER}\\b`, 'i').test(after)) continue;
    return true;
  }
  return false;
};
/**
 * `how about 400`, `call it four hundred`, `would you take 400`. The number
 * has to be a bare one: "we could do a 30 minute lesson" is an arrangement,
 * and the unit after the number is what says so.
 */
const priceLeadIn = re(
  `\\b${PRICE_LEAD_IN}\\b[^.!?]{0,20}?\\b${NUMBER}\\b(?!\\s*${NOT_MONEY_AFTER}\\b)`,
);
/** `400 firm`, `400 cash`, `400 ono`. */
const priceTail = re(`\\b${NUMBER}\\s*${PRICE_TAIL}\\b`);
/**
 * A message that OPENS with a bare round number — "450 and I'll collect
 * Saturday" — is somebody answering about money and nothing else. A year
 * ("2019 model") and a number with its unit attached ("500 metres down the
 * road") are left alone, which is the whole of the exception.
 */
const opensWithBareNumber = (s: string): boolean => {
  const m = /^\s*(\d{3,6})\b(?!\s*(?:st|nd|rd|th)\b)/.exec(s);
  if (!m) return false;
  const n = Number(m[1]);
  if (m[1].length === 4 && n >= 1900 && n <= 2099) return false; // a year
  const after = s.slice(m.index + m[0].length);
  if (new RegExp(`^\\s*${NOT_MONEY_AFTER}\\b`, 'i').test(after)) return false;
  return true;
};
/** `4 2 0` — a number spelled one digit at a time is still that number. */
const spacedDigits = /\b\d(?:\s\d){2,}\b/;
/** `~420`, `420ish`, `420-ish` — three digits or more, so "4ish" stays a time. */
const hedgedNumber = /(?:~\s*\d{3,}|\b\d{3,}\s*-?\s*ish\b)/i;

const RULES: Rule[] = [
  { name: 'money sign before a number', test: (s) => symbolThenNumber.test(s), named: true },
  { name: 'money sign after a number', test: (s) => numberThenSymbol.test(s), named: true },
  { name: 'money code beside a number', test: (s) => codeBesideNumber.test(s), named: true },
  { name: 'thousands comma', test: (s) => groupedThousands.test(s), named: false },
  { name: 'two decimal places', test: (s) => bigDecimal.test(s), named: false },
  {
    name: 'two decimal places on a small number',
    test: (s) => smallDecimal.test(s) && !smallDecimalIsTime(s),
    named: false,
  },
  { name: 'a number and a money word', test: (s) => numberThenMoneyWord.test(s), named: true },
  { name: 'a number for each one', test: (s) => numberThenEach.test(s), named: false },
  { name: 'a spoken round number', test: (s) => spelledMagnitude.test(s), named: false },
  { name: 'a spoken pair of numbers', test: (s) => spelledPair(s), named: false },
  { name: 'a price opening', test: (s) => priceLeadIn.test(s), named: true },
  { name: 'a price ending', test: (s) => priceTail.test(s), named: true },
  { name: 'a bare number for an opening', test: (s) => opensWithBareNumber(s), named: false },
  { name: 'a number spread across spaces', test: (s) => spacedDigits.test(s), named: false },
  { name: 'a hedged number', test: (s) => hedgedNumber.test(s), named: false },
];

// ---------------------------------------------------------------------------
// WHAT THE RULES ARE READ AGAINST (2026-09-17 audit).
//
// Every rule above is written in ASCII, and the audit sent figures that are not
// in ASCII. `I can do \uff14\uff12\uff10 for it` is four hundred and twenty in
// fullwidth digits, `I will accept \u0664\u0662\u0660` is four hundred and
// twenty in Arabic-Indic, `Ill do 4\u200b20` is four hundred and twenty with a
// zero-width space in the middle of it, and `Send 420 \uff55\uff53\uff44` is a
// currency code nothing recognised. Each one reads as a price to the person on
// the other end, which is the only test that matters here, and each one walked
// straight through.
//
// So the text is put into one spelling before any rule reads it, in this order
// and for these reasons:
//
//  - NFKC, which folds every compatibility form to the character it imitates:
//    fullwidth digits and fullwidth letters become the ASCII ones, so `usd` is
//    a currency code again.
//  - Format characters out (`\p{Cf}`): a zero-width space between two digits
//    is invisible to a reader and fatal to `\d{3}`.
//  - Every Unicode decimal digit folded to its ASCII twin. NFKC does not do
//    this, and deliberately: Arabic-Indic digits are a script, not a
//    compatibility spelling. They are still digits to anybody reading them.
//
// Nothing here loosens what counts as money. A bare number is still only money
// where a price opening or ending sits beside it, or where it opens the
// message; a year between 1900 and 2099 and a number with its unit attached are
// still left alone. "see you at 4", "built in 2019" and "size 42 frame" pass
// before and after, which is the point: this change is about how a figure is
// SPELLED, never about what a figure is.
// ---------------------------------------------------------------------------

/**
 * One Unicode decimal digit as its ASCII twin.
 *
 * Every decimal digit set in Unicode is ten consecutive code points beginning
 * at that script's zero, so the value is the distance back to the first code
 * point in the run — at most nine steps, and no table to keep up to date.
 */
const isDigit = (cp: number): boolean => /\p{Nd}/u.test(String.fromCodePoint(cp));

function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let zero = cp;
  for (let i = 0; i < 9 && zero > 0 && isDigit(zero - 1); i++) zero--;
  const value = cp - zero;
  return value >= 0 && value <= 9 ? String(value) : ch;
}

/** The text, in the one spelling the rules are written in. */
export function foldForMoney(text: string): string {
  let s = text;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* an unpaired surrogate cannot be normalised; the rest still runs */
  }
  s = s.replace(/\p{Cf}/gu, '');
  s = s.replace(/\p{Nd}/gu, (d) => (d >= '0' && d <= '9' ? d : asciiDigit(d)));
  return s.toLowerCase().replace(/[‘’]/g, "'");
}

/**
 * The name of the rule that fired, or undefined when the words carry no
 * figure. Exported for the suite and for anyone reading a refusal back: every
 * refusal should be one a person can justify out loud.
 */
export function moneyFigureRule(text: string): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const s = foldForMoney(text);
  for (const rule of RULES) {
    if (rule.test(s)) return rule.name;
  }
  return undefined;
}

/** Does this text carry a money figure, in digits or in words? */
export function carriesMoneyFigure(text: string): boolean {
  return moneyFigureRule(text) !== undefined;
}

// ---------------------------------------------------------------------------
// A FIGURE IN AN ATTRIBUTE (20 September 2026).
//
// `attributes` is free-form: any lower_snake_case key the agent likes, and a
// string, a number or a boolean under it. Every value on it CROSSES to the
// counterparty the moment both sides are keen (domain/matches.ts,
// buildAttributes). So an assistant that writes `budget: 25` or
// `max_price: "up to $25"` onto its human's want has put that human's ceiling
// in front of the person they are about to haggle with, and the posting door
// never looked: it read `kind` and nothing else.
//
// It is the same defect as the best-offer floor read out to a buyer
// (domain/cards.ts assertFloorStaysPrivate, 20 September 2026) arriving by a
// different road. A price band is a field with a number in it and an asking
// price is a number the protocol carries on purpose; an attribute is neither,
// and nothing checks what is written there.
//
// TWO WAYS A FIGURE IS READ HERE, and both are deliberately narrower than the
// rule on the open conversation:
//
//   THE VALUE NAMES MONEY. `$25`, `25 AUD`, `twenty five dollars`, `asking
//   450`, `450 ono`. Only the rules flagged `named` above run, because the
//   shape rules would refuse `wheel_size_in: 29`, `year: 2019`, `ram_gb: 16`
//   and a model number like 1.10, which are the attributes people actually
//   write. A bare number in a typed attribute is a spec and stays a spec.
//
//   THE KEY IS NAMED FOR MONEY, and there is any number under it. `budget`,
//   `max_price`, `price_ceiling`, `hourly_rate`, `per_day`. Here a bare number
//   IS the figure, because the key has already said what it means. No category
//   in the catalogue defines a money-shaped attribute — the whole vocabulary is
//   condition, brand, model, sizes, counts and years — so a key like this one
//   was invented by the assistant on the spot, which is exactly the case this
//   is for. `budget: "flexible"` carries no number and goes up untouched.
//
// WHAT A WRONG ANSWER COSTS, each way. A false refusal costs one rewrite of
// one attribute on a posting that has not gone up yet. A miss costs a human
// their negotiating position, permanently, to a stranger. That is why `floor`
// on its own (a storey) and `rate` on its own (a frame rate) are left out
// while `price`, `budget` and `hourly_rate` are in: the list is the keys that
// are about money in almost every posting they could appear on.
// ---------------------------------------------------------------------------

/**
 * Key segments that mean money on their own. Read as whole lower_snake_case
 * segments, so `price_max` and `max_price` are both caught and `pricey_looking`
 * is not a key anybody writes.
 *
 * DELIBERATELY ABSENT: `floor` (which storey), `ceiling` (height), `rate`
 * (frame rate, refresh rate — but see RATE_OVER_TIME below), `value` (any kind
 * of value), `worth` and `size`. Each is money often enough to be tempting and
 * something else often enough that refusing it would be a nuisance with no
 * leak behind it.
 */
const MONEY_KEY_WORDS = new Set([
  'price',
  'prices',
  'pricing',
  'priced',
  'cost',
  'costs',
  'budget',
  'ask',
  'asking',
  'reserve',
  'rrp',
  'msrp',
  'fee',
  'fees',
  'postage',
  'shipping',
  'freight',
  'deposit',
  'pay',
  'paid',
  'payment',
  'spend',
  'quote',
  'salary',
  'wage',
  'wages',
  'rent',
  'discount',
  'cash',
  'bid',
  'bids',
  'offer',
  'offers',
  'dollars',
  'aud',
  'usd',
  'nzd',
  'cad',
  'sgd',
  'gbp',
  'eur',
  'jpy',
  'inr',
  'chf',
  'hkd',
  'zar',
]);

/**
 * A stretch of time, which is what turns the two words that are not money on
 * their own into a price: `hourly_rate`, `day_rate`, `per_hour`, `per_night`.
 * `frame_rate` and `refresh_rate` have no time word beside them and are left
 * where they are.
 */
const TIME_KEY_WORDS = new Set([
  'hour',
  'hourly',
  'day',
  'daily',
  'night',
  'nightly',
  'week',
  'weekly',
  'month',
  'monthly',
  'year',
  'yearly',
  'annual',
  'session',
  'lesson',
  'visit',
  'job',
  'hr',
]);
/** The two words that are a price only with a stretch of time beside them. */
const RATE_OVER_TIME = new Set(['rate', 'per']);

/** Is this attribute key one whose number is a price by the name of it? */
export function moneyShapedKey(key: string): boolean {
  if (typeof key !== 'string' || !key) return false;
  const parts = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((p) => MONEY_KEY_WORDS.has(p))) return true;
  return parts.some((p) => RATE_OVER_TIME.has(p)) && parts.some((p) => TIME_KEY_WORDS.has(p));
}

/** Any number at all, written either way: `25`, `twenty five`, `a hundred`. */
const anyNumber = re(`(?:\\d|\\b${NUM_WORD}\\b)`);

/**
 * The name of the rule that fired on one attribute, or undefined where it
 * carries no figure. `key` counts: the same `25` is a spec under `seats` and a
 * ceiling under `budget`.
 *
 * Booleans are never a figure. A number is stringified first, so `budget: 25`
 * and `budget: "25"` are the same attribute written two ways and get the same
 * answer.
 */
export function attributeFigureRule(key: string, value: unknown): string | undefined {
  if (typeof value === 'boolean' || value === null || value === undefined) return undefined;
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!raw) return undefined;
  const s = foldForMoney(raw);
  // The key first, because its answer is the more exact one: under a key named
  // for money the bare number IS the finding, and saying so beats reporting
  // whichever spelling rule happened to catch it.
  if (moneyShapedKey(key) && anyNumber.test(s)) return 'a number under a name that means money';
  for (const rule of RULES) {
    if (rule.named && rule.test(s)) return rule.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// What an agent is told, in the register everything else here is written in.
// Both sentences are held to the copy lint and to the banned-noun list.
// ---------------------------------------------------------------------------

/** The refusal on the open conversation: words go here, figures do not. */
export const FIGURE_IN_WORDS_ACTION =
  "This one has not gone. It carries a figure, and a figure travels on its own road, where your human's own limits are checked before anything leaves. Send it as an offer instead, and send these words again without the number in them. Say to your human: I'll put that figure on the table properly.";

/**
 * The refusal on a posting whose attributes carry a figure, naming the one
 * the assistant wrote so it knows which word to take the number out of.
 *
 * The key is the assistant's OWN word — it invented `budget` — so saying it
 * back is not reading the machinery's field names aloud. It is truncated
 * because a key has no length limit worth trusting and `human_action` is
 * capped at 300 characters by the published error schema.
 */
export function figureInAttributeAction(key: string): string {
  const said = key.length > 24 ? `${key.slice(0, 24)}…` : key;
  return (
    `This has not gone up. The words you put under '${said}' carry a figure, and a figure on a posting ` +
    "travels on its own road, where your human's own limits stay private. Post it again with no number in " +
    'those words, and let the posting carry the figure where it asks for one.'
  );
}

/** The refusal on a note riding along with an offer. */
export const FIGURE_IN_OFFER_NOTE_ACTION =
  "This one has not gone. Your figure goes on the offer itself, where your human's own limits are checked; a second one in the note beside it is checked by nothing. Send it again with the note in plain words and no number in it, and let the offer carry the figure.";
