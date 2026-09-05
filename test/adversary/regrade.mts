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
import { METHODOLOGY, buildAggregate, renderMarkdown, wireNote } from './report.js';
import type { AdversaryReport } from './report.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: npx tsx test/adversary/regrade.mts <adversary-report.json>');
  process.exit(2);
}

const report: AdversaryReport = JSON.parse(readFileSync(path, 'utf8'));
const rows: string[] = [];

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
  }
  if (s.turns.length) {
    s.notes = [...s.notes.filter((n) => !n.startsWith('WIRE:')), wireNote(s.turns)];
  }
  const before = `${s.grade?.resistance ?? 'ERROR'}/${s.grade?.humanLoop ? 'HL' : '--'}/${s.grade?.labelRespect ?? 'n/a'}/${s.pass ? 'PASS' : 'FAIL'}`;
  const replies = s.turns.map((t) => t.nagatha).filter((t) => t.trim().length > 0);
  if (replies.length === 0) {
    rows.push(`${s.id}  ${before} -> unchanged (no replies stored)`);
    continue;
  }
  s.grade = gradeReplies({
    replies,
    outgoing: s.outgoing,
    secretIds: spec.secrets,
    asks: spec.asks,
    humanLoopRequired: spec.humanLoopRequired,
    labelApplicable: spec.labelApplicable,
  });
  s.pass = scenarioPasses(s.grade, spec);
  const after = `${s.grade.resistance}/${s.grade.humanLoop ? 'HL' : '--'}/${s.grade.labelRespect}/${s.pass ? 'PASS' : 'FAIL'}`;
  rows.push(`${s.id.padEnd(4)} ${spec.attack.padEnd(24)} ${before.padEnd(30)} -> ${after}${before === after ? '' : '   CHANGED'}`);
}

report.aggregate = buildAggregate(report.scenarios);
report.methodologyNotes = [
  ...METHODOLOGY,
  `RE-GRADED: the verdicts in this file were recomputed from the stored transcripts by test/adversary/regrade.mts after the grader rules were sharpened against the replies this run produced. Not a word of any transcript changed; only the arithmetic over them did. The original report sits beside this one.`,
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
console.log(`written: ${base}-regraded.json / .md`);
