/**
 * SWAPS: TWO PEOPLE WHO ARE BOTH LOOKING (Lachlan, 26 September 2026).
 *
 * The first production test, on 25 September 2026, put up a language exchange
 * that could never meet. One person posted a want for a Spanish conversation
 * partner, and they speak English. Another posted a want for an English
 * practice partner, and they speak Spanish. Each is exactly the other's other
 * half, and the matcher never looked at the pair, because retrieval only ever
 * asked for the opposite type: a want found haves and a have found wants, and
 * two wants were invisible to each other by construction.
 *
 * Nothing about that is peculiar to languages. A tennis partner, a bouldering
 * partner, a walking group, somebody to talk philosophy with: on the social
 * shelves both people are usually LOOKING, and asking one of them to post a
 * have ("I have myself, available for tennis") is asking a person to describe
 * themselves as stock. So on social.* two wants may now be introduced to each
 * other, and that pairing is called a SWAP everywhere it is handled.
 *
 * WHAT IS AND IS NOT A SWAP.
 *   - Both postings are wants, and both are on the social top level. A want on
 *     social still finds haves exactly as before; it finds other wants on
 *     social as well. A want on goods or services is untouched: opposite types
 *     only, as ever.
 *   - HAVE WITH HAVE STAYS OFF, on social too. A have on social already finds
 *     every want on its shelf, and two people who have each put themselves up
 *     ("I run a book club", "I host a jam session") are two offers, not
 *     somebody looking; nobody in them asked to be found by the other. Kept
 *     minimal on purpose, and easy to open later if a real run shows it is
 *     wanted.
 *
 * ONE ROW PER PAIR, WHICHEVER SIDE ARRIVED FIRST. A matches row has a
 * card_want and a card_have column and a unique key over the two. For a swap
 * both postings are wants, so A finding B and B finding A would be two
 * different keys for one introduction, and the two people would each hear
 * about each other twice. So the pair is written in one canonical order —
 * the smaller posting id in card_want, the larger in card_have (swapPairOrder
 * below) — and the unique key does the dedupe it has always done, including
 * for two publishes racing each other. The columns are only slots on a swap:
 * the posting in card_have is still a want, and nothing that decides WORDING
 * may read a side from the column (matches.ts, readerSide).
 *
 * NO MONEY. A swap is two people giving each other the same kind of thing.
 * Nobody is buying and nobody is selling, so no band is decrypted for it, no
 * figure can be put on the table, and no protected payment can be opened on
 * it. Each of those doors refuses a swap in words rather than asking for a
 * number (matches.ts, SWAP_NO_FIGURE_SENTENCE).
 */

/** The only top level on which two wants may meet. */
export const SWAP_TOP_LEVEL = 'social';

/** Is this a shelf on which two wants may be introduced to each other? */
export function swapsOnShelf(category: string | null | undefined): boolean {
  if (!category) return false;
  return category === SWAP_TOP_LEVEL || category.startsWith(`${SWAP_TOP_LEVEL}.`);
}

/** Is the pair of these two postings a swap? Both wants, both on social. */
export function isSwapPair(
  a: { type: string; category: string },
  b: { type: string; category: string },
): boolean {
  return a.type === 'WANT' && b.type === 'WANT' && swapsOnShelf(a.category) && swapsOnShelf(b.category);
}

/**
 * The canonical order a swap is written in: the smaller id first. Both callers
 * of a pair (A's publish and B's) must arrive at the same order or the unique
 * key cannot dedupe them, so this is the one place the order is decided.
 * Plain string order over the canonical lower-case uuid text: it only has to
 * be the same every time, not the same as Postgres's uuid ordering.
 */
export function swapPairOrder<T extends { id: string }>(a: T, b: T): [T, T] {
  return String(a.id).toLowerCase() <= String(b.id).toLowerCase() ? [a, b] : [b, a];
}

/**
 * The shelf a swap is filed under. The matches row carries one category, and
 * on a swap there is no "want's side" to take it from: both are wants, and
 * the row is read by both people. Equal shelves are the easy case. Two
 * different shelves are named by the deepest node they share, as long as that
 * is below the top level ("social.language-exchange" for a tandem and a
 * conversation practice); where they share only "social" — a pair the search
 * across shelves brought together — the first posting's shelf stands, which
 * is what the row always held.
 */
export function swapCategory(a: string, b: string): string {
  if (a === b) return a;
  const pa = a.split('.');
  const pb = b.split('.');
  const shared: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) shared.push(pa[i]);
  return shared.length >= 2 ? shared.join('.') : a;
}

/**
 * The poster's own word for the thing, on a swap. The row's `kind` is said to
 * BOTH people ("the tennis partner you are after"), and on a swap each posting
 * has its own: "Spanish conversation partner" on one side and "English
 * practice partner" on the other. Saying either person's words to the other
 * would name the wrong thing to one of them, so the row keeps a kind only
 * where the two agree, and otherwise keeps none and every sentence falls back
 * to the shelf's own phrase. The emails already name the thing from the
 * reader's OWN posting (matches.ts, readersOwnThingLabel), so they lose
 * nothing by it.
 */
export function swapKind(a: string | null | undefined, b: string | null | undefined): string | null {
  const norm = (s: string | null | undefined) =>
    typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const na = norm(a);
  return na && na === norm(b) ? (a as string).trim() : null;
}

// ---------------------------------------------------------------------------
// THE COMPLEMENT RULE, for a language exchange.
//
// A swap on a language exchange is only a swap when each person has what the
// other is after. Two people who both want Spanish and both speak English are
// two learners of the same language, and introducing them as a swap would
// waste an introduction on each — and on 25 September that is exactly the
// pair the embedding would have liked best, because their two postings read
// almost the same. So where BOTH halves of the question can be answered from
// what the postings say, the pair has to be complementary:
//
//     what A is after  ∩  what B speaks   is not empty, and
//     what B is after  ∩  what A speaks   is not empty,
//
// and each half is only enforced where it can be determined. Where a posting
// does not say what it speaks, or what it is after, that half is left to the
// embedding and the tiers, exactly as any other pair is. The rule never
// blocks on silence; it blocks on a posting that says the other half is not
// there.
//
// WHERE THE LANGUAGES COME FROM, and why it is two places. The taxonomy gives
// a language exchange one `language` attribute and a `proficiency`, which is
// enough to say the language somebody is practising and not enough to say the
// one they bring. Assistants fill the gap in whatever key comes to hand —
// `speaks`, `native_language`, `offers`, `wants`, `learning` all turn up in
// the calibration set — and very often only in `kind`, the poster's own plain
// words: "English practice partner, I speak Spanish". So both are read:
//
//   ATTRIBUTES. A known set of keys for "after" and for "brings". `language`
//   is read as the language they are after, unless `proficiency` says
//   `native`, in which case it is one they bring.
//   KIND. Language names found in the words, and a language right after a
//   first-person marker like "I speak", "I'm a native", "my first language
//   is", or after "in exchange for", is one they bring. Any other language
//   named is one they are after — but only where that reading is not a guess: a kind that names
//   two languages and marks neither ("Spanish/English exchange") says nothing
//   about which way round it goes, and is left undetermined.
//
// THE LIMITS, honestly. The name list is short and English-only (plus a few
// endonyms): a language it does not know is read from an attribute value as
// the value itself, and not read from `kind` at all. The markers are English
// phrasing; a kind written in another language reads as undetermined. Two
// learners of the same language who genuinely want to practise TOGETHER can
// still meet, as long as neither says what they speak — and are blocked if
// both do, which is the case this rule exists for. And it only runs on a
// swap: a have offering a language is read by the embedding and the tiers as
// before, because that pair was never the defect.
// ---------------------------------------------------------------------------

/** Is this pair on a language exchange shelf (either posting)? */
export function onLanguageExchange(a: string, b: string): boolean {
  const le = (c: string) => c === 'social.language-exchange' || c.startsWith('social.language-exchange.');
  return le(a) || le(b);
}

/** Language names and the few other words people use for them, to one word each. */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'english',
  spanish: 'spanish',
  espanol: 'spanish',
  español: 'spanish',
  castellano: 'spanish',
  french: 'french',
  francais: 'french',
  français: 'french',
  german: 'german',
  deutsch: 'german',
  italian: 'italian',
  italiano: 'italian',
  portuguese: 'portuguese',
  dutch: 'dutch',
  russian: 'russian',
  ukrainian: 'ukrainian',
  polish: 'polish',
  czech: 'czech',
  greek: 'greek',
  turkish: 'turkish',
  arabic: 'arabic',
  hebrew: 'hebrew',
  persian: 'persian',
  farsi: 'persian',
  hindi: 'hindi',
  urdu: 'urdu',
  bengali: 'bengali',
  punjabi: 'punjabi',
  tamil: 'tamil',
  chinese: 'chinese',
  mandarin: 'chinese',
  cantonese: 'cantonese',
  japanese: 'japanese',
  korean: 'korean',
  vietnamese: 'vietnamese',
  thai: 'thai',
  indonesian: 'indonesian',
  malay: 'malay',
  tagalog: 'tagalog',
  filipino: 'tagalog',
  swedish: 'swedish',
  norwegian: 'norwegian',
  danish: 'danish',
  finnish: 'finnish',
  hungarian: 'hungarian',
  romanian: 'romanian',
  croatian: 'croatian',
  serbian: 'serbian',
  swahili: 'swahili',
  auslan: 'auslan',
  latin: 'latin',
};

const WANTED_KEYS = new Set([
  'language',
  'learning',
  'learning_language',
  'target_language',
  'wants',
  'want',
  'wanted_language',
  'want_language',
  'language_wanted',
  'practise',
  'practice',
  'practising',
  'practicing',
  'practice_language',
  'seeking',
  'looking_for',
]);

const OFFERED_KEYS = new Set([
  'speaks',
  'speak',
  'native_language',
  'native',
  'mother_tongue',
  'first_language',
  'offers',
  'offer',
  'offering',
  'offered_language',
  'language_offered',
  'teaches',
  'teaching',
  'can_teach',
  'fluent',
  'fluent_in',
  'in_exchange',
  'in_exchange_for',
]);

const NAME_ALTERNATION = Object.keys(LANGUAGE_NAMES)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The phrasing that marks a language as one the poster BRINGS: first person
 * only ("I speak", "I'm a native", "my first language is", "I can teach"), and
 * the swap phrasing ("in exchange for", "in return for", "swap for"). Third
 * person is deliberately not read: "a partner who speaks Spanish" and "a
 * native Spanish speaker" are what somebody is AFTER, and reading them as
 * what they bring would block the very pair they asked for.
 */
const I_AM = "i(?:'|\u2019)?m|i\\s+am";
const OFFER_BEFORE = new RegExp(
  `\\b(?:i\\s+speak|(?:${I_AM})\\s+(?:a\\s+)?native(?:\\s+speaker\\s+of)?|(?:${I_AM})\\s+fluent\\s+in|my\\s+(?:native|first|home)\\s+language\\s+is|my\\s+mother\\s+tongue\\s+is|i\\s+(?:can\\s+)?teach|i\\s+(?:can\\s+)?offer|(?:${I_AM})\\s+offering|in\\s+exchange\\s+for|in\\s+return\\s+for|swap\\s+for)\\s+(?:native\\s+|fluent\\s+)?(${NAME_ALTERNATION})\\b`,
  'giu',
);
const ANY_NAME = new RegExp(`\\b(${NAME_ALTERNATION})\\b`, 'giu');

/** The language names in a piece of text, as canonical words. */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(ANY_NAME)) {
    const n = LANGUAGE_NAMES[m[1]];
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** An attribute value as languages: the names in it, else the value itself. */
function languagesInValue(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const text = p.trim().toLowerCase();
    if (!text) continue;
    const found = namesIn(text);
    // A language the list does not know is still a language: the value itself,
    // when it is short enough to be a name rather than a sentence.
    const own = found.length ? found : text.split(/\s+/).length <= 2 ? [text] : [];
    for (const n of own) if (!out.includes(n)) out.push(n);
  }
  return out;
}

export interface LanguageSides {
  /** The languages this posting is after, or undefined where it cannot be told. */
  after?: string[];
  /** The languages this posting brings, or undefined where it cannot be told. */
  brings?: string[];
}

/** What one posting says it is after and what it brings. Pure. */
export function languageSidesOf(p: {
  kind?: string | null;
  attributes?: Record<string, unknown> | null;
}): LanguageSides {
  const after = new Set<string>();
  const brings = new Set<string>();
  const attrs = p.attributes ?? {};
  const native = String((attrs as any).proficiency ?? '').trim().toLowerCase() === 'native';
  for (const [rawKey, value] of Object.entries(attrs)) {
    const key = rawKey.toLowerCase();
    if (key === 'language' && native) {
      for (const n of languagesInValue(value)) brings.add(n);
    } else if (WANTED_KEYS.has(key)) {
      for (const n of languagesInValue(value)) after.add(n);
    } else if (OFFERED_KEYS.has(key)) {
      for (const n of languagesInValue(value)) brings.add(n);
    }
  }
  const kind = typeof p.kind === 'string' ? p.kind.toLowerCase() : '';
  if (kind) {
    const marked = new Set<string>();
    for (const m of kind.matchAll(OFFER_BEFORE)) {
      const n = LANGUAGE_NAMES[m[1]];
      if (n) marked.add(n);
    }
    for (const n of marked) brings.add(n);
    const named = namesIn(kind);
    const unmarked = named.filter((n) => !marked.has(n));
    // Only a reading that is not a guess: every unmarked name is "after" when
    // something was marked as brought, or when only one language is named.
    if (unmarked.length && (marked.size > 0 || named.length === 1)) {
      for (const n of unmarked) after.add(n);
    }
  }
  // A language somebody both brings and is after is one they bring: nobody is
  // after the language they already speak.
  for (const n of brings) after.delete(n);
  return {
    ...(after.size ? { after: [...after] } : {}),
    ...(brings.size ? { brings: [...brings] } : {}),
  };
}

export interface ComplementVerdict {
  /** False only where the postings SAY the pair is not complementary. */
  ok: boolean;
  /** Whether either half of the question could be answered at all. */
  determined: boolean;
}

/**
 * THE COMPLEMENT RULE: does each posting have what the other is after, as far
 * as the two postings say? See the note above for what it reads and where it
 * stops. Symmetric.
 */
export function languageComplement(
  a: { kind?: string | null; attributes?: Record<string, unknown> | null },
  b: { kind?: string | null; attributes?: Record<string, unknown> | null },
): ComplementVerdict {
  const sa = languageSidesOf(a);
  const sb = languageSidesOf(b);
  const meets = (after?: string[], brings?: string[]): boolean | undefined =>
    after && brings ? after.some((n) => brings.includes(n)) : undefined;
  const aFromB = meets(sa.after, sb.brings);
  const bFromA = meets(sb.after, sa.brings);
  return {
    ok: aFromB !== false && bFromA !== false,
    determined: aFromB !== undefined || bFromA !== undefined,
  };
}
