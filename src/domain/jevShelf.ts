/**
 * JEV HELPS CHOOSE THE SHELF AT THE DOOR (founder, 1 October 2026).
 *
 * The door files a posting sent under a path the catalogue does not know by
 * how far the nearest shelves stand out from the rest (categoryBackfill.ts
 * snapCategory). Where that is unsure it asks the human (SHELF_UNCLEAR), and
 * where it is sure but wrong the two halves of a pair end up on different
 * lines and never meet. This module puts the door's own shortlist to
 * TypeSafe's Jev in exactly those cases and lets a confident answer decide.
 *
 * WHEN. Only at the publish door (never an amend, never the ops sweep), only
 * where JEV_SHELF is on (config.ts: on in dev, OFF in prod unless set), and
 * only where one of these holds (categoryBackfill.jevShelfReasons):
 *   - the door would answer SHELF_UNCLEAR;
 *   - the best shelf is under a different top level than the one the
 *     assistant wrote (a thing filed as a service, say);
 *   - the top two shelves are from different branches and within
 *     SHELF_BRANCH_MARGIN_LEAD of each other.
 * Category refusals (the deny list, closed families) have already run.
 *
 * WHAT IT IS OFFERED. The door's offerable shortlist (at most five OPEN
 * shelves, best first), the nearest shelf the catalogue knows on the line the
 * assistant wrote where that is an open shelf below the top level, and "none
 * of these". Each is described by its label path in words.
 *
 * WHAT IT DECIDES.
 *   - A shelf at p >= JEV_SHELF_MIN_P: filed there, provided it is one of the
 *     options and still open (re-checked by the caller; a closed or
 *     deny-listed shelf is never reached).
 *   - "None of these" at p >= JEV_SHELF_MIN_P, where the door would have asked:
 *     the searchable shelf page (SHELF_PICK) instead of the list.
 *   - Anything else — lower p, a timeout (JEV_SHELF_TIMEOUT_MS), an error, an
 *     answer that is not an option, the flag off — the door's own answer, as
 *     before.
 *
 * WHAT IS SENT is jevTrials.jevCategoryState and the options' label paths:
 * the poster's few words for the thing and its plain attributes with contact
 * details, names, places and prices taken out. Never an id, a price, a place,
 * a name, also_called or not_these.
 *
 * WHAT IS LOGGED: ids, the decision, p and latency. Never a posting's words.
 */
import { categoryDenied, categoryStatus } from '../denylist.js';
import { askJevForShelf, jevShelfEnabled, type JevQuestion, type JevResult } from '../shadow/jev.js';
import { JEV_NONE_OPTION, jevCategoryState } from '../shadow/jevTrials.js';
import { categoryLabelPath } from './matchRules.js';

/** One call, one attempt: a posting is waiting. */
export const JEV_SHELF_TIMEOUT_MS = 2_000;
/** Jev's probability for its answer must be at least this to decide anything. */
export const JEV_SHELF_MIN_P = 0.7;
/** How many of the door's shelves are offered. */
export const JEV_SHELF_OPTIONS = 5;

/** Why Jev was asked. */
export type JevShelfReason = 'unclear' | 'crosses-top' | 'close-branches';

export interface JevShelfRequest {
  /** Open shelves, best first; the caller has already filtered them. */
  options: string[];
  posting: { kind?: string | null; attributes?: unknown };
  reasons: JevShelfReason[];
}

export type JevShelfVerdict =
  | { decision: 'pick'; category: string; p: number; latencyMs: number }
  | { decision: 'none'; p: number; latencyMs: number }
  | { decision: 'rules'; reason: string; p?: number; latencyMs?: number };

const openShelf = (c: string): boolean => categoryStatus(c).status === 'open' && !categoryDenied(c);

/** The one choice question: each option by its label path, plus none of these. */
export function jevShelfQuestion(options: string[]): Record<string, JevQuestion> {
  const criteria: Record<string, string> = {};
  for (const id of options) criteria[id] = categoryLabelPath(id);
  criteria[JEV_NONE_OPTION] = 'None of these fits the thing';
  return {
    shelf: {
      type: 'choice',
      instructions:
        'This is something a person has posted, in their own words, with the ' +
        'facts they chose to state. Which of these categories does it belong in?',
      criteria,
    },
  };
}

type Ask = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResult>;
type Log = (msg: string, extra?: any) => void;

/**
 * Ask Jev which of the door's shelves this is. Never throws, and never waits
 * much longer than one timeout. A 'rules' verdict means the door's own answer
 * stands.
 */
export async function chooseShelfWithJev(
  req: JevShelfRequest,
  log: Log = () => {},
  opts: { ask?: Ask; enabled?: boolean; timeoutMs?: number; ids?: Record<string, unknown> } = {},
): Promise<JevShelfVerdict> {
  const enabled = opts.enabled ?? jevShelfEnabled();
  if (!enabled) return { decision: 'rules', reason: 'disabled' };
  const options = [...new Set(req.options)].filter(openShelf);
  if (!options.length) return { decision: 'rules', reason: 'no-options' };
  const timeoutMs = opts.timeoutMs ?? JEV_SHELF_TIMEOUT_MS;
  const ask: Ask = opts.ask ?? ((state, questions) => askJevForShelf(state, questions, { timeoutMs }));
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let verdict: JevShelfVerdict;
  try {
    const result = await Promise.race<JevResult>([
      ask(jevCategoryState(req.posting), jevShelfQuestion(options)),
      new Promise<JevResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs + 250);
      }),
    ]);
    const latencyMs = result.ok ? result.latencyMs : Date.now() - started;
    if (!result.ok) {
      verdict = { decision: 'rules', reason: result.reason, latencyMs };
    } else {
      const a = result.answers.shelf;
      if (!a || a.type !== 'choice') {
        verdict = { decision: 'rules', reason: 'incomplete', latencyMs };
      } else {
        const fromProbs = a.probabilities?.[a.choice];
        const p = Number.isFinite(fromProbs) ? (fromProbs as number) : Number.isFinite(a.confidence) ? a.confidence : 0;
        if (p < JEV_SHELF_MIN_P) verdict = { decision: 'rules', reason: 'low-p', p, latencyMs };
        else if (a.choice === JEV_NONE_OPTION) verdict = { decision: 'none', p, latencyMs };
        else if (!options.includes(a.choice) || !openShelf(a.choice))
          verdict = { decision: 'rules', reason: 'not-an-option', p, latencyMs };
        else verdict = { decision: 'pick', category: a.choice, p, latencyMs };
      }
    }
  } catch (e: any) {
    verdict = { decision: 'rules', reason: e?.name === 'AbortError' ? 'timeout' : 'error', latencyMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
  log('publish: jev shelf choice', {
    ...(opts.ids ?? {}),
    decision: verdict.decision,
    ...(verdict.decision === 'rules' ? { reason: verdict.reason } : {}),
    reasons: req.reasons,
    p: typeof verdict.p === 'number' ? Number(verdict.p.toFixed(3)) : null,
    latency_ms: verdict.latencyMs ?? null,
  });
  return verdict;
}
