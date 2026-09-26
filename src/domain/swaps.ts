import { onLostPetShelf } from './shelfRules.js';

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
 *   - Both postings are wants, and both are on the same top level: social,
 *     or (since later the same day) services. A want there still finds haves
 *     exactly as before; it finds other wants on its own top level as well.
 *     A want on goods is untouched: opposite types only, as ever. On services
 *     at least one of the two must say what it offers in return, and on either
 *     top level what is said must fit (THE COMPLEMENT RULE, below).
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

/**
 * The top levels on which two wants may meet. Social since the first day of
 * swaps; services since the general rule below (26 September 2026), where a
 * swap is two people each offering the other a hand: guitar lessons for help
 * with a bike, a lift for a tidy-up. Goods stays opposite types only: two
 * people after the same thing are competing for it.
 */
export const SWAP_TOP_LEVELS = ['social', 'services'] as const;
export type SwapTopLevel = (typeof SWAP_TOP_LEVELS)[number];

/**
 * The top level a category sits on, where it is one on which two wants may
 * meet. Always one of OUR constants, never a slice of the caller's string, so
 * the matcher may write it into SQL.
 */
export function swapTopLevel(category: string | null | undefined): SwapTopLevel | undefined {
  if (!category) return undefined;
  return SWAP_TOP_LEVELS.find((t) => category === t || category.startsWith(`${t}.`));
}

/**
 * Is this a shelf on which two wants may be introduced to each other? Every
 * shelf on social and services but one: lost and found pets
 * (domain/shelfRules.ts), where two people who have each lost a dog are two
 * owners, and the only pair worth making is an owner and a finder.
 */
export function swapsOnShelf(category: string | null | undefined): boolean {
  return !!swapTopLevel(category) && !onLostPetShelf(category);
}

/**
 * Is the pair of these two postings a swap, by its shape? Both wants, both on
 * a swap shelf, and both on the SAME top level: a social want and a services
 * want are two different kinds of errand. Whether the two actually complement
 * each other is the next question (swapComplement below).
 */
export function isSwapPair(
  a: { type: string; category: string },
  b: { type: string; category: string },
): boolean {
  return (
    a.type === 'WANT' &&
    b.type === 'WANT' &&
    swapsOnShelf(a.category) &&
    swapsOnShelf(b.category) &&
    swapTopLevel(a.category) === swapTopLevel(b.category)
  );
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
// THE COMPLEMENT RULE, one rule for every swap (Lachlan, 26 September 2026).
//
// The first version of this rule was about languages only: it parsed language
// names out of the postings and asked whether each person spoke what the
// other was learning. It worked for the pair it was written for and for
// nothing else, and it carried a list of fifty language names that could only
// ever be incomplete. The same question is true of every swap: does each
// person have what the other is after? So it is asked once, in general, over
// words:
//
//     what A offers  meets  what B wants, and
//     what B offers  meets  what A wants,
//
// each half enforced only where it can be answered. "Meets" is a shared word
// after a small normaliser (case, punctuation, a plural s) and a short list of
// words that say nothing about the thing ("partner", "lessons", "practice").
//
//   WHAT A POSTING OFFERS is read from the keys people use for it (OFFERED_KEYS:
//   `offers`, `in_exchange`, `speaks`, `teaches` and their kin), and from the
//   poster's own first-person words in `kind` ("I speak Spanish", "I can teach
//   guitar", "offering a lift"). The manual now asks for it in `offers`.
//   WHAT A POSTING WANTS is its own words for the thing (`kind`, less anything
//   it said it offers), the words of its shelf ("guitar" in a guitar lessons
//   shelf), and the keys people use for it (WANTED_KEYS: `language`, `wants`,
//   `learning` and their kin). Every posting wants something, so this side can
//   always be read.
//
// SILENCE NEVER BLOCKS, A STATED MISMATCH DOES. A posting that says nothing
// about what it offers leaves its half to the embedding and the tiers. Two
// learners of Spanish who both say they speak English are blocked, because
// what each offers is nowhere in what the other wants.
//
// ON SERVICES, SOMEBODY HAS TO OFFER SOMETHING. Two people who both want a
// plumber are not a swap; they are two customers. So on services a pair of
// wants is only a swap where at least one of them states an offer. Social
// keeps its first behaviour: two people who both want a tennis partner are
// each other's answer with nothing said about offers at all.
//
// THE LIMITS, honestly. Word overlap is not meaning: "guitar lessons" offered
// meets a want for "guitar repairs" on the word guitar, and the embedding and
// the tiers are what weigh that pair after this rule has let it through.
// First-person offers in `kind` are read in English phrasing only. The
// direction-ambiguous phrases "in exchange for" and "swap for" are NOT read
// from `kind`, because people write them both ways round; the `in_exchange`
// key is read, because a key has only one reading.
// ---------------------------------------------------------------------------

/** Keys that say what a posting wants. Generic: nothing here names a language. */
const WANTED_KEYS = new Set([
  'language',
  'learning',
  'learning_language',
  'target_language',
  'wants',
  'want',
  'wanted',
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
  'needs',
  'need',
]);

/** Keys that say what a posting offers in return. */
export const OFFERED_KEYS: readonly string[] = [
  'offers',
  'offer',
  'offering',
  'offered',
  'in_exchange',
  'in_exchange_for',
  'in_return',
  'can_offer',
  'speaks',
  'speak',
  'native_language',
  'mother_tongue',
  'first_language',
  'offered_language',
  'language_offered',
  'teaches',
  'teaching',
  'can_teach',
  'fluent',
  'fluent_in',
  'skills',
  'can_help_with',
];
const OFFERED = new Set(OFFERED_KEYS);

/**
 * Words that say nothing about WHICH thing: the grammar, and the vocabulary of
 * swapping itself. Without this, "guitar lessons" offered would meet "piano
 * lessons" wanted on the word lessons.
 */
const EMPTY_WORDS = new Set(
  (
    'a an the and or of for to in on at with by from my me i im our your some any ' +
    'someone somebody person people partner partners buddy mate friend group ' +
    'practice practise practising practicing conversation exchange swap swapping trade ' +
    'lesson lessons class classes session sessions help helping hand ' +
    'want wanted wants wanting looking need needed seeking after learn learning ' +
    'teach teaching offer offers offering return native fluent speaker speak speaks ' +
    'social services general other thing things stuff'
  )
    .split(' ')
    .filter(Boolean),
);

/** One word, normalised: lower case, letters and digits only, one plural off. */
function normWord(w: string): string {
  let x = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return x;
}

/** The words in a piece of text that could say which thing, normalised. */
export function swapWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;:.!?()/&+\-_]+/u)) {
    if (!raw || EMPTY_WORDS.has(raw.toLowerCase().replace(/[\u2019']/g, ''))) continue;
    const w = normWord(raw);
    if (w && !EMPTY_WORDS.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** An attribute value as text: a string, or the strings in a list. */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' ');
  return '';
}

/**
 * The first-person phrasing that marks what the poster OFFERS in their own
 * words, up to the next comma or full stop, or the word that turns back to
 * what they want ("and", "wanting", "looking for"). Generic English phrasing,
 * and nothing about any one kind of swap.
 */
const I_AM = "i(?:'|\u2019)?m|i\\s+am";
const OFFER_IN_KIND = new RegExp(
  `\\b(?:i\\s+speak|(?:${I_AM})\\s+(?:a\\s+)?native(?:\\s+speaker)?(?:\\s+of)?|(?:${I_AM})\\s+fluent\\s+in|my\\s+(?:native|first|home)\\s+language\\s+is|my\\s+mother\\s+tongue\\s+is|i\\s+(?:can\\s+)?teach|i\\s+(?:can\\s+)?offer|i\\s+can\\s+help\\s+with|(?:${I_AM})\\s+offering|offering)\\s+([^,;.()]+?)(?=\\s+(?:and|but|wanting|want|wants|looking|seeking|who|for|in\\s+exchange|in\\s+return)\\b|[,;.()]|$)`,
  'giu',
);

export interface SwapSides {
  /** What the posting says it offers, or undefined where it says nothing. */
  offers?: string[];
  /** What the posting wants: its words, its shelf's words, its wanted keys. */
  wants: string[];
}

/** What one posting offers and what it wants, as words. Pure. */
export function swapSidesOf(p: {
  category?: string | null;
  kind?: string | null;
  attributes?: Record<string, unknown> | null;
}): SwapSides {
  const offers = new Set<string>();
  const wants = new Set<string>();
  for (const [rawKey, value] of Object.entries(p.attributes ?? {})) {
    const key = rawKey.toLowerCase();
    if (OFFERED.has(key)) for (const w of swapWords(valueText(value))) offers.add(w);
    else if (WANTED_KEYS.has(key)) for (const w of swapWords(valueText(value))) wants.add(w);
  }
  let kind = typeof p.kind === 'string' ? p.kind : '';
  for (const m of kind.matchAll(OFFER_IN_KIND)) {
    for (const w of swapWords(m[1])) offers.add(w);
  }
  // What they said they offer is not what they want: the rest of kind is.
  kind = kind.replace(OFFER_IN_KIND, ' ');
  for (const w of swapWords(kind)) wants.add(w);
  // The shelf's own words, below the top level: "guitar" in a guitar lessons
  // shelf, "tennis" in the tennis partners one.
  const path = String(p.category ?? '').split('.').slice(1).join(' ');
  for (const w of swapWords(path)) wants.add(w);
  // Nobody wants what they already offer.
  for (const w of offers) wants.delete(w);
  return { ...(offers.size ? { offers: [...offers] } : {}), wants: [...wants] };
}

export interface ComplementVerdict {
  /** False where the postings SAY the pair is not complementary, or where a
   *  services pair has no offer on either side. */
  ok: boolean;
  /** Whether either half of the question could be answered at all. */
  determined: boolean;
}

/**
 * THE COMPLEMENT RULE: does each posting have what the other is after, as far
 * as the two postings say? See the note above for what it reads and where it
 * stops. Symmetric. Only ever asked of a pair isSwapPair has already allowed.
 */
export function swapComplement(
  a: { category?: string | null; kind?: string | null; attributes?: Record<string, unknown> | null },
  b: { category?: string | null; kind?: string | null; attributes?: Record<string, unknown> | null },
): ComplementVerdict {
  const sa = swapSidesOf(a);
  const sb = swapSidesOf(b);
  if (swapTopLevel(a.category) === 'services' && !sa.offers && !sb.offers) {
    return { ok: false, determined: false };
  }
  const meets = (offers: string[] | undefined, wants: string[]): boolean | undefined =>
    offers ? offers.some((w) => wants.includes(w)) : undefined;
  const aGivesB = meets(sa.offers, sb.wants);
  const bGivesA = meets(sb.offers, sa.wants);
  return {
    ok: aGivesB !== false && bGivesA !== false,
    determined: aGivesB !== undefined || bGivesA !== undefined,
  };
}

/**
 * Does this want state an offer at all? The matcher's retrieval reads it: on
 * services, a want that offers nothing only needs other wants that do.
 */
export function statesAnOffer(p: {
  kind?: string | null;
  attributes?: Record<string, unknown> | null;
}): boolean {
  return !!swapSidesOf({ kind: p.kind, attributes: p.attributes }).offers;
}
