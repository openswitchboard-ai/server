/**
 * THE TWO TRIALS, AND THE LINE EACH ONE DOES NOT CROSS.
 * (The client and the reasoning for the whole thing: src/shadow/jev.ts.
 *  What is sent and what never is: docs/jev-shadow.md.)
 *
 * TRIAL A, "category at the door". After a posting passes screening, the
 * switchboard has already filed it under a taxonomy node — by an embedding
 * cosine against the node paths, with the poster's own path snapped onto the
 * nearest known one when it named a branch nobody has written down
 * (domain/categoryBackfill.ts). Jev is shown the same posting and the same
 * shortlist, and asked to pick. Two answers to one closed question, side by
 * side, and neither of them files anything.
 *
 * TRIAL B, "near-miss pair scoring". Where the engine has already scored a
 * want against a have, Jev is asked the plain question underneath the score:
 * is the thing the have offers the thing the want is looking for. It is asked
 * only about pairs that got near enough to be interesting (0.45 and up, the
 * five best per run), because the point is to learn about the boundary, and
 * two postings with nothing to do with each other teach nobody anything.
 *
 * WHAT GOES OUT, EXACTLY.
 *
 *   Trial A   { kind, attributes }
 *   Trial B   { want: { kind, category_label, attributes },
 *               have: { kind, category_label, attributes } }
 *
 * AND WHAT NEVER DOES: the price band, the geography in any form — bucket,
 * lat, lon, radius, country — the account id, the card id, the email, the ask,
 * the urgency, the conversation, and every other piece of free text this
 * service holds. `kind` is the poster's own handful of words for the thing,
 * which is already shown to the other side of every introduction; `attributes`
 * are the structured facts they chose to assert. Nothing else is needed to
 * answer either question, so nothing else is sent. The builders below are the
 * only place that decides this, and the suite asserts on their exact key sets
 * rather than on a promise.
 *
 * NOTHING HERE CAN FAIL A CALLER. Both entry points swallow everything,
 * including their own database write, and both are started rather than
 * awaited. The screening worker and the matching run answered before this ran
 * and would answer identically if it had never run at all.
 */
import { getPool } from '../db.js';
import { categoryLabelPath } from '../domain/matchRules.js';
import { taxonomyKnows } from '../denylist.js';
import { suggestCategories } from '../domain/categorySuggest.js';
import { askJev, jevEnabled, type JevQuestion, type JevResult } from './jev.js';
import type { Config } from '../config.js';

/**
 * How many of the suggester's answers go on the ballot.
 *
 * FIVE, NOT TWELVE. TypeSafe's own consistency cookbook puts the tested sweet
 * spot for a choice question at four to six mutually exclusive options with a
 * short description each; past that, small differences in wording start moving
 * the label around and the answer stops being about the posting. The API will
 * take 255 options and that is not a reason to send them.
 */
export const JEV_CANDIDATE_LIMIT = 5;

/**
 * The ceiling on TAXONOMY options: the five candidates, plus the node we filed
 * the posting under and the one the assistant wrote, where those are known
 * nodes and not already on the list. Over the ceiling, the lowest-scored
 * candidates come off first — the two we add are the ones the trial is about.
 * `none_of_these` sits outside this count.
 */
export const JEV_MAX_OPTIONS = 7;

/**
 * The option that makes the set exhaustive as well as exclusive. Without it a
 * model with nothing that fits has to pick the least bad node, and a forced
 * answer read later as a real one is the worst kind of row in this table.
 */
export const JEV_NONE_OPTION = 'none_of_these';

/**
 * Above this top probability, Jev's choice counts as decided; below it the row
 * is an uncertain one and the report counts it separately.
 *
 * 0.60 IS TYPESAFE'S ILLUSTRATIVE FIGURE, from their application-policy note,
 * and it is not ours until somebody has validated it against our own labelled
 * postings. It is stored as a derived flag rather than applied to anything,
 * which is exactly the kind of number that should not be quietly load-bearing
 * before it has been checked.
 */
export const JEV_CHOICE_DECIDED_MIN_P = 0.6;

/**
 * The noul bands, also TypeSafe's: a noul is not a probability, and their
 * guidance is to read it as yes above 0.70, no below 0.30, and nothing in
 * between. The raw value is stored beside the band, so re-reading these rows
 * under different bands later costs nothing.
 */
export const JEV_NOUL_YES = 0.7;
export const JEV_NOUL_NO = 0.3;

export type JevNoulBand = 'yes' | 'no' | 'uncertain';

/** Same rule everywhere, so the report and the trial cannot drift apart. */
export function noulBand(v: number | null | undefined): JevNoulBand | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v > JEV_NOUL_YES) return 'yes';
  if (v < JEV_NOUL_NO) return 'no';
  return 'uncertain';
}

/** The score at which a pair is close enough to be worth a second opinion. */
export const JEV_PAIR_MIN_SCORE = 0.45;

/** How many pairs one matching run will ask about. */
export const JEV_PAIR_LIMIT = 5;

/** The ladder trial B scores a pair on, worst first. The wording is the plain
 *  question a person would ask, not the engine's vocabulary: "near miss" and
 *  "match" mean things here that they do not mean to an outside model. */
export const JEV_FIT_LEVELS = [
  'Different things',
  'Related but not what is wanted',
  'Probably what is wanted',
  'Exactly what is wanted',
];

// ---------------------------------------------------------------------------
// The state builders. These two functions are the privacy boundary.
// ---------------------------------------------------------------------------

/** Only ever these keys. A card carries far more and none of the rest leaves. */
export interface JevCategoryState {
  kind: string | null;
  attributes: Record<string, unknown>;
}

export interface JevPairSide {
  kind: string | null;
  category_label: string;
  attributes: Record<string, unknown>;
}

export interface JevPairState {
  want: JevPairSide;
  have: JevPairSide;
}

/**
 * Attributes, reduced to the scalars. An attribute value that is an object or
 * an array is somewhere a stray free-text blob could hide, and the structured
 * facts this trial is about are all strings, numbers and booleans anyway.
 */
/** The highest probability on the ballot, or 0 where none came back. */
export function topProbability(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities ?? {}).filter((n) => Number.isFinite(n));
  return values.length ? Math.max(...values) : 0;
}

function scalarAttributes(attributes: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attributes || typeof attributes !== 'object') return out;
  for (const [k, v] of Object.entries(attributes as Record<string, unknown>)) {
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

export function jevCategoryState(card: {
  kind?: string | null;
  attributes?: unknown;
}): JevCategoryState {
  return { kind: card.kind ?? null, attributes: scalarAttributes(card.attributes) };
}

function pairSide(card: {
  kind?: string | null;
  category: string;
  attributes?: unknown;
}): JevPairSide {
  return {
    kind: card.kind ?? null,
    // The label path in words, not the dotted key: "Goods > Bikes > Road" is a
    // question anybody can answer and 'goods.bikes.road' is a database row.
    category_label: categoryLabelPath(card.category),
    attributes: scalarAttributes(card.attributes),
  };
}

export function jevPairState(
  want: { kind?: string | null; category: string; attributes?: unknown },
  have: { kind?: string | null; category: string; attributes?: unknown },
): JevPairState {
  return { want: pairSide(want), have: pairSide(have) };
}

// ---------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------

/**
 * The ballot for trial A: the suggester's shortlist, plus the node we filed
 * the posting under, plus the one the assistant actually wrote, plus a way of
 * saying none of them.
 *
 * THE MIDDLE TWO MATTER MORE THAN THEY LOOK. If the node we chose is not an
 * option, Jev cannot agree with us and every row is a disagreement about
 * nothing. If the assistant's own path is not an option, the case this trial
 * exists to study — a posting filed somewhere it does not belong because the
 * path it named was not in the catalogue — has had its most interesting answer
 * removed from the ballot before the question was asked. Both go on only when
 * the catalogue actually knows them: an invented branch has no label path, so
 * its description would be its own slug read back, which is not an option a
 * model can weigh against six real ones.
 *
 * Over the ceiling, the lowest-scored candidate comes off rather than either
 * of those two, for the same reason.
 *
 * Option key is the node id; the description is its label path in words,
 * because that is the form of the question a model can answer.
 */
export function jevCategoryQuestion(
  candidates: { id: string; score: number }[],
  current: string,
  asPosted?: string | null,
): JevChoiceQuestionWithOptions {
  // Best first, so "drop the lowest-scored" is just a pop.
  const ranked = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, JEV_CANDIDATE_LIMIT)
    .map((c) => String(c.id ?? '').trim())
    .filter(Boolean);

  const ids: string[] = [];
  for (const id of ranked) if (!ids.includes(id)) ids.push(id);

  // The two that are the point of the trial, kept even when the list is full.
  for (const id of [current, asPosted]) {
    const key = String(id ?? '').trim();
    if (!key || ids.includes(key) || !taxonomyKnows(key)) continue;
    if (ids.length >= JEV_MAX_OPTIONS) ids.pop();
    ids.push(key);
  }

  const criteria: Record<string, string> = {};
  for (const id of ids.slice(0, JEV_MAX_OPTIONS)) criteria[id] = categoryLabelPath(id);
  // Last, and outside the ceiling: the set has to be exhaustive as well as
  // exclusive or a model with nothing that fits is forced into a real answer.
  criteria[JEV_NONE_OPTION] = 'None of these fits the thing';
  return {
    type: 'choice',
    instructions:
      'This is something a person has posted, in their own words, with the ' +
      'facts they chose to state. Which of these categories does it belong in?',
    criteria,
  };
}

type JevChoiceQuestionWithOptions = Extract<JevQuestion, { type: 'choice' }>;

/**
 * All of trial B, asked in one request: the API evaluates questions in
 * parallel, so three nouls and a score cost about what one noul costs.
 *
 * WHY A RUBRIC RATHER THAN ONE QUESTION. "Is this the thing they want" folds
 * three different failures into one number — wrong kind of thing, right kind
 * but ruled out by something either side stated, right kind and compatible but
 * not the specific model named — and a single noul cannot tell us which of
 * them our score is getting wrong. Every one is phrased so that YES MEANS THE
 * CONDITION HOLDS, which is what makes the bands readable in one direction.
 */
export function jevPairQuestions(): Record<string, JevQuestion> {
  return {
    same_kind_of_thing: {
      type: 'noul',
      instructions:
        'Is what the HAVE offers the same kind of thing the WANT is asking for?',
    },
    compatible: {
      type: 'noul',
      instructions:
        'Is everything stated on both sides compatible — that is, does nothing ' +
        'either side has said about brand, model, size or condition rule the ' +
        'other out?',
    },
    same_specific_item: {
      type: 'noul',
      instructions:
        'Is what the HAVE offers the same specific product or model the WANT ' +
        'names, where the WANT names one?',
      criteria: {
        true: 'The WANT names a specific product or model and the HAVE offers it.',
        false:
          'The HAVE offers a different specific product or model, or the WANT ' +
          'never names one.',
      },
    },
    fit: {
      type: 'score',
      instructions:
        'How well does what the HAVE offers fit what the WANT is looking for?',
      criteria: JEV_FIT_LEVELS,
    },
  };
}

// ---------------------------------------------------------------------------
// Writing it down.
// ---------------------------------------------------------------------------

export interface JevShadowRow {
  trial: 'category' | 'pair';
  cardId?: string | null;
  otherCardId?: string | null;
  ours: unknown;
  jev: unknown;
  latencyMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

/** One row. Swallows its own failure: a shadow that can wake somebody up at
 *  night by failing to insert is not worth having. */
export async function recordJevShadow(row: JevShadowRow): Promise<void> {
  await getPool().query(
    `INSERT INTO jev_shadow (trial, card_id, other_card_id, ours, jev,
                             latency_ms, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.trial,
      row.cardId ?? null,
      row.otherCardId ?? null,
      JSON.stringify(row.ours),
      JSON.stringify(row.jev),
      row.latencyMs ?? null,
      row.usage?.input_tokens ?? null,
      row.usage?.output_tokens ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// The two entry points. Both are fire-and-forget and neither ever throws.
// ---------------------------------------------------------------------------

type Log = (msg: string, extra?: any) => void;

/**
 * Trial A, for one posting that has just passed screening.
 *
 * Started, never awaited. It runs a suggester call (which may embed, and which
 * has its own cache) and one HTTP request, and the worker has already deleted
 * the message and moved on by the time either finishes.
 *
 * It returns a promise ONLY so the suite can wait for it. The promise never
 * rejects — every path through here is caught — and no caller in the service
 * awaits it or may start awaiting it.
 */
export function shadowCategoryTrial(
  cfg: Config,
  card: {
    id: string;
    kind?: string | null;
    category: string;
    category_as_posted?: string | null;
    attributes?: unknown;
  },
  log: Log = () => {},
): Promise<void> {
  if (!jevEnabled()) return Promise.resolve();
  return (async () => {
    try {
      const suggested = await suggestCategories(cfg, card.category, JEV_CANDIDATE_LIMIT);
      const candidates = suggested.scored.map((s) => ({ id: s.category, score: s.score }));
      const question = jevCategoryQuestion(candidates, card.category, card.category_as_posted);
      const result = await askJev(jevCategoryState(card), { category: question });
      if (!result.ok) {
        // The reason is a status word, never a body and never the posting.
        log('jev shadow: category trial got no answer', {
          card_id: card.id,
          reason: result.reason,
        });
        return;
      }
      const answer = result.answers.category;
      if (!answer || answer.type !== 'choice') return;
      await recordJevShadow({
        trial: 'category',
        cardId: card.id,
        ours: {
          category: card.category,
          category_as_posted: card.category_as_posted ?? null,
          candidates,
        },
        jev: {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          // Derived here and stored, so the report does not have to know the
          // policy and every row carries the reading it was given. Neither
          // field is acted on: `decided` is a label on a record, not a gate.
          top_p: topProbability(answer.probabilities),
          decided: topProbability(answer.probabilities) >= JEV_CHOICE_DECIDED_MIN_P,
        },
        latencyMs: result.latencyMs,
        usage: result.usage,
      });
      log('jev shadow: category recorded', {
        card_id: card.id,
        agreed: answer.choice === card.category,
      });
    } catch (e: any) {
      log('jev shadow: category trial failed', { card_id: card.id, error: e?.message });
    }
  })();
}

/** One pair the engine has already judged, as trial B needs it. */
export interface JevPairCandidate {
  want: { id: string; kind?: string | null; category: string; attributes?: unknown };
  have: { id: string; kind?: string | null; category: string; attributes?: unknown };
  score: number;
  decision: string;
  weights?: unknown;
}

/**
 * Trial B, for the best few pairs of one matching run.
 *
 * Called once, after the run has finished deciding everything, with whatever
 * it collected. Started, never awaited: the run's own answers are already
 * written and its return value is already on its way back to the worker.
 */
export function shadowPairTrials(pairs: JevPairCandidate[], log: Log = () => {}): Promise<void> {
  if (!jevEnabled() || !pairs.length) return Promise.resolve();
  const best = pairs
    .filter((p) => p.score >= JEV_PAIR_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, JEV_PAIR_LIMIT);
  if (!best.length) return Promise.resolve();
  return (async () => {
    for (const pair of best) {
      try {
        const result: JevResult = await askJev(
          jevPairState(pair.want, pair.have),
          jevPairQuestions(),
        );
        if (!result.ok) {
          log('jev shadow: pair trial got no answer', { reason: result.reason });
          // A rate limit or an outage applies to the next pair too; stop
          // rather than spend four more timeouts finding that out again.
          return;
        }
        const fit = result.answers.fit;
        // Each noul with the band it falls in beside it. The raw value is kept
        // because the bands are TypeSafe's illustrative ones and re-reading
        // these rows under different ones should cost nothing.
        const noul = (id: string) => {
          const a = result.answers[id];
          const v = a?.type === 'noul' ? a.noul : null;
          return { value: v, band: noulBand(v) };
        };
        await recordJevShadow({
          trial: 'pair',
          cardId: pair.want.id,
          otherCardId: pair.have.id,
          ours: {
            score: Number(pair.score.toFixed(4)),
            decision: pair.decision,
            ...(pair.weights ? { weights: pair.weights } : {}),
          },
          jev: {
            same_kind_of_thing: noul('same_kind_of_thing'),
            compatible: noul('compatible'),
            same_specific_item: noul('same_specific_item'),
            fit_score: fit?.type === 'score' ? fit.score : null,
            fit_legend: fit?.type === 'score' ? fit.legend : null,
            fit_confidence: fit?.type === 'score' ? fit.confidence : null,
          },
          latencyMs: result.latencyMs,
          usage: result.usage,
        });
      } catch (e: any) {
        log('jev shadow: pair trial failed', { error: e?.message });
      }
    }
  })();
}
