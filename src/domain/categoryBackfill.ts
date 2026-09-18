/**
 * Snap stored cards onto taxonomy v2.
 *
 * Before v2 the dev deployment accepted any well-formed dotted path, so cards
 * are sitting there under categories the taxonomy has never heard of —
 * 'goods.laptop.macbook-air', 'social.conversation.language-exchange'. Those
 * cards can never meet anything: the matcher's tree check asks whether one
 * category is the other, sits on its ancestor line, or shares its immediate
 * parent, and an invented path is none of the three — there is no real card
 * under 'goods.laptop' for a sibling rule to reach.
 *
 * This sweep takes each such card, asks the same suggestion machinery a
 * refused publish would ask, and moves the card to the top answer. Every
 * remap is logged with the old path, the new one, and how it was chosen, so
 * the ops log holds a full record of what moved.
 *
 * A card already under an open category is left exactly where it is, which
 * makes the sweep idempotent and leaves the goods fixtures the end-to-end
 * suite depends on untouched.
 *
 * Two kinds of card are left alone on purpose:
 *   - the integration suite's run-scoped islands ('intg-*'), which exist to
 *     be isolated from everything and would only pollute the real tree;
 *   - any card whose nearest node is not actually near. A suggestion below
 *     the confidence floor means the sweep has no idea where the card
 *     belongs, and inventing an answer is worse than leaving it where it is
 *     for an operator to look at.
 *
 * A remapped card is re-embedded, because the projection text a card is
 * embedded from starts with its category and its label path. Skipping that
 * would leave the vector describing a category the card no longer carries.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { categoryDenied, categoryStatus } from '../denylist.js';
import { suggestCategories, type SuggestionSource } from './categorySuggest.js';
import { nearestKnownAncestor } from './matchRules.js';
import { embedCard } from './embeddings.js';
import type { Config } from '../config.js';

/** Cards per pass. One pass is a few hundred small updates plus embeddings. */
export const SNAP_BATCH = 200;

/**
 * Run-scoped categories the integration suite creates for its own islands.
 * They are never meant to join the tree.
 */
export const ISLAND_PREFIX = /^intg[-.]/;

/** Below this closeness the sweep leaves the card where it is. */
export const DEFAULT_MIN_SCORE = { embedding: 0.55, lexical: 0.2 };

/**
 * The floor at the publish door, which is higher on the lexical side than the
 * sweep's and for a reason worth writing down.
 *
 * The sweep's lexical floor is generous because the alternative there is
 * leaving a posting exactly where it is, under a path that meets nothing. Any
 * plausible node beats that. At the door the alternative is better: the
 * posting's own line up to a node the catalogue knows, which is never wrong,
 * only vague. So a lexical guess has to actually be a guess about the same
 * thing before it beats "this is a good".
 *
 * What 0.2 buys at the door is the case that made this obvious.
 * 'goods.gaming.sim-racing' scores 0.218 against goods.clothing, on nothing
 * but shared trigrams, and filing a racing rig under clothing is worse for
 * everybody than filing it under goods. The embedding floor is unchanged,
 * because the embedding side is measuring meaning and 0.55 there already
 * means what it says.
 */
export const DOOR_MIN_SCORE = { embedding: 0.55, lexical: 0.45 };

export interface SnapCursor {
  created_at: string;
  id: string;
}

// ---------------------------------------------------------------------------
// ONE DECISION, TWO CALLERS.
//
// The sweep below has always answered one question: given a category the
// taxonomy does not hold open, which node should this posting really sit
// under. Since run 9 the publish door asks exactly the same question, at the
// moment the row is written, so that an invented branch never becomes a
// matching key in the first place — 'goods.gaming.sim-racing' matched nothing
// because there is no goods.gaming for a sibling rule to reach, and the want
// for the same object sat under goods.electronics unmet.
//
// The two callers differ in one thing only, and it is what happens when no
// suggestion is close enough. The sweep is reading rows that are already up
// and already matching or not matching on their own: inventing an answer for
// one of them is worse than leaving it alone for an operator, so the sweep
// leaves it. The door has no such luxury. A posting arriving now under a path
// nobody has written down will match nothing at all if it keeps that path, so
// it falls back to the nearest node on its own line that the catalogue does
// know — at the very least 'goods', 'services' or 'social', which is the same
// thing the manual has told assistants to do since version 44.
//
// WHAT THE SNAP MAY NEVER DO is move a posting into a family somebody closed.
// The deny list is judged on what the thing is, and the answer to a weapon
// filed under goods.weapons is the category's word, never a quieter node
// nearby. So every candidate — suggestion and ancestor alike — is put back
// through the same open check the door uses, and a closed one is skipped for
// the next open answer.
// ---------------------------------------------------------------------------

/** How the switchboard arrived at the node a posting is filed under. */
export type SnapHow =
  | 'as-posted' // the catalogue knows this node and holds it open
  | 'suggestion' // the nearest open node, close enough to be trusted
  | 'ancestor' // nothing was close enough, so the line it was filed on
  | 'unmatched'; // nothing was close enough and the caller asked to be left alone

export interface SnapDecision {
  /** Where the posting should be filed. */
  category: string;
  /** The path that was asked about. */
  from: string;
  /** Whether that is a move. */
  changed: boolean;
  how: SnapHow;
  /** Which way closeness was measured, where a suggestion was weighed. */
  source?: SuggestionSource;
  /** The winning suggestion's closeness, where one won. */
  score?: number;
  /** The other answers considered, nearest first. */
  runners_up?: string[];
}

/** True where the taxonomy holds this exact node and nobody has closed it. */
const openNode = (category: string): boolean =>
  categoryStatus(category).status === 'open' && !categoryDenied(category);

/**
 * Where a posting under `category` really belongs.
 *
 * Never throws: the suggester is a courtesy and the answer stands without it
 * (`fallbackToAncestor` callers always get a node back, because the nearest
 * known ancestor is a walk up the path and needs nothing outside the process).
 */
export async function snapCategory(
  cfg: Config,
  category: string,
  log: (msg: string, extra?: any) => void = () => {},
  opts: {
    /** Below the floor: walk up the path rather than leaving it alone. */
    fallbackToAncestor?: boolean;
    minScore?: Partial<typeof DEFAULT_MIN_SCORE>;
  } = {},
): Promise<SnapDecision> {
  const from = String(category ?? '');
  if (openNode(from)) return { category: from, from, changed: false, how: 'as-posted' };
  // Which floor depends on what the caller does when nothing clears it: a
  // caller with the ancestor to fall back on can afford to be fussier.
  const base = opts.fallbackToAncestor ? DOOR_MIN_SCORE : DEFAULT_MIN_SCORE;
  const floor = { ...base, ...(opts.minScore ?? {}) };

  let source: SuggestionSource | undefined;
  let best: { category: string; score: number } | undefined;
  let runnersUp: string[] = [];
  try {
    // Five rather than three: the top answer may be a family somebody closed,
    // and the point of asking is to have an open one left after that.
    const result = await suggestCategories(cfg, from, 5, log);
    source = result.source;
    runnersUp = result.categories;
    best = result.scored.find((s) => s.score >= floor[result.source] && openNode(s.category));
  } catch (e: any) {
    log('snap: suggester unavailable', { category: from, error: e?.message });
  }
  if (best) {
    return {
      category: best.category,
      from,
      changed: best.category !== from,
      how: 'suggestion',
      source,
      score: best.score,
      runners_up: runnersUp.filter((c) => c !== best!.category),
    };
  }
  if (!opts.fallbackToAncestor) {
    return { category: from, from, changed: false, how: 'unmatched', source, runners_up: runnersUp };
  }
  // Up the posting's own line until the catalogue both knows the node and
  // holds it open. The top level always resolves, because the gate before
  // this refuses a top level the taxonomy has no name for.
  const parts = nearestKnownAncestor(from).split('.');
  for (let i = parts.length; i >= 1; i--) {
    const path = parts.slice(0, i).join('.');
    if (openNode(path)) {
      return {
        category: path,
        from,
        changed: path !== from,
        how: 'ancestor',
        source,
        runners_up: runnersUp,
      };
    }
  }
  return { category: from, from, changed: false, how: 'unmatched', source, runners_up: runnersUp };
}

export interface SnapOutcome {
  /** Cards examined in this pass. */
  scanned: number;
  /** Cards moved to a taxonomy node. */
  remapped: { card_id: string; from: string; to: string; source: string }[];
  /** Cards whose category is already open. */
  already_open: number;
  /** Integration-suite islands, deliberately untouched. */
  islands: number;
  /** Cards no suggestion could be found for; they keep what they have. */
  unmatched: number;
  /** Cards moved but not re-embedded, so still carrying the old vector. */
  embed_failed: number;
  /** Pass this back to continue; null when the sweep is done. */
  next: SnapCursor | null;
}

export async function snapCardCategories(
  cfg: Config,
  log: (msg: string, extra?: any) => void = () => {},
  opts: {
    after?: SnapCursor;
    batch?: number;
    dryRun?: boolean;
    minScore?: Partial<typeof DEFAULT_MIN_SCORE>;
  } = {},
): Promise<SnapOutcome> {
  const batch = opts.batch ?? SNAP_BATCH;
  const floor = { ...DEFAULT_MIN_SCORE, ...(opts.minScore ?? {}) };
  const rows = await getPool().query(
    `SELECT id, account_id, category, attributes, lifecycle_state, created_at
       FROM cards
      WHERE lifecycle_state IN ('PUBLISHED', 'PENDING_SCREENING')
        AND expires_at > now()
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id LIMIT $1`,
    [batch, opts.after?.created_at ?? null, opts.after?.id ?? null],
  );
  const last = rows.rows[rows.rows.length - 1];
  const outcome: SnapOutcome = {
    scanned: rows.rowCount ?? 0,
    remapped: [],
    already_open: 0,
    islands: 0,
    unmatched: 0,
    embed_failed: 0,
    next:
      rows.rowCount === batch && last
        ? { created_at: new Date(last.created_at).toISOString(), id: last.id }
        : null,
  };

  for (const row of rows.rows) {
    if (categoryStatus(row.category).status === 'open') {
      outcome.already_open++;
      continue;
    }
    if (ISLAND_PREFIX.test(row.category)) {
      outcome.islands++;
      continue;
    }
    // The sweep asks the same question the publish door asks, and takes the
    // same answer — except that it does NOT walk up the path when nothing is
    // close enough. A row already up is left for an operator; see snapCategory.
    const decision = await snapCategory(cfg, row.category, log, { minScore: floor });
    const source = decision.source ?? 'lexical';
    if (!decision.changed) {
      outcome.unmatched++;
      log('snap-categories: no taxonomy node close enough', {
        card_id: row.id,
        category: row.category,
        source,
        best: decision.runners_up?.[0] ?? null,
        score: decision.score ?? null,
        floor: floor[source],
      });
      continue;
    }
    const target = decision.category;
    if (opts.dryRun) {
      outcome.remapped.push({ card_id: row.id, from: row.category, to: target, source });
      log('snap-categories: would remap', {
        card_id: row.id,
        from: row.category,
        to: target,
        source,
        score: decision.score,
        runners_up: decision.runners_up,
      });
      continue;
    }
    await getPool().query('UPDATE cards SET category = $2, updated_at = now() WHERE id = $1', [
      row.id,
      target,
    ]);
    outcome.remapped.push({ card_id: row.id, from: row.category, to: target, source });
    log('snap-categories: card remapped', {
      card_id: row.id,
      from: row.category,
      to: target,
      source,
      score: decision.score,
      runners_up: decision.runners_up,
    });
    // The vector describes the category, so it has to be rebuilt.
    try {
      await embedCard(cfg, { id: row.id, category: target, attributes: row.attributes });
    } catch (e: any) {
      outcome.embed_failed++;
      log('snap-categories: re-embed failed, card left for the embedding backfill', {
        card_id: row.id,
        error: e?.message,
      });
      await getPool().query('UPDATE cards SET embedding = NULL WHERE id = $1', [row.id]);
    }
  }
  return outcome;
}

/** Hand every remapped, live card back to the matching engine. */
export async function requeueSnapped(
  cfg: Config,
  cardIds: string[],
  log: (msg: string, extra?: any) => void = () => {},
): Promise<number> {
  if (!cardIds.length) return 0;
  const live = await getPool().query(
    `SELECT id FROM cards WHERE id = ANY($1::uuid[])
       AND lifecycle_state = 'PUBLISHED' AND expires_at > now() AND embedding IS NOT NULL`,
    [cardIds],
  );
  for (const row of live.rows) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.matchingQueueUrl,
        MessageBody: JSON.stringify({ kind: 'card-published', card_id: row.id }),
      }),
    );
  }
  log('snap-categories: cards requeued for matching', { count: live.rowCount });
  return live.rowCount ?? 0;
}
