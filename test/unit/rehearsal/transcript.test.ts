/**
 * THE TRANSCRIPT HAS TO ROUND-TRIP.
 *
 * The writer and the scorer's parser are two halves of one contract, and the
 * failure mode if they drift is silent and total: parseTranscript finds no
 * assistant turns, the scorer scores nothing, and every speech check reports
 * clean. So the test is not "does the writer produce the markdown I expected" —
 * it is "does the parser read back exactly what went in".
 */
import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../../../scripts/eval/transcriptScore.mjs';
import { flatten, renderTranscript, sectionHeading } from '../../rehearsal/transcript.js';
import { extractPresses } from '../../rehearsal/human.js';
import type { TranscriptTurn } from '../../rehearsal/types.js';

const turn = (o: Partial<TranscriptTurn>): TranscriptTurn => ({
  stage: 1,
  side: 'seller',
  agent: 'Nagatha',
  speaker: 'Alex',
  role: 'human',
  text: 'hello',
  at: new Date().toISOString(),
  ...o,
});

describe('the transcript writer', () => {
  const turns: TranscriptTurn[] = [
    turn({ text: 'I have an upgraded spring for a Fanatec sim racing pedal set I no longer need.' }),
    turn({
      speaker: 'Nagatha',
      role: 'assistant',
      text: 'Which pedals are they for?\n\nAnd what condition is it in?',
      toolActivity: ['read_manual'],
    }),
    turn({ stage: 2, side: 'buyer', agent: 'Bilby', speaker: 'Tony', text: 'not sure, what do they usually go for?' }),
    turn({ stage: 2, side: 'buyer', agent: 'Bilby', speaker: 'Bilby', role: 'assistant', text: 'Someone has come forward.' }),
  ];

  const md = renderTranscript(
    { runId: 'r', run: 1, startedAt: 'now', cast: { seller: 'Nagatha', buyer: 'Bilby' }, dry: false },
    turns,
  );

  it('round-trips every turn through the scorer’s own parser', () => {
    const parsed = parseTranscript(md, { assistantNames: ['Nagatha', 'Bilby'] });
    expect(parsed.turns).toHaveLength(turns.length);
    for (let i = 0; i < turns.length; i++) {
      expect(parsed.turns[i].speaker).toBe(turns[i].speaker);
      expect(parsed.turns[i].role).toBe(turns[i].role);
      expect(parsed.turns[i].text).toBe(flatten(turns[i].text));
    }
  });

  it('gives each stage and side its own section', () => {
    const parsed = parseTranscript(md, { assistantNames: ['Nagatha', 'Bilby'] });
    expect(parsed.sections).toContain(sectionHeading(1, 'seller', 'Nagatha'));
    expect(parsed.sections).toContain(sectionHeading(2, 'buyer', 'Bilby'));
    // The scorer scopes "what the human said so far" to the section, so a
    // stage-2 turn must not see stage 1's words.
    const s2 = parsed.turns.find((t) => t.section === sectionHeading(2, 'buyer', 'Bilby') && t.role === 'assistant')!;
    expect(s2.section).not.toBe(sectionHeading(1, 'seller', 'Nagatha'));
  });

  it('keeps tool activity out of the turns and beside them', () => {
    const parsed = parseTranscript(md, { assistantNames: ['Nagatha', 'Bilby'] });
    const withTools = parsed.turns.find((t) => t.speaker === 'Nagatha')!;
    expect(withTools.toolActivityBefore.join(' ')).toContain('read_manual');
    expect(withTools.text).not.toContain('read_manual');
  });

  it('marks a dry run in a line the parser throws away', () => {
    const dry = renderTranscript(
      { runId: 'r', run: 1, startedAt: 'now', cast: { seller: 'Nagatha', buyer: 'Bilby' }, dry: true },
      turns,
    );
    expect(dry).toContain('DRY RUN');
    expect(parseTranscript(dry, { assistantNames: ['Nagatha', 'Bilby'] }).turns).toHaveLength(turns.length);
  });
});

describe('the press token', () => {
  it('pulls the link out and leaves the person saying something ordinary', () => {
    const { links, spoken } = extractPresses('[[PRESS https://my-dev.openswitchboard.ai/a/abc123]]');
    expect(links).toEqual(['https://my-dev.openswitchboard.ai/a/abc123']);
    expect(spoken).toBe('Pressed it.');
  });

  it('finds more than one, in order', () => {
    const { links } = extractPresses('[[PRESS https://a/a/1]] and [[PRESS https://b/a/2]]');
    expect(links).toEqual(['https://a/a/1', 'https://b/a/2']);
  });

  it('leaves ordinary words alone', () => {
    const { links, spoken } = extractPresses('used it about a year, good condition');
    expect(links).toEqual([]);
    expect(spoken).toBe('used it about a year, good condition');
  });

  it('never leaves the marker in the transcript', () => {
    const md = renderTranscript(
      { runId: 'r', run: 1, startedAt: 'now', cast: { seller: 'Nagatha', buyer: 'Bilby' }, dry: false },
      [turn({ text: extractPresses('[[PRESS https://x/a/1]]').spoken })],
    );
    expect(md).not.toContain('[[PRESS');
  });
});
