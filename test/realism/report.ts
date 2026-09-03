/**
 * Report model + writers for the realism eval. Produces a machine-readable
 * JSON and a human-readable Markdown, and prints the aggregate to stdout. The
 * report is tagged with the model actually under test and a timestamp, and is
 * written under realism-reports/ (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GradeResult, LeakHit, leakFrequency } from './grader.js';

export interface GradedExchange {
  /** The human's words we sent Nagatha. */
  human: string;
  /** Her verbatim reply. */
  nagatha: string;
  hits: LeakHit[];
  hardCount: number;
  softCount: number;
  pass: boolean;
  durationMs?: number;
}

export interface ScenarioResult {
  id: string;
  track: 'autonomous' | 'email-prompted';
  title: string;
  /** What this scenario is testing, one line. */
  intent: string;
  exchanges: GradedExchange[];
  /** Scenario passes iff every graded exchange passes (no hard leak). */
  pass: boolean;
  /** Operational notes: how state was built, any degradation, dead-conv note. */
  notes: string[];
  /** Set if the scenario could not be driven to completion. */
  error?: string;
  skipped?: boolean;
  /** True for a scenario graded for clarity/non-refusal rather than the jargon
   *  bar (S12: the human asked how it works, so mechanics are allowed). Its
   *  leaks are recorded but excluded from the tuning-signal leak frequency. */
  leakStatsExcluded?: boolean;
}

export interface Report {
  generatedAt: string;
  modelUnderTest: string;
  openclawConfiguredModel: string;
  runId: string;
  env: string;
  scenarios: ScenarioResult[];
  aggregate: {
    scenariosRun: number;
    scenariosPassed: number;
    scenariosFailed: number;
    scenariosSkipped: number;
    passRatePct: number;
    gradedReplies: number;
    repliesWithHardLeak: number;
    leakFrequency: { label: string; severity: string; count: number }[];
  };
  methodologyNotes: string[];
}

export function buildAggregate(scenarios: ScenarioResult[]): Report['aggregate'] {
  const run = scenarios.filter((s) => !s.skipped);
  const passed = run.filter((s) => s.pass && !s.error).length;
  const failed = run.filter((s) => !s.pass || s.error).length;
  const skipped = scenarios.filter((s) => s.skipped).length;
  const allGrades: GradeResult[] = [];
  let gradedReplies = 0;
  let hardLeakReplies = 0;
  for (const s of scenarios) {
    // Clarity-graded scenarios (S12) allow mechanics by design; their leaks are
    // recorded on the scenario but excluded from the tuning-signal statistics.
    if (s.leakStatsExcluded) continue;
    for (const ex of s.exchanges) {
      gradedReplies++;
      if (ex.hardCount > 0) hardLeakReplies++;
      allGrades.push({
        text: ex.nagatha,
        hits: ex.hits,
        hardCount: ex.hardCount,
        softCount: ex.softCount,
        pass: ex.pass,
      });
    }
  }
  return {
    scenariosRun: run.length,
    scenariosPassed: passed,
    scenariosFailed: failed,
    scenariosSkipped: skipped,
    passRatePct: run.length ? Math.round((passed / run.length) * 1000) / 10 : 0,
    gradedReplies,
    repliesWithHardLeak: hardLeakReplies,
    leakFrequency: leakFrequency(allGrades),
  };
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`# OpenSwitchboard realism eval — jargon report`);
  L.push('');
  L.push(`- **Model under test:** \`${r.modelUnderTest}\` (OpenClaw configured: \`${r.openclawConfiguredModel}\`)`);
  L.push(`- **Generated:** ${r.generatedAt}`);
  L.push(`- **Env:** ${r.env}   **Run:** ${r.runId}`);
  L.push('');
  L.push(`## Aggregate`);
  const a = r.aggregate;
  L.push('');
  L.push(`| metric | value |`);
  L.push(`| --- | --- |`);
  L.push(`| scenarios run | ${a.scenariosRun} |`);
  L.push(`| scenarios passed (no hard leak anywhere) | ${a.scenariosPassed} |`);
  L.push(`| scenarios failed | ${a.scenariosFailed} |`);
  L.push(`| scenarios skipped | ${a.scenariosSkipped} |`);
  L.push(`| **pass rate** | **${a.passRatePct}%** |`);
  L.push(`| graded replies | ${a.gradedReplies} |`);
  L.push(`| replies with a hard leak | ${a.repliesWithHardLeak} |`);
  L.push('');
  L.push(`### Leak-word frequency (where to aim the manual tune)`);
  L.push('');
  if (a.leakFrequency.length === 0) {
    L.push(`_No leaks detected._`);
  } else {
    L.push(`| leak | severity | count |`);
    L.push(`| --- | --- | --- |`);
    for (const f of a.leakFrequency) L.push(`| ${f.label} | ${f.severity} | ${f.count} |`);
  }
  L.push('');
  L.push(`## Scenarios`);
  for (const s of r.scenarios) {
    const status = s.skipped ? 'SKIPPED' : s.error ? 'ERROR' : s.pass ? 'PASS' : 'FAIL';
    L.push('');
    L.push(`### [${status}] ${s.id} · ${s.title}  _(${s.track})_`);
    L.push(`_${s.intent}_`);
    if (s.error) L.push(`\n> ERROR: ${s.error}`);
    for (const n of s.notes) L.push(`\n- note: ${n}`);
    for (const ex of s.exchanges) {
      L.push('');
      L.push(`**Human:** ${ex.human}`);
      L.push('');
      L.push(`**Nagatha${ex.pass ? '' : ' [HARD LEAK]'}:** ${ex.nagatha}`);
      if (ex.hits.length) {
        const hs = ex.hits.map((h) => `${h.label}${h.severity === 'soft' ? '(soft)' : ''}:"${h.substring}"`).join(', ');
        L.push('');
        L.push(`  - leaks: ${hs}`);
      }
    }
  }
  L.push('');
  L.push(`## Methodology notes`);
  for (const n of r.methodologyNotes) L.push(`- ${n}`);
  L.push('');
  return L.join('\n');
}

export function renderFailingTranscripts(r: Report): string {
  const L: string[] = [];
  const failing = r.scenarios.filter((s) => !s.skipped && (!s.pass || s.error));
  if (failing.length === 0) return 'No failing scenarios — every graded reply was clean of hard leaks.';
  for (const s of failing) {
    L.push(`===== ${s.id} · ${s.title} (${s.track}) =====`);
    if (s.error) L.push(`ERROR: ${s.error}`);
    for (const ex of s.exchanges) {
      L.push(`  HUMAN: ${ex.human}`);
      L.push(`  NAGATHA: ${ex.nagatha}`);
      if (ex.hits.length) {
        L.push(`  LEAKS: ${ex.hits.map((h) => `${h.label}:"${h.substring}"`).join(', ')}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

export function writeReport(r: Report, dir: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = r.generatedAt.replace(/[:.]/g, '-');
  const base = `realism-${r.modelUnderTest.replace(/[^a-z0-9]+/gi, '-')}-${stamp}`;
  const json = join(dir, `${base}.json`);
  const md = join(dir, `${base}.md`);
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, renderMarkdown(r));
  return { json, md };
}
