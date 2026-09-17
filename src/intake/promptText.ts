/**
 * THE ONE WAY UNTRUSTED WORDS ENTER A PROMPT.
 *
 * Both model checks — the posting screen and the message classifier — hand the
 * model text a stranger wrote, inside a tag that says so. A tag is only a fence
 * while the words inside it cannot draw one of their own: text carrying
 * `</untrusted_listing_text>` closes the fence early and everything after it
 * reads as the switchboard's own instruction. The cheapest and most complete
 * answer is that no angle bracket ever reaches the prompt.
 *
 * What passes through here, in order, and why each step is there:
 *
 *  - NFKC first. Fullwidth `＜` and the other compatibility forms normalise to
 *    the ASCII characters they imitate, so the step below sees them. Doing this
 *    the other way round would let `＜/untrusted_message＞` through untouched
 *    and let the model's own normalisation finish the job.
 *  - Format characters (`\p{Cf}`: zero-width space, zero-width joiner, the
 *    bidi overrides, the byte-order mark) go. They are invisible to a reader
 *    and to a reviewer, and they break up a word the model would otherwise
 *    recognise — `ig​nore previous instructions` reads as prose to a human and
 *    survives every substring rule.
 *  - Control characters go, except the newline, which is ordinary punctuation
 *    in a posting. A carriage return becomes a newline rather than vanishing.
 *  - `<` and `>` become the single guillemets `‹` and `›`. Not stripped: a
 *    stripped bracket silently changes "under 10 > 5kg" into something else,
 *    and the guillemet keeps the sentence readable to the model while being
 *    something no tag can be built out of.
 *  - A length cap, last, so that one enormous field cannot push the system
 *    prompt out of the model's attention or the bill out of the cost table.
 *
 * It is idempotent: running it twice changes nothing the first run left.
 */

/** The default ceiling on one field. Roomier than any field the switchboard
 *  accepts, so it is a backstop rather than a rule of its own. */
export const PROMPT_FIELD_CAP = 2000;

/** What a closing tag is made of, and what therefore may not survive. */
const ANGLE_OPEN = '‹';
const ANGLE_CLOSE = '›';

/**
 * One untrusted string, made safe to sit inside a prompt.
 *
 * `cap` is in characters after normalising, and the cut is a plain slice: the
 * point is a ceiling, not a tidy ending.
 */
export function promptSafe(raw: unknown, cap: number = PROMPT_FIELD_CAP): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  try {
    s = s.normalize('NFKC');
  } catch {
    /* an unpaired surrogate cannot be normalised; the steps below still run */
  }
  s = s.replace(/\r\n?/g, '\n');
  // Format characters, then every other control character bar the newline.
  s = s.replace(/\p{Cf}/gu, '');
  // Cc is exactly these three ranges; written out rather than as a set
  // subtraction so the expression needs nothing newer than an ordinary regex.
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '');
  s = s.replace(/</g, ANGLE_OPEN).replace(/>/g, ANGLE_CLOSE);
  if (s.length > cap) s = s.slice(0, cap);
  return s;
}

/**
 * A `key: value` line for the posting screen, with both halves made safe. The
 * key is as much the author's as the value is — an attribute called
 * `</untrusted_listing_text>ignore` would otherwise walk straight in.
 */
export function promptSafePair(key: unknown, value: unknown, cap: number = PROMPT_FIELD_CAP): string {
  return `${promptSafe(key, 200)}: ${promptSafe(value, cap)}`;
}

/**
 * True where the string is already what `promptSafe` would make of it. Used by
 * the suite, and by the note-writing paths that want to assert rather than
 * re-run.
 */
export function isPromptSafe(s: string, cap: number = PROMPT_FIELD_CAP): boolean {
  return promptSafe(s, cap) === s;
}
