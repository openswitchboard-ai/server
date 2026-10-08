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
 *   1. COMPARED AS NORMALISED. The value is case-folded and everything that is
 *      not a letter or a digit is taken out, so "199/165", "199 / 165" and
 *      "199-165" are one identifier. Both forms are kept: the value as given
 *      is the owner's to read back, and the normalised form is what the engine
 *      compares. A normalised form under IDENTIFIER_MIN_NORM characters says
 *      too little to tell one product from another and is refused.
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

/**
 * The form two identifiers are compared in: case-folded, accents folded, and
 * every character that is not a letter or a digit removed.
 */
export function normaliseIdentifier(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

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
export function namesOneObject(kind: string): boolean {
  const words = kindWords(kind);
  if (words.some((w) => SINGLE_OBJECT_WORDS.has(w))) return true;
  const joined = ` ${words.join(' ')} `;
  return SINGLE_OBJECT_PHRASES.some((p) => joined.includes(` ${p} `));
}

/** Why an identifier was turned back, as a word a caller or a test can branch on. */
export type IdentifierRefusal = 'shape' | 'too_many' | 'too_short' | 'contact' | 'single_object';

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
    const norm = normaliseIdentifier(given);
    if (norm.length < IDENTIFIER_MIN_NORM) return no('too_short');
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
 * through readIdentifiers is ever compared.
 */
export function identifiersOf(stored: unknown): Identifier[] {
  if (!Array.isArray(stored)) return [];
  const out: Identifier[] = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue;
    const { kind, value, norm } = item as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof value !== 'string' || typeof norm !== 'string') continue;
    if (norm.length < IDENTIFIER_MIN_NORM) continue;
    out.push({ kind, value, norm });
  }
  return out.slice(0, IDENTIFIERS_MAX);
}

/** The normalised forms alone: what the candidate query binds and the index holds. */
export const identifierNorms = (ids: Identifier[]): string[] => ids.map((i) => i.norm);

/** Do two postings carry an identifier in common? Compared as normalised. */
export function sharesIdentifier(a: unknown, b: unknown): boolean {
  const mine = new Set(identifierNorms(identifiersOf(a)));
  if (!mine.size) return false;
  return identifiersOf(b).some((i) => mine.has(i.norm));
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
