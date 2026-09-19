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
import {
  suggestCategories,
  type Suggestion,
  type SuggestionSource,
} from './categorySuggest.js';
import { categoryLabelPath, nearestKnownAncestor } from './matchRules.js';
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

/** A pair of raw floors, one per way of measuring closeness. */
type FloorSet = typeof DEFAULT_MIN_SCORE;

// ---------------------------------------------------------------------------
// AND THE SECOND FLOOR, WHICH IS ABOUT CONFIDENCE RATHER THAN CLOSENESS.
//
// Clearing the floor above says the nearest node is not a stranger. It does
// not say the switchboard knows which node. The rehearsal of 19 September:
// 'goods.sim-racing.pedal-parts' snapped onto goods.motoring at 0.625, with
// the runners-up scattered across motoring, bicycle parts and equestrian. Sim
// racing is not motoring. The want for the other half of that pair would have
// gone up under electronics, and the category gate would have kept the two
// apart in silence — which is the whole defect the snap exists to close, done
// one shelf further along.
//
// So a specific node is only taken when BOTH of these hold: the top answer is
// close on its own terms, and the field behind it agrees about the branch. A
// runner-up under the same second-level branch is agreement; a runner-up from
// somewhere else has to be beaten by a margin before the top answer counts as
// a decision rather than a coin landing.
//
// That rule still stands, and the block below is about the RULER it is read
// off: the two raw-cosine numbers this block bought came from one rehearsal,
// and it turned out they could not have been earned, because the quantity they
// were set on does not hold still.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AND WHY THOSE TWO NUMBERS ARE NO LONGER THE ONES THE DOOR READS (20 Sept).
//
// The pair below are raw-cosine numbers, and a raw cosine turned out not to
// mean the same thing from one question to the next. When the door started
// asking about the posting's words as well as its path, every query got longer
// and more mixed, and every cosine in the catalogue fell with it — measured on
// dev's own corpus, 'goods.sim-racing.pedals' scores 0.52 against its nearest
// node asked alone and 0.24 asked with the posting's words, with nothing about
// the right answer changed. A 0.55 floor then rejected EVERY answer, correct
// ones included, so `best` was never set, the unclear branch below was never
// reached — it can only be reached when there is a best — and every unknown
// path fell silently to its top level with no score at all. Twelve postings in
// ninety minutes on 19 September, and not one SHELF_UNCLEAR in thirty runs.
//
// The instrument was wrong, not the setting. Across twelve realistic postings
// there is no raw cosine that separates right from wrong: the one wrong top
// answer scored 0.204 and three correct ones scored 0.258, 0.270 and 0.278.
// What does separate them is how far the top answer stands out from the other
// 498 nodes the same question was compared against (categorySuggest lead):
// run end to end through this function against dev's own corpus, every answer
// that was right led the field by 4.22 standard deviations or more, and the
// one that was wrong by 3.73.
//
// So the embedding side is judged on the lead, and the two numbers below stay
// exactly as they were for the lexical side, which has its own scale and has
// not been remeasured.
// ---------------------------------------------------------------------------

/** Below this, a LEXICAL top answer is not a decision whatever the field behind it. */
export const SHELF_CONFIDENT_MIN = 0.75;
/** How far a LEXICAL top answer must beat the nearest answer from another branch. */
export const SHELF_BRANCH_MARGIN = 0.08;

/**
 * On the embedding side: how far in front of the field the top answer must
 * stand before it is filed without asking.
 *
 * Measured, 20 September, twelve realistic postings put through this function
 * against dev's catalogue: ten landed on the node a person would have chosen,
 * leading the field by 4.22 to 8.87; an eleventh landed on a sibling of it
 * (a wheelset under road bikes rather than bike parts, which the matcher's
 * sibling rule still lets meet); and the twelfth — a Fanatec sim-racing brake
 * spring, which this catalogue has no shelf for at all — led by 3.73 and is
 * the one that should be asked about. Set between the two, nearer the wrong
 * one, because the failure this whole file exists to stop is a confident wrong
 * answer filed in silence.
 *
 * TWELVE POSTINGS IS TWELVE POSTINGS. It is more than the one rehearsal the
 * old numbers came from and it is still not much. The jev_shadow table is
 * collecting a second opinion on the same question (src/shadow/jevTrials.ts,
 * trial A); tune this against that before trusting it further.
 */
export const SHELF_CONFIDENT_LEAD = 4.0;

/**
 * And below THIS the answer is not a candidate at all — the node does not
 * stand out from the catalogue, so there is nothing worth putting to a human
 * and the posting goes up on its own line. This one is not measured: nothing
 * in the twelve came anywhere near it. It is deliberately low, because a
 * shortlist with a real answer on it is a question a person can settle in a
 * sentence and the top level is not.
 */
export const SHELF_MIN_LEAD = 2.0;

/**
 * How far the top answer must beat the nearest answer from ANOTHER branch,
 * in the same standard deviations. Measured on the same twelve: where the
 * runner-up was from another branch and the top answer was right, it led it by
 * 1.29 or more; where the runner-up was from the same branch the margin does
 * not apply, and those ran as close as 0.28.
 */
export const SHELF_BRANCH_MARGIN_LEAD = 1.0;
/** How many shelves a refusal offers, one per branch. */
export const SHELF_CANDIDATE_LIMIT = 4;
/** The last option on that list: the human may recognise none of them. */
export const SHELF_NONE_OPTION = 'none_of_these';

/** The second-level branch a node sits under: 'goods.motoring' for a car part. */
const branchOf = (category: string): string => category.split('.').slice(0, 2).join('.');

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
  | 'unclear' // something was close, nothing was convincing: ask the human
  | 'unmatched'; // nothing was close enough and the caller asked to be left alone

/** One shelf to put to the human, on an unclear decision. */
export interface ShelfChoice {
  category: string;
  /** The node in plain words: "car parts", "games console accessories". */
  words: string;
}

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
  /**
   * And how far in front of the catalogue it stood, in standard deviations.
   * This is what the decision was actually made on wherever the embedding
   * answered; the raw score above moves with the shape of the question and is
   * kept because it is what was measured. See categorySuggest.Suggestion.lead.
   */
  lead?: number;
  /** The other answers considered, nearest first. */
  runners_up?: string[];
  /** On 'unclear': the shelves to put to the human, one per branch. */
  candidates?: ShelfChoice[];
  /**
   * The nodes that were weighed, nearest first, each with its lead where the
   * embedding gave one. Kept for the shelf gap log (domain/shelfGaps.ts),
   * which records up to five of them beside every decision the door was
   * unsure of.
   */
  shortlist?: { category: string; lead?: number }[];
  /**
   * On 'suggestion': whether the field agreed about the branch (confidentIn).
   * Always true at the publish door, which asks instead of filing an
   * unconfident answer; an amend or the sweep can file one, and the gap log
   * wants to know when it did.
   */
  confident?: boolean;
}

/**
 * The node in the words a person would use for it. The whole label path reads
 * as a database breadcrumb — "Secondhand consumer goods > Motoring > Car parts"
 * — and what a human is being asked is only which of four things it is, so the
 * node's own label is the whole of the answer.
 */
export function categoryWords(category: string): string {
  const labels = categoryLabelPath(category).split(' > ');
  return (labels[labels.length - 1] ?? category).toLowerCase();
}

/** True where the taxonomy holds this exact node and nobody has closed it. */
const openNode = (category: string): boolean =>
  categoryStatus(category).status === 'open' && !categoryDenied(category);

/**
 * Is the winning answer a decision or a coin landing?
 *
 * Two conditions, both of them about the field rather than about the node. It
 * has to be close on its own terms; and the answers behind it have to agree
 * about the branch, either by being in it or by being far enough behind that
 * their disagreement carries no weight. See the note on SHELF_CONFIDENT_MIN
 * for the run that bought both numbers, and for the fact that neither is
 * earned yet.
 */
function confidentIn(best: Suggestion, ranked: Suggestion[]): boolean {
  // Which ruler: the lead where the embedding side gave one, the raw score
  // otherwise. See SHELF_CONFIDENT_LEAD for why the two are not the same ruler.
  const lead = typeof best.lead === 'number';
  const of = (s: Suggestion) => (lead ? (s.lead ?? 0) : s.score);
  const floor = lead ? SHELF_CONFIDENT_LEAD : SHELF_CONFIDENT_MIN;
  const margin = lead ? SHELF_BRANCH_MARGIN_LEAD : SHELF_BRANCH_MARGIN;
  if (of(best) < floor) return false;
  const rest = ranked.filter((s) => s.category !== best.category);
  if (!rest.length) return true;
  if (branchOf(rest[0].category) === branchOf(best.category)) return true;
  const elsewhere = rest.find((s) => branchOf(s.category) !== branchOf(best.category));
  if (!elsewhere) return true;
  return of(best) - of(elsewhere) >= margin;
}

/**
 * Is this answer worth putting to anybody — as a shelf to file under, or as a
 * shelf to ask about? On the embedding side that is the lead; on the lexical
 * side it is the old raw floor, which is the only thing that side has.
 */
function worthOffering(
  s: Suggestion,
  source: SuggestionSource,
  floor: FloorSet,
  minLead: number,
): boolean {
  if (!openNode(s.category)) return false;
  if (typeof s.lead === 'number') return s.lead >= minLead;
  return s.score >= floor[source];
}

/**
 * THE PATH THE ASSISTANT WROTE IS A PRIOR, not evidence — but it is not
 * nothing either.
 *
 * Where two answers are within a hair of each other and one of them sits on
 * the line the posting was already filed on ('goods.motoring.*' for something
 * posted under 'goods.motoring.spares'), that one is the tie-break. The
 * assistant knew something when it wrote the top of the path, even where it
 * invented the bottom of it. Anything wider than a hair is left alone: the
 * words are the evidence and a prior does not get to overrule them.
 */
function preferAncestorLine(offerable: Suggestion[], from: string): Suggestion | undefined {
  const top = offerable[0];
  if (!top) return undefined;
  const line = nearestKnownAncestor(from);
  if (!line.includes('.')) return top; // A bare top level says nothing to tie-break on.
  if (top.category === line || top.category.startsWith(`${line}.`)) return top;
  const of = (s: Suggestion) => (typeof s.lead === 'number' ? s.lead : s.score);
  const hair = typeof top.lead === 'number' ? SHELF_BRANCH_MARGIN_LEAD / 2 : SHELF_BRANCH_MARGIN / 2;
  const onTheLine = offerable.find(
    (s) => s.category === line || s.category.startsWith(`${line}.`),
  );
  if (onTheLine && of(top) - of(onTheLine) < hair) return onTheLine;
  return top;
}

/**
 * The shelves to put to the human: one per branch, best first, and then the
 * honest last option. One per branch because offering four flavours of the
 * same wrong branch is not a choice; the disagreement between branches is the
 * whole reason anybody is being asked.
 *
 * `none_of_these` is what makes the list answerable rather than a trap. Sent
 * back as the category, it is answered with the searchable shelf page
 * (SHELF_PICK, domain/shelfPick.ts; cards.ts publishIntent).
 */
function shelfChoices(ranked: { category: string; score: number }[]): ShelfChoice[] {
  const chosen: ShelfChoice[] = [];
  const branches = new Set<string>();
  for (const s of ranked) {
    if (chosen.length >= SHELF_CANDIDATE_LIMIT) break;
    if (!openNode(s.category)) continue;
    const branch = branchOf(s.category);
    if (branches.has(branch)) continue;
    branches.add(branch);
    chosen.push({ category: s.category, words: categoryWords(s.category) });
  }
  chosen.push({ category: SHELF_NONE_OPTION, words: 'none of these' });
  return chosen;
}

/** The weighed nodes as the gap log keeps them: a path and a lead, no more. */
const shortlistOf = (ranked: Suggestion[]): { category: string; lead?: number }[] =>
  ranked.slice(0, 5).map((s) => ({
    category: s.category,
    ...(typeof s.lead === 'number' ? { lead: s.lead } : {}),
  }));

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
    /**
     * The posting's own words, where the caller holds them. They are asked
     * about alongside the path, because the path is a guess and the words are
     * evidence (see categorySuggest.askText).
     */
    posting?: { kind?: string | null; attributes?: unknown };
    /**
     * Where the suggestions are close but scattered, answer 'unclear' with the
     * shelves rather than picking one. Only the publish door asks for this:
     * the ops sweep is reading rows that are already up, and an amend must
     * never take a posting down for being what it already was.
     */
    askWhenUnsure?: boolean;
  } = {},
): Promise<SnapDecision> {
  const from = String(category ?? '');
  if (openNode(from)) return { category: from, from, changed: false, how: 'as-posted' };
  // Which floor depends on what the caller does when nothing clears it: a
  // caller with the ancestor to fall back on can afford to be fussier.
  const base = opts.fallbackToAncestor ? DOOR_MIN_SCORE : DEFAULT_MIN_SCORE;
  const floor = { ...base, ...(opts.minScore ?? {}) };
  // And the same question on the embedding side's own ruler. The door can put
  // a middling answer to the human, so anything that stands out from the
  // catalogue is worth having on the list. The sweep has nobody to ask and is
  // MOVING A ROW THAT IS ALREADY UP, so it only acts where it would have been
  // confident enough to file the posting at the door without asking.
  const minLead = opts.fallbackToAncestor ? SHELF_MIN_LEAD : SHELF_CONFIDENT_LEAD;

  let source: SuggestionSource | undefined;
  let best: Suggestion | undefined;
  let runnersUp: string[] = [];
  let ranked: Suggestion[] = [];
  let offerable: Suggestion[] = [];
  try {
    // Five rather than three: the top answer may be a family somebody closed,
    // and the point of asking is to have an open one left after that.
    const result = await suggestCategories(cfg, from, 5, log, {
      // Path AND words, framed in one plain register (categorySuggest.askText).
      // The path alone is what the assistant guessed, and in the rehearsal it
      // shared tokens with three branches and with nothing that was actually
      // in the box.
      ...(opts.posting ? { posting: opts.posting } : {}),
    });
    source = result.source;
    runnersUp = result.categories;
    ranked = result.scored;
    offerable = result.scored.filter((s) => worthOffering(s, result.source, floor, minLead));
    best = preferAncestorLine(offerable, from);
    if (result.source === 'lexical') {
      // The last resort, said out loud at the door too: this answer was read
      // off the shape of a string, not off what the posting says it is.
      log('snap: the embedder was not there, this is the lexical answer', {
        category: from,
        best: best?.category ?? null,
        score: best?.score ?? null,
      });
    }
  } catch (e: any) {
    log('snap: suggester unavailable', { category: from, error: e?.message });
  }
  if (best && opts.askWhenUnsure && !confidentIn(best, ranked)) {
    // Close enough to be worth asking about, scattered enough that picking
    // one would be a guess. The human whose thing it is can settle it in a
    // sentence, so the posting waits and they are asked.
    return {
      category: from,
      from,
      changed: false,
      how: 'unclear',
      source,
      score: best.score,
      lead: best.lead,
      runners_up: runnersUp.filter((c) => c !== best!.category),
      // Only answers that are actually worth a person's attention: the shelves
      // put to them are the ones that stood out from the catalogue, best
      // first, one per branch.
      candidates: shelfChoices(offerable.length ? offerable : ranked),
      shortlist: shortlistOf(ranked),
    };
  }
  if (best) {
    return {
      category: best.category,
      from,
      changed: best.category !== from,
      how: 'suggestion',
      source,
      score: best.score,
      lead: best.lead,
      runners_up: runnersUp.filter((c) => c !== best!.category),
      shortlist: shortlistOf(ranked),
      confident: confidentIn(best, ranked),
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
        shortlist: shortlistOf(ranked),
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
