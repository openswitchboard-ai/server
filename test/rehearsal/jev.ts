/**
 * SCORING WHAT THE ASSISTANTS SAID, TWICE.
 *
 * The rubric, the parser and the reasoning behind both already exist in
 * scripts/eval/transcriptScore.mts and are used here directly rather than
 * copied: one rubric, one parser, one place to argue with. What this module
 * adds is the suite's own bar (levels.ts) and the second look.
 *
 * THE SECOND LOOK. A turn that comes back failed or uncertain is asked again,
 * and both answers are kept. A turn fails only when both calls clear the bar.
 * That removes boundary flicker at roughly a 0.01–0.05 standard deviation
 * without hiding anything: where the two calls disagree, the disagreement is
 * itself a reported row.
 *
 * ALWAYS ANSWERS. A missing key, a scorer that times out, a turn it would not
 * answer about: each is a blank row that the report says is blank. A rehearsal
 * reading that stops halfway is worth less than one that says which turns it
 * could not read.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { JEV_ENDPOINT, JEV_MODEL, postToJev } from '../../src/shadow/jev.js';
import {
  RULES,
  buildTurnState,
  parseTranscript,
  rubricQuestions,
  type Turn,
} from '../../scripts/eval/transcriptScore.mjs';
import { JEV_SECRET, REGION } from './config.js';
import { bandFor, type Band } from './levels.js';

export interface ScoredMark {
  ruleId: string;
  /** The two probabilities, in order. The second is absent when not needed. */
  values: (number | null)[];
  bands: (Band | null)[];
  /** The verdict after both looks. */
  band: Band | null;
  /** True when the two calls landed in different bands. */
  disagreed: boolean;
}

export interface ScoredTurn {
  section: string;
  speaker: string;
  index: number;
  text: string;
  marks: ScoredMark[];
  /** Why there is no answer, where there is none. */
  reason?: string;
  latencyMs: number[];
  tokensIn: number;
  tokensOut: number;
}

export interface ScoreResult {
  turns: ScoredTurn[];
  /** Turns with at least one mark that failed on both calls. */
  failedTurns: ScoredTurn[];
  /** Turns with at least one uncertain mark and no failure. */
  uncertainTurns: ScoredTurn[];
  scoredCount: number;
  meanLatencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Set when nothing could be scored, and why. */
  unavailable?: string;
}

async function readKey(): Promise<string | undefined> {
  try {
    const secrets = new SecretsManagerClient({ region: REGION });
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: JEV_SECRET }));
    const json = JSON.parse(r.SecretString ?? '{}');
    return json.apiKey ? String(json.apiKey) : undefined;
  } catch {
    // The message can quote the secret's name; the caller only needs to know
    // that there is no key.
    return undefined;
  }
}

export type AskJev = (state: unknown) => Promise<{
  answers: Record<string, number | null>;
  reason?: string;
  latencyMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
}>;

/** The real scorer: one rubric of nine nouls per call. */
function liveAsk(apiKey: string): AskJev {
  const questions = rubricQuestions();
  return async (state) => {
    const r = await postToJev({
      state,
      questions,
      apiKey,
      endpoint: process.env.JEV_ENDPOINT || JEV_ENDPOINT,
      model: process.env.JEV_MODEL || JEV_MODEL,
      timeoutMs: 20_000,
    });
    if (!r.ok) return { answers: {}, reason: r.reason };
    const answers: Record<string, number | null> = {};
    for (const rule of RULES) {
      const a = r.answers[rule.id];
      answers[rule.id] = a?.type === 'noul' ? a.noul : null;
    }
    return { answers, latencyMs: r.latencyMs, usage: r.usage };
  };
}

/**
 * Score one run's transcript.
 *
 * `ask` is injectable so the dry run and the unit tests can drive the whole
 * double-look arrangement without a key or a network.
 */
export async function scoreTranscript(
  markdown: string,
  opts: { assistantNames: string[]; ask?: AskJev; concurrency?: number } = { assistantNames: [] },
): Promise<ScoreResult> {
  const transcript = parseTranscript(markdown, { assistantNames: opts.assistantNames });
  const assistantTurns = transcript.turns.filter((t) => t.role === 'assistant');
  const empty: ScoreResult = {
    turns: [],
    failedTurns: [],
    uncertainTurns: [],
    scoredCount: 0,
    meanLatencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  if (!assistantTurns.length) {
    return { ...empty, unavailable: 'the transcript held no assistant turns' };
  }
  let ask = opts.ask;
  if (!ask) {
    const key = await readKey();
    if (!key) {
      return {
        ...empty,
        unavailable: `no Jev key in ${JEV_SECRET}; the speech rules were NOT read this run`,
      };
    }
    ask = liveAsk(key);
  }

  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 3));
  const out: ScoredTurn[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= assistantTurns.length) return;
        out[i] = await scoreOne(transcript, assistantTurns[i], ask!);
      }
    }),
  );

  const turns = out.filter(Boolean);
  const scored = turns.filter((t) => !t.reason);
  const failedTurns = scored.filter((t) => t.marks.some((m) => m.band === 'fail'));
  const uncertainTurns = scored.filter(
    (t) => !t.marks.some((m) => m.band === 'fail') && t.marks.some((m) => m.band === 'uncertain'),
  );
  const lat = scored.flatMap((t) => t.latencyMs);
  return {
    turns,
    failedTurns,
    uncertainTurns,
    scoredCount: scored.length,
    meanLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
    tokensIn: scored.reduce((n, t) => n + t.tokensIn, 0),
    tokensOut: scored.reduce((n, t) => n + t.tokensOut, 0),
  };
}

async function scoreOne(
  transcript: ReturnType<typeof parseTranscript>,
  turn: Turn,
  ask: AskJev,
): Promise<ScoredTurn> {
  const state = buildTurnState(transcript, turn, { includeStepTools: true });
  const first = await ask(state);
  const base: ScoredTurn = {
    section: turn.section,
    speaker: turn.speaker,
    index: turn.index,
    text: turn.text,
    marks: [],
    latencyMs: first.latencyMs !== undefined ? [first.latencyMs] : [],
    tokensIn: first.usage?.input_tokens ?? 0,
    tokensOut: first.usage?.output_tokens ?? 0,
  };
  if (first.reason) return { ...base, reason: first.reason };

  const needsSecond = RULES.some((r) => {
    const b = bandFor(r.id, first.answers[r.id]);
    return b === 'fail' || b === 'uncertain';
  });
  const second = needsSecond ? await ask(state) : undefined;
  if (second?.latencyMs !== undefined) base.latencyMs.push(second.latencyMs);
  base.tokensIn += second?.usage?.input_tokens ?? 0;
  base.tokensOut += second?.usage?.output_tokens ?? 0;

  for (const rule of RULES) {
    const v1 = first.answers[rule.id] ?? null;
    const b1 = bandFor(rule.id, v1);
    if (b1 === null || b1 === 'no') continue;
    const v2 = second && !second.reason ? (second.answers[rule.id] ?? null) : null;
    const b2 = second && !second.reason ? bandFor(rule.id, v2) : null;
    // BOTH calls have to clear the bar for a failure. Where the second could
    // not be had at all, the first stands as uncertain rather than as a
    // failure: one reading is not two.
    const band: Band = b1 === 'fail' && b2 === 'fail' ? 'fail' : 'uncertain';
    base.marks.push({
      ruleId: rule.id,
      values: [v1, v2],
      bands: [b1, b2],
      band,
      disagreed: b2 !== null && b1 !== b2,
    });
  }
  return base;
}

/** Slip rate per rule per assistant, for the end-of-series table. */
export function slipRates(results: ScoreResult[]): {
  speaker: string;
  ruleId: string;
  failed: number;
  uncertain: number;
  turns: number;
}[] {
  const tally = new Map<string, { failed: number; uncertain: number }>();
  const turnsBySpeaker = new Map<string, number>();
  for (const r of results) {
    for (const t of r.turns) {
      if (t.reason) continue;
      turnsBySpeaker.set(t.speaker, (turnsBySpeaker.get(t.speaker) ?? 0) + 1);
      for (const m of t.marks) {
        const key = `${t.speaker}\u0000${m.ruleId}`;
        const e = tally.get(key) ?? { failed: 0, uncertain: 0 };
        if (m.band === 'fail') e.failed++;
        if (m.band === 'uncertain') e.uncertain++;
        tally.set(key, e);
      }
    }
  }
  return [...tally.entries()]
    .map(([key, e]) => {
      const [speaker, ruleId] = key.split('\u0000');
      return { speaker, ruleId, ...e, turns: turnsBySpeaker.get(speaker) ?? 0 };
    })
    .sort((a, b) => b.failed - a.failed || b.uncertain - a.uncertain);
}
