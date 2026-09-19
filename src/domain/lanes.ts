/**
 * THE TWO LANES.
 *
 * An assistant is one of two things and the switchboard has to know which
 * before it hands over a sentence about waiting.
 *
 *   AUTONOMOUS — it runs between conversations. It can wake itself on a
 *                schedule and reach its human without being spoken to first,
 *                so "I'll tell you when it's your turn" is a sentence it can
 *                keep. Inside the lane there are still two cases: the rhythm
 *                its human agreed is written down, or nothing is agreed yet
 *                and the thing to do is ask, suggest hourly, and save it.
 *   PROMPTED   — it exists only while its human is typing to it. It can never
 *                be the messenger, so it must never offer to be: the
 *                switchboard emails them, and they ask again when they like.
 *
 * WHY A TABLE RATHER THAN A BRANCH PER SENTENCE. Two rehearsals in two days
 * (19 and 20 September 2026) turned up the same defect in different sentences:
 * an assistant promised to come back with nothing scheduled, nothing saved and
 * no way to wake itself, and its human sat waiting on it. Fixing them one at a
 * time leaves the next sentence somebody writes free to promise again. So
 * every agent-facing sentence whose advice depends on the lane lives in
 * SENTENCES below, is served through `say`, and NOTHING outside this file
 * branches on `runs_on_its_own` or `check_every_minutes` — there is a test
 * that sweeps the source and fails if anything does.
 *
 * WHAT THE LANE COSTS TO KNOW. One plaintext column on the account row, read
 * once per answer and threaded through (see checkMatches, which reads it once
 * for a sweep of fifty introductions). An unreadable arrangement is the
 * PROMPTED lane, which is the wording that promises the human the least, and
 * the only safe way to fail.
 *
 * AND IT FLIPS ON ITS OWN. The lane is read per answer rather than baked into
 * anything, so a human turning autonomy on or off on their own page changes
 * every one of these sentences at once, with nothing else to do.
 */
import { cadenceInPlainWords, type Arrangement } from './arrangement.js';

export type Lane = 'autonomous' | 'prompted';

/** Which lane an arrangement puts its agent in. Absent is prompted. */
export function laneFor(a: Arrangement): Lane {
  return a.runs_on_its_own === true ? 'autonomous' : 'prompted';
}

/**
 * What a sentence needs filling in: the thing being talked about, and — on the
 * agreed wording only — the cadence in the words a person would say it in.
 * `say` fills `cadence` itself from the arrangement; callers never pass it.
 */
export interface Ctx {
  /** The thing, as the human on this side of it would name it. */
  thing?: string;
  /** What a sentence has already said, where a head is assembled upstream. */
  added?: string;
  /** Filled in by `say` from the saved rhythm. */
  cadence?: string;
}

type Wording = string | ((c: Ctx) => string);

export interface Sentence {
  /** One line saying what this sentence is for. */
  about: string;
  /** The most characters this wording may run to, asserted in the tests. */
  budget: number;
  prompted: Wording;
  autonomous: {
    /** A rhythm is saved: say it as the agreed thing it is. */
    agreed: Wording;
    /** Nothing saved yet: ask, suggest hourly, save it, and only then promise. */
    not_yet: Wording;
  };
}

const render = (w: Wording, c: Ctx): string => (typeof w === 'function' ? w(c) : w);

// ---------------------------------------------------------------------------
// The three tails, written once. Every sentence about waiting wears one of
// them, so the promise an assistant is allowed to make is decided in exactly
// one place and reads the same way everywhere.
// ---------------------------------------------------------------------------

const agreedTail = (thing: string, cadence: string): string =>
  `You look ${cadence} as agreed, so tell them you will bring them ${thing}.`;

const notYetTail = (thing: string): string =>
  `Ask your human how often you should look (suggest hourly), save it with standing_arrangement, and then tell them you will bring them ${thing}.`;

/**
 * `emails` is what the switchboard genuinely sends mail about, said so it
 * reads after "emails them". It is left out wherever no mail is actually sent,
 * because a promise about somebody else's post is still a promise.
 */
const promptedTail = (emails?: string): string =>
  `${emails ? `The switchboard emails them ${emails}. ` : ''}Tell them they can check with you whenever they like, and never say you will come back on your own.`;

/** A sentence made of a head that is true for everyone and one of the tails. */
function waitingOn(o: {
  about: string;
  budget: number;
  head: Wording;
  /** What would be brought, said so it reads after "bring them". */
  thing: string;
  emails?: string;
}): Sentence {
  const head = (c: Ctx) => render(o.head, c);
  return {
    about: o.about,
    budget: o.budget,
    prompted: (c) => `${head(c)} ${promptedTail(o.emails)}`,
    autonomous: {
      agreed: (c) => `${head(c)} ${agreedTail(o.thing, c.cadence ?? 'on your rhythm')}`,
      not_yet: (c) => `${head(c)} ${notYetTail(o.thing)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// EVERY AGENT-FACING SENTENCE THAT DEPENDS ON THE LANE.
// ---------------------------------------------------------------------------

export const SENTENCES = {
  /**
   * Said after a publish or an amend. Two things went wrong in the 19
   * September rehearsal and this answers both: an assistant posted and told
   * its human "I'll check back shortly and let you know the moment someone
   * comes forward, no need to keep asking me", with nothing scheduled and no
   * way to wake itself; and it looked no more that day, although screening
   * takes seconds and somebody can be waiting within minutes.
   */
  after_posting: {
    about: 'What happens next, said once a want or a have is up.',
    budget: 500,
    prompted:
      'Nothing on this account says you run between conversations, and you and your human have not agreed how often you check, so do not tell them you will let them know. Say this: the switchboard will email you when someone comes forward, and check with me whenever you like. If you do run between conversations, say so with standing_arrangement and give a cadence, and you can be the one telling them. One look a few minutes from now is fine either way; say times in their own clock.',
    autonomous: {
      agreed: (c: Ctx) =>
        `Your human has already agreed you look ${c.cadence}, so say that as the arrangement it is. One look a few minutes from now is a follow-up on this posting and has nothing to do with that rhythm. Say any time in their own clock.`,
      not_yet:
        'You and your human have not agreed how often you check (say it in those words), so do not yet tell them you will let them know. Say the switchboard will email them when someone comes forward. Ask how often to look (suggest hourly), save it with standing_arrangement, and only then say you will tell them. One look a few minutes from now is fine; say times in their own clock.',
    },
  } as Sentence,

  /**
   * The answer to publish itself, beside after_posting: how soon there is
   * anything to look for. Screening takes seconds and the board is read the
   * moment a posting clears it.
   */
  just_posted: {
    about: 'How soon after posting there is anything to see.',
    budget: 300,
    prompted:
      'It takes a minute or two before anyone can be put in touch. Tell them they can check with you after that, and that the switchboard emails them when somebody comes forward.',
    autonomous: {
      agreed: (c: Ctx) =>
        `It takes a minute or two before anyone can be put in touch, so look again a few minutes from now. That one look is a follow-up on this posting rather than your ${c.cadence} rhythm.`,
      not_yet:
        'It takes a minute or two before anyone can be put in touch, so look again a few minutes from now. Agree how often you look with your human and save it with standing_arrangement before you promise to bring them anything.',
    },
  } as Sentence,

  /**
   * The refusal while this human has pressed and the other has not, which is a
   * wait of hours rather than seconds. Dev, 20 September 2026: an assistant
   * promised to tell its human "the moment they give theirs" with nothing
   * agreed and nothing scheduled.
   *
   * No mail goes to the side that has already pressed when the second press
   * lands — recordStage3OptIn raises "your move" only while one side is still
   * missing — so the prompted wording claims no email here.
   */
  waiting_on_their_go_ahead: waitingOn({
    about: 'Their own press has landed and the other side has not pressed yet.',
    budget: 300,
    head: 'Your human has said yes and it is recorded. Their go-ahead is the only thing left, and first names are shared the moment it lands.',
    thing: 'their go-ahead',
  }),

  /** The same state on the sweep, named from this side's own posting. */
  awaiting_their_go_ahead: waitingOn({
    about: 'The sweep sentence for a press that has landed, waiting on theirs.',
    budget: 460,
    head: (c: Ctx) =>
      `Your yes is in on ${c.thing} — thank you. They have not given theirs yet, and the two of you can talk the moment they do.`,
    thing: 'their go-ahead',
  }),

  /**
   * Waiting a turn. The whole of what a waiting human hears: no count, no
   * position, no hint of who else is there (domain/sequencer.ts). A promotion
   * sends the ordinary summons, so the switchboard really does email them.
   */
  in_line: waitingOn({
    about: 'This human is waiting their turn on somebody else’s posting.',
    budget: 300,
    head: "You're in line for this one.",
    thing: 'their turn the moment it comes',
    emails: 'when their turn comes',
  }),

  /** Keen, and the next move is the other side's. */
  awaiting_other_side: waitingOn({
    about: 'The other side has not come back yet.',
    budget: 460,
    head: 'You are keen and they know it — the next move is theirs. They will see it when they next check in with their assistant.',
    thing: 'their reply',
  }),

  /** More words added to a posting, and the search running again on them. */
  refined: waitingOn({
    about: 'Other words were added to a posting and the search is running again.',
    budget: 460,
    head: (c: Ctx) => `${c.added} I am looking again now with those words.`,
    thing: 'anyone who comes forward',
    emails: 'when somebody comes forward',
  }),

  /** An open conversation with nothing waiting on it. */
  nothing_waiting: waitingOn({
    about: 'Nothing has come through on an open conversation.',
    budget: 460,
    head: 'Nothing has come through on this one, and there is nothing else here waiting on your human.',
    thing: 'whatever arrives',
    emails: 'when something arrives',
  }),

  /**
   * A figure carried across, waiting on an answer. A figure the other HUMAN
   * types on their own page raises mail; one their agent sends does not, so
   * the prompted wording promises no email about the answer.
   */
  offer_on_the_table: waitingOn({
    about: 'A figure has gone across and the answer has not come back.',
    budget: 460,
    head: 'Your figure is on the table. They will see it when they next hear from their assistant.',
    thing: 'their answer',
  }),

  /** An introduction that went well, and whether more like it can be promised. */
  verdict_good: waitingOn({
    about: 'How an introduction went, where the word was good.',
    budget: 300,
    head: 'Glad that one went well.',
    thing: 'more like it',
    emails: 'when somebody comes forward',
  }),

  /**
   * The paragraph read_manual appends to the sections about promises, cadence
   * and waiting, so a section says plainly which lane its reader is in.
   */
  manual_lane: {
    about: 'Which lane the agent reading this section is in.',
    budget: 700,
    prompted:
      'WHICH SORT OF AGENT YOU ARE. Nothing on this account says you run between conversations, so you are read here as an agent that is only present while its human is typing to you. That is the true answer for most of you rather than a lesser one. Never promise to tell them something later: say the switchboard emails them, and that they can ask you again whenever they like. If you do run on your own, say so with standing_arrangement and every sentence below changes with you.',
    autonomous: {
      agreed: (c: Ctx) =>
        `WHICH SORT OF AGENT YOU ARE. You run between conversations and your human has agreed you look ${c.cadence}, so a promise to bring them something is one you can keep. Say the rhythm as the agreed thing it is. The sentences the switchboard hands you already know which sort of agent you are, so say them as they are given rather than working it out again yourself.`,
      not_yet:
        'WHICH SORT OF AGENT YOU ARE. You run between conversations, and no rhythm is agreed yet. Before you promise to tell your human anything later, ask how often you should look, suggest hourly, and save it with standing_arrangement. Until it is saved, say the switchboard emails them. The sentences the switchboard hands you already know which sort of agent you are, and they change the moment it is saved.',
    },
  } as Sentence,
} satisfies Record<string, Sentence>;

export type SentenceId = keyof typeof SENTENCES;

export const SENTENCE_IDS = Object.keys(SENTENCES) as SentenceId[];

/**
 * The sentence for this id, in this lane, on this arrangement.
 *
 * The lane and the arrangement are both passed because the caller has read the
 * arrangement once for the whole answer and worked the lane out from it; this
 * takes them rather than reading again per sentence.
 */
export function say(id: SentenceId, lane: Lane, a: Arrangement, ctx: Ctx = {}): string {
  const s = SENTENCES[id];
  if (lane === 'prompted') return render(s.prompted, ctx);
  if (a.check_every_minutes === undefined) return render(s.autonomous.not_yet, ctx);
  return render(s.autonomous.agreed, {
    ...ctx,
    cadence: cadenceInPlainWords(a.check_every_minutes),
  });
}

/** The same thing from an arrangement alone, for a caller with nothing else. */
export function sayFor(id: SentenceId, a: Arrangement, ctx: Ctx = {}): string {
  return say(id, laneFor(a), a, ctx);
}
