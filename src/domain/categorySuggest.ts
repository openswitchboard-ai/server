/**
 * "Did you mean" for categories.
 *
 * When a card names a category the taxonomy does not open, the refusal is a
 * taxonomy decision and nothing else decides it. Alongside the refusal the
 * switchboard names up to three of the closest OPEN nodes, so an agent can
 * correct itself on the next call.
 *
 * Two ways of measuring closeness, in this order:
 *
 *  1. Embeddings. Every open node is described in plain words once (nodeText),
 *     embedded with the same Titan model the matching engine uses, cached in
 *     this process, and the question — the posting's own words, or the path
 *     where that is all there is — is compared to them by cosine. The corpus
 *     is warmed in the background, so no request ever waits on it.
 *  2. Token and trigram overlap on the raw text. Always available, needs
 *     nothing outside the process.
 *
 * Suggestions are a courtesy. If Bedrock is down, if the corpus is still
 * warming, or if anything else goes wrong, the lexical answer stands in and
 * the card is refused exactly the same way. NO-FALLBACKS applies to screening
 * and consent decisions; this is neither.
 */
import { openCategories, reservedFamily, taxonomyNode } from '../denylist.js';
import { categoryLabelPath } from './matchRules.js';
import { embedText } from './embeddings.js';
import { shelfInWords } from './shelfPick.js';
import type { Config } from '../config.js';

/** How the switchboard arrived at a set of suggestions. */
export type SuggestionSource = 'embedding' | 'lexical';

export interface Suggestion {
  category: string;
  /** Raw closeness: cosine on the embedding side, token overlap on the other. */
  score: number;
  /**
   * HOW FAR IN FRONT OF THE FIELD, in standard deviations. Embedding side only.
   *
   * A raw cosine is not comparable between one query and the next, because it
   * moves with how long and how mixed the query text is. Measured on dev's own
   * corpus (19 September): 'goods.sim-racing.pedals' alone scores 0.52 against
   * its nearest node; the same path with the posting's words after it scores
   * 0.24 against the same node, with nothing about the answer changed. A fixed
   * cosine floor therefore measures the shape of the question, not the quality
   * of the answer — which is exactly how a 0.55 floor came to reject every
   * correct answer at the door (see categoryBackfill.SHELF_CONFIDENT_LEAD).
   *
   * The lead is scale-free: it asks how far the top answer stands out from the
   * other 498 nodes the same query was compared against. That number IS
   * comparable between queries, and it is what the door's confidence is on.
   */
  lead?: number;
}

export interface SuggestionResult {
  categories: string[];
  /** The same answers with their closeness scores, nearest first. */
  scored: Suggestion[];
  source: SuggestionSource;
}

/**
 * What the switchboard is willing to suggest: every open category except the
 * bare top levels. 'goods' and 'services' are open, but naming one back to an
 * agent tells it nothing it did not already know, and a sentence that ends
 * "Closest open ones: services.repairs, services.tech, services." reads like a
 * typo. Somewhere to actually post is the point.
 */
export function suggestableCategories(): string[] {
  return openCategories().filter((c) => c.includes('.'));
}

/**
 * THE TEXT EMBEDDED FOR A NODE: what the node is, in words a person would use.
 *
 * It used to be `category: goods.electronics.console.accessories (Secondhand
 * consumer goods > Electronics > Game consoles > Console accessories)` — a
 * database breadcrumb, most of whose characters are punctuation, the word
 * "category", and the same formal top-level name every node in the branch
 * carries. Two nodes framed that way are similar to each other mostly because
 * of the boilerplate, and a posting's own words are similar to none of them,
 * because a person describing a thing does not write a breadcrumb.
 *
 * Measured on dev's catalogue, 19 September, twelve realistic postings: with
 * the breadcrumb framing the right node was top of the list 9 times and in the
 * top four 9 times; with the words below, 10 and 11. The case the rehearsal was
 * about — a PlayStation controller posted as 'goods.gaming.accessories' — moves
 * from fifteenth to first.
 *
 * So: the node's own label and the phrase the catalogue already holds for it
 * ('console accessories', 'mountain bike'), then the branch it sits in. The
 * top level is dropped: "Secondhand consumer goods" is on all 400-odd of them
 * and says nothing about which one this is.
 */
export function nodeText(category: string): string {
  const node = taxonomyNode(category) as { label?: string; phrase?: string } | undefined;
  const labels = categoryLabelPath(category).split(' > ').slice(1);
  const leaf = labels[labels.length - 1] ?? category;
  const phrase = typeof node?.phrase === 'string' ? node.phrase.trim() : '';
  const head = phrase && phrase.toLowerCase() !== leaf.toLowerCase() ? `${leaf}, ${phrase}` : leaf;
  return labels.length ? `${head}. ${labels.join(', ')}.` : category;
}

/** A dotted path read as the words in it: 'goods.sim-racing.pedals' -> 'sim racing pedals'. */
export function pathWords(category: string): string {
  return String(category ?? '')
    .split('.')
    .slice(1)
    .join(' ')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/**
 * THE TEXT ASKED ABOUT, framed the same way the nodes are: plain words.
 *
 * The posting's own words first, because they are the evidence — then the
 * stated facts, as values rather than as `key: value` pairs, because the keys
 * are schema and the corpus has no schema in it — and the assistant's own path
 * last, named as a filing rather than as a fact, because it is a guess.
 *
 * Measured with the same twelve postings: keys and values in the old framing
 * put the right node first 9 times; this framing, 10, and it is the framing
 * that recovers the console accessories case.
 */
export function askText(
  category: string,
  posting?: { kind?: string | null; attributes?: unknown },
): string {
  const words = pathWords(category);
  if (!posting) return words || String(category ?? '');
  const values = Object.entries((posting.attributes ?? {}) as Record<string, unknown>)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => String(v).toLowerCase().slice(0, 60))
    .join(', ');
  const own = typeof posting.kind === 'string' ? posting.kind.trim().toLowerCase().slice(0, 60) : '';
  const parts = [own, values, words ? `filed as ${words}` : ''].filter(Boolean);
  return parts.length ? `${parts.join('. ')}.` : String(category ?? '');
}

// ---------------------------------------------------------------------------
// Lexical closeness: tokens first, trigrams to break ties.
// ---------------------------------------------------------------------------

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function trigrams(text: string): Set<string> {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Lexical similarity in [0,1]. A shared token counts for most of it — an agent
 * that wrote 'goods.laptop.macbook-air' should land on the laptop node because
 * both say "laptop" — and trigrams settle the rest.
 */
export function lexicalScore(query: string, candidate: string): number {
  const q = tokens(query);
  const c = tokens(candidate);
  const qSet = new Set(q);
  const cSet = new Set(c);
  let shared = 0;
  for (const t of qSet) if (cSet.has(t)) shared++;
  const tokenScore = qSet.size ? shared / qSet.size : 0;
  // The last segment of the query is what the agent was really naming.
  const leaf = query.split('.').pop() ?? '';
  const leafBonus = leaf && cSet.has(leaf.toLowerCase()) ? 0.15 : 0;
  return Math.min(1, 0.6 * tokenScore + 0.4 * jaccard(trigrams(query), trigrams(candidate)) + leafBonus);
}

export function lexicalSuggestions(category: string, limit = 3): Suggestion[] {
  const scored = suggestableCategories().map((c) => ({
    category: c,
    score: lexicalScore(category, `${c} ${categoryLabelPath(c)}`),
  }));
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Embedding closeness.
// ---------------------------------------------------------------------------

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Corpus {
  categories: string[];
  vectors: number[][];
}

let corpus: Corpus | undefined;
let warming: Promise<Corpus | undefined> | undefined;

/** Test seam: drop the cached corpus. */
export function resetCategoryCorpus(): void {
  corpus = undefined;
  warming = undefined;
}

/** Test seam: what the process currently holds. */
export function categoryCorpusSize(): number {
  return corpus?.categories.length ?? 0;
}

async function buildCorpus(
  cfg: Config,
  log: (msg: string, extra?: any) => void,
): Promise<Corpus | undefined> {
  const categories = suggestableCategories();
  const vectors: number[][] = new Array(categories.length);
  const CONCURRENCY = 8;
  let next = 0;
  let failed = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++;
      if (i >= categories.length) return;
      try {
        vectors[i] = await embedText(cfg, nodeText(categories[i]));
      } catch {
        failed++;
        return; // Bedrock is unhappy; stop this worker and leave the corpus off.
      }
    }
  });
  await Promise.all(workers);
  if (failed || vectors.some((v) => !v)) {
    log('category-suggest: corpus warm-up incomplete, staying lexical', {
      embedded: vectors.filter(Boolean).length,
      of: categories.length,
    });
    return undefined;
  }
  log('category-suggest: corpus warm', { categories: categories.length });
  return { categories, vectors };
}

/**
 * Warm the taxonomy corpus in the background. Safe to call more than once and
 * safe to ignore: while it runs, suggestions come out lexically.
 */
export function warmCategoryCorpus(
  cfg: Config,
  log: (msg: string, extra?: any) => void = () => {},
): Promise<Corpus | undefined> {
  if (corpus) return Promise.resolve(corpus);
  if (!warming) {
    warming = buildCorpus(cfg, log)
      .catch(() => undefined)
      .then((c) => {
        corpus = c;
        // A FAILED WARM-UP IS NOT AN ANSWER, so it is not remembered as one.
        // Holding the settled promise here left a process that started while
        // Bedrock was unhappy answering lexically for as long as it lived,
        // with nothing in the log after the one line at boot. Dropping it
        // means the next caller tries again.
        if (!c) warming = undefined;
        return c;
      });
  }
  return warming;
}

// ---------------------------------------------------------------------------
// The query embedding, remembered (2026-09-17 audit).
//
// Every refused posting embedded its own category path before the switchboard
// would say what to try instead. A refusal is cheap to provoke and cheap to
// repeat, and an agent that keeps sending the same wrong category — which is
// exactly what a confused agent does — bought a Titan call each time for an
// answer that could not possibly have changed. The corpus side of this has
// always been warmed once and kept; the query side was the half nobody cached.
//
// Five hundred entries, least-recently-used out first, keyed on the input
// normalised the same way the text handed to the model is. A Map in JavaScript
// keeps insertion order, so re-inserting on a hit is the whole of the LRU. In
// memory per process, which is right for what this is: a pure function of a
// string, wrong about nothing if a replica has to work it out again, and gone
// on restart without anybody having to clean it up.
// ---------------------------------------------------------------------------

export const SUGGEST_CACHE_MAX = 500;

const queryVectors = new Map<string, number[]>();

/**
 * The key: THE TEXT THAT IS SENT TO THE MODEL, and nothing else.
 *
 * This cache holds one thing — the vector a given string embeds to — and the
 * only honest key for it is that string. It was keyed for a while on what the
 * caller asked ABOUT rather than on what was sent, so that a spelling of the
 * path was one key however the query around it was framed. Two callers framing
 * the same path differently then shared one entry and one of them got the
 * other's vector. The class of bug is "a key that is not the input", and the
 * way it cannot recur is that `embedQuery` takes one string, keys on it, and
 * embeds it — there is no second value for the two to drift apart.
 *
 * Whitespace and case are normalised, which is a property of the text itself.
 */
const cacheKey = (embedded: string): string =>
  String(embedded ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** For the suite, and for a corpus rebuild: the vectors are only ever a cache. */
export function resetSuggestCache(): void {
  queryVectors.clear();
}

export function suggestCacheSize(): number {
  return queryVectors.size;
}

async function embedQuery(cfg: Config, query: string): Promise<number[]> {
  const key = cacheKey(query);
  const hit = queryVectors.get(key);
  if (hit) {
    // Touch it, so the ones being asked for are the ones that stay.
    queryVectors.delete(key);
    queryVectors.set(key, hit);
    return hit;
  }
  const vector = await embedText(cfg, query);
  queryVectors.set(key, vector);
  while (queryVectors.size > SUGGEST_CACHE_MAX) {
    const oldest = queryVectors.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    queryVectors.delete(oldest);
  }
  return vector;
}

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

/**
 * Up to `limit` open categories closest to `category`, nearest first. Never
 * throws and never blocks on Bedrock: if the corpus is not warm, or the query
 * cannot be embedded, the lexical answer is returned instead.
 */
export async function suggestCategories(
  cfg: Config,
  category: string,
  limit = 3,
  log: (msg: string, extra?: any) => void = () => {},
  opts: {
    /**
     * Ask about this text instead of the category path. The Jev ballot asks
     * about the posting's words alone, so that the shortlist it weighs is not
     * the one we already chose.
     */
    text?: string;
    /**
     * The posting's own words, where the caller holds them. The path is what
     * an assistant guessed; the words are what the poster said. Both go into
     * the question, framed the way the nodes are (see askText).
     */
    posting?: { kind?: string | null; attributes?: unknown };
  } = {},
): Promise<SuggestionResult> {
  const given = opts.text?.trim();
  // ONE FRAMING ON BOTH SIDES. The embedding side compares like with like, so
  // the question is put in the same plain words the nodes are described in.
  // The lexical side is token overlap on raw text and has always read the bare
  // path, leaf bonus and all; framing it would change every score it has ever
  // given.
  const query = given || askText(category, opts.posting);
  const lexical = (why: string, extra: Record<string, unknown> = {}) => {
    // NEVER SILENTLY. The lexical scorer reads the shape of a string, not the
    // meaning of a posting, and every answer it gives at the door should be
    // findable in the log afterwards with the reason it was asked.
    log('category-suggest: answering lexically', { why, asked: category, ...extra });
    const scored = lexicalSuggestions(given ?? category, limit);
    return {
      categories: scored.map((s) => s.category),
      scored,
      source: 'lexical' as const,
    };
  };
  try {
    // Kick the warm-up off, but do not wait for it.
    void warmCategoryCorpus(cfg, log);
    if (!corpus) return lexical('corpus not warm');
    const q = await embedQuery(cfg, query);
    const scored = corpus.categories.map((c, i) => ({
      category: c,
      score: cosine(q, corpus!.vectors[i]),
    }));
    // How far in front of the field the answers stand, measured over the WHOLE
    // field rather than over the handful that are returned — a top five is not
    // a distribution. See Suggestion.lead.
    const mean = scored.reduce((a, s) => a + s.score, 0) / (scored.length || 1);
    const variance = scored.reduce((a, s) => a + (s.score - mean) ** 2, 0) / (scored.length || 1);
    const sd = Math.sqrt(variance);
    scored.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
    const top = scored
      .slice(0, limit)
      .map((s) => ({ ...s, lead: sd > 0 ? (s.score - mean) / sd : 0 }));
    return { categories: top.map((s) => s.category), scored: top, source: 'embedding' };
  } catch (e: any) {
    return lexical('the embedder would not answer', { error: e?.message });
  }
}

// ---------------------------------------------------------------------------
// THE REFUSAL, SAID TO A PERSON (26 September 2026).
//
// An edge-case probe on dev read back what this used to say. A want for a good
// dentist came back "That category is reserved and can't be posted yet.
// Closest open ones: services.garden, services.repairs.computer,
// goods.home.decor." A plumber came back with trading cards and aquariums, and
// a room in a share house with skill sharing. Three faults in one sentence:
//
//  - it read dotted paths aloud, which the manual forbids an assistant to do
//    and which the switchboard was doing on its behalf;
//  - the "closest" shelves were the nearest vectors to a closed family, and
//    the nearest open thing to dental care is not a thing at all — the whole
//    family is closed, so whatever is left over is unrelated by construction;
//  - it never said why, so the human heard a refusal with no reason in it.
//
// So a reserved family is now named in plain words, with the one real reason
// where the taxonomy gives one. The reasons are the schema's own (SPEC §2,
// "Reserved nodes"): a licensed trade "needs a licence in most places the
// switchboard runs", and a regulated vertical is "held back deliberately at
// launch, pending a policy that does it justice". Nothing past that is
// claimed: no law is cited, and a reserved top level, which the taxonomy says
// only "not yet open" about, is given no reason at all.
//
// AND THE SUGGESTIONS ARE CURATED, OR THERE ARE NONE. A nearest-vector list is
// the wrong tool for a closed family, and a wrong suggestion is worse than
// none: offering "small fixes around the house" to someone after a licensed
// plumber routes them round the very reason the door is closed. So a reserved
// family only ever suggests from RELATED_OPEN below, written by hand, where the
// open shelf is genuinely the same errand done the neighbourly way (moving
// help beside commercial removals). Most families have nothing there, and
// they say nothing. The embedding search still runs for a top level nobody
// has heard of, because that is a spelling problem rather than a closed door.
//
// Paths stay in `suggestions`, the machine field an assistant files with. The
// sentence names shelves in words and never says a path.
// ---------------------------------------------------------------------------

/** A closed family, as a person would name it after "isn't open to". */
const RESERVED_WORDS: Record<string, string> = {
  property: 'rooms, rentals and other property',
  work: 'jobs and paid work',
  'services.trades': 'licensed trades like plumbing and electrical work',
  'services.health': 'health care',
  'services.legal': 'legal services',
  'services.financial': 'financial services like advice, tax and accounting',
  'services.childcare': 'childcare',
  'services.driving': 'paid driving, like lessons, passenger rides and removals',
  'services.security': 'security work like guarding, alarms and locksmithing',
  'services.food': 'cooking and catering to order',
  'goods.vehicles': 'vehicles and trailers',
  'social.dating': 'dating',
  'social.support': 'support groups',
};

/**
 * The only suggestions a closed family ever makes: open shelves that are the
 * same errand done between neighbours, and nothing that works round the reason
 * the family is closed. Keyed on the closed path itself or on the family, the
 * more specific first. An absent key means no suggestion, on purpose.
 */
export const RELATED_OPEN: Record<string, string[]> = {
  // Commercial removals need a licence; a hand with the lifting does not.
  'services.driving.removals': ['services.moving'],
  // Freelance and gig work between neighbours is what everyday help is for.
  'work.freelance': ['services.creative', 'services.tech', 'services.admin'],
  'work.gig': ['services.errands', 'services.moving', 'services.garden'],
  'work.casual': ['services.errands', 'services.moving', 'services.garden'],
};

/** A closed path's curated open neighbours, most specific key first. */
export function relatedOpenShelves(category: string): string[] {
  const parts = String(category ?? '').split('.');
  for (let i = parts.length; i >= 1; i--) {
    const hit = RELATED_OPEN[parts.slice(0, i).join('.')];
    if (hit) return hit.filter((c) => suggestableCategories().includes(c));
  }
  return [];
}

/** The reason clause, where the taxonomy gives a real one. */
function reservedWhy(reason: string): string {
  if (reason === 'licensed-trade') return ", because that work needs licence checks it doesn't do";
  if (reason === 'regulated-vertical') return ', while the right rules for that are worked out';
  return '';
}

/** "a", "a and b", "a, b and c". */
function listInWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The suggestions as a sentence of shelf names, or nothing. */
function nearestInWords(suggestions: string[]): string {
  const words = suggestions.map(shelfInWords).filter(Boolean);
  if (!words.length) return '';
  return words.length === 1
    ? ` The nearest open shelf is ${words[0]}.`
    : ` The nearest open shelves are ${listInWords(words)}.`;
}

/**
 * The sentence an agent's human hears when a category is refused. Plain,
 * never a path, and a reason only where there is a real one.
 */
export function suggestionSentence(
  status: 'reserved' | 'unknown',
  suggestions: string[],
  category?: string,
): string {
  if (status === 'reserved') {
    const family = category ? reservedFamily(category) : undefined;
    const words =
      (family && RESERVED_WORDS[family.path]) ||
      (family ? shelfInWords(family.path) : '') ||
      'that kind of thing';
    const why = family ? reservedWhy(family.reason) : '';
    return `The switchboard isn't open to ${words} yet${why}.${nearestInWords(suggestions)}`;
  }
  return `That heading isn't one the switchboard uses.${nearestInWords(suggestions)}`;
}
