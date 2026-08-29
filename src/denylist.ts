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

/** True when the category exists in the v1 taxonomy under an open top level. */
export function categoryKnownAndOpen(category: string): { ok: boolean; reason?: string } {
  const top = category.split('.')[0];
  const topStatus = taxonomy.top_levels?.[top]?.status;
  if (topStatus !== 'open') return { ok: false, reason: `top level '${top}' is not open` };
  if (!taxonomy.nodes?.[category]) return { ok: false, reason: `unknown category '${category}'` };
  return { ok: true };
}
