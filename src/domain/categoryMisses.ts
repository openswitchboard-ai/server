/**
 * What the taxonomy was asked for and did not have.
 *
 * IT IS A GROWTH LIST NOW, NOT A COMPLAINTS BOOK. Until 17 September 2026 a
 * row here was a refusal: a card naming a node the catalogue did not open was
 * turned away, and the string it named was written down on the way past. Since
 * the catalogue became a deny list (docs/taxonomy-question.md) that posting
 * goes UP — the top level was open, nothing on the path was reserved, and the
 * agent said in plain words what the thing is — and the row is written after
 * it does. Same table, same digest, opposite feeling: every line is something
 * that is live on the board right now under a name nobody has written down
 * yet, which is as clean a statement of what the next taxonomy release should
 * contain as this network is ever going to get.
 *
 * Two functions, and they answer to different masters:
 *
 *  - recordCategoryMiss is a WRITE BESIDE A POSTING THAT SUCCEEDED, so it
 *    never throws. The posting is up; a failed INSERT is not allowed to undo
 *    it or to be mentioned to the agent. Anything that goes wrong is logged as
 *    a warning and swallowed.
 *  - categoryMissDigest is an operator read. It is not an agent-facing surface
 *    and there is no tool that returns it: raw category strings typed by other
 *    people's agents are not something a counterparty is shown.
 *
 * WHAT IS NOT LOGGED. A category that was actually refused — a reserved
 * family, a top level the taxonomy has no name for — is deliberately NOT
 * recorded. That refusal is a policy decision already taken, not a gap in the
 * taxonomy, and counting it as demand would put "open the weapons vertical" at
 * the top of a list whose whole job is to say what to build next.
 */
import { getPool } from '../db.js';

/** One row of the digest: a string people keep reaching for, and how often. */
export interface CategoryMissRow {
  /** The category path that was asked for. */
  requested: string;
  /** How many postings carried it in the window. */
  count: number;
  /** The open node most often offered against it, or null if none ever was. */
  top_suggestion: string | null;
  /** The commonest of the agents' own plain words for the thing, or null. */
  top_kind: string | null;
  /** When it was last posted. */
  last_seen: Date;
}

/**
 * Park one unknown leaf that went up. Best-effort by contract: the posting has
 * already succeeded, so this must not change what the agent gets back and
 * resolves whatever happens.
 */
export async function recordCategoryMiss(
  accountId: string,
  requested: string,
  suggestions: string[] = [],
  kind: string | null = null,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO category_misses (requested, suggestions, account_id, kind)
       VALUES ($1, $2, $3, $4)`,
      [requested, suggestions, accountId, kind],
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn(
      `category-miss log failed (the posting stands): ${e?.message ?? e}`,
    );
  }
}

/**
 * The digest statement, in one place because two things read it: the server
 * (categoryMissDigest below, over the pool) and scripts/category-misses.ts
 * (over the RDS Data API, with $1 rewritten to a named parameter). Keeping one
 * copy is what stops the CLI and the server drifting into answering slightly
 * different questions about the same table.
 *
 * $1 is the window in days.
 *
 * `top_suggestion` is the node most often offered against that string — the
 * suggester is not deterministic across restarts (embeddings when the corpus is
 * warm, lexical when it is not), so the mode is more honest than "the first one
 * we happened to store". Ties break on the node's own name, so the digest reads
 * the same twice in a row. A string that was never offered anything — the
 * suggester is a courtesy and may return none — keeps its row with a null
 * suggestion rather than dropping out of the count.
 *
 * `top_kind` is the commonest of the agents' OWN words for the thing under
 * that path, picked the same way and for the same reason. It is the part a
 * taxonomy editor actually reads: "services.repairs.vintage-synthesiser"
 * posted eleven times, called "vintage synth repair" by nine of them, is a leaf
 * with its label already written.
 */
export const CATEGORY_MISS_DIGEST_SQL = `WITH recent AS (
  SELECT requested, suggestions, kind, created_at
    FROM category_misses
   WHERE created_at > now() - make_interval(days => $1::int)
),
totals AS (
  SELECT requested, count(*)::int AS count, max(created_at) AS last_seen
    FROM recent GROUP BY requested
),
offered AS (
  SELECT requested, suggestion, count(*) AS n
    FROM recent, unnest(coalesce(suggestions, '{}'::text[])) AS suggestion
   GROUP BY requested, suggestion
),
top AS (
  SELECT DISTINCT ON (requested) requested, suggestion
    FROM offered
   ORDER BY requested, n DESC, suggestion ASC
),
named AS (
  SELECT requested, kind, count(*) AS n
    FROM recent WHERE kind IS NOT NULL AND kind <> ''
   GROUP BY requested, kind
),
top_kind AS (
  SELECT DISTINCT ON (requested) requested, kind
    FROM named
   ORDER BY requested, n DESC, kind ASC
)
SELECT t.requested, t.count, x.suggestion AS top_suggestion, k.kind AS top_kind, t.last_seen
  FROM totals t
  LEFT JOIN top x USING (requested)
  LEFT JOIN top_kind k USING (requested)
 ORDER BY t.count DESC, t.requested ASC`;

/**
 * What people posted without a leaf, over the last `days` days: one row per
 * distinct string, commonest first. A window of less than a day is read as one
 * day rather than as "everything ever".
 */
export async function categoryMissDigest(days: number): Promise<CategoryMissRow[]> {
  const window = Math.max(1, Math.floor(Number(days) || 0));
  const r = await getPool().query(CATEGORY_MISS_DIGEST_SQL, [window]);
  return r.rows.map((row: any) => ({
    requested: row.requested,
    count: Number(row.count),
    top_suggestion: row.top_suggestion ?? null,
    top_kind: row.top_kind ?? null,
    last_seen: new Date(row.last_seen),
  }));
}
