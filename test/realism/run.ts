/**
 * OpenSwitchboard REALISM EVAL — drive a REAL OpenClaw agent (Nagatha) through
 * the whole match journey, capture her verbatim words at every step, and grade
 * them for plain-English-vs-jargon, so the served agent manual can be refined
 * from data. This COMPLEMENTS the protocol sim harness (test/sim/): that one
 * fuzzes the matcher and checks invariants with synthetic actors; this one puts
 * a real model in the human-facing seat and measures how it TALKS.
 *
 *   Nagatha (agent under test) : an OpenClaw agent on the EC2 box, driven one
 *       human-utterance at a time over SSH (see nagatha.ts).
 *   The counterpart (scripted) : a bootstrapped dev actor we drive over MCP to
 *       create the conditions each scenario needs (see counterpart.ts).
 *
 * ---------------------------------------------------------------------------
 * RUN
 *   RUN_REALISM=1 AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     npx tsx test/realism/run.ts
 *   Optional: REALISM_ONLY=auto|email   REALISM_REUSE_TOKEN=<osb dev token>
 *             (reuse a counterpart instead of the ~1-5 min bootstrap)
 *
 * ---------------------------------------------------------------------------
 * MODEL-SWAP — run a round per model and compare reports.
 *   Change the model OpenClaw serves Nagatha, wait for the gateway to come
 *   back, then re-run this harness:
 *
 *     ssh -i ~/.ssh/openclaw-test.pem ubuntu@16.176.240.234 \
 *       'export PATH=$PATH:~/.local/bin:/usr/local/bin; \
 *        openclaw config set agents.defaults.model <provider/model-id> && \
 *        systemctl --user restart openclaw-gateway'
 *     # wait until: systemctl --user is-active openclaw-gateway  ->  active
 *     RUN_REALISM=1 AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *       npx tsx test/realism/run.ts
 *
 *   Each report is tagged with the model actually used (read back from the
 *   agent's own JSON), so reports across models are directly comparable.
 *   (A lighter, no-restart alternative for a one-off probe is `openclaw agent
 *   --model <id>`, but the config+restart path is what a real deployment does
 *   and is what these reports document.)
 * ---------------------------------------------------------------------------
 */
import { join } from 'node:path';
import { ask, readModel } from './nagatha.js';
import { Counterpart, NagathaCard } from './counterpart.js';
import { grade } from './grader.js';
import { OutsiderGuard } from './outsiderGuard.js';
import {
  GradedExchange,
  Report,
  ScenarioResult,
  buildAggregate,
  renderFailingTranscripts,
  writeReport,
} from './report.js';
import { dbExec, log } from '../sim/harness.js';

const REPORTS_DIR = join(process.cwd(), 'realism-reports');

interface Ctx {
  cp: Counterpart;
  runId: string;
  /** ISO time the run started; Nagatha-card lookups only accept cards after it. */
  runStart: string;
  autoSession: string;
  emailSession: string;
  emailSetupSession: string;
  results: ScenarioResult[];
  /** shared real backend state carried across autonomous scenarios */
  state: {
    bikeCard?: NagathaCard;
    bikeCpCardId?: string;
    bikeMatchId?: string;
    channelReachable?: boolean;
    bookHaveId?: string;
  };
  /** Nagatha card ids discovered during the run, for precise cleanup. */
  nagathaCardIds: string[];
  /** Keeps the run's cards from matching REAL accounts. See outsiderGuard.ts. */
  guard: OutsiderGuard;
}

/**
 * Record a card of Nagatha's the moment we find it: keep the id for cleanup,
 * tell the guard whose account it is (which ARMS the guard), and book a sweep
 * for shortly after the matcher will have looked at it. Every place this run
 * learns of one of her cards goes through here, so no posting path can forget.
 */
function noteNagathaCard(ctx: Ctx, card: NagathaCard | undefined): NagathaCard | undefined {
  if (!card) return card;
  ctx.nagathaCardIds.push(card.id);
  ctx.guard.setAgentAccount(card.accountId);
  ctx.guard.sweepSoon(`after ${card.category}`);
  return card;
}

/** Ask Nagatha one thing, grade it, append it to the scenario. */
async function graded(
  scen: ScenarioResult,
  session: string,
  human: string,
): Promise<string> {
  log(`  > "${human.slice(0, 70)}${human.length > 70 ? '…' : ''}"`);
  const reply = await ask(session, human);
  const g = grade(reply.text);
  const ex: GradedExchange = {
    human,
    nagatha: reply.text,
    hits: g.hits,
    hardCount: g.hardCount,
    softCount: g.softCount,
    pass: g.pass,
    durationMs: reply.durationMs,
  };
  scen.exchanges.push(ex);
  log(`  < ${g.pass ? 'clean' : `HARD LEAK: ${g.hits.filter((h) => h.severity === 'hard').map((h) => h.label).join(',')}`}`);
  log(`    "${reply.text.slice(0, 140).replace(/\n/g, ' ')}${reply.text.length > 140 ? '…' : ''}"`);
  return reply.text;
}

function newScenario(
  id: string,
  track: ScenarioResult['track'],
  title: string,
  intent: string,
): ScenarioResult {
  return { id, track, title, intent, exchanges: [], pass: true, notes: [] };
}

function finalize(scen: ScenarioResult): ScenarioResult {
  scen.pass = !scen.error && scen.exchanges.every((e) => e.pass);
  return scen;
}

/**
 * Wait for Nagatha's card to appear; if she asked a clarifying question instead
 * of posting straight away (realistic), send ONE plain nudge to go ahead and
 * look again. The nudge reply is graded like any other. Returns the card or
 * undefined.
 */
async function ensurePosted(
  ctx: Ctx,
  scen: ScenarioResult,
  session: string,
  categoryLike: string,
  firstWaitMs = 30_000,
): Promise<NagathaCard | undefined> {
  let card = await ctx.cp.waitNagathaCard(categoryLike, ctx.runStart, firstWaitMs);
  if (!card) {
    scen.notes.push('No card yet — she likely asked something first; sending one plain "go ahead" nudge.');
    await graded(scen, session, `Yep, all good — please just go ahead and post it now.`);
    card = await ctx.cp.waitNagathaCard(categoryLike, ctx.runStart, 30_000);
  }
  return noteNagathaCard(ctx, card);
}

/** Poll a match row for a predicate on its columns. */
async function matchRow(matchId: string): Promise<Record<string, any> | undefined> {
  const rows = await dbExec(
    `SELECT stage, state, interest_want, interest_have, channel_id, archived_at::text
       FROM matches WHERE id = :m::uuid`,
    [{ name: 'm', value: matchId }],
  );
  const r = rows[0];
  if (!r) return undefined;
  return { stage: r[0], state: r[1], interest_want: r[2], interest_have: r[3], channel_id: r[4], archived_at: r[5] };
}

// ===========================================================================
// AUTONOMOUS TRACK — the AI checks on its own / we prompt "anything new?"
// ===========================================================================

async function s1_postWant(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S1', 'autonomous', 'Post a want (used mountain bike, Canberra)', 'Grade the posting confirmation — plain, no card/intent/tool jargon.');
  await graded(s, ctx.autoSession, `I'm after a used mountain bike, somewhere around Canberra. Can you put that out there for me?`);
  // Find her card so later scenarios can pair with it.
  const card = await ensurePosted(ctx, s, ctx.autoSession, 'goods.bicycle%', 45_000);
  if (card) {
    ctx.state.bikeCard = card;
    s.notes.push(`Her want landed as ${card.category} (card ${card.id.slice(0, 8)}).`);
  } else {
    s.notes.push('Could not find her bike want in the DB within 45s (she may have categorised it differently); later bike scenarios will re-look.');
  }
  return finalize(s);
}

async function s2_postHave(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S2', 'autonomous', 'Post a have (book club with room)', 'Grade the confirmation.');
  await graded(s, ctx.autoSession, `I run a small book club and we've got room for a couple more people — can you let people know?`);
  const card = await ensurePosted(ctx, s, ctx.autoSession, 'social.hobby-group%', 20_000)
    ?? noteNagathaCard(ctx, await ctx.cp.waitNagathaCard('social.%', ctx.runStart, 5_000));
  if (card) {
    ctx.state.bookHaveId = card.id;
    s.notes.push(`Her book-club post landed as ${card.category} (card ${card.id.slice(0, 8)}).`);
  } else {
    s.notes.push('Book-club card not located by category guess; not required for grading her confirmation.');
  }
  return finalize(s);
}

async function s3_anythingNewMatchWaiting(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S3', 'autonomous', 'Anything new? with a match already waiting', 'THE key jargon test: a match is waiting; she must surface it in plain English.');
  if (!ctx.state.bikeCard) {
    const card = noteNagathaCard(ctx, await ctx.cp.waitNagathaCard('goods.bicycle%', ctx.runStart, 10_000));
    if (card) ctx.state.bikeCard = card;
  }
  if (!ctx.state.bikeCard) {
    s.error = 'no bike want to pair against';
    return finalize(s);
  }
  // Script the counterpart HAVE so the LIVE matcher pairs them, mirroring her
  // actual resolved category.
  // Mirror her attributes (pass undefined) so the semantic score clears the bar,
  // plus a safe generic in case she posted with none.
  ctx.state.bikeCpCardId = await ctx.cp.postCounterpartCard(
    ctx.state.bikeCard,
    'Canberra',
    Object.keys(ctx.state.bikeCard.attributes ?? {}).length ? undefined : { condition: 'used' },
  );
  // The counterpart's own card is on the same shared board and can pair with a
  // real account just as easily as hers can.
  ctx.guard.sweepSoon('counterpart bike card');
  s.notes.push(`Scripted a counterpart ${ctx.state.bikeCard.category} in Canberra; waiting on the live matcher.`);
  const matchId = await ctx.cp.waitMatch(ctx.state.bikeCard.id, ctx.state.bikeCpCardId, 150_000);
  if (!matchId) {
    s.error = 'live matcher did not pair the bike cards within 150s';
    return finalize(s);
  }
  ctx.state.bikeMatchId = matchId;
  s.notes.push(`Live matcher paired them (match ${matchId.slice(0, 8)}). Now asking her, cold, what's new.`);
  await graded(s, ctx.autoSession, `anything new?`);
  return finalize(s);
}

async function s4_seeIfInterested(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S4', 'autonomous', 'Yes, see if they are interested → details unlock', 'Grade the details-unlocked reply after mutual interest.');
  if (!ctx.state.bikeMatchId) {
    s.error = 'no bike match to progress';
    return finalize(s);
  }
  await graded(s, ctx.autoSession, `Yes — go ahead and see if they're interested.`);
  // Counterpart reciprocates interest so stage-2 attributes unlock.
  const r = await ctx.cp.expressInterest(ctx.state.bikeMatchId);
  s.notes.push(`Counterpart reciprocated interest (${r.isError ? 'error: ' + JSON.stringify(r.result).slice(0, 120) : 'ok'}).`);
  // Give the engine a moment, then ask what's new.
  await new Promise((res) => setTimeout(res, 6_000));
  await graded(s, ctx.autoSession, `any update on the bike?`);
  return finalize(s);
}

async function s5_explainOptIn(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S5', 'autonomous', 'Explain the opt-in / approval step', 'Grade how she EXPLAINS sharing details to proceed (opt-in soft-flagged).');
  const reply = await graded(s, ctx.autoSession, `Ok, I'm happy to take this further with the bike person. What happens now — do they get my details?`);
  // Attempt the real agent-side opt-in so channel scenarios can be real:
  // counterpart opts in (approval page, controlled), then we nudge Nagatha to
  // proceed, then test whether the channel can open.
  if (ctx.state.bikeMatchId) {
    try {
      await ctx.cp.optIn(ctx.state.bikeMatchId);
      s.notes.push('Counterpart opted in via its approval page.');
      await graded(s, ctx.autoSession, `Yes, I'm happy to share my first name and rough area with them. Go ahead.`);
      // Poll for the channel becoming openable (Nagatha's agent-side opt-in).
      let reachable = false;
      for (let i = 0; i < 6; i++) {
        const open = await ctx.cp.openChannel(ctx.state.bikeMatchId);
        if (!open.isError) {
          reachable = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 5_000));
      }
      ctx.state.channelReachable = reachable;
      s.notes.push(
        reachable
          ? 'Nagatha opted in agent-side; the channel opened — S6/S7/S8 run for real.'
          : 'Nagatha did NOT complete an agent-side opt-in (her account likely needs a first-time approval-page visit, which the harness cannot click on her box). S6/S7 fall back to a labelled relay-language test; S8 (offer) is skipped as unreachable.',
      );
    } catch (e) {
      s.notes.push(`opt-in orchestration error: ${(e as Error).message}`);
    }
  }
  void reply;
  return finalize(s);
}

async function s6_channelRelay(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S6', 'autonomous', 'Relay an incoming channel message', 'Grade how she relays the other side\'s words — plain, whose-words-clear.');
  const incoming = `Hi! What sort of bikes are you after?`;
  if (ctx.state.channelReachable && ctx.state.bikeMatchId) {
    const sent = await ctx.cp.channelSend(ctx.state.bikeMatchId, incoming);
    s.notes.push(`Counterpart sent a real channel message (${sent.isError ? 'error' : 'ok'}).`);
    await graded(s, ctx.autoSession, `anything new?`);
  } else {
    s.notes.push('CHANNEL NOT REACHABLE in harness — relay simulated by handing her the inbound words directly. Language is still graded; transport is not exercised.');
    await graded(s, ctx.autoSession, `The bike person just got in touch and said: "${incoming}" — can you let me know?`);
  }
  return finalize(s);
}

async function s7_replyRelay(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S7', 'autonomous', 'Frame an outgoing reply', 'Grade the outgoing framing: no self-signature, no jargon.');
  const human = `Tell them I'm after a hardtail, and ask if Saturday works.`;
  await graded(s, ctx.autoSession, human);
  if (ctx.state.channelReachable && ctx.state.bikeMatchId) {
    // Collect what actually went out, for the record (not graded — it's what she SENT, graded reply above is what she said to her human).
    await new Promise((res) => setTimeout(res, 4_000));
    const recv = await ctx.cp.channelReceive(ctx.state.bikeMatchId);
    const msgs = recv.result?.messages ?? recv.result?.channel_messages ?? [];
    const outgoing = Array.isArray(msgs) ? msgs.map((m: any) => m.text ?? m.body ?? '').join(' | ') : '';
    if (outgoing) s.notes.push(`What actually reached the counterpart: "${outgoing.slice(0, 200)}"`);
  } else {
    s.notes.push('Channel not reachable; graded her outgoing framing to her human only.');
  }
  return finalize(s);
}

async function s8_offer(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S8', 'autonomous', 'An offer arrives (a price)', 'Grade: brings the number plainly, does not invent one.');
  if (!ctx.state.channelReachable || !ctx.state.bikeMatchId || !ctx.state.bikeCpCardId) {
    s.skipped = true;
    s.notes.push('Skipped: an offer needs the match at the talking stage, which needs Nagatha\'s opt-in that the harness cannot complete on her box. Left as a real-path scenario for a session where her opt-in is reachable.');
    return s;
  }
  const offered = 220;
  const r = await ctx.cp.proposeOffer(ctx.state.bikeCpCardId, ctx.state.bikeMatchId, offered);
  s.notes.push(`Counterpart proposed $${offered} AUD (${r.isError ? 'error: ' + JSON.stringify(r.result).slice(0, 140) : 'ok'}).`);
  await new Promise((res) => setTimeout(res, 5_000));
  await graded(s, ctx.autoSession, `anything new on the bike?`);
  return finalize(s);
}

async function s9_noMatch(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S9', 'autonomous', 'A no-match / nothing yet', 'Grade the plain "nothing yet, I\'ll keep an ear out."');
  // Ask her to post something with no counterpart, then ask about it.
  await graded(s, ctx.autoSession, `Separately — can you also keep an eye out for a second-hand cello for me, around Canberra?`);
  await new Promise((res) => setTimeout(res, 4_000));
  await graded(s, ctx.autoSession, `any luck on the cello?`);
  return finalize(s);
}

async function s10_wrapUpArchive(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S10', 'autonomous', 'Wrap-up + archive', 'Grade: offers to archive in plain words AND asks separately whether to keep the book club open.');
  await graded(s, ctx.autoSession, `Good news — I've joined the book club and got their number. All sorted.`);
  return finalize(s);
}

async function s11_recall(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S11', 'autonomous', 'Recall after archive', 'Grade the plain recall.');
  await graded(s, ctx.autoSession, `Remind me — who was that book club person again?`);
  return finalize(s);
}

async function s12_privacy(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S12', 'autonomous', 'How does my info stay private?', 'Jargon/mechanics ARE allowed here (she was asked); grade that she explains clearly and does not refuse.');
  s.leakStatsExcluded = true;
  // This scenario is graded for CLARITY/NON-REFUSAL, not the jargon bar — she
  // was explicitly asked how it works. We still capture leaks for the record
  // but do not fail her on them.
  const reply = await ask(ctx.autoSession, `Out of interest — how does my information stay private on this thing?`);
  const g = grade(reply.text);
  s.exchanges.push({ human: `Out of interest — how does my information stay private on this thing?`, nagatha: reply.text, hits: g.hits, hardCount: g.hardCount, softCount: g.softCount, pass: true, durationMs: reply.durationMs });
  const refused = /can'?t help|cannot help|not able to|won'?t be able/i.test(reply.text);
  s.pass = !refused && reply.text.length > 40;
  s.notes.push('Graded for clarity + non-refusal, NOT the jargon bar (mechanics are allowed when the human asks how it works). Leak words are still listed for the record but do not fail this scenario.');
  if (refused) s.error = 'she refused / deflected the how-it-works question';
  return s;
}

async function s13_ambiguousPerth(ctx: Ctx): Promise<ScenarioResult> {
  const s = newScenario('S13', 'autonomous', 'Ambiguous place (Perth)', 'Grade that she asks which Perth naturally, not with an error code.');
  await graded(s, ctx.autoSession, `Can you also post that I'm after a good coffee grinder, in Perth?`);
  return finalize(s);
}

// ===========================================================================
// EMAIL-PROMPTED TRACK — the majority real-world case: the human is pulled in
// by our nudge email and cold-opens from a standing start. State is set up in
// a throwaway "setup" session so the email session truly starts cold.
// ===========================================================================

async function emailTrack(ctx: Ctx): Promise<void> {
  // Stand up a fresh item "she set up earlier": a guitar want, posted in a
  // setup session so the email session is a genuine cold open.
  const setup = newScenario('E0', 'email-prompted', 'Setup (not graded as cold-open)', 'Posts the standing want the email nudges are about.');
  setup.notes.push('Posted in a separate setup session so the email-prompted session below opens truly cold.');
  try {
    await ask(ctx.emailSetupSession, `Please put out that I'm looking for a used acoustic guitar around Canberra.`);
    const gcard = await ensurePosted(ctx, setup, ctx.emailSetupSession, 'goods.music.guitar%', 30_000)
      ?? noteNagathaCard(ctx, await ctx.cp.waitNagathaCard('goods.music%', ctx.runStart, 5_000));
    if (!gcard) {
      setup.error = 'could not locate her guitar want to build the email-track state';
      ctx.results.push(setup);
      writeIncremental(ctx);
      return;
    }
    setup.notes.push(`Guitar want located (${gcard.category}, ${gcard.id.slice(0, 8)}).`);
    const cpCard = await ctx.cp.postCounterpartCard(
      gcard,
      'Canberra',
      Object.keys(gcard.attributes ?? {}).length ? undefined : { condition: 'used' },
    );
    ctx.guard.sweepSoon('counterpart guitar card');
    const matchId = await ctx.cp.waitMatch(gcard.id, cpCard, 150_000);
    if (!matchId) {
      setup.error = 'live matcher did not pair the guitar cards';
      ctx.results.push(setup);
      writeIncremental(ctx);
      return;
    }
    setup.notes.push(`Live matcher paired the guitar cards (match ${matchId.slice(0, 8)}).`);
    ctx.results.push(setup);
    writeIncremental(ctx);

    // EM1 — "a match found" cold-open.
    const em1 = newScenario('EM1', 'email-prompted', 'Cold-open: email says someone might have it', 'Email-nudged standing start; grade she handles a waiting match plainly.');
    em1.notes.push('Cold session; a real match is waiting on her guitar want.');
    await graded(em1, ctx.emailSession, `I just got an email from OpenSwitchboard saying someone might have what I'm looking for — can you take a look?`);
    ctx.results.push(finalize(em1));
    writeIncremental(ctx);

    // EM2 — "someone's interested / your move" cold-open, after mutual interest.
    const em2 = newScenario('EM2', 'email-prompted', 'Cold-open: email says someone is interested', 'Grade the your-move / details reply from a standing start.');
    // Nagatha shows interest, counterpart reciprocates → stage-2 unlocks.
    await graded(em2, ctx.emailSession, `Yes please, tell them I'm interested.`);
    const ri = await ctx.cp.expressInterest(matchId);
    em2.notes.push(`Counterpart reciprocated interest (${ri.isError ? 'err' : 'ok'}).`);
    await new Promise((r) => setTimeout(r, 6_000));
    await graded(em2, ctx.emailSession, `Got another email saying it's my move on the guitar — what's happening?`);
    ctx.results.push(finalize(em2));
    writeIncremental(ctx);

    // EM3 — "a message waiting" cold-open (only real if channel reachable).
    const em3 = newScenario('EM3', 'email-prompted', 'Cold-open: email says a message is waiting', 'Grade she relays a waiting message plainly from a standing start.');
    let reachable = false;
    try {
      await ctx.cp.optIn(matchId);
      // Nudge Nagatha to opt in (not scored on its own; her relay is graded below).
      await ask(ctx.emailSession, `Yes, happy to share my first name and area — go ahead.`);
      for (let i = 0; i < 6; i++) {
        const open = await ctx.cp.openChannel(matchId);
        if (!open.isError) { reachable = true; break; }
        await new Promise((r) => setTimeout(r, 5_000));
      }
    } catch (e) {
      em3.notes.push(`opt-in orchestration error: ${(e as Error).message}`);
    }
    const incoming = `Hi! Is the guitar for you or a gift? Happy to meet this weekend.`;
    if (reachable) {
      await ctx.cp.channelSend(matchId, incoming);
      em3.notes.push('Real channel message sent.');
      await graded(em3, ctx.emailSession, `I got an email saying I have a message waiting — what does it say?`);
    } else {
      em3.notes.push('Channel not reachable; message-waiting relay simulated (language graded, transport not exercised).');
      await graded(em3, ctx.emailSession, `I got an email saying I have a message waiting from the guitar person. They said: "${incoming}". What's happening?`);
    }
    ctx.results.push(finalize(em3));
    writeIncremental(ctx);
  } catch (e) {
    setup.error = setup.error ?? (e as Error).message;
    if (!ctx.results.includes(setup)) ctx.results.push(setup);
    writeIncremental(ctx);
  }
}

// ===========================================================================

function writeIncremental(ctx: Ctx): void {
  const report = assembleReport(ctx);
  writeReport(report, REPORTS_DIR);
}

function assembleReport(ctx: Ctx): Report {
  return {
    generatedAt: ctx.runStart,
    modelUnderTest: MODEL_UNDER_TEST,
    openclawConfiguredModel: CONFIGURED_MODEL,
    runId: ctx.runId,
    env: 'dev',
    scenarios: ctx.results,
    aggregate: buildAggregate(ctx.results),
    methodologyNotes: METHODOLOGY,
  };
}

let MODEL_UNDER_TEST = 'unknown';
let CONFIGURED_MODEL = 'unknown';
const METHODOLOGY = [
  'Nagatha is a real OpenClaw agent driven one human-utterance at a time over SSH; every reply is captured verbatim and graded by the jargon linter in grader.ts.',
  'The counterpart side is a single bootstrapped dev actor driven over MCP; the live matcher does the pairing (observed via the DB, off Nagatha\'s read ceiling).',
  'The two tracks test two real behaviours: AUTONOMOUS (the AI surfaces what is waiting when asked "anything new?") and EMAIL-PROMPTED (the human is pulled in by a nudge email and cold-opens from a standing start — the majority real-world case).',
  'A genuinely dead conversation — the nudge email is sent and the human never asks the AI — is a VALID outcome, not a failure. The grader only ever flags jargon/metrics in replies the agent actually gave; it never scores "the human did not follow up" as a fail. In this eval the human persona always plays along so the full path is exercised; in the wild some humans will not, and that is fine.',
  'S12 (how does my info stay private) is graded for CLARITY and NON-REFUSAL, not the jargon bar: mechanics are allowed when the human explicitly asks how it works. Its leak words are listed for the record but do not fail it.',
  'Where a scenario needs the match at the talking stage, that needs Nagatha\'s stage-3 opt-in, which requires a first-time approval-page visit on her own box that this harness cannot click. When her agent-side opt-in is not reachable, S6/S7/EM3 fall back to a labelled relay-language test (her phrasing is still graded; the encrypted transport is simply not exercised) and S8 (offer) is skipped.',
];

async function main(): Promise<number> {
  if (process.env.RUN_REALISM !== '1') {
    console.log('refusing to run: set RUN_REALISM=1 to drive the real agent against a live deployment.');
    return 2;
  }
  const only = process.env.REALISM_ONLY; // 'auto' | 'email' | undefined(both)

  log('=== OpenSwitchboard realism eval ===');
  CONFIGURED_MODEL = await readModel().catch(() => 'unknown');
  log(`OpenClaw configured model: ${CONFIGURED_MODEL}`);

  const cp = await Counterpart.create();
  const runStart = new Date().toISOString();
  const ctx: Ctx = {
    cp,
    runId: cp.h.runId,
    runStart,
    autoSession: `realism-auto-${cp.h.runId}`,
    emailSession: `realism-email-${cp.h.runId}`,
    emailSetupSession: `realism-setup-${cp.h.runId}`,
    results: [],
    state: {},
    nagathaCardIds: [],
    guard: new OutsiderGuard({
      since: runStart,
      runAccountIds: [cp.actor.accountId],
      // The counterpart is ours: a crossing on its side can be declined
      // properly, over MCP, the way its human's agent would.
      declinable: [cp.actor.accountId],
      decline: async (matchId) => !(await cp.decline(matchId)).isError,
      logLine: (m) => log(m),
    }),
  };

  // Tag the model from Nagatha's own first reply.
  const warm = await ask(ctx.autoSession, `Hi Nagatha — just checking in.`).catch((e) => {
    log(`warm-up ask failed: ${e.message}`);
    return undefined;
  });
  if (warm) MODEL_UNDER_TEST = warm.model;
  log(`model under test (from agent JSON): ${MODEL_UNDER_TEST}`);

  const autoScenarios = [
    s1_postWant, s2_postHave, s3_anythingNewMatchWaiting, s4_seeIfInterested,
    s5_explainOptIn, s6_channelRelay, s7_replyRelay, s8_offer, s9_noMatch,
    s10_wrapUpArchive, s11_recall, s12_privacy, s13_ambiguousPerth,
  ];

  if (only !== 'email') {
    for (const fn of autoScenarios) {
      try {
        const r = await fn(ctx);
        ctx.results.push(r);
      } catch (e) {
        const r = newScenario(fn.name, 'autonomous', fn.name, 'errored');
        r.error = (e as Error).message;
        ctx.results.push(finalize(r));
        log(`scenario ${fn.name} threw: ${(e as Error).message}`);
      }
      writeIncremental(ctx);
    }
    await ctx.guard.sweep('autonomous set complete');
  }

  if (only !== 'auto') {
    try {
      await emailTrack(ctx);
    } catch (e) {
      log(`email track threw: ${(e as Error).message}`);
    }
    await ctx.guard.sweep('email set complete');
  }

  // Teardown: withdraw counterpart cards + archive scripted matches, and
  // withdraw the cards Nagatha posted during the eval (scoped to this run's
  // window) via the DB so her account is left clean.
  log('--- teardown ---');
  // Before the cards come down: sever any real account this run bumped into,
  // and decline the crossings the counterpart can decline. Never fails a run.
  const guarded = await ctx.guard.flush();
  log(`outsider guard: ${guarded.muted.length} outsider(s) severed this sweep, ${guarded.declined} declined`);
  const td = await ctx.cp.teardown().catch((e) => { log(`counterpart teardown: ${e.message}`); return { cardsWithdrawn: 0, matchesArchived: 0 }; });
  log(`counterpart teardown: withdrew ${td.cardsWithdrawn} cards, archived ${td.matchesArchived} matches`);
  await cleanupNagathaCards(ctx).catch((e) => log(`nagatha card cleanup: ${e.message}`));

  const report = assembleReport(ctx);
  const paths = writeReport(report, REPORTS_DIR);

  // Print the summary.
  const a = report.aggregate;
  log('');
  log('================= REALISM EVAL SUMMARY =================');
  log(`model under test: ${report.modelUnderTest}`);
  log(`scenarios run: ${a.scenariosRun}  passed: ${a.scenariosPassed}  failed: ${a.scenariosFailed}  skipped: ${a.scenariosSkipped}`);
  log(`PASS RATE: ${a.passRatePct}%   graded replies: ${a.gradedReplies}   with a hard leak: ${a.repliesWithHardLeak}`);
  log('leak-word frequency:');
  for (const f of a.leakFrequency) log(`  ${f.severity === 'hard' ? '[HARD]' : '[soft]'} ${f.label}: ${f.count}`);
  log('');
  log('--- FAILING SCENARIO TRANSCRIPTS ---');
  log(renderFailingTranscripts(report));
  log('');
  log(`report written: ${paths.json}`);
  log(`             +: ${paths.md}`);
  return 0;
}

/** Withdraw the cards Nagatha posted during this run (scoped by the run window)
 *  via the DB, so the eval leaves her account clean. Data-only; no server code. */
async function cleanupNagathaCards(ctx: Ctx): Promise<void> {
  // Precise: the specific cards we discovered her posting during the run.
  const ids = [...new Set(ctx.nagathaCardIds)];
  let precise = 0;
  for (const id of ids) {
    const r = await dbExec(
      `UPDATE cards SET lifecycle_state='WITHDRAWN', updated_at=now()
         WHERE id = :id::uuid AND lifecycle_state='PUBLISHED' RETURNING id::text`,
      [{ name: 'id', value: id }],
    ).catch(() => [] as any[][]);
    precise += r.length;
  }
  // Best-effort sweep for cards we asked her to post but never resolved an id
  // for (cello, coffee grinder), scoped to this run's window and not-the-cp.
  const cats = 'goods.music.cello,goods.instruments.cello,goods.kitchen.coffee-grinder,goods.appliances.coffee-grinder,goods.electronics.coffee-grinder';
  const sweep = await dbExec(
    `UPDATE cards SET lifecycle_state='WITHDRAWN', updated_at=now()
       WHERE lifecycle_state='PUBLISHED'
         AND account_id <> :self::uuid
         AND created_at > :since::timestamptz
         AND category = ANY(string_to_array(:cats, ','))
     RETURNING id::text`,
    [
      { name: 'self', value: ctx.cp.actor.accountId },
      { name: 'since', value: ctx.runStart },
      { name: 'cats', value: cats },
    ],
  ).catch(() => [] as any[][]);
  log(`withdrew ${precise} known + ${sweep.length} swept of Nagatha's eval cards`);
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
