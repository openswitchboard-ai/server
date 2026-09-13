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
  '(?:how about|what about|how\'?s|how does .{0,20} sound|i could do|could do|i can do|can do|can you do|could you do|would you take|will you take|would you do|i\'?ll take|i will take|i\'?d take|i would take|happy to take|(?:best|lowest|highest|max|maximum|minimum|budget|limit|ceiling|top) (?:i can do )?is|call it|drop to|drop it to|come down to|go down to|knock it down to|knock off|could go to|can go to|go up to|come up to|stretch to|push to|meet you at|meet you in the middle at|meet in the middle at|split the difference at|settle at|settle on|land on|asking|i am asking|i\'m asking|offer(?:ing)? you|i\'ll offer|i will offer|offer|i\'ll pay|i will pay|i\'d pay|i would pay|pay you|the price is|price is|priced at|it\'s worth|worth|sell it for|let it go for|take it for|do it for)';

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
  `\\b(?:${NUM_WORD}|a|an|couple(?: of)?|few)[\\s-]+(?:hundred|thousand|grand)\\b(?!\\s+${NOT_MONEY_AFTER}\\b)`,
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
  { name: 'money sign before a number', test: (s) => symbolThenNumber.test(s) },
  { name: 'money sign after a number', test: (s) => numberThenSymbol.test(s) },
  { name: 'money code beside a number', test: (s) => codeBesideNumber.test(s) },
  { name: 'thousands comma', test: (s) => groupedThousands.test(s) },
  { name: 'two decimal places', test: (s) => bigDecimal.test(s) },
  {
    name: 'two decimal places on a small number',
    test: (s) => smallDecimal.test(s) && !smallDecimalIsTime(s),
  },
  { name: 'a number and a money word', test: (s) => numberThenMoneyWord.test(s) },
  { name: 'a number for each one', test: (s) => numberThenEach.test(s) },
  { name: 'a spoken round number', test: (s) => spelledMagnitude.test(s) },
  { name: 'a spoken pair of numbers', test: (s) => spelledPair(s) },
  { name: 'a price opening', test: (s) => priceLeadIn.test(s) },
  { name: 'a price ending', test: (s) => priceTail.test(s) },
  { name: 'a bare number for an opening', test: (s) => opensWithBareNumber(s) },
  { name: 'a number spread across spaces', test: (s) => spacedDigits.test(s) },
  { name: 'a hedged number', test: (s) => hedgedNumber.test(s) },
];

/**
 * The name of the rule that fired, or undefined when the words carry no
 * figure. Exported for the suite and for anyone reading a refusal back: every
 * refusal should be one a person can justify out loud.
 */
export function moneyFigureRule(text: string): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const s = text.toLowerCase().replace(/[‘’]/g, "'");
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
// What an agent is told, in the register everything else here is written in.
// Both sentences are held to the copy lint and to the banned-noun list.
// ---------------------------------------------------------------------------

/** The refusal on the open conversation: words go here, figures do not. */
export const FIGURE_IN_WORDS_ACTION =
  "This one has not gone. It carries a figure, and a figure travels on its own road, where your human's own limits are checked before anything leaves. Send it as an offer instead, and send these words again without the number in them. Say to your human: I'll put that figure on the table properly.";

/** The refusal on a note riding along with an offer. */
export const FIGURE_IN_OFFER_NOTE_ACTION =
  "This one has not gone. Your figure goes on the offer itself, where your human's own limits are checked; a second one in the note beside it is checked by nothing. Send it again with the note in plain words and no number in it, and let the offer carry the figure.";
