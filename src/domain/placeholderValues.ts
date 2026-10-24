/**
 * A MASK OR A PLACEHOLDER WHERE A VALUE SHOULD BE (October 2026).
 *
 * In a rehearsal an assistant's client masked a detail before it reached the
 * switchboard, and the posting went up carrying `"***"` as that detail. A mask
 * says nothing about the thing, it reads to the other side as though something
 * were being hidden from them, and it is a sign the real value was something
 * that should never have been on a posting at all.
 *
 * So a value that is only a mask or a placeholder is refused wherever a
 * posting's words are read: a single posting's details, an amend, a list
 * item's details, an identifier, and the other words refine_intent takes. The
 * one move that fixes it is always the same: give the value the human said,
 * or leave that one off.
 *
 * THE RULE, and why each part is as narrow as it is. A value is a placeholder
 * when it is:
 *
 *   1. ONLY MASK MARKS: nothing but characters people type to blank something
 *      out or to say "unknown" — * • · ● ○ █ ■ # ? _ - – — . … ~ and quotes —
 *      with any spacing. None of these says anything about a thing on its own.
 *
 *   2. A RUN OF X USED AS A MASK: only the letter x (any case) with optional
 *      separators, where there are at least four x and either two or more
 *      groups ("xxxx-xxxx", "XXX XXX") or six or more in one run ("xxxxxx").
 *      Shorter runs are real values: X, XX and XXX are sizes and Roman
 *      numerals, and XXXX is a brand name. Anything with another letter in it
 *      (XL, XXL) or a digit (4x4, ****1234) is never caught by this part.
 *
 *   3. A BRACKETED PLACEHOLDER: the whole value wrapped in [ ], < > or { },
 *      where the words inside include one of the few words people use to
 *      stand in for a value ("redacted", "hidden", "masked", "removed",
 *      "withheld", "private", "omitted", "placeholder", "value", "number"...).
 *      "[redacted]", "<hidden>" and "{{number}}" are caught; "[EN]" is not,
 *      because its word is about the thing. Round brackets are how people
 *      write real asides ("(boxed)", "(private sale)"), so a value in round
 *      brackets is caught only where nothing but mask marks is inside.
 *
 *   4. A BARE REDACTION WORD: the whole value, once marks are taken off, is
 *      "redacted", "withheld" or "placeholder". Those three words say nothing
 *      else when they stand alone. "hidden", "removed", "private", "censored"
 *      and the like are left alone bare, because each is an honest value for
 *      some detail ("closure: hidden", "battery: removed", "seller: private").
 *
 * WHAT IS NEVER REFUSED. "N/A", "none", "unknown" and "TBC" are answers a
 * human gives: not applicable, there is none, they do not know. Each says
 * something true and none stands in for a value that exists, so they go up as
 * written. Numbers and true/false are never placeholders.
 *
 * Nothing here is about any sort of goods. Pure: no I/O.
 */

/** Characters that blank a value out or say "unknown", and nothing else. */
const MASK_ONLY = /^[\s*•·●○◦∙⋅█▓▒░■□▪▫#?_\-‐‑–—.…~'"`´‘’“”]+$/u;

/** Separators a run of x is split by when it masks a number. */
const X_SEPARATORS = /[\s\-‐‑–—_./*•·]+/u;

/** Words that, inside brackets around the whole value, stand in for one. */
const BRACKET_WORDS = new Set([
  'redacted',
  'hidden',
  'masked',
  'removed',
  'withheld',
  'private',
  'omitted',
  'censored',
  'confidential',
  'placeholder',
  'blank',
  'value',
  'number',
  'insert',
  'here',
]);

/** Words that are a placeholder when they are the whole value. */
const BARE_WORDS = new Set(['redacted', 'withheld', 'placeholder']);

/** Brackets around a whole value, and whether words inside them can make it a placeholder. */
const BRACKETS: { open: string; close: string; words: boolean }[] = [
  { open: '[', close: ']', words: true },
  { open: '<', close: '>', words: true },
  { open: '{', close: '}', words: true },
  { open: '(', close: ')', words: false },
];

const wordsOf = (s: string): string[] =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Is this value only a mask or a placeholder? Strings only; anything else is not. */
export function isPlaceholderValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  // 1. Only mask marks.
  if (MASK_ONLY.test(v)) return true;
  // 2. A run of x used as a mask.
  if (/^[xX\s\-‐‑–—_./*•·]+$/u.test(v)) {
    const groups = v.split(X_SEPARATORS).filter(Boolean);
    const xs = groups.join('').length;
    if (xs >= 4 && (groups.length >= 2 || xs >= 6)) return true;
  }
  // 3. A bracketed placeholder.
  for (const { open, close, words } of BRACKETS) {
    if (v.length >= 2 && v.startsWith(open) && v.endsWith(close)) {
      const inner = v.replace(/^[[<{(]+/, '').replace(/[\]>})]+$/, '');
      if (!inner.trim() || MASK_ONLY.test(inner)) return true;
      if (words && wordsOf(inner).some((w) => BRACKET_WORDS.has(w))) return true;
    }
  }
  // 4. A bare redaction word.
  const words = wordsOf(v);
  if (words.length === 1 && BARE_WORDS.has(words[0])) return true;
  return false;
}

/**
 * The first detail on a posting whose value is a placeholder, by its key, or
 * undefined where there is none. Reads a plain object of details and nothing
 * else; an array or a nested object is the schema's business, not this one's.
 */
export function placeholderDetail(attributes: unknown): string | undefined {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  for (const [k, v] of Object.entries(attributes as Record<string, unknown>)) {
    if (isPlaceholderValue(v)) return k;
  }
  return undefined;
}

/** What the assistant reads about a detail that is a placeholder, on a posting or an amend. */
export function placeholderDetailSentence(key: string): string {
  return `The \`${key}\` detail holds a mask or a placeholder where its value would be. Give the value your human said, or leave that detail off.`;
}

/**
 * The refusal as the posting doors throw it: a plain sentence and the field to
 * fix, the shape every other refusal of a posting's words has.
 */
export function placeholderDetailError(key: string): Error {
  return Object.assign(new Error(placeholderDetailSentence(key)), {
    validation: [`attributes.${key}`],
  });
}

/** Throws the refusal where a detail is a placeholder; otherwise does nothing. */
export function assertNoPlaceholderDetail(attributes: unknown): void {
  const key = placeholderDetail(attributes);
  if (key !== undefined) throw placeholderDetailError(key);
}
