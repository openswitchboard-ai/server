/**
 * AN ADDRESS OR A PHONE NUMBER NEVER TRAVELS IN THE WORDS (1 October 2026).
 *
 * Contact details now have a road of their own: the send-contact page, where
 * the person types them on their own device and their browser scrambles them
 * to the other person's browser (domain/sealedContact.ts). Neither assistant
 * sees them there. A message, an offer note or a photo caption would put them
 * in front of both assistants and in the relay, so those doors refuse them and
 * point at the page instead.
 *
 * WHY PATTERNS AND NOT THE MODEL. The message door already has a model read
 * every message (intake/checks/messageSafety.ts), and it is built never to
 * refuse: its answers are holds for a person to read. A refusal has to be one
 * a person can justify out loud and an assistant can fix in one move, so this
 * rule is deterministic, in-house and cheap, and it runs before any model is
 * paid. Nothing here goes to any outside service.
 *
 * FALSE POSITIVES ARE THE COST TO WATCH. Times, dates, prices, quantities,
 * sizes, model numbers and a suburb on its own must all pass: two people
 * arranging a handover say all of those. So a phone number is a run of digits
 * shaped like one (a leading + or 0, a 1300/1800 number, or the 3-3-4 shape),
 * with dates taken out first; and an address is a street number, one to three
 * name words, and a street type. The ambiguous street types (road, way, court,
 * place and so on, which are also ordinary words) count only where the name is
 * capitalised or the type ends the phrase. test/unit/contactInWords.test.ts
 * holds both lists.
 */

/** The street types that are never ordinary words in a sentence. */
const PLAIN_STREET_TYPES = [
  'street', 'st', 'avenue', 'ave', 'av', 'crescent', 'cres', 'terrace', 'tce', 'parade', 'pde',
  'boulevard', 'blvd', 'esplanade', 'esp', 'circuit', 'cct', 'highway', 'hwy', 'rd', 'dr',
  'drv', 'ct', 'pl', 'ln', 'cl', 'gr', 'sq', 'pkwy', 'parkway', 'crt',
] as const;

/** Street types that are also everyday words ("road bike", "no way"). */
const AMBIGUOUS_STREET_TYPES = [
  'road', 'way', 'court', 'place', 'lane', 'drive', 'close', 'grove', 'square', 'rise', 'row',
  'walk', 'loop', 'glen', 'view', 'vista', 'promenade', 'quay', 'wharf', 'mews', 'track',
] as const;

const WORD = "[A-Za-z][A-Za-z'’-]*";
/** A street number: 12, 12a, 3/45, 3-5, unit 3/45. */
const STREET_NUMBER = String.raw`(?:(?:unit|apt|apartment|flat|shop|suite)\s*\d{1,5}[a-z]?\s*[,/]?\s*)?\d{1,5}[a-z]?(?:\s*[/-]\s*\d{1,5}[a-z]?)?`;

const PLAIN_RE = new RegExp(
  String.raw`(?:^|[^\w$.:])${STREET_NUMBER}\s+(?:${WORD}\s+){1,3}(?:${PLAIN_STREET_TYPES.join('|')})\b\.?`,
  'i',
);

// The ambiguous types: either the name words are capitalised...
const AMBIGUOUS_CAPS_RE = new RegExp(
  String.raw`(?:^|[^\w$.:])${STREET_NUMBER}\s+(?:[A-Z][A-Za-z'’-]*\s+){1,3}(?:${AMBIGUOUS_STREET_TYPES.map(
    (t) => `${t[0].toUpperCase()}${t.slice(1)}|${t}`,
  ).join('|')})\b`,
);
// ...or the type ends the phrase: a comma, a full stop, a line end, the end.
const AMBIGUOUS_END_RE = new RegExp(
  String.raw`(?:^|[^\w$.:])${STREET_NUMBER}\s+(?:${WORD}\s+){1,3}(?:${AMBIGUOUS_STREET_TYPES.join('|')})\s*(?:[,.;!?\n]|$)`,
  'i',
);

const PO_BOX_RE = /\b(?:P\.?\s?O\.?|post\s+office)\s*box\s*\d{1,6}\b/i;

/** Every run that might be a phone number: digits with the usual separators. */
const PHONE_CANDIDATE_RE = /(?:\+\s?)?\(?\d[\d\s().-]{5,22}\d/g;

/** Dates written with separators, which are not numbers to call. */
const DATE_SHAPES = [
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/,
  /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/,
];

const SPELLED_DIGITS = new Set(['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);

function looksLikePhone(raw: string): boolean {
  const s = raw.trim();
  const digits = s.replace(/\D/g, '');
  if (DATE_SHAPES.some((re) => re.test(s))) return false;
  // Two numbers either side of a spaced dash are a range, not one number.
  if (/\d\s+[-–]\s+\d/.test(s) && !s.startsWith('+')) return false;
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15;
  // 1300 and 1800 numbers.
  if (/^1[38]00$/.test(digits.slice(0, 4)) && digits.length === 10) return true;
  // A leading zero: a trunk prefix. Australian and New Zealand numbers are 9
  // or 10 digits from the zero, British ones 11.
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) {
    // A bare run with no separators and a leading zero is still a number.
    return true;
  }
  // The North American shape, 3-3-4, with a bracket or separators.
  if (digits.length === 10 && /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$/.test(s)) return true;
  return false;
}

/** Eight or more digits spelled out in a row: "zero four one two ...". */
function spelledPhone(text: string): boolean {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let run = 0;
  for (const w of words) {
    if (SPELLED_DIGITS.has(w)) {
      run += 1;
      if (run >= 8) return true;
    } else if (w === 'double' || w === 'triple') {
      // "double four" is still inside the run.
    } else {
      run = 0;
    }
  }
  return false;
}

export type ContactKind = 'phone' | 'address';

/**
 * What kind of contact detail these words carry, if any. The rule that fired
 * is returned as a kind only: nothing about the words themselves.
 */
export function contactDetailRule(text: string): ContactKind | undefined {
  if (!text) return undefined;
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const start = m.index ?? 0;
    // A run straight after a currency sign or a letter is a price or a model
    // number ("$1,200", "RTX4090"), which other rules and nobody's phone own.
    const before = text[start - 1] ?? '';
    if (/[$€£A-Za-z#]/.test(before)) continue;
    if (looksLikePhone(m[0])) return 'phone';
  }
  if (spelledPhone(text)) return 'phone';
  if (PO_BOX_RE.test(text)) return 'address';
  if (PLAIN_RE.test(text) || AMBIGUOUS_CAPS_RE.test(text) || AMBIGUOUS_END_RE.test(text)) {
    return 'address';
  }
  return undefined;
}

export function carriesContactDetails(text: string): boolean {
  return contactDetailRule(text) !== undefined;
}

/** The reason code a refusal of this kind is recorded under. */
export const CONTACT_IN_WORDS_REASON = 'contact-details-in-words';

/**
 * The page's own sentence, for the one door a person types into themselves:
 * the line beside a photo.
 */
export const CONTACT_IN_CAPTION_LINE =
  'Take the address or phone number out of the description. Your assistant can give you a page to send those to them privately.';
