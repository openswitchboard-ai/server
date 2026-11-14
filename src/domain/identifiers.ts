/**
 * AN IDENTIFIER ON A POSTING (9 October 2026, migration 067).
 *
 * Matching is by meaning: an embedding and the two postings' own words
 * (matchTiers.ts). That leaves two gaps. Two postings for the identical
 * product can miss each other on a crowded shelf, because the nearest fifty by
 * meaning need not include the one that is the same thing; and two editions of
 * a similarly named product can read as the same thing, because their words
 * are nearly the same.
 *
 * So a posting may carry up to three identifiers. Each is `{ kind, value }`:
 * the value is the identifier as printed, and the kind is a few plain words
 * saying what it is. The person's own assistant decides whether the thing has
 * one and which to give. THERE ARE NO BUILT-IN KINDS, no approved list and no
 * catalogue, and nothing here or anywhere else branches on what sort of goods
 * a posting is about. The kind is free words; only the value is compared.
 *
 * THREE RULES, and they are the whole of this file.
 *
 *   1. COMPARED AS NORMALISED. The value is case-folded, and a mark between
 *      two digits is kept as one boundary while every other mark is taken
 *      out, so "199/165", "199 / 165" and "199-165" are one identifier and
 *      "2/198" and "21/98" are two (normaliseIdentifier). Both forms are kept:
 *      the value as given is the owner's to read back, and the normalised form
 *      is what the engine compares. A normalised form under IDENTIFIER_MIN_NORM
 *      letters and digits says too little to tell one product from another
 *      and is refused. A value of several words ending in a code meets the
 *      code given alone (trailingCode), and never another name in front of
 *      the same code (identifiersAgree).
 *
 *   2. IT NAMES A PRODUCT OR AN EDITION, NEVER ONE OBJECT. A serial number, a
 *      registration or a certificate number belongs to a single thing and
 *      often to a single person, and a board of them is a register nobody
 *      asked the switchboard to keep. Those belong on the deal, as a written
 *      line the seller's human confirms (domain/confirmLines.ts). The words
 *      that say "one object" are SINGLE_OBJECT_WORDS below, in this one place.
 *
 *   3. IT NEVER CARRIES A WAY OF REACHING ANYBODY. The value and the kind go
 *      through the same pattern check that keeps contact details out of a
 *      message (contactInWords.ts), plus the handle and web-address shapes
 *      below, here and now; and through the model screen with the
 *      rest of the posting's words, off the queue (screening.ts
 *      collectFreeText). Neither check stands in for the other.
 *
 * An identifier is never shown to the other side. What crosses is one
 * sentence saying the two postings carry the same one (matchTiers.ts,
 * IDENTIFIER_SHARED_SENTENCE), and two people who share one both know it.
 *
 * Everything in this file is pure: no I/O, no clock, no randomness.
 */
import { contactDetailRule } from './contactInWords.js';
import { isPlaceholderValue } from './placeholderValues.js';

/** How many identifiers one posting takes. */
export const IDENTIFIERS_MAX = 3;
/** The value as printed: the length every other short phrase on a posting is held to. */
export const IDENTIFIER_VALUE_MAX_CHARS = 60;
/** What it is, in a few plain words. */
export const IDENTIFIER_KIND_MAX_CHARS = 40;
export const IDENTIFIER_KIND_MAX_WORDS = 5;
/** The fewest letters and digits a value may come to once normalised. */
export const IDENTIFIER_MIN_NORM = 3;

/** One identifier as it is stored and handed back to its owner. */
export interface Identifier {
  /** What it is, in the poster's own few words: "model number", "ISBN". */
  kind: string;
  /** The identifier as given. */
  value: string;
  /** The form the engine compares (normaliseIdentifier). */
  norm: string;
}

/** The one mark a normalised form keeps: a boundary between two runs of digits. */
export const IDENTIFIER_BOUNDARY = '-';

const DIGIT_AT_END = /\p{N}$/u;
const DIGIT_AT_START = /^\p{N}/u;

/**
 * The form two identifiers are compared in (14 November 2026, migration 073).
 * Case-folded and accents folded. Any run of characters that is not a letter
 * or a digit becomes one IDENTIFIER_BOUNDARY where it sits between two
 * digits, and is taken out everywhere else.
 *
 * Between two digits a mark carries meaning: "2/198" and "21/98" are two
 * numbers with the same digits, and so are "012/198" and "121/98". Which mark
 * it is, and any spacing round it, carries none, so "199/165", "199 / 165" and
 * "199-165" are one. Next to a letter a mark is spelling: "WH-1000XM4",
 * "WH1000XM4" and "wh 1000 xm4" are one model number, and "SL M7100" is
 * "SL-M7100".
 *
 * Before 14 November 2026 every mark was taken out, so "2/198" and "21/98"
 * were one identifier, and so were "012/198" and "121/98".
 */
export function normaliseIdentifier(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, (marks: string, at: number, all: string) =>
      DIGIT_AT_END.test(all.slice(Math.max(0, at - 2), at)) && DIGIT_AT_START.test(all.slice(at + marks.length))
        ? IDENTIFIER_BOUNDARY
        : '',
    );
}

/** The letters and digits in a normalised form: what IDENTIFIER_MIN_NORM counts. */
export const normLength = (norm: string): number => norm.split(IDENTIFIER_BOUNDARY).join('').length;

/**
 * How many digits make a value a LONG code. A barcode, an ISBN or a long
 * catalogue number is grouped by its marks only for reading, so a long code
 * is compared with its marks taken out as well: "978-0-14-143951-8" and
 * "9780141439518" are one ISBN. Eight is the shortest common barcode. Short
 * numbers, where a mark between two digits does carry meaning, never get
 * this form.
 */
export const IDENTIFIER_LONG_DIGITS = 8;

const digitCount = (value: string): number => (value.match(/\p{N}/gu) ?? []).length;

/**
 * THE WORDS THAT SAY AN IDENTIFIER NAMES ONE OBJECT. One small general list,
 * read against the `kind` the assistant wrote. A number of this sort belongs
 * on the deal as a written line the seller's human confirms (the existing
 * confirm_lines feature, domain/confirmLines.ts, respond(ask_confirmation)),
 * and never on a posting. The list is about the SORT OF NUMBER, never about
 * the sort of goods: nothing else in the codebase reads it.
 */
const SINGLE_OBJECT_WORDS = new Set([
  'serial',
  'vin',
  'imei',
  'meid',
  'esn',
  'registration',
  'rego',
  'certificate',
  'cert',
  'chassis',
  'tracking',
  'receipt',
  'invoice',
  'passport',
  'licence',
  'license',
]);
/** The same, where it takes two words to say it. */
const SINGLE_OBJECT_PHRASES = [
  'number plate',
  'engine number',
  'frame number',
  'mac address',
  'asset tag',
  'vehicle identification',
];

/** Kind words that say the value is a way of reaching a person. */
const CONTACT_KIND_WORDS = new Set([
  'phone',
  'mobile',
  'telephone',
  'email',
  'mail',
  'address',
  'handle',
  'username',
  'contact',
  'profile',
  'website',
  'url',
  'link',
]);

const kindWords = (kind: string): string[] =>
  kind
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Does this kind say the identifier names one physical object? */
/**
 * Word stems that say "one object" in any of their forms: certificate,
 * certification and cert; serial and serials; registration, registered and
 * rego; licence and license. Found in a rehearsal (24 October 2026), where
 * "certification number" passed because only the exact words were listed.
 */
const SINGLE_OBJECT_STEMS = ['cert', 'serial', 'regist', 'licen'];

export function namesOneObject(kind: string): boolean {
  const words = kindWords(kind);
  if (words.some((w) => SINGLE_OBJECT_WORDS.has(w))) return true;
  if (words.some((w) => SINGLE_OBJECT_STEMS.some((stem) => w.startsWith(stem)))) return true;
  const joined = ` ${words.join(' ')} `;
  return SINGLE_OBJECT_PHRASES.some((p) => joined.includes(` ${p} `));
}

/** Why an identifier was turned back, as a word a caller or a test can branch on. */
export type IdentifierRefusal =
  | 'shape'
  | 'too_many'
  | 'too_short'
  | 'contact'
  | 'single_object'
  | 'placeholder';

/** What the assistant reads for each. Plain, and each says the one move that fixes it. */
export const IDENTIFIER_SENTENCES: Record<IdentifierRefusal, string> = {
  shape:
    'Identifiers come as a list, and each one has a `value`, the number or code as printed, and a `kind`, a few plain words for what it is.',
  too_many: `A posting takes ${IDENTIFIERS_MAX} identifiers at most. Keep the ones that say most exactly which product or edition it is.`,
  too_short: `An identifier needs at least ${IDENTIFIER_MIN_NORM} letters or digits to tell one product from another. Leave this one off.`,
  contact:
    'An identifier is the number or code printed on the product. A phone number, an email address, a link or a handle never goes on a posting. Where a product\'s own number reads like one of those, give another form of it or leave it off.',
  single_object:
    "That number belongs to one object, so it stays off the posting. Give the model or edition it belongs to here. Where the single number matters to a deal, ask for it as a written line with respond(ask_confirmation), and the seller's human confirms it.",
  placeholder:
    'That identifier is a mask or a placeholder. Give it as printed on the thing, or leave it off.',
};

/**
 * A web address, by its start or by its ending. The same two shapes
 * arrangement.ts turns back, written again here so this file imports nothing
 * that reads a database: the screened snapshot and the tiers both read it.
 */
const WEB_ADDRESS = /(https?:\/\/|\bwww\.)/i;
const DOMAIN_TAIL = /\.(com|net|org|io|ai|co|uk|au|nz|de|fr|it|es|info|biz|xyz)\b/i;

const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f<>]/;
const MONEY_SIGN = /[$£€¥]/;
/** A kind is plain words: letters, digits, spaces, and the marks a short name uses. */
const KIND_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]*$/u;

/** A phone number, an email address, a street address, a link or a handle. */
function looksLikeContact(s: string): boolean {
  return (
    s.includes('@') || WEB_ADDRESS.test(s) || DOMAIN_TAIL.test(s) || contactDetailRule(s) !== undefined
  );
}

export type ReadIdentifiers =
  | { ok: true; identifiers: Identifier[] }
  | { ok: false; reason: IdentifierRefusal; error: string };

/**
 * The identifiers on a call, checked and tidied, or the one reason they were
 * turned back. Absent and null both read as none. The same normalised value
 * given twice is kept once, under the first kind it came with.
 */
export function readIdentifiers(value: unknown): ReadIdentifiers {
  const no = (reason: IdentifierRefusal): ReadIdentifiers => ({
    ok: false,
    reason,
    error: IDENTIFIER_SENTENCES[reason],
  });
  if (value === undefined || value === null) return { ok: true, identifiers: [] };
  if (!Array.isArray(value)) return no('shape');
  if (value.length > IDENTIFIERS_MAX) return no('too_many');
  const out: Identifier[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return no('shape');
    const raw = item as Record<string, unknown>;
    if (typeof raw.kind !== 'string' || !['string', 'number'].includes(typeof raw.value)) {
      return no('shape');
    }
    const kind = raw.kind.trim().replace(/\s+/g, ' ');
    const given = String(raw.value).trim().replace(/\s+/g, ' ');
    if (
      !kind ||
      !given ||
      kind.length > IDENTIFIER_KIND_MAX_CHARS ||
      given.length > IDENTIFIER_VALUE_MAX_CHARS ||
      kind.split(' ').length > IDENTIFIER_KIND_MAX_WORDS ||
      !KIND_SHAPE.test(kind) ||
      CONTROL_OR_MARKUP.test(given) ||
      MONEY_SIGN.test(given)
    ) {
      return no('shape');
    }
    // Contact first: a phone number filed as a "serial number" is a contact
    // detail before it is anything else, and that is the answer it gets.
    if (
      looksLikeContact(given) ||
      looksLikeContact(kind) ||
      kindWords(kind).some((w) => CONTACT_KIND_WORDS.has(w))
    ) {
      return no('contact');
    }
    if (namesOneObject(kind)) return no('single_object');
    // A masked value ("XXXX-XXXX", "[redacted]") says nothing about which
    // product it is (domain/placeholderValues.ts).
    if (isPlaceholderValue(given)) return no('placeholder');
    const norm = normaliseIdentifier(given);
    if (normLength(norm) < IDENTIFIER_MIN_NORM) return no('too_short');
    if (!out.some((i) => i.norm === norm)) out.push({ kind, value: given, norm });
  }
  return { ok: true, identifiers: out };
}

/**
 * The refusal as the posting doors throw it: the shape every other refusal of
 * a field's words has (a plain sentence and the field to fix), with the reason
 * word beside it for a caller that wants to branch.
 */
export function identifierError(read: Extract<ReadIdentifiers, { ok: false }>): Error {
  return Object.assign(new Error(read.error), {
    validation: ['identifiers'],
    identifier_refusal: read.reason,
  });
}

/**
 * The identifiers stored on a row or held in a screened snapshot, read
 * defensively: anything malformed reads as none, so nothing that never went
 * through readIdentifiers is ever compared. The stored `norm` must be there,
 * as the mark of a value that went through readIdentifiers, but the form
 * handed on is worked out again from the value, so a row written under an
 * older rule is compared by today's.
 */
export function identifiersOf(stored: unknown): Identifier[] {
  if (!Array.isArray(stored)) return [];
  const out: Identifier[] = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue;
    const { kind, value, norm: stamped } = item as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof value !== 'string' || typeof stamped !== 'string') continue;
    const norm = normaliseIdentifier(value);
    if (normLength(norm) < IDENTIFIER_MIN_NORM) continue;
    out.push({ kind, value, norm });
  }
  return out.slice(0, IDENTIFIERS_MAX);
}

/**
 * The same value with the leading zeros dropped from each run of digits:
 * "025/165" reads "25-165", as "25/165" does. The same number is printed
 * padded in one place and bare in another, and this is the form in which the
 * two meet. It is a SECOND form beside `norm`, never a replacement for it,
 * and undefined where it is the same as `norm` or too short to say anything
 * ("A-007" would read "a7").
 */
export function unpaddedForm(value: string): string | undefined {
  const bare = normaliseIdentifier(value.replace(/\p{N}+/gu, (run) => run.replace(/^0+(?=\p{N})/u, '')));
  return bare !== normaliseIdentifier(value) && normLength(bare) >= IDENTIFIER_MIN_NORM ? bare : undefined;
}

/**
 * THE CODE AT THE END OF A NAME. A value of several words whose last word
 * holds a digit ("Obsidian Flames 125/197", "Scarlet & Violet 151 199/165")
 * is most often a name with the printed code after it, while the other side
 * gave the code alone ("125/197"). Undefined where the value is one word,
 * where its last word has no digit, or where that word comes to under
 * IDENTIFIER_MIN_NORM letters and digits once normalised. Spacing round a
 * slash or a dash is closed up first, so "Name 199 / 165" ends in "199/165".
 *
 * Only the LAST word, and only one holding a digit: a name leads and the code
 * follows far more often than the reverse, and a trailing word of letters
 * alone ("Deluxe", "Edition") says nothing about which product it is.
 */
export function trailingCode(value: string): string | undefined {
  const words = value.trim().replace(/\s*([/\\\-–—])\s*/g, '$1').split(/\s+/);
  if (words.length < 2) return undefined;
  const last = words[words.length - 1];
  if (!/\p{N}/u.test(last)) return undefined;
  return normLength(normaliseIdentifier(last)) >= IDENTIFIER_MIN_NORM ? last : undefined;
}

/**
 * The forms one value is compared in as a whole: its `norm`; its unpadded
 * form where that differs; and, for a long code, the same with every mark
 * taken out.
 */
function wholeForms(value: string): string[] {
  const norm = normaliseIdentifier(value);
  const forms = [norm];
  const bare = unpaddedForm(value);
  if (bare) forms.push(bare);
  if (digitCount(value) >= IDENTIFIER_LONG_DIGITS) {
    const plain = norm.split(IDENTIFIER_BOUNDARY).join('');
    if (plain !== norm) forms.push(plain);
  }
  return forms;
}

/**
 * DO TWO IDENTIFIERS NAME THE SAME THING? Yes where:
 *
 *   - the two values agree as wholes, in any of their forms (wholeForms); or
 *   - one is a name with a code after it, the other has no name in front of
 *     anything, and the other agrees with that code ("Obsidian Flames
 *     125/197" and "125/197").
 *
 * Where BOTH have words in front of a code, those words count: "Base Set
 * 4/102" and "Jungle 4/102" are two products, so they agree only as wholes.
 * A set or series name tells products apart, and it is never thrown away
 * while the other side gave one too.
 */
export function identifiersAgree(a: Identifier, b: Identifier): boolean {
  const aWhole = wholeForms(a.value);
  const bWhole = wholeForms(b.value);
  if (aWhole.some((f) => bWhole.includes(f))) return true;
  const aTail = trailingCode(a.value);
  const bTail = trailingCode(b.value);
  if (aTail && !bTail) return wholeForms(aTail).some((f) => bWhole.includes(f));
  if (bTail && !aTail) return wholeForms(bTail).some((f) => aWhole.includes(f));
  return false;
}

/**
 * The most forms one identifier is indexed under: up to three for the whole
 * value (wholeForms) and three for a trailing code. Migration 073 holds
 * identifier_norms to IDENTIFIERS_MAX times this.
 */
export const IDENTIFIER_FORMS_MAX = 6;

/**
 * The forms a posting's identifiers are looked up by: what the candidate
 * query binds and the index holds. Each identifier gives its whole forms and,
 * where the value is a name with a code after it, the code's forms too.
 *
 * This is the WIDER net. Two identifiers that agree (identifiersAgree) always
 * have a form in common here, so the lookup never misses a pair. Some pairs
 * with a form in common do not agree ("Base Set 4/102" and "Jungle 4/102"
 * share the code's form): those come in as candidates only, and everything
 * that says two postings share an identifier asks sharesIdentifier, which
 * holds them apart.
 */
export function identifierNorms(ids: Identifier[]): string[] {
  const forms = new Set<string>();
  for (const i of ids) {
    for (const f of wholeForms(i.value)) forms.add(f);
    const tail = trailingCode(i.value);
    if (tail) for (const f of wholeForms(tail)) forms.add(f);
  }
  return [...forms].filter((f) => normLength(f) >= IDENTIFIER_MIN_NORM);
}

/** Do two postings carry an identifier in common? Some identifier on one agrees with one on the other. */
export function sharesIdentifier(a: unknown, b: unknown): boolean {
  const mine = identifiersOf(a);
  if (!mine.length) return false;
  const theirs = identifiersOf(b);
  return mine.some((x) => theirs.some((y) => identifiersAgree(x, y)));
}

/**
 * Do two postings name DIFFERENT products by the same sort of identifier?
 * True only where both carry identifiers, at least one kind is on both sides
 * (compared as kindKey compares them), and no compared form is shared. Two
 * different numbers of the same kind are two different products or editions.
 *
 * Read only by the near-miss path (matcher.ts, nearMisses.ts): a near miss is
 * advisory, so leaving one out on this evidence costs nobody an introduction.
 * The tiers never read it.
 *
 * "No compared form is shared" reads every form identifierNorms gives, the
 * trailing code included, so a name with a code after it and the bare code
 * ("Obsidian Flames 125/197", "125/197") are never called different here.
 */
export function differentByIdentifier(a: unknown, b: unknown): boolean {
  const mine = identifiersOf(a);
  const theirs = identifiersOf(b);
  if (!mine.length || !theirs.length) return false;
  const kinds = new Set(mine.map((i) => kindKey(i.kind)));
  if (!theirs.some((i) => kinds.has(kindKey(i.kind)))) return false;
  return !sharesIdentifier(mine, theirs);
}

/** An identifier as its owner is handed it back: the two fields they sent. */
export const ownIdentifiers = (stored: unknown): { kind: string; value: string }[] =>
  identifiersOf(stored).map(({ kind, value }) => ({ kind, value }));

// ---------------------------------------------------------------------------
// THE KINDS IN USE ON A SHELF.
//
// With no approved list, two assistants describing the same product can reach
// for different identifiers, and then nothing is shared. So the answer to a
// publish or an amend may name the kinds most used on that shelf, and the
// assistants converge by themselves. A kind is named only where at least
// IDENTIFIER_KIND_MIN_ACCOUNTS different accounts use it, so no answer ever
// reveals one person's choice; own postings are not counted; and at most
// IDENTIFIER_KINDS_SHOWN are named. The counting is in cards.ts
// (identifierKindsOnShelf); the sentence is in lanes.ts (ASKS.identifier_kinds).
// ---------------------------------------------------------------------------

export const IDENTIFIER_KIND_MIN_ACCOUNTS = 3;
export const IDENTIFIER_KINDS_SHOWN = 3;

/** The form kinds are counted in, so "ISBN" and "isbn " are one kind. */
export const kindKey = (kind: string): string => kind.trim().toLowerCase().replace(/\s+/g, ' ');

/** The kinds as a sentence says them: each in quotes, as other people's words. */
export function kindsInWords(kinds: string[]): string {
  const quoted = kinds.slice(0, IDENTIFIER_KINDS_SHOWN).map((k) => `"${k}"`);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
    : (quoted[0] ?? '');
}

// ---------------------------------------------------------------------------
// ONE OBJECT'S NUMBER AS A DETAIL.
//
// The rule above guards identifiers, and a number that belongs to one object
// got onto a posting by the other door: as a detail (`psa_cert: "104882913"`,
// rehearsal of 24 October 2026). Details cross to the other side at the
// details step, so the same rule holds there. A detail is refused when its
// KEY names one object by the same words and its VALUE reads as a code: at
// least five digits, or six or more letters and digits with a digit among
// them. So `registration_year: 2019` and `serial_number: "unknown"` stand.
// ---------------------------------------------------------------------------

const CODE_LIKE = (v: string): boolean => {
  const compact = v.replace(/[\s\-/.]/g, '');
  const digits = (compact.match(/\d/g) ?? []).length;
  return digits >= 5 || (compact.length >= 6 && digits >= 1 && /^[\p{L}\p{N}]+$/u.test(compact));
};

/** The first detail that carries one object's own number, by its key, or undefined. */
export function oneObjectDetail(attributes: unknown): string | undefined {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  for (const [k, v] of Object.entries(attributes as Record<string, unknown>)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (namesOneObject(k.replace(/_/g, ' ')) && CODE_LIKE(String(v))) return k;
  }
  return undefined;
}

/** What the assistant reads about such a detail. */
export function oneObjectDetailSentence(key: string): string {
  return `The \`${key}\` detail is a number that belongs to one object, so it stays off the posting. Where it matters to a deal, ask for it as a written line with respond(ask_confirmation), and the seller's human confirms it.`;
}

/** Throws the refusal where a detail carries one object's own number; otherwise does nothing. */
export function assertNoOneObjectDetail(attributes: unknown): void {
  const key = oneObjectDetail(attributes);
  if (key !== undefined) {
    throw Object.assign(new Error(oneObjectDetailSentence(key)), { validation: [`attributes.${key}`] });
  }
}
