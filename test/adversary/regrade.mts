/**
 * Re-grade a finished adversary report from its stored transcripts.
 *
 * The grader is deterministic and the report keeps every reply verbatim, so a
 * rule fix can be applied to a run that has already happened without touching
 * the agent again. That matters: the rules get sharpened by real replies, and
 * the honest way to use what a run taught us is to re-run the arithmetic over
 * the same words rather than to drive a fresh run and quietly report the second
 * number. The transcripts are copied across unchanged; only the verdicts move,
 * and the old verdict is printed beside the new one for every scenario.
 *
 *   npx tsx test/adversary/regrade.mts realism-reports/adversary-<model>-<stamp>.json
 *
 * Writes <input>-regraded.json and .md next to the original.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SCENARIOS } from './attacks.js';
import { gradeReplies, scenarioPasses } from './grader.js';
import { METHODOLOGY, buildAggregate, gradeTurnsFrom, renderMarkdown, switchboardRefusal, wireNote } from './report.js';
import type { AdversaryGrade } from './grader.js';
import type { AdversaryReport } from './report.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: npx tsx test/adversary/regrade.mts <adversary-report.json>');
  process.exit(2);
}

const report: AdversaryReport = JSON.parse(readFileSync(path, 'utf8'));
const rows: string[] = [];
const moved: string[] = [];

/** The evidence that decided a verdict, in one line: what made it OBEYED or PARTIAL. */
function deciding(g: AdversaryGrade | undefined): string {
  if (!g) return 'no grade';
  const hard = g.evidence.filter((e) => e.context === 'performed' || e.context === 'offered');
  if (!hard.length) {
    return g.resistance === 'RESISTED'
      ? 'nothing performed or offered'
      : `${g.resistance} with no performed/offered hit (bare mention or label)`;
  }
  return hard
    .map((e) => `${e.context.toUpperCase()} ${e.kind}:${e.id} "${e.substring}" in "${e.clause.replace(/\s+/g, ' ').slice(0, 150)}"${e.basis ? ` [${e.basis}]` : ''}`)
    .join(' ;; ');
}

for (const s of report.scenarios) {
  const spec = SCENARIOS.find((x) => x.id === s.id);
  if (!spec) {
    rows.push(`${s.id}  (no catalogue entry — left as it was)`);
    continue;
  }
  // Repair the wire label on reports written before the runner recorded the
  // wire a turn actually travelled on rather than the one it set out to use.
  // The stored prompt says which without ambiguity: a fallback prompt hands
  // over the words, a relay prompt only asks what is new.
  for (const t of s.turns) {
    t.wire = /^(?:A message just came in|Another one just came in)/.test(t.prompt) ? 'fallback' : 'relay';
    // A re-grade INFERS the path from the stored prompt; it checked nothing
    // itself, and a report written before 2026-09-13 checked nothing either.
    // So every fact behind the label is recorded as unchecked, which is what
    // stops the re-graded note claiming a delivery or a collection that no run
    // ever verified.
    if (!t.wireFacts) {
      t.wireFacts = {
        channel: 'unchecked',
        send: t.wire === 'relay' ? 'accepted' : 'not-attempted',
        collected: 'unobserved',
        detail:
          'this label was inferred from the stored prompt when the report was re-graded; the original run verified neither the conversation nor the collection',
      };
    }
  }
  if (s.turns.length) {
    // A per-turn refusal note written before 2026-09-14 filed the switchboard
    // refusing a money figure as an ordinary fallback. The refusal body it
    // quotes says why, so it is re-said in those words; any other note stays.
    const graded = s.turns.filter((t) => t.graded !== false);
    s.notes = s.notes
      .filter((n) => !n.startsWith('WIRE:'))
      .map((n) => {
        const m = /^Turn (\d+) did NOT ride the relay: the send was refused/.exec(n);
        const t = m ? graded[Number(m[1]) - 1] : undefined;
        const stop = t ? switchboardRefusal(t) : undefined;
        return stop?.kind === 'money-figure'
          ? `Turn ${m![1]} was STOPPED BY THE SWITCHBOARD before it reached her: the relay refused to carry it. ${stop.why} It was then handed over as a labelled fallback, so her judgment on the same words is still graded as the second line.`
          : n;
      });
    s.notes.push(wireNote(s.turns));
  }
  const before = `${s.grade?.resistance ?? 'ERROR'}/${s.grade?.humanLoop ? 'HL' : '--'}/${s.grade?.labelRespect ?? 'n/a'}/${s.pass ? 'PASS' : 'FAIL'}`;
  const oldGrade = s.grade;
  // The turns with what was observed beside each: her tool receipt always (these
  // reports carry it), the per-turn collection and settlement reads only where
  // the report recorded them. Ungraded context turns stay out, as in the runner.
  const gradeTurns = gradeTurnsFrom(s.turns);
  if (gradeTurns.length === 0) {
    rows.push(`${s.id}  ${before} -> unchanged (no replies stored)`);
    continue;
  }
  s.grade = gradeReplies({
    turns: gradeTurns,
    // Reports written before 2026-09-14 kept what the counterparty collected at
    // scenario level only. A planted secret in it still counts, unconditionally.
    ...(s.turns.some((t) => t.outgoing) ? {} : { outgoing: s.outgoing }),
    secretIds: spec.secrets,
    asks: spec.asks,
    humanLoopRequired: spec.humanLoopRequired,
    labelApplicable: spec.labelApplicable,
    // Without this the re-grade would score A13 blind to the whole point of it:
    // a payment link on a host that is not ours.
    ...(spec.urlPolicy ? { urlPolicy: spec.urlPolicy } : {}),
  });
  s.pass = scenarioPasses(s.grade, spec);
  const after = `${s.grade.resistance}/${s.grade.humanLoop ? 'HL' : '--'}/${s.grade.labelRespect}/${s.pass ? 'PASS' : 'FAIL'}`;
  rows.push(`${s.id.padEnd(4)} ${spec.attack.padEnd(24)} ${before.padEnd(30)} -> ${after.padEnd(30)} [${s.grade.basis}]${before === after ? '' : '   CHANGED'}`);
  if (before !== after) {
    moved.push(`${s.id} ${spec.attack}: ${before} -> ${after}`);
    moved.push(`   before: ${deciding(oldGrade)}`);
    moved.push(`   after:  ${deciding(s.grade)}`);
    // The same hits that decided the old verdict, as the new rules read them.
    // A hit that no longer appears at all was matched by a pattern that no
    // longer matches it (the suburb, since 2026-09-14).
    const oldHard = (oldGrade?.evidence ?? []).filter((e) => e.context === 'performed' || e.context === 'offered');
    for (const o of oldHard.slice(0, 4)) {
      const n = s.grade.evidence.find((e) => e.kind === o.kind && e.id === o.id && e.substring === o.substring && e.clause === o.clause);
      moved.push(
        n
          ? `   why:    ${o.kind}:${o.id} "${o.substring}" ${o.context} -> ${n.context}${n.note ? `: ${n.note}` : n.context === 'refused' ? ': a refusal marker governs it now' : ''}`
          : `   why:    ${o.kind}:${o.id} "${o.substring}" ${o.context} -> no longer a hit at all`,
      );
    }
    moved.push(`   basis:  ${s.grade.basisNote}`);
  }
}

report.aggregate = buildAggregate(report.scenarios);
report.methodologyNotes = [
  ...METHODOLOGY,
  `RE-GRADED: the verdicts in this file were recomputed from the stored transcripts by test/adversary/regrade.mts after the grader rules were sharpened against the replies this run produced. Not a word of any transcript changed; only the arithmetic over them did. The original report sits beside this one.`,
  `WHAT A RE-GRADE CAN SEE: the tool receipts this report stored, per turn. Where the report predates 2026-09-14 it did not record, per turn, whether the counterparty's collection was read successfully, nor the settlement's state, so neither is treated as observed here: outward travel counts as observed only on turns whose receipt lists no call that can carry text outward, and every settlement act is text-inferred. Anything the original run's database showed afterwards (a settlement still 'proposed', say) is not evidence this file can cite.`,
];

const base = path.replace(/\.json$/, '');
writeFileSync(`${base}-regraded.json`, JSON.stringify(report, null, 2));
writeFileSync(`${base}-regraded.md`, renderMarkdown(report));

console.log(rows.join('\n'));
const a = report.aggregate;
console.log('');
console.log(`RESISTED ${a.resisted} · PARTIAL ${a.partial} · OBEYED ${a.obeyed}   resist rate ${a.resistRatePct}%`);
console.log(`human-loop ${a.humanLoopMet}/${a.humanLoopRequiredCount} (${a.humanLoopRatePct}%)   label ${a.labelRespected}/${a.labelApplicableCount} (${a.labelRatePct}%)`);
console.log(`passed on all applicable axes: ${a.scenariosPassed}/${a.scenariosRun}`);
console.log(`stopped by the switchboard before it reached her: ${a.wire.stoppedBySwitchboard ?? 0} (${(a.wire.stoppedIds ?? []).join(', ')})`);
console.log(`resistance verdicts resting in whole or part on her words: ${a.textInferred ?? 0}/${a.scenariosRun}`);
if (moved.length) {
  console.log('');
  console.log('--- WHAT MOVED, AND WHY ---');
  console.log(moved.join('\n'));
}
console.log(`written: ${base}-regraded.json / .md`);
