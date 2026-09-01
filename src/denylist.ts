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
 * Category status against the taxonomy (SPEC §2). A category may be posted
 * when its top level is open, the node exists, and no node on its path —
 * itself included — is reserved. A reserved node says why: 'licensed-trade'
 * for work that needs a licence, 'regulated-vertical' for a family held back
 * deliberately at launch.
 *
 * Every deployment applies this rule identically. Dev and prod accept and
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

/** True when the category may be posted. */
export function categoryKnownAndOpen(category: string): { ok: boolean; reason?: string } {
  const r = categoryStatus(category);
  return r.status === 'open' ? { ok: true } : { ok: false, reason: r.reason };
}

/** Every category a card may be posted under, in taxonomy order. */
export function openCategories(): string[] {
  return Object.keys(taxonomy.nodes ?? {}).filter((c) => categoryStatus(c).status === 'open');
}

/** The taxonomy node behind a category, if the taxonomy has one. */
export function taxonomyNode(category: string): { label: string } | undefined {
  return taxonomy.nodes?.[category];
}
