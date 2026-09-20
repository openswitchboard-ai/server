/**
 * WRITING THE RUN OUT IN THE ONE SHAPE THAT CAN BE READ BACK.
 *
 * scripts/eval/transcriptScore.mts parses these files, and its parser is not
 * forgiving by design: a `## heading`, `**Name:** words` per turn, `> notes`
 * ignored, `*(tool activity)*` kept aside as context and never scored. A
 * transcript that does not round-trip through parseTranscript is a transcript
 * the Jev rubric silently reads as having no assistant turns in it, and the
 * speech checks then pass because nothing was read. So the writer here is
 * tested against the parser rather than against a fixture of itself.
 *
 * ONE HEADING PER STAGE PER SIDE. The parser scopes "what the human had said so
 * far" to the section, which is what makes a step the unit a rehearsal is read
 * in: a slip in stage 3 must not be excused by something the human said in
 * stage 1 on the other side of the board.
 *
 * NEWLINES ARE FLATTENED, deliberately. The parser ends a turn at a blank line,
 * so an assistant reply with a paragraph break in it would be cut in half and
 * the second half scored as if nobody had said anything to prompt it. The words
 * are all kept; only the line breaks go, and `run-<i>.json` holds the reply
 * exactly as it arrived.
 */
import type { TranscriptTurn } from './types.js';

/**
 * The whole errand, in order. Stage 7 is its own scenario: a report closes the
 * conversation, so a run that reported could never reach stage 6.
 */
export const STAGE_NAMES: Record<number, string> = {
  1: 'Posting',
  2: 'Introduction and names',
  3: 'Conversation',
  4: 'Photos',
  5: 'Figures',
  6: 'Wrapping up',
  7: 'Report',
};

/** The heading's TEXT, without the `##`: what parseTranscript hands back. */
export function sectionHeading(stage: number, side: string, agent: string): string {
  return `Stage ${stage} — ${side}, ${agent}`;
}

/** One turn's words, on one line, safe for the parser. */
export function flatten(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface TranscriptHeader {
  runId: string;
  run: number;
  startedAt: string;
  cast: Record<string, string>;
  dry: boolean;
}

/**
 * A tool failure the CLIENT wrote into the conversation, rather than words the
 * assistant chose. Kept narrow on purpose: it has to carry a failure marker and
 * name a tool failing, so an assistant TELLING its human something went wrong
 * is still its own turn and still judged.
 */
const CLIENT_FAILURE = /^\s*(⚠️|🧩|\u26a0)[^\n]{0,120}\bfailed\b\s*$/iu;

export function renderTranscript(header: TranscriptHeader, turns: TranscriptTurn[]): string {
  const out: string[] = [];
  out.push(`# Rehearsal run ${header.run} — ${header.runId}`);
  out.push('');
  out.push(`> started ${header.startedAt}`);
  out.push(`> seller: ${header.cast.seller}, buyer: ${header.cast.buyer}`);
  if (header.dry) {
    out.push('> DRY RUN — canned assistant replies and a stubbed human. Nothing here happened.');
  }
  out.push('');

  let section = '';
  for (const t of turns) {
    const want = sectionHeading(t.stage, t.side, t.agent);
    if (want !== section) {
      section = want;
      out.push(`## ${section}`);
      out.push('');
    }
    if (t.toolActivity?.length) {
      out.push(`*(called ${t.toolActivity.join(', ')})*`);
    }
    // A CLIENT'S OWN FAILURE BANNER IS NOT THE ASSISTANT SPEAKING.
    // OpenClaw renders a tool failure into the conversation as a line of its
    // own ("⚠️ 🧩 Openswitchboard Wait For Press failed"), and it arrives here
    // looking exactly like a turn. Scored as one, it drew 47% for reading
    // machine detail aloud — a mark against an assistant for words its client
    // wrote (dev, 20 September 2026). It is written into the transcript as an
    // aside, so a person reading the run still sees the failure happen, and
    // the assistant's RECOVERY from it is still judged like any other turn.
    if (CLIENT_FAILURE.test(t.text)) {
      out.push(`*(the client showed a tool failure: ${flatten(t.text)})*`);
      out.push('');
      continue;
    }
    out.push(`**${t.speaker}:** ${flatten(t.text)}`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
