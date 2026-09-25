/**
 * THE TABLE, AND THE SUMMARY.
 *
 * Factual, and short enough to read. The rule the founder set for every report
 * in this repository holds here: say what was NOT run. A stage that never
 * started, a check that could not be answered, a scorer with no key, an
 * assistant that could not be attributed in the tool log — each of those is a
 * line in the report rather than a gap in it.
 */
import {
  CRITICAL_FAIL_AT,
  CRITICAL_RULES,
  MAX_NONCRITICAL_SLIPS_PER_RUN,
  MAX_UNCERTAIN_TURN_SHARE,
  OTHER_FAIL_AT,
  RATE_IS_THE_THING_TO_WATCH,
  streakMeaning,
} from './levels.js';
import { splitSlips, type ScoreResult, type Slip } from './jev.js';
import { judgeRun, passRates, type RunSummary, type SeriesVerdict } from './series.js';
import type { RunResult } from './types.js';

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

const MARK: Record<string, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  todo: 'TODO',
  skip: 'SKIP',
};

export function runTable(run: RunResult): string {
  const out: string[] = [];
  out.push(
    `run ${run.run}  seller ${run.cast.seller}, buyer ${run.cast.buyer}  ${run.green ? 'GREEN' : 'NOT GREEN'}`,
  );
  out.push(`  ${pad('stage', 7)}${pad('check', 30)}${pad('', 6)}evidence`);
  for (const stage of run.stages) {
    for (const c of stage.checks) {
      out.push(
        `  ${pad(String(stage.stage), 7)}${pad(c.id, 30)}${pad(MARK[c.verdict] ?? c.verdict, 6)}${c.evidence}`,
      );
    }
  }
  if (run.error) out.push(`  run stopped: ${run.error}`);
  return out.join('\n');
}

export interface SeriesInput {
  runs: RunResult[];
  summaries: RunSummary[];
  scores: ScoreResult[];
  verdict: SeriesVerdict;
  wanted: number;
  /** Flags a person judged false, if any were passed with --overrule. */
  overrules: { run: number; turn: number; rule: string; reason: string }[];
  /** Stages this series was asked to reach. */
  stagesAsked: number;
  scenario: string;
  /** What the series never did, in plain sentences. */
  notRun: string[];
}

export function seriesSummary(input: SeriesInput): string {
  const { runs, summaries, scores, verdict } = input;
  const out: string[] = [];

  // The headline paragraph. It goes first because a fail-fast series exists to
  // hand somebody one defect to fix, and making them read a table for it would
  // be the harness getting in the way.
  const firstFail = runs
    .flatMap((r) => r.stages.flatMap((s) => s.checks.map((c) => ({ run: r.run, stage: s.stage, c }))))
    .find((x) => x.c.verdict === 'fail');
  out.push('# Rehearsal series');
  out.push('');
  if (firstFail) {
    out.push(
      `**What failed.** Run ${firstFail.run}, stage ${firstFail.stage}, \`${firstFail.c.id}\`: ` +
        `${firstFail.c.says} It did not: ${firstFail.c.evidence}. ` +
        'The run was cut short at that point, the board was cleared, and everything gathered ' +
        'up to then is below. Fix it, then run the series again from the top.',
    );
  } else if (verdict.green) {
    out.push(
      `**Green.** ${verdict.streak} clean run(s) in a row through stage ${input.stagesAsked}, ` +
        `with the casts the bar asks for. ${streakMeaning(input.wanted)}`,
    );
  } else {
    out.push(
      `**Not green.** The streak stands at ${verdict.streak} of ${input.wanted}. Still wanted: ` +
        `${verdict.missing.join('; ')}. Read the tolerated slips and the uncertain turns below ` +
        'before concluding anything from the runs that did pass.',
    );
  }
  out.push('');

  // WHAT THE GATE ACTUALLY WAS, in plain words and near the top, because the
  // split of 2026-09-20 is exactly the kind of change that can read as
  // "loosened until green" if a reader has to dig for it.
  const counted = summaries.filter((s) => !s.voided);
  const factsPassed = counted.filter((s) => s.deterministicClean).length;
  const criticalClean = counted.filter((s) => !s.criticalSlips).length;
  const rate = verdict.slipRate;
  out.push('## The gate, in plain words');
  out.push('');
  out.push(
    `**${counted.length} run(s) counted** (${summaries.length - counted.length} void — the harness broke, ` +
      `so they say nothing either way). **${factsPassed} of ${counted.length} passed every deterministic ` +
      'check they were asked** — the facts read off the database and the transcript: the link was handed ' +
      'over, the postings met, the presses landed, the shelf agreed, no figure reached a card its human ' +
      'never said. Those gate, every one, and nothing here softens them. ' +
      `**${criticalClean} of ${counted.length} carried no critical speech slip**; a critical rule ` +
      `(${CRITICAL_RULES.join(', ')}) gates at zero, because it is about harm rather than style.`,
  );
  out.push('');
  out.push(
    `**Non-critical speech-slip rate: ${rate.rate.toFixed(3)}** — ${rate.slips} slip(s) over ${rate.turns} ` +
      `scored assistant turn(s). Ceiling ${rate.ceiling.toFixed(3)}; per-run ceiling ` +
      `${MAX_NONCRITICAL_SLIPS_PER_RUN}. ` +
      (rate.advisoryOnly
        ? 'Too few turns for the rate to decide anything yet, so it is reported and not enforced. '
        : rate.withinCeiling
          ? 'Inside the ceiling. '
          : '**Over the ceiling, and the series is not green because of it.** ') +
      'These slips are TOLERATED, not absent: every one is printed verbatim below with its rule and ' +
      'both its scores, so a reader can disagree with any of them.',
  );
  out.push('');
  // COUNTED APART, NEVER HIDDEN. See levels.ts, PROMISE_RULE.
  const pr = verdict.promiseRate;
  if (pr) {
    out.push(
      `**Counted apart from that rate: unbacked promises to notify — ${pr.slips} over ${pr.turns} ` +
        `scored turn(s), a rate of ${pr.rate.toFixed(3)}.** A chat assistant saying "I'll let you know ` +
        'when he replies", which it cannot keep. Held at three or four a run through every wording ' +
        'tried, so it is reported on its own line rather than failing every series; each one is ' +
        'still printed verbatim below, and still counts toward the per-run ceiling.',
    );
    out.push('');
  }
  out.push(
    'Why this is split: a day of rehearsals showed that some slips are ones the switchboard invited and ' +
      'can be designed out, and some are the model simply inventing — an assistant told its human they had ' +
      '"already agreed" an hourly rhythm that exists in no database, no settings page and no memory. No ' +
      'wording prevents that. Demanding a streak of wholly perfect runs would measure luck. So the facts ' +
      'gate, the harmful speech rules gate, and the register faults are capped and rated.',
  );
  out.push('');
  out.push(
    `Scenario \`${input.scenario}\`, stages 1–${input.stagesAsked}, ${runs.length} run(s). ` +
      `Speech bar: a critical rule fails at p ≥ ${CRITICAL_FAIL_AT}, any other above ${OTHER_FAIL_AT}, ` +
      `each mark asked twice and failing only when both calls clear it; a run is unclean above ` +
      `${Math.round(MAX_UNCERTAIN_TURN_SHARE * 100)}% uncertain turns.`,
  );
  out.push('');

  out.push('## Runs');
  out.push('');
  // The two classes get their own columns. "facts" is the gate; "critical" is
  // the gate; "other" is the rated column, and a number in it on a run marked
  // clean is the point of the table, not an oversight.
  out.push('| run | cast | clean | det. checks | facts | critical slips | other slips | uncertain turns | scored |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of summaries) {
    const r = runs.find((x) => x.run === s.run);
    const det = r
      ? `${r.stages.flatMap((x) => x.checks).filter((c) => c.verdict === 'pass').length}/${r.stages.flatMap((x) => x.checks).filter((c) => c.verdict !== 'skip').length}`
      : '?';
    const clean = s.voided ? 'void' : judgeRun(s).clean ? 'yes' : 'no';
    out.push(
      `| ${s.run} | ${s.cast} | ${clean} | ${det} | ${s.deterministicClean ? 'pass' : 'FAIL'} | ${s.criticalSlips} | ${s.otherSlips} | ${s.uncertainTurns} | ${s.scoredTurns} |`,
    );
  }
  out.push('');

  out.push('## Per-check pass rate');
  out.push('');
  out.push('| check | passed | asked | rate |');
  out.push('| --- | --- | --- | --- |');
  for (const row of passRates(runs.map((r) => ({ checks: r.stages.flatMap((s) => s.checks) })))) {
    out.push(`| ${row.id} | ${row.passed} | ${row.seen} | ${Math.round(row.rate * 100)}% |`);
  }
  out.push('');

  out.push('## Speech rules');
  out.push('');
  const scored = scores.reduce((n, s) => n + s.scoredCount, 0);
  const lat = scores.filter((s) => s.scoredCount).map((s) => s.meanLatencyMs);
  if (!scored) {
    out.push(
      scores.find((s) => s.unavailable)?.unavailable ??
        'No assistant turn was scored. The speech rules were NOT read for this series.',
    );
  } else {
    out.push(
      `${scored} assistant turn(s) scored, mean scorer latency ` +
        `${lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0} ms, ` +
        `tokens in ${scores.reduce((n, s) => n + s.tokensIn, 0)} / out ${scores.reduce((n, s) => n + s.tokensOut, 0)}.`,
    );
    out.push('');
    out.push('| assistant | rule | failed | uncertain | of turns |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const row of slipTable(scores)) {
      out.push(`| ${row.speaker} | ${row.ruleId} | ${row.failed} | ${row.uncertain} | ${row.turns} |`);
    }
  }
  out.push('');

  // EVERY SLIP, VERBATIM. Both classes, whether or not the run passed and
  // whether or not the series did. A tolerated slip that is not printed is a
  // slip that has been hidden, and the whole argument for rating instead of
  // gating rests on the reader being able to see each one and disagree.
  const perRun = scores.map((s, i) => ({ run: summaries[i]?.run ?? i + 1, ...splitSlips(s) }));
  const allCritical = perRun.flatMap((p) => p.critical.map((s) => ({ run: p.run, slip: s })));
  const allOther = perRun.flatMap((p) => p.other.map((s) => ({ run: p.run, slip: s })));

  out.push('## Critical speech slips, verbatim — these gate');
  out.push('');
  if (!allCritical.length) {
    out.push('None. A single one of these makes its run unclean, however good the rest of it was.');
  }
  for (const { run, slip } of allCritical) out.push(...slipLines(run, slip));
  out.push('');

  out.push('## Non-critical speech slips, verbatim — these were TOLERATED and counted into the rate');
  out.push('');
  if (!allOther.length) {
    out.push('None.');
  } else {
    out.push(
      `${allOther.length} slip(s), each one inside the per-run ceiling of ${MAX_NONCRITICAL_SLIPS_PER_RUN} ` +
        'or else its run is marked unclean above. They are register faults, not harm, and they are ' +
        'printed in full so that "tolerated" never means "unseen".',
    );
    out.push('');
    for (const { run, slip } of allOther) out.push(...slipLines(run, slip));
  }
  out.push('');
  out.push(RATE_IS_THE_THING_TO_WATCH);
  out.push('');

  // MARKS A FACT OVERRODE, PRINTED. The rubric marked these and a fact about
  // the run says otherwise — today only asks_them_to_report_a_press on a step
  // that called wait_for_press, which is the fallback manual 64 asks for. They
  // are not counted into the rate, so they are printed here instead: an
  // excuse nobody can see is indistinguishable from a bar quietly lowered.
  const excused = scores.flatMap((s, i) =>
    s.turns.flatMap((t) =>
      (t.excused ?? []).map((e) => ({ run: summaries[i]?.run ?? i + 1, turn: t, e })),
    ),
  );
  out.push('## Marks a fact about the run overrode');
  out.push('');
  if (!excused.length) {
    out.push('None.');
  } else {
    out.push(
      `${excused.length} mark(s). Each is a rubric judgement the harness set aside because ` +
        'something the run actually did contradicts it. Not counted into the rate, and printed ' +
        'here so the setting-aside can be argued with.',
    );
    out.push('');
    for (const { run, turn, e } of excused) {
      out.push(
        `- **${turn.speaker}**, run ${run}, ${turn.section} — \`${e.ruleId}\` at ` +
          `${e.values.map((v) => (v === null ? '?' : v.toFixed(2))).join('/')} — ${e.why}`,
      );
      out.push(`  > ${turn.text}`);
    }
  }
  out.push('');

  // The uncertain turns, verbatim, because the bar says a person settles them.
  const uncertain = scores.flatMap((s) => s.uncertainTurns);
  out.push('## Uncertain turns, verbatim');
  out.push('');
  if (!uncertain.length) out.push('None.');
  for (const t of uncertain) {
    const marks = t.marks
      .filter((m) => m.band === 'uncertain')
      .map((m) => `${m.ruleId} ${m.values.map((v) => (v === null ? '?' : v.toFixed(2))).join('/')}${m.disagreed ? ' (the two calls disagreed)' : ''}`)
      .join(', ');
    out.push(`- **${t.speaker}**, ${t.section} — ${marks}`);
    out.push(`  > ${t.text}`);
  }
  out.push('');

  out.push('## Flagged, judged false by a human');
  out.push('');
  if (!input.overrules.length) {
    out.push(
      'Empty. Nothing here is waved through unless somebody passes `--overrule <run>:<turn>:<rule> "<reason>"`, ' +
        'and an overruled run does not count toward the streak: the rubric gets fixed and the run is repeated.',
    );
  } else {
    out.push('| run | turn | rule | reason |');
    out.push('| --- | --- | --- | --- |');
    for (const o of input.overrules) out.push(`| ${o.run} | ${o.turn} | ${o.rule} | ${o.reason} |`);
  }
  out.push('');

  out.push('## What this series did NOT do');
  out.push('');
  for (const line of input.notRun) out.push(`- ${line}`);
  out.push('');
  return out.join('\n');
}

/**
 * One slip as two lines: who, where, which rule, BOTH scores, then the words.
 * The second score is printed even when it is missing ("?"), because a mark
 * that could only be read once is a weaker finding than one read twice and the
 * reader should be able to tell them apart.
 */
function slipLines(run: number, s: Slip): string[] {
  const scores = s.values.map((v) => (v === null || v === undefined ? '?' : v.toFixed(2))).join(' / ');
  return [
    `- **${s.speaker}**, run ${run}, ${s.section} — \`${s.ruleId}\` at ${scores}` +
      `${s.disagreed ? ' (the two calls disagreed)' : ''}`,
    `  > ${s.text}`,
  ];
}

function slipTable(scores: ScoreResult[]): {
  speaker: string;
  ruleId: string;
  failed: number;
  uncertain: number;
  turns: number;
}[] {
  const tally = new Map<string, { failed: number; uncertain: number }>();
  const turns = new Map<string, number>();
  for (const s of scores) {
    for (const t of s.turns) {
      if (t.reason) continue;
      turns.set(t.speaker, (turns.get(t.speaker) ?? 0) + 1);
      for (const m of t.marks) {
        const key = `${t.speaker} ${m.ruleId}`;
        const e = tally.get(key) ?? { failed: 0, uncertain: 0 };
        if (m.band === 'fail') e.failed++;
        if (m.band === 'uncertain') e.uncertain++;
        tally.set(key, e);
      }
    }
  }
  return [...tally.entries()]
    .map(([k, e]) => {
      const [speaker, ruleId] = k.split(' ');
      return { speaker, ruleId, ...e, turns: turns.get(speaker) ?? 0 };
    })
    .sort((a, b) => b.failed - a.failed || b.uncertain - a.uncertain);
}
