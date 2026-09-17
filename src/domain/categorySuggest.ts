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
 *  1. Embeddings. Every open node's path and label path is embedded once with
 *     the same Titan model the matching engine uses, cached in this process,
 *     and the free-typed category is compared to them by cosine. The corpus is
 *     warmed in the background, so no request ever waits on it.
 *  2. Token and trigram overlap on the raw text. Always available, needs
 *     nothing outside the process.
 *
 * Suggestions are a courtesy. If Bedrock is down, if the corpus is still
 * warming, or if anything else goes wrong, the lexical answer stands in and
 * the card is refused exactly the same way. NO-FALLBACKS applies to screening
 * and consent decisions; this is neither.
 */
import { openCategories } from '../denylist.js';
import { categoryLabelPath } from './matchRules.js';
import { embedText } from './embeddings.js';
import type { Config } from '../config.js';

/** How the switchboard arrived at a set of suggestions. */
export type SuggestionSource = 'embedding' | 'lexical';

export interface Suggestion {
  category: string;
  score: number;
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

/** The text embedded for a node: the dotted path plus its human label path. */
export function nodeText(category: string): string {
  return `category: ${category} (${categoryLabelPath(category)})`;
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
      .then((c) => {
        corpus = c;
        return c;
      })
      .catch(() => undefined);
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

/** The key: the same string in any spelling of whitespace or case is one key. */
const cacheKey = (category: string): string =>
  String(category ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** For the suite, and for a corpus rebuild: the vectors are only ever a cache. */
export function resetSuggestCache(): void {
  queryVectors.clear();
}

export function suggestCacheSize(): number {
  return queryVectors.size;
}

async function embedQuery(cfg: Config, category: string): Promise<number[]> {
  const key = cacheKey(category);
  const hit = queryVectors.get(key);
  if (hit) {
    // Touch it, so the ones being asked for are the ones that stay.
    queryVectors.delete(key);
    queryVectors.set(key, hit);
    return hit;
  }
  const vector = await embedText(cfg, nodeText(category));
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
): Promise<SuggestionResult> {
  const lexical = () => {
    const scored = lexicalSuggestions(category, limit);
    return {
      categories: scored.map((s) => s.category),
      scored,
      source: 'lexical' as const,
    };
  };
  try {
    // Kick the warm-up off, but do not wait for it.
    void warmCategoryCorpus(cfg, log);
    if (!corpus) return lexical();
    const q = await embedQuery(cfg, category);
    const scored = corpus.categories.map((c, i) => ({
      category: c,
      score: cosine(q, corpus!.vectors[i]),
    }));
    scored.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
    const top = scored.slice(0, limit);
    return { categories: top.map((s) => s.category), scored: top, source: 'embedding' };
  } catch (e: any) {
    log('category-suggest: falling back to lexical', { error: e?.message });
    return lexical();
  }
}

/**
 * The sentence an agent's human reads. Plain, and it names what to do next.
 */
export function suggestionSentence(
  status: 'reserved' | 'unknown',
  suggestions: string[],
): string {
  const head =
    status === 'reserved'
      ? "That category is reserved and can't be posted yet."
      : "That category isn't in the taxonomy.";
  if (!suggestions.length) return head;
  return `${head} Closest open ones: ${suggestions.join(', ')}.`;
}
