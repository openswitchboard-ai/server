/**
 * Report model + writers for the duet eval. One JSON (everything, machine
 * readable) and one Markdown (the interleaved transcript, the DB timeline, the
 * linter table per model, the invariant results, the outcome and the findings).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GradeResult, LeakHit, leakFrequency } from '../realism/grader.js';
import type { DbEvent } from './progress.js';
import type { SideId } from './persona.js';

export interface Utterance {
  ts: string;
  round: number;
  side: SideId;
  /** Who spoke. */
  from: 'human' | 'agent';
  text: string;
  /** For a human line: which persona rule produced it (or 'brief'/'heartbeat'). */
  rule?: string;
  /** For an agent line: how the reply graded, how long it took, what it called. */
  hits?: LeakHit[];
  hardCount?: number;
  softCount?: number;
  pass?: boolean;
  durationMs?: number;
  toolsUsed?: string[];
  model?: string;
}

export interface HarnessAction {
  ts: string;
  round: number;
  side: SideId;
  action: string;
  detail: string;
  /** Did the agent tell its human about this step before the harness did it? */
  surfacedByAgent?: boolean;
}

export interface PrivacyFinding {
  /** Whose private number. */
  owner: SideId;
  label: string;
  /** Where it turned up. */
  where: string;
  excerpt: string;
  /** True when it crossed to the OTHER side — the only real leak. */
  crossed: boolean;
  /**
   * Set when the figure is on the wire because its OWNER typed it on their own
   * offer page. A human sending their own limit as their own offer is the
   * consent gate working, not a leak, and it must not be scored as one.
   */
  consented?: string;
}

export interface ModelLinterResult {
  side: SideId;
  model: string;
  repliesGraded: number;
  repliesWithHardLeak: number;
  leakFrequency: { label: string; severity: string; count: number }[];
  worstExamples: { text: string; hits: LeakHit[] }[];
  /** Clock times excused as two people arranging a pickup (duet/logistics.ts). */
  meetingTimesAllowed: number;
}

/**
 * Whether figures travelled on the offers rail, and what the switchboard holds
 * to show it. This is the headline measurement of the run: the rail exists so
 * a figure crosses under the human's own limits rather than as free text in a
 * sealed conversation nothing can enforce against, and a run where the two
 * agents negotiated entirely in words has proved the rail unused.
 */
export interface OffersRail {
  used: boolean;
  count: number;
  /** `authoredBy` says who typed the figure: the human, or their agent. */
  offers: { side: string; amount: number; ccy: string; state: string; authoredBy: string }[];
  settlements: { side: string; amount: number; ccy: string; state: string }[];
}

export interface DuetReport {
  generatedAt: string;
  runId: string;
  env: string;
  outcome: 'deal' | 'no-deal' | 'deadlock' | 'error';
  outcomeDetail: string;
  /** Did any figure travel as an offer, and what came of it. */
  offersRail: OffersRail;
  sides: Record<
    SideId,
    { human: string; agent: string; model: string; accountId: string; sharedFirstName: string }
  >;
  rounds: number;
  transcript: Utterance[];
  harnessActions: HarnessAction[];
  dbTimeline: DbEvent[];
  linter: ModelLinterResult[];
  invariants: { invariant: string; detail: string; where: string }[];
  invariantsChecked: string[];
  privacy: { findings: PrivacyFinding[]; note: string };
  findings: string[];
  limitations: string[];
  /** What each agent actually published, verbatim from the board. */
  listings: { side: string; type: string; category: string; geo: any; attributes: any }[];
  /** Pairs of the run's own cards the engine scored but did not introduce. */
  nearMisses: { score: number; category: string; threshold: number }[];
  nagathaMemoryAfterRun?: string;
}

export function buildLinter(
  side: SideId,
  model: string,
  replies: {
    text: string;
    hits: LeakHit[];
    hardCount: number;
    softCount: number;
    pass: boolean;
    meetingTimesAllowed?: number;
  }[],
): ModelLinterResult {
  const grades: GradeResult[] = replies.map((r) => ({
    text: r.text,
    hits: r.hits,
    hardCount: r.hardCount,
    softCount: r.softCount,
    pass: r.pass,
  }));
  return {
    side,
    model,
    repliesGraded: replies.length,
    repliesWithHardLeak: replies.filter((r) => r.hardCount > 0).length,
    leakFrequency: leakFrequency(grades),
    worstExamples: replies
      .filter((r) => r.hardCount > 0)
      .sort((a, b) => b.hardCount - a.hardCount)
      .slice(0, 3)
      .map((r) => ({ text: r.text, hits: r.hits })),
    meetingTimesAllowed: replies.reduce((n, r) => n + (r.meetingTimesAllowed ?? 0), 0),
  };
}

const clip = (s: string, n = 1400): string =>
  s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;

export function renderMarkdown(r: DuetReport): string {
  const L: string[] = [];
  L.push('# OpenSwitchboard duet eval — two real agents, unscripted');
  L.push('');
  L.push(`- **Generated:** ${r.generatedAt}   **Run:** ${r.runId}   **Env:** ${r.env}`);
  L.push(`- **Outcome:** **${r.outcome.toUpperCase()}** — ${r.outcomeDetail}`);
  L.push(
    `- **Offers used:** **${r.offersRail.used ? 'YES' : 'NO'}** — ${r.offersRail.count} offer(s) on the rail` +
      (r.offersRail.settlements.length ? `, ${r.offersRail.settlements.length} settlement(s)` : ''),
  );
  L.push(`- **Rounds:** ${r.rounds}`);
  for (const side of ['priya', 'marlowe'] as SideId[]) {
    const s = r.sides[side];
    L.push(
      `- **${s.human}** (${side === 'priya' ? 'seller' : 'buyer'}) — agent \`${s.agent}\` on \`${s.model}\`, account \`${s.accountId.slice(0, 8)}\`, shares as "${s.sharedFirstName}"`,
    );
  }
  L.push('');

  L.push('## Findings');
  L.push('');
  if (!r.findings.length) L.push('_None recorded._');
  for (const f of r.findings) L.push(`- ${f}`);
  L.push('');

  L.push('## Did the figures travel as offers?');
  L.push('');
  L.push(
    r.offersRail.used
      ? `**Yes — ${r.offersRail.count} offer(s) went on the rail**, where the server holds each human's own limits and refuses anything outside them.`
      : '**No offer was ever put on the rail.** Every figure the two agents exchanged travelled as free text across the open conversation, which the switchboard seals and cannot enforce a limit against.',
  );
  L.push('');
  if (r.offersRail.offers.length) {
    L.push('| proposed by | amount | typed by | state |');
    L.push('| --- | --- | --- | --- |');
    for (const o of r.offersRail.offers) {
      L.push(`| ${o.side} | ${o.amount} ${o.ccy} | ${o.authoredBy} | ${o.state} |`);
    }
    L.push('');
  }
  if (r.offersRail.settlements.length) {
    L.push(
      'Settlements proposed (a settlement is only ever proposed once the two sides have agreed a figure):',
    );
    L.push('');
    L.push('| proposed by | amount | state |');
    L.push('| --- | --- | --- |');
    for (const s of r.offersRail.settlements) L.push(`| ${s.side} | ${s.amount} ${s.ccy} | ${s.state} |`);
    L.push('');
  }

  L.push('## What the two agents published, and whether the engine introduced them');
  L.push('');
  if (!r.listings.length) L.push('_Neither agent published anything._');
  else {
    L.push('| side | type | category | place | attributes the agent chose to write |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const l of r.listings) {
      L.push(
        `| ${l.side} | ${l.type} | ${l.category} | ${l.geo?.place ?? l.geo?.bucket ?? '-'} | \`${JSON.stringify(l.attributes)}\` |`,
      );
    }
  }
  L.push('');
  if (r.nearMisses.length) {
    L.push(
      `**They were scored and NOT introduced.** ` +
        r.nearMisses
          .map((n) => `${n.category}: **${n.score.toFixed(4)}** against a create threshold of ${n.threshold}`)
          .join('; ') +
        '. The listings were for the same thing, in the same category, in the same place — the gap is in how much each agent wrote down.',
    );
    L.push('');
  }

  L.push('## Jargon linter, per model');
  L.push('');
  L.push(
    'A clock time in a reply that is arranging a pickup ("Saturday at 10:00, at the shops") is excused here as ordinary speech; the register eval\'s own rule is untouched, and the excused count is shown so nothing is hidden.',
  );
  L.push('');
  L.push('| side | model | replies | with a hard leak | pickup times excused |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const m of r.linter) {
    L.push(
      `| ${m.side} | \`${m.model}\` | ${m.repliesGraded} | ${m.repliesWithHardLeak} | ${m.meetingTimesAllowed} |`,
    );
  }
  for (const m of r.linter) {
    L.push('');
    L.push(`### ${m.side} — \`${m.model}\``);
    if (!m.leakFrequency.length) {
      L.push('');
      L.push('_No leaks detected._');
    } else {
      L.push('');
      L.push('| leak | severity | count |');
      L.push('| --- | --- | --- |');
      for (const f of m.leakFrequency) L.push(`| ${f.label} | ${f.severity} | ${f.count} |`);
    }
    for (const e of m.worstExamples) {
      L.push('');
      L.push(`> ${clip(e.text, 500).replace(/\n/g, '\n> ')}`);
      L.push('');
      L.push(`  - leaks: ${e.hits.map((h) => `${h.label}:"${h.substring}"`).join(', ')}`);
    }
  }
  L.push('');

  L.push('## Private-number scan');
  L.push('');
  L.push(r.privacy.note);
  L.push('');
  if (!r.privacy.findings.length) {
    L.push('_Neither private figure was found anywhere the scan can see._');
  } else {
    L.push('| owner | figure | where | crossed to the other side? |');
    L.push('| --- | --- | --- | --- |');
    for (const f of r.privacy.findings) {
      L.push(
        `| ${f.owner} | ${f.label} | ${f.where} | ${f.crossed ? '**YES**' : f.consented ? `no — ${f.consented}` : 'no'} |`,
      );
    }
    for (const f of r.privacy.findings) {
      L.push('');
      L.push(`- **${f.where}**: ${clip(f.excerpt, 400)}`);
    }
  }
  L.push('');

  L.push('## Invariants');
  L.push('');
  L.push(`Checked: ${r.invariantsChecked.join('; ')}`);
  L.push('');
  if (!r.invariants.length) L.push('_No violations._');
  else {
    L.push('| invariant | detail | where |');
    L.push('| --- | --- | --- |');
    for (const v of r.invariants) L.push(`| ${v.invariant} | ${v.detail} | ${v.where} |`);
  }
  L.push('');

  L.push('## DB event timeline');
  L.push('');
  if (!r.dbTimeline.length) L.push('_No events._');
  else {
    L.push('| time | side | event | detail |');
    L.push('| --- | --- | --- | --- |');
    for (const e of r.dbTimeline) {
      L.push(`| ${e.at.slice(11, 19)} | ${e.side ?? '-'} | ${e.kind} | ${e.detail} |`);
    }
  }
  L.push('');

  L.push('## Harness actions (the real page presses)');
  L.push('');
  if (!r.harnessActions.length) L.push('_None._');
  else {
    L.push('| time | round | side | action | detail | agent had surfaced it? |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const a of r.harnessActions) {
      L.push(
        `| ${a.ts.slice(11, 19)} | ${a.round} | ${a.side} | ${a.action} | ${a.detail} | ${a.surfacedByAgent === undefined ? '-' : a.surfacedByAgent ? 'yes' : 'no'} |`,
      );
    }
  }
  L.push('');

  L.push('## Interleaved transcript');
  for (const u of r.transcript) {
    const who =
      u.from === 'human'
        ? `${r.sides[u.side].human} (human)`
        : `${r.sides[u.side].agent} [${u.model ?? ''}]`;
    L.push('');
    L.push(`**r${u.round} · ${u.ts.slice(11, 19)} · ${who}**${u.rule ? ` _(${u.rule})_` : ''}${u.pass === false ? ' **[HARD LEAK]**' : ''}`);
    L.push('');
    L.push(clip(u.text).split('\n').map((l) => `> ${l}`).join('\n'));
    if (u.hits?.length) {
      L.push('');
      L.push(`  - leaks: ${u.hits.map((h) => `${h.label}${h.severity === 'soft' ? '(soft)' : ''}:"${h.substring}"`).join(', ')}`);
    }
    if (u.toolsUsed?.length) {
      L.push('');
      L.push(`  - called: ${u.toolsUsed.join(', ')}`);
    }
  }
  L.push('');

  if (r.nagathaMemoryAfterRun) {
    L.push('## What Nagatha wrote into her memory during the run');
    L.push('');
    L.push('```');
    L.push(clip(r.nagathaMemoryAfterRun, 4000));
    L.push('```');
    L.push('');
  }

  L.push('## Limitations');
  L.push('');
  for (const l of r.limitations) L.push(`- ${l}`);
  L.push('');
  return L.join('\n');
}

export function writeReport(r: DuetReport, dir: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = r.generatedAt.replace(/[:.]/g, '-');
  const base = `duet-${stamp}`;
  const json = join(dir, `${base}.json`);
  const md = join(dir, `${base}.md`);
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, renderMarkdown(r));
  return { json, md };
}
