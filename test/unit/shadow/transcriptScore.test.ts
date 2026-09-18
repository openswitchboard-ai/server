/**
 * THE REHEARSAL TRANSCRIPT SCORER, WITHOUT THE MODEL.
 * (scripts/eval/transcriptScore.mts; the runner is
 *  scripts/eval/jev-transcript-score.mts; docs/jev-shadow.md.)
 *
 * No network here and no key. What is asserted is the part that decides what
 * an outside model is shown, which is the part worth being sure about:
 *
 *  - WHICH LINES ARE TURNS. A finding somebody wrote under a step is that
 *    person's conclusion about the turn above it, and scoring a conclusion as
 *    if it were evidence would score the reader rather than the assistant.
 *  - WHAT A TURN IS SCORED AGAINST: the human turns EARLIER IN THE SAME STEP,
 *    and nothing else. Not the notes, not the assistant's own earlier turns,
 *    and not another step — a rehearsal transcript carries pre-wipe takes the
 *    assistant never heard.
 *  - THAT EVERY RULE POINTS THE SAME WAY, so one set of bands reads the whole
 *    rubric: yes means the slip happened.
 *
 * The fixture below is shaped like a real run-9 transcript and says nothing
 * real: no addresses, no ids, no key.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_NAMES,
  RULES,
  RULE_IDS,
  buildTurnState,
  parseTranscript,
  rubricQuestions,
} from '../../../scripts/eval/transcriptScore.mjs';
import { noulBand } from '../../../src/shadow/jevTrials.js';

const FIXTURE = `# Run 12 transcript (rehearsal)

## Step 1 — laptop, the have side

**Lachlan:** I have a spare bike pump I no longer need.

*Assistant asked:* Roughly what would you want for it? → Open to offers

*(Called openswitchboard 2 times)*

**Assistant:** Listing posted, filed under goods.bicycle. Want me to check back
on it now or later?

> FINDING: she said the dotted path aloud. Manual rule on machinery under the water.

## Step 2 — phone, the want side

**Tony:** looking for a bike pump

**Nagatha:** Done — posted a want, up to $25 AUD, and I'll let you know the
moment anyone comes forward.

> FINDING: "$25" is a figure Tony never said.

---

## Step 3 — nobody says anything

> NOTE: nothing happened here.
`;

describe('reading a transcript', () => {
  const t = parseTranscript(FIXTURE);

  it('finds every step heading, including one with no turns in it', () => {
    expect(t.sections).toEqual([
      'Run 12 transcript (rehearsal)',
      'Step 1 — laptop, the have side',
      'Step 2 — phone, the want side',
      'Step 3 — nobody says anything',
    ]);
  });

  it('finds the four turns and nothing else', () => {
    expect(t.turns.map((x) => x.speaker)).toEqual(['Lachlan', 'Assistant', 'Tony', 'Nagatha']);
  });

  it('knows who is the assistant, by the default cast', () => {
    expect(DEFAULT_ASSISTANT_NAMES).toEqual(['Assistant', 'Nagatha', 'Bilby']);
    expect(t.turns.map((x) => x.role)).toEqual(['human', 'assistant', 'human', 'assistant']);
  });

  it('takes a different cast when it is given one', () => {
    const other = parseTranscript(FIXTURE, { assistantNames: ['Tony'] });
    const roles = Object.fromEntries(other.turns.map((x) => [x.speaker, x.role]));
    expect(roles.Tony).toBe('assistant');
    expect(roles.Nagatha).toBe('human');
  });

  it('SKIPS the findings somebody wrote afterwards', () => {
    const all = t.turns.map((x) => x.text).join(' ');
    expect(all).not.toContain('FINDING');
    expect(all).not.toContain('Manual rule');
    expect(all).not.toContain('nothing happened here');
  });

  it('skips tool activity and the italic asides, and keeps them aside as context', () => {
    const all = t.turns.map((x) => x.text).join(' ');
    expect(all).not.toContain('Called openswitchboard');
    expect(all).not.toContain('Assistant asked');
    const assistant = t.turns.find((x) => x.speaker === 'Assistant')!;
    expect(assistant.toolActivityBefore.join(' ')).toContain('Called openswitchboard 2 times');
  });

  it('keeps a wrapped turn as one turn', () => {
    const nagatha = t.turns.find((x) => x.speaker === 'Nagatha')!;
    expect(nagatha.text).toBe(
      "Done — posted a want, up to $25 AUD, and I'll let you know the moment anyone comes forward.",
    );
  });

  it('puts each turn under its own step', () => {
    expect(t.turns.find((x) => x.speaker === 'Tony')!.section).toBe(
      'Step 2 — phone, the want side',
    );
  });

  it('is unbothered by an empty document', () => {
    expect(parseTranscript('')).toEqual({ turns: [], sections: [] });
    expect(parseTranscript('just some prose, no turns at all')).toEqual({
      turns: [],
      sections: [],
    });
  });
});

describe('what one turn is scored against', () => {
  const t = parseTranscript(FIXTURE);
  const nagatha = t.turns.find((x) => x.speaker === 'Nagatha')!;
  const assistant = t.turns.find((x) => x.speaker === 'Assistant')!;

  it('carries the prior human turns of the SAME step, verbatim', () => {
    expect(buildTurnState(t, nagatha)).toEqual({
      human_said_so_far: ['looking for a bike pump'],
      assistant_turn: nagatha.text,
    });
  });

  it('does not reach into another step', () => {
    // Lachlan spoke in step 1. Nagatha answers in step 2 and never heard him.
    expect(buildTurnState(t, nagatha).human_said_so_far).not.toContain(
      'I have a spare bike pump I no longer need.',
    );
  });

  it('carries no findings and no tool activity by default', () => {
    const state = buildTurnState(t, assistant);
    expect(Object.keys(state).sort()).toEqual(['assistant_turn', 'human_said_so_far']);
    expect(JSON.stringify(state)).not.toContain('FINDING');
    expect(JSON.stringify(state)).not.toContain('Called openswitchboard');
  });

  it('carries the tool activity only when it is asked for', () => {
    const state = buildTurnState(t, assistant, { includeToolActivity: true });
    expect(state.tool_activity?.join(' ')).toContain('Called openswitchboard');
  });

  it('carries no assistant turn but the one being scored', () => {
    const state = buildTurnState(t, nagatha);
    expect(state.human_said_so_far).not.toContain(assistant.text);
  });
});

describe('the rubric', () => {
  it('is the nine rules, all nouls', () => {
    expect(RULE_IDS).toEqual([
      'invented_figure',
      'queue_claim',
      'machine_detail_aloud',
      'offers_contact_on_near_miss',
      'unbacked_promise_to_notify',
      'describes_unseen_picture',
      'asks_for_or_handles_pin',
      'asked_already_answered',
      'vague_area',
    ]);
    const q = rubricQuestions();
    expect(Object.keys(q).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) expect(q[id].type).toBe('noul');
  });

  it('phrases every rule so that YES MEANS THE SLIP HAPPENED', () => {
    // A rubric half of whose questions are negations cannot be read through one
    // set of bands, and these bands are one set.
    for (const rule of RULES) {
      expect(rule.instructions).toMatch(/^Does the assistant /);
      expect(rule.instructions.trim().endsWith('?')).toBe(true);
    }
  });

  it('says which rules are the manual’s and which are ours', () => {
    // Two of them are not in the manual in so many words, and a table that did
    // not say so would read as if the manual had been broken when it had not.
    const extrapolated = RULES.filter((r) => r.source === 'extrapolated').map((r) => r.id);
    expect(extrapolated).toEqual(['machine_detail_aloud', 'describes_unseen_picture']);
    for (const rule of RULES) expect(rule.manualNote.length).toBeGreaterThan(20);
  });

  it('reads an answer through the same bands the trials use', () => {
    expect(noulBand(0.92)).toBe('yes');
    expect(noulBand(0.55)).toBe('uncertain');
    expect(noulBand(0.04)).toBe('no');
  });
});
