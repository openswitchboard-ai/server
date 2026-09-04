/**
 * Offline merge + re-grade. Combines the autonomous run (S1-S13) with the
 * email-prompted run (EM*), re-grades every captured reply with the CURRENT
 * grader (so a grader fix is reflected without re-driving the real agent), and
 * writes the final combined report. No network, no agent — pure post-processing
 * of the verbatim replies already captured.
 *
 *   npx tsx test/realism/merge.mts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { grade } from './grader.js';
import { Report, ScenarioResult, buildAggregate, renderFailingTranscripts, writeReport } from './report.js';

const DIR = join(process.cwd(), 'realism-reports');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('FINAL'));
const reports: Report[] = files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));

// Autonomous scenarios: from the report that actually has S1..S13.
const autoReport = reports
  .map((r) => ({ r, n: r.scenarios.filter((s) => s.track === 'autonomous').length }))
  .sort((a, b) => b.n - a.n)[0]?.r;
// Email scenarios: from the report with the most non-errored EM* scenarios.
const emailReport = reports
  .map((r) => ({ r, n: r.scenarios.filter((s) => s.id.startsWith('EM') && !s.error).length }))
  .sort((a, b) => b.n - a.n)[0]?.r;

if (!autoReport) throw new Error('no report with autonomous scenarios found');

function regrade(s: ScenarioResult): ScenarioResult {
  const isClarityGraded = s.id === 'S12'; // graded for clarity/non-refusal, not the jargon bar
  if (isClarityGraded) s.leakStatsExcluded = true;
  for (const ex of s.exchanges) {
    const g = grade(ex.nagatha);
    ex.hits = g.hits;
    ex.hardCount = g.hardCount;
    ex.softCount = g.softCount;
    ex.pass = isClarityGraded ? true : g.pass;
  }
  if (!isClarityGraded) s.pass = !s.error && !s.skipped && s.exchanges.every((e) => e.pass);
  return s;
}

const scenarios: ScenarioResult[] = [];
for (const s of autoReport.scenarios.filter((x) => x.track === 'autonomous')) scenarios.push(regrade(s));
if (emailReport) {
  for (const s of emailReport.scenarios.filter((x) => x.track === 'email-prompted')) scenarios.push(regrade(s));
}

const final: Report = {
  ...autoReport,
  generatedAt: new Date().toISOString(),
  scenarios,
  aggregate: buildAggregate(scenarios),
  methodologyNotes: autoReport.methodologyNotes,
};

// Write with a FINAL- prefix so it is unmistakable.
const stamp = final.generatedAt.replace(/[:.]/g, '-');
const base = `FINAL-realism-${final.modelUnderTest.replace(/[^a-z0-9]+/gi, '-')}-${stamp}`;
const { writeFileSync } = await import('node:fs');
writeFileSync(join(DIR, `${base}.json`), JSON.stringify(final, null, 2));
const { renderMarkdown } = await import('./report.js');
writeFileSync(join(DIR, `${base}.md`), renderMarkdown(final));

const a = final.aggregate;
console.log('===== FINAL COMBINED REPORT =====');
console.log('model under test:', final.modelUnderTest);
console.log(`scenarios: ${a.scenariosRun} run, ${a.scenariosPassed} passed, ${a.scenariosFailed} failed, ${a.scenariosSkipped} skipped`);
console.log(`PASS RATE: ${a.passRatePct}%  | graded replies: ${a.gradedReplies} | with hard leak: ${a.repliesWithHardLeak}`);
console.log('leak frequency:');
for (const f of a.leakFrequency) console.log(`  [${f.severity}] ${f.label}: ${f.count}`);
console.log('\nscenario status:');
for (const s of scenarios) console.log(`  ${s.id} ${s.skipped ? 'SKIP' : s.error ? 'ERR' : s.pass ? 'PASS' : 'FAIL'} — ${s.title}`);
console.log('\n' + renderFailingTranscripts(final));
console.log(`\nwritten: ${base}.json / .md`);
