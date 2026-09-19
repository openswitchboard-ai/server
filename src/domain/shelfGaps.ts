/**
 * THE SHELF GAP LOG, and the short-lived record of a shelf question in flight.
 *
 * Lachlan, 20 September 2026: every time the posting door is unsure which
 * shelf a thing belongs on, write it down, and write down how it ended. The
 * confident snaps are the catalogue working; the rest are the catalogue missing
 * a shelf somebody needed, and the only way to know which shelf to add is to
 * count them in the posters' own words. `npm run shelf-gaps` does the counting
 * (scripts/ops/shelf-gaps.mts, summariseShelfGaps below).
 *
 * WHAT A ROW HOLDS: the path the assistant sent, the poster's own few words for
 * the thing, up to five nodes the door weighed with how far each stood in front
 * of the catalogue, the outcome, and the node it ended on. NO ACCOUNT ID and
 * nothing else from the posting: no attributes, no price or ask, no place, no
 * figure of any kind. See migrations/049 for why.
 *
 * TWO ROWS, ONE ATTEMPT. The row that asked and the row that says how it ended
 * are joined by a random `attempt` id. The account behind it is known only to
 * shelf_attempts, which is honoured for an hour and swept after a day, and is
 * also what lets the next posting attempt be read as the human's answer.
 *
 * EVERY WRITE HERE IS A COURTESY. None of it may fail a publish or a press:
 * each function swallows its own failure and says so in the log.
 */
import { getPool } from '../db.js';
import { KIND_MAX_CHARS } from './matchRules.js';
import { detailKey } from './postingDetail.js';

/** How the door's uncertainty ended, in the words the table checks. */
export type ShelfGapOutcome =
  | 'snapped_low_confidence'
  | 'asked'
  | 'human_picked'
  | 'none_of_these'
  | 'picked_from_list'
  | 'top_level';

export const SHELF_GAP_OUTCOMES: readonly ShelfGapOutcome[] = [
  'snapped_low_confidence',
  'asked',
  'human_picked',
  'none_of_these',
  'picked_from_list',
  'top_level',
];

/** How many nodes a row keeps from the door's shortlist. */
export const SHELF_GAP_SHORTLIST = 5;

/** How long a gap row is kept. Swept on the ttl-expiry tick. */
export const SHELF_GAP_RETENTION_DAYS = 180;

/**
 * How long a shelf question in flight is honoured: long enough for a human to
 * be asked in chat, open a page, search and tap, short enough that a posting a
 * day later under the same words is a fresh posting.
 */
export const SHELF_ATTEMPT_WINDOW_MINUTES = 60;

/** And when the in-flight rows are swept for good. */
export const SHELF_ATTEMPT_SWEEP_HOURS = 24;

export interface ShortlistEntry {
  category: string;
  /** Standard deviations in front of the catalogue; null on the lexical side. */
  lead: number | null;
}

/** The poster's words as a row keeps them: trimmed, capped, or null. */
export function kindForGap(kind: unknown): string | null {
  if (typeof kind !== 'string') return null;
  const k = kind.trim().replace(/\s+/g, ' ').slice(0, KIND_MAX_CHARS);
  return k || null;
}

/** Up to five nodes, each a path and a lead, and nothing else from the ranking. */
export function shortlistForGap(
  ranked: { category: string; lead?: number }[] | undefined,
): ShortlistEntry[] {
  return (ranked ?? []).slice(0, SHELF_GAP_SHORTLIST).map((s) => ({
    category: String(s.category),
    lead: typeof s.lead === 'number' && Number.isFinite(s.lead) ? Math.round(s.lead * 100) / 100 : null,
  }));
}

/** Write one gap row. Never throws. */
export async function recordShelfGap(row: {
  as_posted: string;
  kind: unknown;
  outcome: ShelfGapOutcome;
  shortlist?: ShortlistEntry[];
  picked?: string | null;
  attempt?: string | null;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO shelf_gaps (attempt, as_posted, kind, shortlist, outcome, picked)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        row.attempt ?? null,
        String(row.as_posted ?? '').slice(0, 120),
        kindForGap(row.kind),
        JSON.stringify((row.shortlist ?? []).slice(0, SHELF_GAP_SHORTLIST)),
        row.outcome,
        row.picked ?? null,
      ],
    );
  } catch (e: any) {
    console.warn(JSON.stringify({ event: 'shelf-gap: not written', error: e?.message }));
  }
}

// ---------------------------------------------------------------------------
// The question in flight.
// ---------------------------------------------------------------------------

export interface ShelfAttempt {
  attempt: string;
  as_posted: string;
  kind: string | null;
  none_at: Date | null;
  picked: string | null;
}

/**
 * Start (or carry on) a shelf question for this account and these words.
 * Asking the same thing again while the first question is still open keeps the
 * attempt it already has, so a resent posting is not counted twice.
 */
export async function openShelfAttempt(
  accountId: string,
  kind: unknown,
  asPosted: string,
): Promise<{ attempt: string; fresh: boolean } | undefined> {
  try {
    const current = await readShelfAttempt(accountId, kind);
    if (current && current.as_posted === asPosted && !current.picked) {
      return { attempt: current.attempt, fresh: false };
    }
    const r = await getPool().query(
      `INSERT INTO shelf_attempts (account_id, kind_key, as_posted, kind, asked_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, kind_key) DO UPDATE
         SET attempt = gen_random_uuid(), as_posted = EXCLUDED.as_posted, kind = EXCLUDED.kind,
             asked_at = now(), none_at = NULL, picked = NULL, picked_at = NULL
       RETURNING attempt`,
      [accountId, detailKey(kind), asPosted, kindForGap(kind)],
    );
    const attempt = r.rows[0]?.attempt as string | undefined;
    return attempt ? { attempt, fresh: true } : undefined;
  } catch (e: any) {
    console.warn(JSON.stringify({ event: 'shelf-attempt: not opened', error: e?.message }));
    return undefined;
  }
}

/** The shelf question this account has open about these words, if any. */
export async function readShelfAttempt(
  accountId: string,
  kind: unknown,
): Promise<ShelfAttempt | undefined> {
  try {
    const r = await getPool().query(
      `SELECT attempt, as_posted, kind, none_at, picked FROM shelf_attempts
        WHERE account_id = $1 AND kind_key = $2
          AND asked_at > now() - make_interval(mins => $3::int)`,
      [accountId, detailKey(kind), SHELF_ATTEMPT_WINDOW_MINUTES],
    );
    return r.rows[0] ?? undefined;
  } catch {
    // Unreadable: behave as though nothing is in flight, which is how every
    // posting behaved before this existed.
    return undefined;
  }
}

/** The same question, found by its attempt id: what the page reads. */
export async function readShelfAttemptById(
  accountId: string,
  attempt: string,
): Promise<ShelfAttempt | undefined> {
  const r = await getPool().query(
    `SELECT attempt, as_posted, kind, none_at, picked FROM shelf_attempts
      WHERE account_id = $1 AND attempt = $2`,
    [accountId, attempt],
  );
  return r.rows[0] ?? undefined;
}

/** Mark that the human said none of the options fit. True the first time. */
export async function markNoneOfThese(accountId: string, attempt: string): Promise<boolean> {
  try {
    const r = await getPool().query(
      `UPDATE shelf_attempts SET none_at = now()
        WHERE account_id = $1 AND attempt = $2 AND none_at IS NULL
        RETURNING attempt`,
      [accountId, attempt],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The page's press: the shelf the human chose, against their own question. */
export async function recordShelfPick(
  accountId: string,
  attempt: string,
  picked: string,
): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE shelf_attempts SET picked = $3, picked_at = now()
      WHERE account_id = $1 AND attempt = $2
      RETURNING attempt`,
    [accountId, attempt, picked],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The posting went up: the question is over. Never throws. */
export async function closeShelfAttempt(accountId: string, attempt: string): Promise<void> {
  try {
    await getPool().query('DELETE FROM shelf_attempts WHERE account_id = $1 AND attempt = $2', [
      accountId,
      attempt,
    ]);
  } catch {
    /* swept within the day in any case */
  }
}

/** The retention sweep: gaps past 180 days, questions in flight past a day. */
export async function sweepShelfGaps(): Promise<{ gaps: number; attempts: number }> {
  const pool = getPool();
  const gaps = await pool.query(
    `DELETE FROM shelf_gaps WHERE created_at < now() - make_interval(days => $1::int)`,
    [SHELF_GAP_RETENTION_DAYS],
  );
  const attempts = await pool.query(
    `DELETE FROM shelf_attempts WHERE asked_at < now() - make_interval(hours => $1::int)`,
    [SHELF_ATTEMPT_SWEEP_HOURS],
  );
  return { gaps: gaps.rowCount ?? 0, attempts: attempts.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Reading it back: what `npm run shelf-gaps` prints.
// ---------------------------------------------------------------------------

export interface ShelfGapRow {
  as_posted: string;
  kind: string | null;
  outcome: ShelfGapOutcome;
  picked: string | null;
}

export interface ShelfGapGroup {
  /** The normalised words, or the path, the group is keyed on. */
  key: string;
  /** How many times the door was unsure about it: one per attempt start. */
  times: number;
  outcomes: Partial<Record<ShelfGapOutcome, number>>;
  /** What the human chose, most often first: node -> count. */
  picked: [string, number][];
}

/**
 * Words a person used, folded so "Sim racing pedals" and "sim-racing pedal"
 * land together: lower case, punctuation to spaces, a plural s dropped from
 * any word longer than three letters.
 */
export function normaliseKind(kind: string | null | undefined): string {
  const words = String(kind ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return words.join(' ') || '(no words given)';
}

/**
 * Group the rows two ways. A row that starts an attempt ('asked', or one of the
 * two filing outcomes) counts as one time the door was unsure; the answers that
 * come back afterwards are counted under outcomes and picks without adding to
 * it, so "14 times, picked console accessories 6, none of these 5" adds up.
 */
export function summariseShelfGaps(
  rows: ShelfGapRow[],
  by: 'kind' | 'as_posted',
): ShelfGapGroup[] {
  const starts = new Set<ShelfGapOutcome>(['asked', 'snapped_low_confidence', 'top_level']);
  const groups = new Map<string, { times: number; outcomes: Map<ShelfGapOutcome, number>; picked: Map<string, number> }>();
  for (const r of rows) {
    const key = by === 'kind' ? normaliseKind(r.kind) : r.as_posted;
    let g = groups.get(key);
    if (!g) {
      g = { times: 0, outcomes: new Map(), picked: new Map() };
      groups.set(key, g);
    }
    if (starts.has(r.outcome)) g.times++;
    g.outcomes.set(r.outcome, (g.outcomes.get(r.outcome) ?? 0) + 1);
    if (r.picked && (r.outcome === 'human_picked' || r.outcome === 'picked_from_list')) {
      g.picked.set(r.picked, (g.picked.get(r.picked) ?? 0) + 1);
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      times: g.times,
      outcomes: Object.fromEntries(g.outcomes) as Partial<Record<ShelfGapOutcome, number>>,
      picked: [...g.picked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    }))
    .sort((a, b) => b.times - a.times || a.key.localeCompare(b.key));
}

/** One group as a line: "sim racing: 14 times, picked console accessories 6, none of these 5". */
export function shelfGapLine(g: ShelfGapGroup, words: (category: string) => string = (c) => c): string {
  const bits = [`${g.times} time${g.times === 1 ? '' : 's'}`];
  for (const [node, n] of g.picked) bits.push(`picked ${words(node)} ${n}`);
  if (g.outcomes.none_of_these) bits.push(`none of these ${g.outcomes.none_of_these}`);
  if (g.outcomes.top_level) bits.push(`top level ${g.outcomes.top_level}`);
  if (g.outcomes.snapped_low_confidence) {
    bits.push(`filed unsure ${g.outcomes.snapped_low_confidence}`);
  }
  // An 'asked' is answered in chat (human_picked) or with none of these; a pick
  // from the list is the answer to the second of those, so it is not counted
  // again here.
  const answered = (g.outcomes.human_picked ?? 0) + (g.outcomes.none_of_these ?? 0);
  const unanswered = (g.outcomes.asked ?? 0) - answered;
  if (unanswered > 0) bits.push(`no answer yet ${unanswered}`);
  return `${g.key}: ${bits.join(', ')}`;
}
