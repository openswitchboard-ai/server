/**
 * JEV AS THE JUDGE ON THE BORDERLINE (founder, 29 September 2026).
 *
 * The tiers in matchTiers.ts are a cosine and a word overlap, and the pairs
 * they get wrong are the ones in the middle: the maybes, the near misses and
 * the sures that rest on the cosine alone. An offline comparison on the
 * labelled calibration set (test/calibration) found TypeSafe's Jev answered
 * those better than the rules, with no NOTHING pair called SURE, so from
 * today Jev decides them wherever JEV_MATCHING is on (config.ts: on in dev,
 * off in prod unless set; it has been set on in prod since 1 October 2026).
 *
 * WHICH PAIRS IT JUDGES. Only pairs that have already passed every hard rule
 * (geo, price, urgency, mutes, own account, the shelf gate) and that the rules
 * placed at POSSIBLE, NEAR-MISS, or SURE on closeness of meaning ('sure-close').
 * Never a pair the rules called NOTHING, never a SURE on THE WANT IS COVERED
 * (the rules read every word of the want in the have, which is the one SURE
 * that does not rest on the cosine), and never a swap: the questions ask
 * whether the HAVE is what the WANT wants, and a swap has two wants.
 *
 * HOW IT DECIDES, on the existing pair questions (jevTrials.jevPairQuestions):
 *   SURE      same_kind_of_thing >= 0.7 AND compatible >= 0.7, and the parts
 *             guard allows it (matchTiers.partsGuardAllowsSure: where either
 *             side is a part, the want must say what it fits, or it is a maybe);
 *   POSSIBLE  same_kind_of_thing >= 0.3 AND compatible > 0.3;
 *   NEAR-MISS otherwise. THE NEAR-MISS FLOOR (founder, 1 October 2026): Jev
 *             may lift a pair or keep it, but it never erases one. Every pair
 *             it is asked about is one the rules placed at NEAR-MISS or above,
 *             so where its answer would be NOTHING the pair is recorded as a
 *             near miss instead. A near miss never makes an introduction; it
 *             only means the switchboard can say "something close is here"
 *             rather than nothing (answers never say nothing while something
 *             waits). The usual case is same_kind_of_thing high and compatible
 *             low: the same kind of thing with a stated detail that conflicts.
 *
 * WHEN IT DOES NOT. The rules' own answer stands wherever Jev is off, not
 * configured, slow (JEV_JUDGE_TIMEOUT_MS per call, one attempt, no retry),
 * errors, or answers without both nouls. The matcher never waits longer than
 * one timeout: the calls for one posting are made together, and only for the
 * JEV_JUDGE_TOP_N best candidates by fit.
 *
 * WHAT IS SENT is jevPairState and nothing else: each side's kind, category
 * label and scalar attributes, with contact details, places, names and prices
 * taken out. Never a message, an account, a place, a band or an ask.
 *
 * WHAT IS LOGGED: ids, the two tiers, the three numbers and a reason word.
 * Never a posting's words.
 */
import { askJevForMatching, jevMatchingEnabled, type JevAnswer, type JevResult } from '../shadow/jev.js';
import { jevPairQuestions, jevPairState } from '../shadow/jevTrials.js';
import { partsGuardAllowsSure, type PostingWords, type Tier, type TierResult } from './matchTiers.js';

/** Per call, and so per matching run: the calls are made together. */
export const JEV_JUDGE_TIMEOUT_MS = 2_000;
/** How many candidates of one posting Jev is asked about, best fit first. */
export const JEV_JUDGE_TOP_N = 5;
/** same_kind_of_thing at or above this, for SURE. */
export const JEV_SURE_SAME_KIND_MIN = 0.7;
/**
 * same_kind_of_thing at or above this, for POSSIBLE: 0.3, the bottom of
 * TypeSafe's uncertain band. Set on 29 September 2026 after calibration: Jev
 * scores most labelled maybes (a specific want against a general have) between
 * 0.3 and 0.7 on this noul, so at 0.7 they fell to NOTHING (114/158 exact); at
 * 0.3 it is 136/158 with no false SURE or false POSSIBLE on a NOTHING pair.
 */
export const JEV_POSSIBLE_SAME_KIND_MIN = 0.3;
/** compatible at or above this, for SURE. */
export const JEV_SURE_COMPATIBLE_MIN = 0.7;
/** compatible strictly above this, for POSSIBLE. */
export const JEV_POSSIBLE_COMPATIBLE_ABOVE = 0.3;

export type Judge = 'rules' | 'jev';

/** Does the judge get asked about a pair the rules placed like this? */
export function jevJudgesTier(rules: Pick<TierResult, 'tier' | 'parts'>): boolean {
  if (!rules.parts.hardRulesPass) return false;
  if (rules.tier === 'possible' || rules.tier === 'near-miss') return true;
  return rules.tier === 'sure' && rules.parts.rule === 'sure-close';
}

export interface JevNouls {
  same_kind: number;
  compatible: number;
  same_specific?: number | null;
}

/** The two nouls the decision needs, or undefined where either is missing. */
export function noulsOf(answers: Record<string, JevAnswer>): JevNouls | undefined {
  const n = (id: string) => {
    const a = answers[id];
    return a?.type === 'noul' && Number.isFinite(a.noul) ? a.noul : undefined;
  };
  const same_kind = n('same_kind_of_thing');
  const compatible = n('compatible');
  if (same_kind === undefined || compatible === undefined) return undefined;
  return { same_kind, compatible, same_specific: n('same_specific_item') ?? null };
}

/**
 * Jev's own tier for one pair, before the near-miss floor. Pure. The parts
 * guard is the rules' own, read on the two postings in want -> have order.
 */
export function jevTier(nouls: JevNouls, want: PostingWords, have: PostingWords): Exclude<Tier, 'near-miss'> {
  if (nouls.same_kind >= JEV_SURE_SAME_KIND_MIN && nouls.compatible >= JEV_SURE_COMPATIBLE_MIN) {
    return partsGuardAllowsSure(want, have) ? 'sure' : 'possible';
  }
  if (nouls.same_kind >= JEV_POSSIBLE_SAME_KIND_MIN && nouls.compatible > JEV_POSSIBLE_COMPATIBLE_ABOVE) {
    return 'possible';
  }
  return 'nothing';
}

/**
 * THE NEAR-MISS FLOOR. The tier a pair ends with once Jev has answered: Jev's
 * own tier, except that a NOTHING on a pair the rules placed at NEAR-MISS or
 * above becomes NEAR-MISS. Never higher than Jev said, never lower than a
 * near miss where the rules found one. Pure.
 */
export function flooredTier(jev: Exclude<Tier, 'near-miss'>, rules: Tier): Tier {
  if (jev === 'nothing' && rules !== 'nothing') return 'near-miss';
  return jev;
}

/** One side of a pair as the judge needs it: what is sent, and what the parts guard reads. */
export interface JudgeSide extends PostingWords {
  id: string;
  category: string;
}

export interface JudgeRequest {
  /** The caller's own handle for the pair, returned as is. */
  key: string;
  want: JudgeSide;
  have: JudgeSide;
  /** The rules' fit, which picks the top N. */
  score: number;
  /** The rules' tier, which sets the near-miss floor. */
  rulesTier: Tier;
}

export interface JudgeVerdict {
  /** The tier the pair ends with: Jev's, floored at a near miss. */
  tier: Tier;
  /** Jev's own answer before the floor, for the log. */
  jevTier: Exclude<Tier, 'near-miss'>;
  /** True where the floor turned Jev's NOTHING into a near miss. */
  floored: boolean;
  nouls: JevNouls;
  latencyMs: number;
}

type Ask = (state: unknown, questions: ReturnType<typeof jevPairQuestions>) => Promise<JevResult>;
type Log = (msg: string, extra?: any) => void;

/**
 * Ask Jev about up to JEV_JUDGE_TOP_N pairs, all at once, and return a
 * verdict for every pair it answered in time. A pair missing from the map
 * keeps the rules' tier. Never throws, and never takes much longer than one
 * JEV_JUDGE_TIMEOUT_MS: each call carries its own abort, and a race here
 * guards against anything that ignores it.
 */
export async function judgeWithJev(
  requests: JudgeRequest[],
  log: Log = () => {},
  opts: { ask?: Ask; enabled?: boolean; timeoutMs?: number; topN?: number } = {},
): Promise<Map<string, JudgeVerdict>> {
  const out = new Map<string, JudgeVerdict>();
  const enabled = opts.enabled ?? jevMatchingEnabled();
  if (!enabled || !requests.length) return out;
  const timeoutMs = opts.timeoutMs ?? JEV_JUDGE_TIMEOUT_MS;
  const ask: Ask =
    opts.ask ?? ((state, questions) => askJevForMatching(state, questions, { timeoutMs }));
  const chosen = [...requests].sort((a, b) => b.score - a.score).slice(0, opts.topN ?? JEV_JUDGE_TOP_N);
  const questions = jevPairQuestions();

  await Promise.all(
    chosen.map(async (req) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const started = Date.now();
        const result = await Promise.race<JevResult>([
          ask(jevPairState(req.want, req.have), questions),
          new Promise<JevResult>((resolve) => {
            // A little slack over the call's own abort, so the abort is what
            // normally fires and this only catches something that ignored it.
            timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs + 250);
          }),
        ]);
        if (!result.ok) {
          log('matcher: jev gave no answer, the rules decide', {
            card_want: req.want.id,
            card_have: req.have.id,
            reason: result.reason,
          });
          return;
        }
        const nouls = noulsOf(result.answers);
        if (!nouls) {
          log('matcher: jev answer incomplete, the rules decide', {
            card_want: req.want.id,
            card_have: req.have.id,
          });
          return;
        }
        const own = jevTier(nouls, req.want, req.have);
        const tier = flooredTier(own, req.rulesTier);
        out.set(req.key, {
          tier,
          jevTier: own,
          floored: tier !== own,
          nouls,
          latencyMs: result.latencyMs ?? Date.now() - started,
        });
      } catch (e: any) {
        log('matcher: jev judge failed, the rules decide', {
          card_want: req.want.id,
          card_have: req.have.id,
          error: e?.name ?? 'error',
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return out;
}
