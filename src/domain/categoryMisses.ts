/**
 * What the taxonomy was asked for and did not have.
 *
 * The category gate refuses a card naming a node the taxonomy does not open,
 * and names the closest open ones instead (cards.ts assertCategoryOpen,
 * categorySuggest.ts). That refusal is right. What it used to throw away is the
 * demand signal underneath it: every refusal is a person, through their agent,
 * saying "this is the errand I actually have". Read back over a fortnight and
 * grouped, those strings are a ranked list of what the next taxonomy release
 * should contain — the alternative being to guess.
 *
 * Two functions, and they answer to different masters:
 *
 *  - recordCategoryMiss is a WRITE ON A REFUSAL PATH, so it never throws. The
 *    refusal is a taxonomy decision; a failed INSERT is not allowed a vote in
 *    it. Anything that goes wrong is logged as a warning and swallowed, and the
 *    caller's CATEGORY_PROHIBITED goes back to the agent unchanged.
 *  - categoryMissDigest is an operator read. It is not an agent-facing surface
 *    and there is no tool that returns it: raw category strings typed by other
 *    people's agents are not something a counterparty is shown.
 *
 * WHAT IS NOT LOGGED. The deny-list path (denylist.ts categoryDenied — a
 * vertical held back on purpose, weapons and the like) also refuses with
 * CATEGORY_PROHIBITED, and is deliberately NOT recorded here. That refusal is a
 * policy decision already taken, not a gap in the taxonomy, and counting it as
 * demand would put "open the weapons vertical" at the top of a list whose whole
 * job is to say what to build next.
 */
import { getPool } from '../db.js';

/** One row of the digest: a string people keep reaching for, and how often. */
export interface CategoryMissRow {
  /** The category path that was asked for. */
  requested: string;
  /** How many refusals carried it in the window. */
  count: number;
  /** The open node most often offered against it, or null if none ever was. */
  top_suggestion: string | null;
  /** When it was last asked for. */
  last_seen: Date;
}

/**
 * Park one refused category. Best-effort by contract: called from inside the
 * CATEGORY_PROHIBITED path, it must not change what the agent gets back, so it
 * resolves whatever happens.
 */
export async function recordCategoryMiss(
  accountId: string,
  requested: string,
  suggestions: string[] = [],
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO category_misses (requested, suggestions, account_id) VALUES ($1, $2, $3)`,
      [requested, suggestions, accountId],
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn(
      `category-miss log failed (the refusal stands): ${e?.message ?? e}`,
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
 */
export const CATEGORY_MISS_DIGEST_SQL = `WITH recent AS (
  SELECT requested, suggestions, created_at
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
)
SELECT t.requested, t.count, x.suggestion AS top_suggestion, t.last_seen
  FROM totals t LEFT JOIN top x USING (requested)
 ORDER BY t.count DESC, t.requested ASC`;

/**
 * What people asked for and did not find, over the last `days` days: one row
 * per distinct string, commonest first. A window of less than a day is read as
 * one day rather than as "everything ever".
 */
export async function categoryMissDigest(days: number): Promise<CategoryMissRow[]> {
  const window = Math.max(1, Math.floor(Number(days) || 0));
  const r = await getPool().query(CATEGORY_MISS_DIGEST_SQL, [window]);
  return r.rows.map((row: any) => ({
    requested: row.requested,
    count: Number(row.count),
    top_suggestion: row.top_suggestion ?? null,
    last_seen: new Date(row.last_seen),
  }));
}
