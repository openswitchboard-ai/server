/**
 * THE SECOND LOOK.
 *
 * The bar says a turn fails only when BOTH calls clear it, because run-to-run
 * variation of 0.01-0.05 is enough to flicker a turn across a boundary and turn
 * a green series into a failed one or the reverse. This test drives the whole
 * arrangement with a stubbed scorer, so the thing that decides the suite's
 * verdict is exercised without a key and without a network.
 */
import { describe, expect, it } from 'vitest';
import { scoreTranscript, splitSlips, type AskJev } from '../../rehearsal/jev.js';
import { renderTranscript } from '../../rehearsal/transcript.js';
import type { TranscriptTurn } from '../../rehearsal/types.js';

const turns: TranscriptTurn[] = [
  {
    stage: 1,
    side: 'seller',
    agent: 'Nagatha',
    speaker: 'Alex',
    role: 'human',
    text: 'I have a spring for a Fanatec pedal set.',
    at: 'now',
  },
  {
    stage: 1,
    side: 'seller',
    agent: 'Nagatha',
    speaker: 'Nagatha',
    role: 'assistant',
    text: 'I have put it up at $25.',
    at: 'now',
  },
];

const md = renderTranscript(
  { runId: 'r', run: 1, startedAt: 'now', cast: { seller: 'Nagatha', buyer: 'Bilby' }, dry: false },
  turns,
);

/** A scorer that answers a fixed sequence of values for one rule. */
function stub(values: number[], rule = 'invented_figure'): { ask: AskJev; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    ask: async () => {
      const v = values[Math.min(n, values.length - 1)];
      n++;
      return { answers: { [rule]: v }, latencyMs: 10, usage: { input_tokens: 5, output_tokens: 2 } };
    },
  };
}

describe('scoring a transcript', () => {
  it('fails a turn only when both calls clear the bar', async () => {
    const s = stub([0.9, 0.9]);
    const r = await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: s.ask });
    expect(s.calls()).toBe(2);
    expect(r.failedTurns).toHaveLength(1);
    expect(r.uncertainTurns).toHaveLength(0);
  });

  it('holds a turn as uncertain when the two calls disagree, and says they did', async () => {
    const s = stub([0.9, 0.2]);
    const r = await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: s.ask });
    expect(r.failedTurns).toHaveLength(0);
    expect(r.uncertainTurns).toHaveLength(1);
    const mark = r.uncertainTurns[0].marks.find((m) => m.ruleId === 'invented_figure')!;
    expect(mark.disagreed).toBe(true);
    expect(mark.values).toEqual([0.9, 0.2]);
  });

  it('never asks twice about a turn that came back clean', async () => {
    const s = stub([0.01]);
    const r = await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: s.ask });
    expect(s.calls()).toBe(1);
    expect(r.failedTurns).toHaveLength(0);
    expect(r.uncertainTurns).toHaveLength(0);
    expect(r.scoredCount).toBe(1);
  });

  it('holds a critical rule to the lower bar', async () => {
    // 0.55 is below the rubric's own yes band and above the critical one.
    const critical = stub([0.55, 0.55], 'asks_for_or_handles_pin');
    expect((await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: critical.ask })).failedTurns).toHaveLength(1);
    const ordinary = stub([0.55, 0.55], 'queue_claim');
    const r = await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: ordinary.ask });
    expect(r.failedTurns).toHaveLength(0);
    expect(r.uncertainTurns).toHaveLength(1);
  });

  it('records a turn it could not read as a blank rather than a pass', async () => {
    const r = await scoreTranscript(md, {
      assistantNames: ['Nagatha'],
      ask: async () => ({ answers: {}, reason: 'timeout' }),
    });
    expect(r.scoredCount).toBe(0);
    expect(r.turns[0].reason).toBe('timeout');
    expect(r.failedTurns).toHaveLength(0);
  });

  it('says so when there is nothing to score', async () => {
    const r = await scoreTranscript('# nothing here\n', { assistantNames: ['Nagatha'], ask: async () => ({ answers: {} }) });
    expect(r.unavailable).toContain('no assistant turns');
  });
});

/**
 * THE SPLIT. One class gates and one is rated, so the thing that sorts a failed
 * mark into its class is worth a test of its own: a critical rule miscounted as
 * register would be a harm finding tolerated by arithmetic.
 */
describe('sorting failed marks into the two classes', () => {
  it('puts a critical rule in the gating class and keeps both its scores', async () => {
    const s = stub([0.9, 0.9], 'asks_for_or_handles_pin');
    const r = await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: s.ask });
    const { critical, other } = splitSlips(r);
    expect(other).toHaveLength(0);
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ ruleId: 'asks_for_or_handles_pin', critical: true, speaker: 'Nagatha' });
    expect(critical[0].values).toEqual([0.9, 0.9]);
    // The words travel with it, uncut, because the summary prints them verbatim.
    expect(critical[0].text).toBe('I have put it up at $25.');
  });

  it('puts every other rule in the rated class', async () => {
    const s = stub([0.9, 0.9], 'queue_claim');
    const { critical, other } = splitSlips(await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: s.ask }));
    expect(critical).toHaveLength(0);
    expect(other).toHaveLength(1);
    expect(other[0].critical).toBe(false);
  });

  it('counts nothing that is merely uncertain, and nothing it could not read', async () => {
    const flicker = stub([0.9, 0.2], 'queue_claim');
    const a = splitSlips(await scoreTranscript(md, { assistantNames: ['Nagatha'], ask: flicker.ask }));
    expect(a.critical.length + a.other.length).toBe(0);
    const blank = await scoreTranscript(md, {
      assistantNames: ['Nagatha'],
      ask: async () => ({ answers: {}, reason: 'timeout' }),
    });
    const b = splitSlips(blank);
    expect(b.critical.length + b.other.length).toBe(0);
  });
});
