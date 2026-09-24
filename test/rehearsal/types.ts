/**
 * The shapes the rehearsal suite is built out of.
 *
 * A CHECK is one sentence a person could argue with, an id, a verdict and the
 * evidence the verdict was read off. Nothing in here is a boolean on its own:
 * a check that passes with no evidence is a check nobody can audit, and this
 * suite exists to replace a person reading a transcript by hand.
 *
 * There is a third verdict on purpose. `todo` is a check that is WRITTEN but
 * NOT IMPLEMENTED — the stage-4 and stage-5 pieces that need a page nobody has
 * pointed this harness at yet. It never passes and it never fails: it reports
 * "not implemented", and the stage it sits in is reported as incomplete rather
 * than green. A fake pass would be worse than no check.
 */

export type Verdict = 'pass' | 'fail' | 'todo' | 'skip';

export interface Check {
  /** 'S1.manual', 'S3.pin_refused' — stable across runs, so a rate can be counted. */
  id: string;
  /** One plain sentence saying what had to be true. */
  says: string;
  verdict: Verdict;
  /** What the verdict was read off: a row, a count, a quoted line. One line. */
  evidence: string;
  /**
   * A slip this check SAW and let through rather than failing on, counted into
   * the run's non-critical rate beside the speech marks. The first is a link
   * the human had to ask for: the gate is whether they got it, and having to
   * ask is counted (Lachlan, 24 September 2026). Printed in the evidence too,
   * so a tolerated slip is never an unseen one.
   */
  countedSlip?: string;
}

export const pass = (id: string, says: string, evidence: string): Check => ({
  id,
  says,
  verdict: 'pass',
  evidence,
});
export const fail = (id: string, says: string, evidence: string): Check => ({
  id,
  says,
  verdict: 'fail',
  evidence,
});
export const todo = (id: string, says: string, evidence: string): Check => ({
  id,
  says,
  verdict: 'todo',
  evidence,
});
export const skip = (id: string, says: string, evidence: string): Check => ({
  id,
  says,
  verdict: 'skip',
  evidence,
});

/** A stage passes only when every check in it passed. A `todo` is not a pass. */
export function stagePassed(checks: Check[]): boolean {
  return checks.length > 0 && checks.every((c) => c.verdict === 'pass' || c.verdict === 'skip');
}

export interface StageResult {
  stage: number;
  name: string;
  checks: Check[];
  passed: boolean;
}

/** Which side of the errand somebody is on. */
export type SideId = 'seller' | 'buyer';

/** A line in the transcript, before it is written out. */
export interface TranscriptTurn {
  stage: number;
  side: SideId;
  /** The assistant playing this side in this run. */
  agent: string;
  speaker: string;
  role: 'human' | 'assistant';
  text: string;
  /** Tool names the reply exposed, where the driver could see any. */
  toolActivity?: string[];
  at: string;
}

export interface RunResult {
  run: number;
  startedAt: string;
  endedAt: string;
  /** seller -> agent name, buyer -> agent name, for this run. */
  cast: Record<SideId, string>;
  accounts: Record<SideId, string | undefined>;
  stages: StageResult[];
  /** True when every stage 1..n asked for passed. */
  green: boolean;
  /** Anything that stopped the run before it finished. */
  error?: string;
  /**
   * TRUE ONLY WHERE THE SWITCHBOARD REALLY CALLED THE INTRODUCTION A MAYBE.
   *
   * The transcript cannot say this — the scorer is shown words and tool names,
   * never the switchboard's own answers — so the rules that turn on it are
   * asked only when this is true. See Rule.needs in transcriptScore.mts.
   */
  possibleIntro?: boolean;
  /** True where the pair came close and no introduction was made. */
  nearMiss?: boolean;
  /**
   * Every figure that was actually put on the table in this run, whoever put
   * it there. A figure here is a FACT about the deal, so saying it back is
   * reporting rather than inventing — see jev.ts, invented_figure.
   */
  tableFigures?: number[];
}

/**
 * ONE ASSISTANT, AS FAR AS THIS SUITE CARES.
 *
 * Every client is driven the same way: a session id and one human utterance in,
 * the assistant's verbatim words out. `toolActivity` is whatever that client
 * lets us see about the tools the turn called — OpenClaw's terminal receipt,
 * Claude Code's tool_use blocks — and is absent, not empty, where the client
 * shows nothing. An empty array means "this turn called nothing"; `undefined`
 * means "this client cannot tell us", and the two must never be confused.
 */
export interface AgentReply {
  text: string;
  toolActivity?: string[];
  model?: string;
  durationMs?: number;
  raw?: string;
}

export interface Driver {
  /** 'Nagatha', 'Bilby', 'Claude' — the name that goes in the transcript. */
  name: string;
  /** Wipe it back to a clean assistant and point it at `agentKey`. */
  prepare(agentKey: string, runId: string, humanFirstName?: string): Promise<string>;
  ask(sessionId: string, utterance: string): Promise<AgentReply>;
  /** Delete anything the run wrote for this client. Never throws. */
  teardown?(): Promise<void>;
}
