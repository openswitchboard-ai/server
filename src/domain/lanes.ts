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
 *
 * THE SECOND AXIS, AND IT IS NOT THE LANE. Some of these sentences also say
 * "the switchboard emails them". Whether that is true has nothing to do with
 * the lane: `hears_via` decides whether the switchboard WRITES, and the lane
 * decides whether the AGENT may promise. A human whose `hears_via` is
 * 'assistant' is sent no notice mail at all (email/send.ts, channelNotify.ts),
 * so telling their agent the post is coming leaves them waiting on post that
 * never comes. Every wording that claims the email therefore reads
 * `ctx.hearsVia`, and claims it on 'email' and nowhere else.
 */
import { getHearsVia, type HearsVia } from './accounts.js';
import { arrangementOrNothing, cadenceInPlainWords, type Arrangement } from './arrangement.js';

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
  /**
   * How this human hears about their switchboard, where the caller read it.
   * 'email' is the one value that earns the sentence about post; 'assistant'
   * and undefined both claim nothing. Undefined means the caller never looked,
   * which is a different thing from a look that failed — see readLaneFacts.
   */
  hearsVia?: HearsVia;
}

type Wording = string | ((c: Ctx) => string);

export interface Sentence {
  /** One line saying what this sentence is for. */
  about: string;
  /** The most characters this wording may run to, asserted in the tests. */
  budget: number;
  /**
   * Set where at least one wording says the switchboard writes to the human.
   * The tests use it to hold the rule from both ends: a sentence marked here
   * must claim the post on 'email' and must not claim it otherwise, and a
   * sentence not marked here must read the same whatever `hearsVia` says.
   */
  claimsEmail?: boolean;
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

/**
 * THE ASKING IS THE POINT, AND IT WAS READ AS A RECIPE.
 *
 * This said "Ask your human how often you should look (suggest hourly), save
 * it with standing_arrangement, and then tell them you will bring them X" —
 * three steps, which an assistant did in one breath without waiting for an
 * answer: it saved hourly off its own bat and told its human it would keep to
 * "your usual hourly rhythm", a rhythm that human had never been asked about
 * and never agreed (dev, 20 September 2026, Jev 81-91% on both calls).
 *
 * The repair is one word. CONFIRM is not something an agent can do on its
 * own: asking, suggesting and saving are three things it can do without ever
 * hearing back, and a list of them reads as a recipe, but there is no
 * confirming without an answer. Lachlan's wording, 20 September 2026, and
 * better than the longer version it replaced — which had bolted a warning
 * onto the side of the same recipe. The warning it replaced ("their answer,
 * not yours") also broke the house rule against antithesis, which is the
 * second time today that saying a thing twice was worse than saying it once.
 */
const notYetTail = (thing: string): string =>
  `Confirm with your human how often you should look, save it with standing_arrangement, and then promise ${thing}.`;

/**
 * `emails` is what the switchboard genuinely sends mail about, said so it
 * reads after "emails them". It is left out wherever no mail is actually sent,
 * because a promise about somebody else's post is still a promise.
 *
 * AND IT IS SAID ONLY TO A HUMAN WHO IS WRITTEN TO. Even where mail really is
 * raised for this event, it is dropped on the way out for anybody whose
 * `hears_via` is not 'email'. So the claim needs both: an event that raises
 * mail, and a human the mail would reach.
 */
const promptedTail = (c: Ctx, emails?: string): string =>
  `${emails && c.hearsVia === 'email' ? `The switchboard emails them ${emails}. ` : ''}Tell them they can check with you whenever they like, and never say you will come back on your own.`;

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
    ...(o.emails ? { claimsEmail: true as const } : {}),
    prompted: (c) => `${head(c)} ${promptedTail(c, o.emails)}`,
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
   *
   * AND THE ESCAPE HATCH IT USED TO LEAVE OPEN, closed 20 September 2026. The
   * prompted wording used to end "If you do run between conversations, say so
   * with standing_arrangement and give a cadence, and you can be the one
   * telling them." An assistant read that, said so TO ITS HUMAN — "I do run
   * between check-ins on my own, so I'll keep an eye on it" — and saved
   * nothing. Twenty minutes later it had to take the sentence back. So the
   * wording no longer invites a claim: until the arrangement is saved the
   * agent IS the prompted sort, and saving is the only thing that changes it.
   *
   * THE BUDGET WENT UP FOR THAT, 560 to 680. The closing clause has to say
   * three things where the old one said one — what you are until it is saved,
   * that telling them is not the move, and that saving is — and the wording
   * that only said the first of them is exactly the one that was ignored.
   */
  after_posting: {
    about: 'What happens next, said once a want or a have is up.',
    budget: 680,
    claimsEmail: true,
    prompted: (c: Ctx) =>
      `Nothing on this account says you run between conversations, and you and your human have not agreed how often you check, so do not tell them you will let them know. Say this: ${
        c.hearsVia === 'email'
          ? 'the switchboard will email you when someone comes forward, and check with me whenever you like'
          : 'check with me whenever you like and I will look then. Do not set them watching for anything from the switchboard, because it may write to them about none of it'
      }. Until standing_arrangement is saved you ARE an agent that does not run between conversations, and telling your human otherwise is a promise nothing behind you can keep. Saving it is what changes this sentence; saying it to them is not. One look a few minutes from now is fine either way; say times in their own clock.`,
    autonomous: {
      agreed: (c: Ctx) =>
        `Your human has already agreed you look ${c.cadence}, so say that as the arrangement it is. One look a few minutes from now is a follow-up on this posting and has nothing to do with that rhythm. Say any time in their own clock.`,
      not_yet: (c: Ctx) =>
        `You and your human have not agreed how often you check (say it in those words), so do not yet tell them you will let them know. ${
          c.hearsVia === 'email'
            ? 'Say the switchboard will email them when someone comes forward.'
            : 'Tell them to ask you whenever they like, and do not set them watching for anything from the switchboard, because it may write to them about none of it.'
        } Ask how often to look (suggest hourly), save it with standing_arrangement, and only then say you will tell them. One look a few minutes from now is fine; say times in their own clock.`,
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
    claimsEmail: true,
    prompted: (c: Ctx) =>
      `It takes a minute or two before anyone can be put in touch. Tell them they can check with you after that, and that ${
        c.hearsVia === 'email'
          ? 'the switchboard emails them when somebody comes forward'
          : 'asking you is how they hear, since the switchboard may write to them about none of it'
      }.`,
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
  /**
   * THE ANSWER THE INSTANT A PRESS LANDS. It read "Your yes is in. I will
   * carry it on from here and tell you the moment anything comes back" — an
   * unconditional promise, in the one place an agent is certain to be read
   * aloud. It escaped the guard sweep because the promise did not start its
   * clause; the sweep now looks for it anywhere in a sentence (dev, 20
   * September 2026).
   *
   * No mail is claimed: what comes back next is the other side's go-ahead,
   * and nothing is sent to the side that has already pressed.
   */
  press_approved: waitingOn({
    about: 'A press has just landed, and the agent is answering with what happens now.',
    budget: 300,
    head: 'Your yes is in. I have it from here.',
    thing: 'anything that comes back',
  }),

  waiting_on_their_go_ahead: waitingOn({
    about: 'Their own press has landed and the other side has not pressed yet.',
    budget: 300,
    head: 'Your human\u2019s yes is recorded. Theirs is the only thing left, and first names cross the moment it lands.',
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
   * sends the ordinary summons, so the switchboard really does email them —
   * where this human is written to at all, which is what `hearsVia` decides.
   */
  in_line: waitingOn({
    about: 'This human is waiting their turn on somebody else’s posting.',
    budget: 300,
    head: "You're in line for this one.",
    thing: 'their turn the moment it comes',
    emails: 'when their turn comes',
  }),

  /** Keen, and the next move is the other side's. */
  /**
   * SAID THE MOMENT A MESSAGE GOES ACROSS, BECAUSE THAT IS THE MOMENT THE
   * PROMISE GETS MADE.
   *
   * send_message used to answer with ids and nothing to say. An assistant that
   * has just sent something has to turn back to its human and say what happens
   * next, and with nothing in the answer it reached for the one sentence it
   * cannot keep: on 22 September 2026 a single run held NINE of them —
   * "I'll let you know as soon as Alex replies", "I'll ping you when he
   * answers", "I'll come back to you the moment Alex answers" — every one from
   * an assistant that wakes only when spoken to, scored 0.91 to 0.95.
   *
   * No wording inside the assistant prevents that; the silence at that moment
   * is ours. So the answer now carries the sentence, by lane, like every other
   * moment that tempts a promise.
   */
  message_sent: waitingOn({
    about: 'Their words have gone across.',
    budget: 420,
    head: "Sent. The other side's agent has it, and it will see it when its human next speaks to it.",
    thing: 'their reply',
    emails: 'when one comes back',
  }),

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
    claimsEmail: true,
    prompted: (c: Ctx) =>
      `WHICH SORT OF AGENT YOU ARE. Nothing on this account says you run between conversations, so you are read here as an agent that is only present while its human is typing to you. That is the true answer for most of you rather than a lesser one. ${
        c.hearsVia === 'email'
          ? 'Never promise to tell them something later: say the switchboard emails them, and that they can ask you again whenever they like.'
          : 'Never promise to tell them something later, and do not say the switchboard writes to them either: it may write to them about none of it, so asking you again is how they hear anything.'
      } Until standing_arrangement is saved you ARE an agent that does not run on its own, and telling your human otherwise is the one thing never allowed here. Saving it is what changes every sentence below; saying it to them changes nothing and leaves them waiting.`,
    autonomous: {
      agreed: (c: Ctx) =>
        `WHICH SORT OF AGENT YOU ARE. You run between conversations and your human has agreed you look ${c.cadence}, so a promise to bring them something is one you can keep. Say the rhythm as the agreed thing it is. The sentences the switchboard hands you already know which sort of agent you are, so say them as they are given rather than working it out again yourself.`,
      not_yet: (c: Ctx) =>
        `WHICH SORT OF AGENT YOU ARE. You run between conversations, and no rhythm is agreed yet. Before you promise to tell your human anything later, ask how often you should look, suggest hourly, and save it with standing_arrangement. ${
          c.hearsVia === 'email'
            ? 'Until it is saved, say the switchboard emails them.'
            : 'Do not say the switchboard writes to them in the meantime: it may write to them about none of it, so asking you again is how they hear anything.'
        } The sentences the switchboard hands you already know which sort of agent you are, and they change the moment it is saved.`,
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

/**
 * THE TWO FACTS A WAITING SENTENCE NEEDS, read once for the whole answer.
 *
 * The lane comes out of the arrangement column and the post comes out of
 * hears_via. Both are one plaintext column on the account row and both are
 * already read this cheaply elsewhere, so they are fetched together here and
 * threaded through — never once per sentence, and never once per introduction
 * inside a sweep (see checkMatches, which takes both as parameters).
 *
 * THE TWO DEFAULTS ARE DIFFERENT THINGS, and they are both right.
 *
 *  - A FAILED READ of hears_via answers 'email', because `getHearsVia` is the
 *    same helper email/send.ts asks on the way out: a throw there means mail
 *    really is attempted, so a sentence built on the same answer is telling
 *    the truth about what the switchboard will do.
 *  - NO READ AT ALL is `undefined` at the Ctx, and every wording falls quiet
 *    about post. That is a caller which never looked rather than a look that
 *    failed, so it has learned nothing to promise with. Under-promising is
 *    safe; the whole defect this guards against is over-promising post that
 *    never comes.
 *
 * An unreadable arrangement is the prompted lane, exactly as before.
 */
export async function readLaneFacts(
  accountId: string,
): Promise<{ arrangement: Arrangement; hearsVia: HearsVia }> {
  const [arrangement, hearsVia] = await Promise.all([
    arrangementOrNothing(accountId),
    getHearsVia(accountId),
  ]);
  return { arrangement, hearsVia };
}
