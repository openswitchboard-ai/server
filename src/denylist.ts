/**
 * Deny-list category matching against the schema repo's seed
 * (data/deny-list.seed.json). Globs: '**' matches any suffix of dotted
 * segments, '*' matches one segment.
 */
import { loadDenyListSeed, loadTaxonomy } from './protocol.js';

export interface DenyEntry {
  jurisdiction: string;
  denied: string[];
  reason_code: string;
  status: 'denied' | 'vertical-policy-pending';
}

const seed: { entries: DenyEntry[] } = loadDenyListSeed();
const taxonomy = loadTaxonomy();

export function globMatches(glob: string, category: string): boolean {
  const g = glob.split('.');
  const c = category.split('.');
  let gi = 0;
  let ci = 0;
  while (gi < g.length) {
    const seg = g[gi];
    if (seg === '**') {
      // '**' matches one-or-more remaining segments (seed uses 'x.**' plus a
      // separate bare 'x' entry for the node itself).
      return ci < c.length;
    }
    if (ci >= c.length) return false;
    if (seg !== '*' && seg !== c[ci]) return false;
    gi++;
    ci++;
  }
  return ci === c.length;
}

/**
 * Category-level deny decision, made synchronously at publish time.
 * `screening-only` reason codes (jurisdiction-wide goods.** entries for
 * stolen-goods markers and recalled goods) are NOT category denials — they are
 * enforced by the screening pipeline on card content.
 */
const SCREENING_ONLY_REASONS = new Set(['stolen-goods-markers', 'recalled-goods']);

export function categoryDenied(category: string): DenyEntry | undefined {
  for (const e of seed.entries) {
    if (SCREENING_ONLY_REASONS.has(e.reason_code)) continue;
    if (e.denied.some((g) => globMatches(g, category))) return e;
  }
  return undefined;
}

/** Screening-time reason codes that apply to this category (content checks). */
export function screeningReasonCodes(category: string): string[] {
  return seed.entries
    .filter((e) => SCREENING_ONLY_REASONS.has(e.reason_code))
    .filter((e) => e.denied.some((g) => globMatches(g, category)))
    .map((e) => e.reason_code);
}

/**
 * Where a category sits in the taxonomy (SPEC §2): 'open' for a node it holds
 * and does not reserve, 'reserved' for a node inside a closed family, and
 * 'unknown' for one it has never heard of. A reserved node says why:
 * 'licensed-trade' for work that needs a licence, 'regulated-vertical' for a
 * family held back deliberately at launch.
 *
 * THIS IS NOT THE PUBLISH GATE any more; categoryGate below is. 'unknown' here
 * means the catalogue has no node, which is a gap in the catalogue rather than
 * a reason to turn a person away. What still reads this is everything that
 * works on the tree itself: the suggester, the backfill, and the tests that
 * pin where the reserved families sit.
 *
 * Every deployment applies these rules identically. Dev and prod accept and
 * refuse exactly the same categories.
 */
export interface CategoryStatus {
  status: 'open' | 'reserved' | 'unknown';
  /** Plain reason, present whenever the status is not 'open'. */
  reason?: string;
}

export function categoryStatus(category: string): CategoryStatus {
  const parts = category.split('.');
  const top = parts[0];
  const topLevel = taxonomy.top_levels?.[top];
  if (!topLevel) {
    return { status: 'unknown', reason: `top level '${top}' is not in the taxonomy` };
  }
  if (topLevel.status !== 'open') {
    return { status: 'reserved', reason: `top level '${top}' is reserved` };
  }
  if (!taxonomy.nodes?.[category]) {
    return { status: 'unknown', reason: `category '${category}' is not in the taxonomy` };
  }
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('.');
    const node = taxonomy.nodes[path];
    if (node?.status === 'reserved') {
      return {
        status: 'reserved',
        reason: `'${path}' is reserved (${node.reserved_reason ?? 'reserved'})`,
      };
    }
  }
  return { status: 'open' };
}

/** True when the category is a node the taxonomy knows and holds open. */
export function categoryKnownAndOpen(category: string): { ok: boolean; reason?: string } {
  const r = categoryStatus(category);
  return r.status === 'open' ? { ok: true } : { ok: false, reason: r.reason };
}

/** Whether the taxonomy has this exact node. */
export function taxonomyKnows(category: string): boolean {
  return Boolean(taxonomy.nodes?.[category]);
}

/**
 * THE CATALOGUE IS A DENY LIST (docs/taxonomy-question.md).
 *
 * `categoryStatus` above answers a question about the taxonomy: is this a node
 * it holds, and does it hold it open. That is still the right question for
 * suggestions, for the backfill and for anything reading the tree. It is no
 * longer the question the publish gate asks.
 *
 * The gate asks whether the thing may go up, and the answer is yes unless
 * somebody decided otherwise: the top level has to be one the taxonomy knows
 * and holds open, and no node on the path — itself included — may be reserved.
 * A leaf nobody has written down fails neither test, so it goes up. It was
 * never a policy decision that it should not; it was the catalogue's silence
 * mistaken for one, and an allow list of things a person is permitted to want
 * is the wrong shape for a network whose point is that people want unforeseen
 * things.
 *
 * The reserved walk runs over the path whether or not the leaf itself is
 * known, which is the one thing the old ordering got wrong: `social.dating`
 * being reserved has to close `social.dating.whatever` as well, and under the
 * old code an unknown child of a reserved parent came back 'unknown' rather
 * than 'reserved'. Here it comes back reserved, which is what it is.
 *
 * `known` is not part of the decision. It is what the caller needs afterwards:
 * an unknown leaf has to carry `kind`, and it is written down as a gap in the
 * catalogue once it is up (domain/categoryMisses.ts).
 */
export interface CategoryGate {
  ok: boolean;
  /** Whether the taxonomy has this exact node. */
  known: boolean;
  /** Plain reason, present only on a refusal. */
  reason?: string;
  /** Which refusal it was, for the sentence that goes back. */
  refusal?: 'reserved' | 'unknown';
}

export function categoryGate(category: string): CategoryGate {
  const parts = category.split('.');
  const top = parts[0];
  const known = taxonomyKnows(category);
  const topLevel = taxonomy.top_levels?.[top];
  if (!topLevel) {
    return {
      ok: false,
      known,
      refusal: 'unknown',
      reason: `top level '${top}' is not in the taxonomy`,
    };
  }
  if (topLevel.status !== 'open') {
    return { ok: false, known, refusal: 'reserved', reason: `top level '${top}' is reserved` };
  }
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('.');
    const node = taxonomy.nodes?.[path];
    if (node?.status === 'reserved') {
      return {
        ok: false,
        known,
        refusal: 'reserved',
        reason: `'${path}' is reserved (${node.reserved_reason ?? 'reserved'})`,
      };
    }
  }
  return { ok: true, known };
}

/** Every category a card may be posted under, in taxonomy order. */
export function openCategories(): string[] {
  return Object.keys(taxonomy.nodes ?? {}).filter((c) => categoryStatus(c).status === 'open');
}

/** The taxonomy node behind a category, if the taxonomy has one. */
export function taxonomyNode(category: string): { label: string } | undefined {
  return taxonomy.nodes?.[category];
}
