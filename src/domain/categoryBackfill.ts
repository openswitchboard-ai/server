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
import { categoryStatus } from '../denylist.js';
import { suggestCategories } from './categorySuggest.js';
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

export interface SnapCursor {
  created_at: string;
  id: string;
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
    const { categories, scored, source } = await suggestCategories(cfg, row.category, 3, log);
    const best = scored[0];
    const target = best && best.score >= floor[source] ? best.category : undefined;
    if (!target) {
      outcome.unmatched++;
      log('snap-categories: no taxonomy node close enough', {
        card_id: row.id,
        category: row.category,
        source,
        best: best?.category ?? null,
        score: best?.score ?? null,
        floor: floor[source],
      });
      continue;
    }
    if (opts.dryRun) {
      outcome.remapped.push({ card_id: row.id, from: row.category, to: target, source });
      log('snap-categories: would remap', {
        card_id: row.id,
        from: row.category,
        to: target,
        source,
        score: best.score,
        runners_up: categories.slice(1),
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
      score: best.score,
      runners_up: categories.slice(1),
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
