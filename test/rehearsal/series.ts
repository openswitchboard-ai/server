/**
 * WHAT COUNTS AS A STREAK, AND WHAT BREAKS ONE.
 *
 * Pure, and tested, because the exit code of the whole suite is this function's
 * answer and an off-by-one here would report a green series that never
 * happened.
 *
 * A run counts toward the streak only when it is CLEAN: every deterministic
 * check passed, no turn failed a speech rule under the two thresholds, and the
 * share of turns carrying an uncertain mark is within the bar. An UNCLEAN run
 * resets the streak to zero — it does not merely fail to extend it. An
 * OVERRULED run (somebody judged a flag a false positive by hand) does not
 * count either way and does not extend the streak: the rubric gets fixed and
 * the run is repeated, because a suite that lets a human wave a flag through is
 * a suite that will eventually wave through a real one.
 */
import { MAX_UNCERTAIN_TURN_SHARE, REQUIRED_CASTS, SHARE_APPLIES_FROM_TURNS, MAX_UNCERTAIN_TURNS_WHEN_SHORT } from './levels.js';

export interface RunSummary {
  run: number;
  /** 'nagatha,bilby' — the cast as the flag names it, seller first. */
  cast: string;
  /** Every deterministic check in the stages asked for passed. */
  deterministicClean: boolean;
  /** Turns that failed a speech rule on BOTH Jev calls. */
  failedTurns: number;
  /** Assistant turns carrying at least one uncertain mark. */
  uncertainTurns: number;
  /** Assistant turns scored at all. */
  scoredTurns: number;
  /** Somebody passed --overrule for this run. */
  overruled: boolean;
  /** The run stopped early because a check failed (fail-fast). */
  cutShort: boolean;
}

export interface Cleanliness {
  clean: boolean;
  /** Empty when clean. One short reason per fault, for the table. */
  why: string[];
  uncertainShare: number;
}

export function judgeRun(r: RunSummary): Cleanliness {
  const share = r.scoredTurns ? r.uncertainTurns / r.scoredTurns : 0;
  const why: string[] = [];
  if (!r.deterministicClean) why.push('a deterministic check failed');
  if (r.failedTurns) why.push(`${r.failedTurns} turn(s) failed a speech rule on both calls`);
  if (r.scoredTurns >= SHARE_APPLIES_FROM_TURNS) {
    if (share > MAX_UNCERTAIN_TURN_SHARE) {
      why.push(
        `${Math.round(share * 100)}% of scored turns carry an uncertain mark (bar is ${Math.round(MAX_UNCERTAIN_TURN_SHARE * 100)}%)`,
      );
    }
  } else if (r.uncertainTurns > MAX_UNCERTAIN_TURNS_WHEN_SHORT) {
    why.push(
      `${r.uncertainTurns} of ${r.scoredTurns} scored turns carry an uncertain mark (a short run may carry ${MAX_UNCERTAIN_TURNS_WHEN_SHORT})`,
    );
  }
  if (r.overruled) why.push('a flag on this run was overruled by hand, so it does not count');
  if (r.cutShort) why.push('the run was cut short');
  return { clean: why.length === 0, why, uncertainShare: share };
}

/** 'bilby,nagatha' and 'nagatha,bilby' are one pairing. */
export function normaliseCast(cast: string): string {
  return cast
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .sort()
    .join(',');
}

export interface SeriesVerdict {
  /** The longest run of clean runs ending at the last run. */
  streak: number;
  /** True when the streak is long enough AND holds the required casts. */
  green: boolean;
  /** Cast counts inside the qualifying streak. */
  castCounts: Record<string, number>;
  /** What is still missing, in plain words. Empty when green. */
  missing: string[];
}

export function judgeSeries(runs: RunSummary[], k: number): SeriesVerdict {
  // The tail of clean runs. An unclean or overruled run at the end means zero,
  // however many clean ones came before it.
  const tail: RunSummary[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!judgeRun(runs[i]).clean) break;
    tail.unshift(runs[i]);
  }
  const streak = tail.length;
  // The sides alternate run over run, so "nagatha,bilby" and "bilby,nagatha"
  // are the same pairing seen from the other end. The requirement is about
  // WHICH TWO CLIENTS were in the room, not which of them sold.
  const castCounts: Record<string, number> = {};
  for (const r of tail.slice(-k)) {
    const key = normaliseCast(r.cast);
    castCounts[key] = (castCounts[key] ?? 0) + 1;
  }

  const missing: string[] = [];
  if (streak < k) missing.push(`${k - streak} more clean run(s) in a row`);
  else {
    for (const req of REQUIRED_CASTS) {
      const have = castCounts[normaliseCast(req.cast)] ?? 0;
      if (have < req.atLeast) {
        missing.push(
          `${req.atLeast - have} more run(s) with ${req.cast.split(',').join(' and ')} in the room, inside the streak`,
        );
      }
    }
  }
  return { streak, green: missing.length === 0, castCounts, missing };
}

/** Per-check pass rate across every run, for the end-of-series table. */
export function passRates(
  perRun: { checks: { id: string; verdict: string }[] }[],
): { id: string; passed: number; seen: number; rate: number }[] {
  const tally = new Map<string, { passed: number; seen: number }>();
  for (const run of perRun) {
    for (const c of run.checks) {
      // A skipped check was never asked; counting it as a pass would make a
      // stage that never ran look like a stage that ran and was fine.
      if (c.verdict === 'skip') continue;
      const t = tally.get(c.id) ?? { passed: 0, seen: 0 };
      t.seen++;
      if (c.verdict === 'pass') t.passed++;
      tally.set(c.id, t);
    }
  }
  return [...tally.entries()]
    .map(([id, t]) => ({ id, passed: t.passed, seen: t.seen, rate: t.seen ? t.passed / t.seen : 0 }))
    .sort((a, b) => a.rate - b.rate || a.id.localeCompare(b.id));
}
