import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { decryptFields, generateChannelKey, writeConsentEvent } from '../crypto.js';
import { getAccount, getHearsVia, getTimezone } from './accounts.js';
import { getCard } from './cards.js';
import {
  MAX_THRESHOLD_BUMP,
  THRESHOLD_BUMP_STEP,
  categoryPhrase,
  categoryPhraseWithArticle,
} from './matchRules.js';
import { inLineCount, noteMovement, ownCardIsFull } from './sequencer.js';
import {
  counterpartyProfileConsentError,
  profileIsFilled,
  readSharedProfile,
  sharedProfileConsentError,
  type SharedProfile,
} from './profile.js';
import { OsbError, SCHEMA_VERSION, assertOutbound } from '../protocol.js';
import type { Config } from '../config.js';

export interface MatchRow {
  id: string;
  card_want: string;
  card_have: string;
  account_want: string;
  account_have: string;
  score: number;
  category: string;
  stage: number;
  interest_want: boolean;
  interest_have: boolean;
  state: 'open' | 'declined' | 'closed' | 'archived';
  channel_id: string | null;
  opened_at: Date | null;
  archived_at?: Date | null;
  archived_by?: string | null;
  archived_via?: string | null;
  /** In a slot right now. An introduction that is not live is in line. */
  live?: boolean;
  live_at?: Date | null;
  last_movement_at?: Date | null;
}

export async function getMatch(id: string): Promise<MatchRow | undefined> {
  const r = await getPool().query('SELECT * FROM matches WHERE id = $1', [id]);
  return r.rows[0];
}

export function sideOf(m: MatchRow, accountId: string): 'want' | 'have' {
  if (m.account_want === accountId) return 'want';
  if (m.account_have === accountId) return 'have';
  throw Object.assign(new Error('introduction not found'), { notFound: true });
}

/**
 * Create a match between a WANT and a HAVE card. In 0.C this is called only
 * by the internal ops interface (the 0.F matching engine will consume the
 * matching queue and call it). Price-band compatibility checking — the only
 * consumer of the encrypted bands — also lands in 0.F.
 */
export async function createMatch(
  cardWantId: string,
  cardHaveId: string,
  score: number,
): Promise<string> {
  const want = await getCard(cardWantId);
  const have = await getCard(cardHaveId);
  if (!want || want.type !== 'WANT' || want.lifecycle_state !== 'PUBLISHED') {
    throw new Error(`card_want ${cardWantId} is not a published WANT`);
  }
  if (!have || have.type !== 'HAVE' || have.lifecycle_state !== 'PUBLISHED') {
    throw new Error(`card_have ${cardHaveId} is not a published HAVE`);
  }
  const r = await getPool().query(
    `INSERT INTO matches (card_want, card_have, account_want, account_have, score, category)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (card_want, card_have) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [cardWantId, cardHaveId, want.account_id, have.account_id, score, want.category],
  );
  // A new candidate joins a line rather than arriving on somebody's doorstep,
  // so the sequencer decides whether there is a slot free for it right now.
  const { resequenceCard } = await import('./sequencer.js');
  await resequenceCard(cardWantId);
  await resequenceCard(cardHaveId);
  return r.rows[0].id as string;
}

// ---------------------------------------------------------------------------
// Contested wants and haves: the line, not the window.
//
// Until migration 030 a second person coming forward put the holder's want or
// have into a COLLECTION WINDOW: everybody was introduced at once, and for six
// hours the holder could talk to all of them and commit to none of them. It
// solved the wrong problem. Nobody asked to run an auction, and the person who
// came second was left in silence either way.
//
// Nothing blocks a holder now. Every open want and have holds a LINE of
// candidates and a number of slots (cards.slots): the introductions in a slot
// are live and behave exactly as an introduction always has, and the rest wait
// their turn. The holder is shown nothing of who is in line beyond a count of
// their own line; the person waiting is told one sentence and nothing else.
// The whole of that machinery is domain/sequencer.ts.
//
// What stayed: the ban on scarcity theatre. No rival count, no position, no
// hint that a contest exists, crosses to a counterparty — asserted in tests.
// ---------------------------------------------------------------------------

/** The caller's OWN card on this match. */
export function ownCardId(m: MatchRow, accountId: string): string {
  return sideOf(m, accountId) === 'want' ? m.card_want : m.card_have;
}

// ---------------------------------------------------------------------------
// How it went: one tap, in the three words a person says. Simple documented
// model (no ML):
//   - the verdict row is stored (match_verdicts, unique per human+match);
//   - 'bad' additionally (a) mutes the account pairing so the matcher never
//     pairs these two accounts again, (b) declines the introduction if still
//     open (reasonless, as all declines are), and (c) nudges the verdict-
//     giver's personal threshold up by +0.01 (cap +0.10 over the 0.75 base);
//   - 'good' relaxes the personal threshold by -0.01 (floor 0);
//   - 'fine' is recorded and does nothing else. It is the answer most of them
//     are, and it was missing: without it an introduction that was merely all
//     right had to be filed as a rejection, which muted the pairing for good.
//     Neutral in the reliability signal, both ways.
// The old wire words ('good-call', 'not-for-me') are mapped in the tool layer
// for one manual version and never reach here.
// ---------------------------------------------------------------------------
export type Verdict = 'good' | 'fine' | 'bad';

/** The three words, for anything that has to check one. */
export const VERDICTS: readonly Verdict[] = ['good', 'fine', 'bad'];

export const isVerdict = (v: unknown): v is Verdict => VERDICTS.includes(v as Verdict);

/**
 * The two words the wire used before run 7, mapped to the ones it uses now.
 * An agent holding the older tool schema keeps working for one manual version;
 * nothing is logged about the alias, and neither old word is stored.
 */
const VERDICT_ALIASES: Record<string, Verdict> = {
  'good-call': 'good',
  'not-for-me': 'bad',
};

/** The verdict a caller meant, from either vocabulary (undefined = neither). */
export function readVerdict(v: unknown): Verdict | undefined {
  if (isVerdict(v)) return v;
  return typeof v === 'string' ? VERDICT_ALIASES[v] : undefined;
}

export async function recordVerdict(
  matchId: string,
  accountId: string,
  verdict: Verdict,
  recordedVia: string,
): Promise<{ intro_id: string; verdict: string }> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId); // throws notFound if not a party
  const pool = getPool();
  await pool.query(
    `INSERT INTO match_verdicts (match_id, account_id, verdict, recorded_via)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (match_id, account_id) DO UPDATE SET verdict = $3, created_at = now()`,
    [matchId, accountId, verdict, recordedVia],
  );
  // 'fine' is recorded and stops there: no mute, no decline, and no move on
  // the threshold in either direction.
  if (verdict === 'fine') return { intro_id: matchId, verdict };
  if (verdict === 'bad') {
    const counterparty = m.account_want === accountId ? m.account_have : m.account_want;
    await pool.query(
      `INSERT INTO match_mutes (account_id, muted_account) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [accountId, counterparty],
    );
    await pool.query(
      `UPDATE matches SET state = 'declined', updated_at = now()
       WHERE id = $1 AND state = 'open'`,
      [matchId],
    );
    await pool.query(
      `UPDATE reputation SET threshold_bump = LEAST(threshold_bump + $2, $3), updated_at = now()
       WHERE account_id = $1`,
      [accountId, THRESHOLD_BUMP_STEP, MAX_THRESHOLD_BUMP],
    );
  } else {
    await pool.query(
      `UPDATE reputation SET threshold_bump = GREATEST(threshold_bump - $2, 0), updated_at = now()
       WHERE account_id = $1`,
      [accountId, THRESHOLD_BUMP_STEP],
    );
  }
  return { intro_id: matchId, verdict };
}

/** Count of recorded stage-3 opt-ins for a match (0, 1, or 2 distinct humans). */
async function stage3OptinCount(matchId: string): Promise<number> {
  const r = await getPool().query(
    `SELECT count(DISTINCT account_id)::int AS n FROM consent_tokens
     WHERE match_id = $1 AND kind = 'stage3-optin'`,
    [matchId],
  );
  return r.rows[0].n as number;
}

/**
 * The one sentence a waiting agent ever gets about the line. No count, no
 * position, no hint of who else is there — see domain/sequencer.ts.
 */
export const IN_LINE_SENTENCE =
  "You're in line for this one. I'll tell you when it's your turn.";

async function loadOpenMatchFor(
  matchId: string,
  accountId: string,
  requireLive = true,
): Promise<MatchRow> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId); // throws notFound if not a party
  if (m.state === 'declined' || m.state === 'closed' || m.state === 'archived') {
    // A closed match discloses nothing further; declines carry no reason; an
    // archived match is a finished connection, so it accepts no further
    // interest, opt-in or channel action (retrieval reads it separately).
    throw new OsbError('NOT_UNLOCKED_YET');
  }
  // An introduction still in line is a row, not yet an introduction: nothing
  // advances on it until its turn comes. The refusal carries the same sentence
  // the sweep carries, and nothing more — a waiting agent must not be able to
  // learn anything about the line by poking at it.
  if (requireLive && m.live === false) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: IN_LINE_SENTENCE });
  }
  return m;
}

/**
 * Record stage-1 interest for the calling side. Advances stage to 2 when mutual.
 *
 * The side that spoke FIRST is told, once, when the second side makes it
 * mutual. That human said they were keen and then heard nothing: their own
 * assistant only wakes when spoken to, so the details opening was a thing that
 * happened on a page nobody had told them to open. The side calling now needs
 * no notice — its own assistant is right here and has the answer in hand.
 */
export async function expressInterest(
  cfg: Config,
  matchId: string,
  accountId: string,
): Promise<MatchRow> {
  const m = await loadOpenMatchFor(matchId, accountId);
  const col = sideOf(m, accountId) === 'want' ? 'interest_want' : 'interest_have';
  const r = await getPool().query(
    `UPDATE matches SET ${col} = true,
        stage = CASE WHEN stage < 2 AND interest_want AND interest_have THEN stage ELSE stage END,
        updated_at = now()
     WHERE id = $1 RETURNING *`,
    [matchId],
  );
  const updated: MatchRow = r.rows[0];
  // Movement: the slot's clock starts again from here.
  await noteMovement(matchId);
  if (updated.interest_want && updated.interest_have && updated.stage < 2) {
    const r2 = await getPool().query(
      `UPDATE matches SET stage = 2, updated_at = now() WHERE id = $1 RETURNING *`,
      [matchId],
    );
    const unlocked: MatchRow = r2.rows[0];
    await queueYourMove(cfg, matchId, counterpartyOf(unlocked, accountId), 'details');
    return unlocked;
  }
  return updated;
}

/**
 * Enqueue a "your move" notice, best-effort and never able to fail the action
 * that raised it. Only for a human who hears about the switchboard by email:
 * an always-on assistant brings the same news itself, and a second copy of it
 * is noise. The dedupe key on the far side makes a repeat harmless.
 */
async function queueYourMove(
  cfg: Config,
  matchId: string,
  recipientAccount: string,
  step: 'names' | 'details',
): Promise<void> {
  if (!cfg.opsQueueUrl) return;
  try {
    if ((await getHearsVia(recipientAccount)) !== 'email') return;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.opsQueueUrl,
        MessageBody: JSON.stringify({
          op: 'your-move-notify',
          match_id: matchId,
          account_id: recipientAccount,
          step,
        }),
      }),
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`your-move-notify: enqueue failed (the step itself stands): ${e?.message ?? e}`);
  }
}

/** The other party's account on a match. */
function counterpartyOf(m: MatchRow, accountId: string): string {
  return sideOf(m, accountId) === 'want' ? m.account_have : m.account_want;
}

/**
 * Record the calling human's stage-3 opt-in (0.C: agent-attested via the
 * respond tool; 0.D moves capture to the counter). Written to the WORM
 * consent log before the token row is committed. Advances stage to 3 only
 * when BOTH humans' tokens are recorded.
 *
 * An opt-in is a promise to hand over a first name and an area, so an account
 * that has neither on file cannot make it. That case is refused BEFORE the
 * WORM write with CONSENT_REQUIRED and the human's own approval link: the
 * opt-in is not recorded, and the agent is never the one that supplies the
 * name.
 */
export async function recordStage3OptIn(
  cfg: Config,
  matchId: string,
  accountId: string,
  recordedVia: string,
): Promise<{ match: MatchRow; both: boolean }> {
  const m = await loadOpenMatchFor(matchId, accountId);
  if (m.stage < 2) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'Both sides have to say they are interested before this opens.',
    });
  }
  const own = await readSharedProfile(accountId, {
    purpose: 'stage3-optin-profile-check',
    actor: accountId,
    refs: { match_id: matchId },
  });
  if (!profileIsFilled(own)) {
    throw await sharedProfileConsentError(cfg, {
      accountId,
      matchId,
      counterpartyAccount: counterpartyOf(m, accountId),
    });
  }
  await writeConsentEvent({
    event: 'stage3-optin',
    match_id: matchId,
    account_id: accountId,
    recorded_via: recordedVia,
  });
  await getPool().query(
    `INSERT INTO consent_tokens (match_id, account_id, kind, recorded_via)
     VALUES ($1,$2,'stage3-optin',$3)
     ON CONFLICT (match_id, account_id, kind) DO NOTHING`,
    [matchId, accountId, recordedVia],
  );
  await noteMovement(matchId); // the slot's clock starts again
  const n = await stage3OptinCount(matchId);
  if (n >= 2 && m.stage < 3) {
    await getPool().query(`UPDATE matches SET stage = 3, updated_at = now() WHERE id = $1`, [
      matchId,
    ]);
  }
  // "Your move": this side has opted in and the other has not, so the ball is
  // now in the counterparty's court. New-match is already summoned; a passive
  // human would otherwise never learn the progression reached them. Best-effort
  // and idempotent (your-move:{match}:{account} dedupe), so it never fails the
  // opt-in and a repeat opt-in raises no second email.
  if (n < 2 && cfg.opsQueueUrl) {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: cfg.opsQueueUrl,
          MessageBody: JSON.stringify({
            op: 'your-move-notify',
            match_id: matchId,
            account_id: counterpartyOf(m, accountId),
          }),
        }),
      );
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`your-move-notify: enqueue failed (opt-in unaffected): ${e?.message ?? e}`);
    }
  }
  const updated = (await getMatch(matchId))!;
  return { match: updated, both: n >= 2 };
}

/**
 * Decline: closes the match. NO reason is recorded on the wire (anti-probing).
 *
 * A person in line may decline too — dropping out of a queue is a perfectly
 * ordinary thing to want to do, and refusing it would leave them stuck behind
 * something they no longer want. Either way the slot it held (or would have
 * held) goes to whoever is next.
 */
export async function declineMatch(
  matchId: string,
  accountId: string,
  cfg?: Config,
): Promise<void> {
  await loadOpenMatchFor(matchId, accountId, false);
  await getPool().query(
    `UPDATE matches SET state = 'declined', live = false, updated_at = now() WHERE id = $1`,
    [matchId],
  );
  const { resequenceAround } = await import('./sequencer.js');
  await resequenceAround(matchId, cfg);
}

/**
 * Archive a finished connection. This is the SUCCESS close: two people matched,
 * opted in, talked, and have taken it off the switchboard (swapped numbers,
 * joined the book club). Only a party to the match may archive it, and only an
 * OPEN match can be archived. The row and its disclosed-profile linkage STAY,
 * so the connection record — the counterparty's disclosed first name and area,
 * the category, the dates — is retrievable afterwards. What is torn down is the
 * live channel: the state leaving 'open' is itself enough to make
 * channel_send/receive refuse (loadOpenChannel gates on state === 'open'), and
 * any uncollected message is expired here so the ordinary sweep clears it. The
 * conversation and the phone number were never retained, so there is nothing of
 * them to keep or to drop.
 *
 * Idempotent: archiving an already-archived match records nothing new and
 * reports it as archived. A declined or closed match cannot be archived.
 */
export async function archiveMatch(
  matchId: string,
  accountId: string,
  recordedVia: string,
  cfg?: Config,
): Promise<{ intro_id: string; state: 'archived'; already: boolean }> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId); // throws notFound when the caller is not a party
  if (m.state === 'archived') {
    return { intro_id: matchId, state: 'archived', already: true };
  }
  if (m.state !== 'open') {
    // Only a live, open connection can be filed away as finished. A declined or
    // closed match went nowhere; there is nothing to archive.
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'This introduction is not an open connection, so there is nothing to file away.',
    });
  }
  const r = await getPool().query(
    `UPDATE matches
        SET state = 'archived', archived_at = now(), archived_by = $2,
            archived_via = $3, live = false, updated_at = now()
      WHERE id = $1 AND state = 'open'
      RETURNING id`,
    [matchId, accountId, recordedVia],
  );
  if (!r.rowCount) {
    // Lost a race to another archive of the same match: treat as idempotent.
    return { intro_id: matchId, state: 'archived', already: true };
  }
  // WORM record of who filed it and when, the recorded_via shape the verdict
  // and opt-in paths already use.
  await writeConsentEvent({
    event: 'match-archived',
    match_id: matchId,
    account_id: accountId,
    recorded_via: recordedVia,
  });
  // Tear down the live channel's leftovers: the state change already stops new
  // sends and collections; expiring any uncollected message hands it to the
  // sweep instead of leaving it to sit out its 14-day TTL.
  await getPool().query(
    `UPDATE channel_messages SET expires_at = now() WHERE match_id = $1 AND expires_at > now()`,
    [matchId],
  );
  // The slot it held is free, so whoever is next in line on either side goes
  // live now and their human is summoned the ordinary way.
  const { resequenceAround } = await import('./sequencer.js');
  await resequenceAround(matchId, cfg);
  return { intro_id: matchId, state: 'archived', already: false };
}

/**
 * File away the open introductions on a want or have that has just been taken
 * down — the ones that never got as far as a conversation. Taking one down is
 * the human saying the thing is gone — the bike sold, the room filled — and an
 * introduction still advancing on it wastes the other person's time on
 * something they can no longer have. So the withdrawal carries those with it:
 * each becomes 'archived' with archived_via 'withdrawn', which keeps it out of
 * both sides' sweeps as something new to act on, and anything uncollected is
 * expired so the ordinary sweep clears it.
 *
 * An introduction whose conversation is already open is left exactly as it
 * was. Run 6 (12 September 2026): the seller said "the bike is sold, take it
 * down" and the conversation with the buyer, in which the handover was being
 * arranged, closed with it. Taking the thing down and closing a conversation
 * are two different acts; the second is the explicit archive, on the human's
 * word, once the two people are done.
 *
 * The record stays, the same way an ordinary archive keeps one: who it was and
 * what it was about are still there to answer "who was that person again?".
 *
 * Best-effort by construction — it is called after it is already down,
 * and returns how many it filed away.
 */
export async function archiveOpenIntroductionsOnCard(
  cardId: string,
  accountId: string,
  recordedVia = 'withdrawn',
): Promise<number> {
  const r = await getPool().query(
    `UPDATE matches
        SET state = 'archived', archived_at = now(), archived_by = $2,
            archived_via = $3, live = false, updated_at = now()
      WHERE (card_want = $1 OR card_have = $1) AND state = 'open'
        AND (channel_id IS NULL OR stage < 4)
      RETURNING id`,
    [cardId, accountId, recordedVia],
  );
  const ids = (r.rows as { id: string }[]).map((x) => x.id);
  if (!ids.length) return 0;
  for (const id of ids) {
    await writeConsentEvent({
      event: 'match-archived',
      match_id: id,
      account_id: accountId,
      recorded_via: recordedVia,
    });
  }
  await getPool().query(
    `UPDATE channel_messages SET expires_at = now()
      WHERE match_id = ANY($1::uuid[]) AND expires_at > now()`,
    [ids],
  );
  // Each of those people had a slot of their own taken up by this. It is free
  // now, so whoever is next in THEIR line goes live and hears about it.
  const { resequenceAround } = await import('./sequencer.js');
  for (const id of ids) await resequenceAround(id);
  return ids.length;
}

// ---------------------------------------------------------------------------
// Stage payload builders. Every payload is validated OUTBOUND against its
// protocol schema before being returned (assertOutbound) — the disclosure
// schemas have additionalProperties:false and no price-band slot, so a leak
// is structurally impossible on this path.
// ---------------------------------------------------------------------------

/** The newest offer from the OTHER side still awaiting this human, if any. An
 *  offer is a deliberate disclosure, so its amount is safe to surface — unlike
 *  a private price band, which never leaves the engine. */
async function incomingOffer(
  matchId: string,
  accountId: string,
): Promise<{ amount: number; ccy: string; message: string | null } | undefined> {
  // Sealed on a best offer: the seller sees no number until the window closes,
  // by whichever road they come looking.
  const { bestOfferSealedFrom } = await import('./offers.js');
  if (await bestOfferSealedFrom(matchId, accountId)) return undefined;
  const r = await getPool().query(
    `SELECT amount, ccy, message FROM offers
     WHERE match_id = $1 AND proposer_account <> $2
       AND state IN ('proposed', 'awaiting-human')
     ORDER BY created_at DESC LIMIT 1`,
    [matchId, accountId],
  );
  if (!r.rowCount) return undefined;
  const o = r.rows[0];
  // The message is stored as { text, provenance }; the agent gets the words.
  // Handing the wrapper across is what put "[object Object]" in front of a
  // human in the 2026-09-09 rehearsal.
  const { offerMessageText } = await import('./offers.js');
  return {
    amount: Number(o.amount),
    ccy: o.ccy as string,
    message: offerMessageText(o.message),
  };
}

export async function buildSignal(m: MatchRow, accountId: string) {
  const side = sideOf(m, accountId);
  // No score crosses to the agent. The switchboard already decided the match
  // was worth sending, so the number is never needed to act — and a number an
  // agent never receives is a number it can never read out to its human. Score
  // stays in the DB and the internal matcher logs; it is stripped here, at the
  // agent boundary, and the outbound schema (no `score` slot) makes that
  // structural rather than advisory.
  return assertOutbound('intro.signal', {
    schema_version: SCHEMA_VERSION,
    kind: 'intro.signal' as const,
    intro_id: m.id,
    category: m.category,
    // The side the other person is on, said in the words the wire uses: they
    // are offering something, or they are looking for one. WANT/HAVE stay in
    // the database and the matcher; they stop here.
    counterparty_type: side === 'want' ? ('offering' as const) : ('looking_for' as const),
  });
}

/**
 * What the agent can do next on a match, as a word rather than a level. This
 * is the agent-facing replacement for the raw stage integer: it is derived
 * from the same interest / stage / channel state the flow already turns on, so
 * the word plus the match_id is enough to drive the next tool call, and no
 * stage number is ever handed across the boundary to be read out.
 *
 *   show_interest        a fresh signal; this side has not expressed interest
 *   awaiting_other_side  this side is interested, waiting on the other side
 *   details_unlocked     both sides interested — attributes are on the entry
 *   awaiting_your_human  a stage-3 opt-in / approval sits with the human
 *   ready_to_talk        both opted in; open the channel (or it is already open)
 *   deal_agreed          a figure on this introduction has been accepted by a
 *                        human, whichever side proposed it; the switchboard's
 *                        part is finished and the handover is the two people's
 *                        own to arrange
 *
 * `awaiting_your_human` and `deal_agreed` are not reachable from the row state
 * alone — checkMatches sets them, from a reveal genuinely waiting on the
 * human's own page and from the offers table respectively.
 */
export type NextAction =
  | 'show_interest'
  | 'awaiting_other_side'
  | 'details_unlocked'
  | 'awaiting_your_human'
  | 'ready_to_talk'
  | 'deal_agreed';

export function nextAction(m: MatchRow, accountId: string): NextAction {
  const iMine = sideOf(m, accountId) === 'want' ? m.interest_want : m.interest_have;
  if (m.channel_id) return 'ready_to_talk'; // stage 4 — channel open
  if (m.stage >= 3) return 'ready_to_talk'; // both opted in — open the channel
  if (m.stage >= 2) return 'details_unlocked'; // mutual interest — attributes present
  if (iMine) return 'awaiting_other_side'; // this side keen, waiting on them
  return 'show_interest'; // fresh signal
}

export async function buildAttributes(m: MatchRow, accountId: string) {
  if (m.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET');
  if (m.stage < 2) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'The details open up once both sides have said they are interested.',
    });
  }
  const side = sideOf(m, accountId);
  const counterCardId = side === 'want' ? m.card_have : m.card_want;
  const card = await getCard(counterCardId);
  if (!card) throw new Error('counterparty card missing');
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');
  const payload: any = {
    schema_version: SCHEMA_VERSION,
    kind: 'intro.attributes' as const,
    intro_id: m.id,
    attributes: card.attributes ?? {},
  };
  // Only the deliberate, disclosable ask ever crosses — never the price band.
  if (card.type === 'HAVE' && card.ask) payload.ask = card.ask;
  return assertOutbound('intro.attributes', payload);
}

export async function buildMutual(
  cfg: Config,
  m: MatchRow,
  accountId: string,
  ownProfile?: SharedProfile,
) {
  // Open matches disclose at stage 3; an archived match keeps disclosing the
  // same stage-3 record so the connection stays retrievable after it is filed
  // away ("you connected with Alex in Franklin about Italian"). Declined and
  // closed matches disclose nothing.
  if (m.state !== 'open' && m.state !== 'archived') throw new OsbError('NOT_UNLOCKED_YET');
  // HARD GATE: stage-3 data is NEVER returned without BOTH humans' recorded
  // opt-in tokens. The check queries consent_tokens directly — not the stage
  // column — so a bug elsewhere cannot open the gate.
  const optins = await stage3OptinCount(m.id);
  if (optins < 2 || m.stage < 3) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'First names are shared only once both humans have said yes. Ask your human to give the go-ahead on their approval page.',
    });
  }
  const side = sideOf(m, accountId);
  const counterAccountId = side === 'want' ? m.account_have : m.account_want;
  // Both opt-ins are on record, so the only thing that can still be missing is
  // the substance of the disclosure. An empty profile on either side is
  // answered with CONSENT_REQUIRED and a plain instruction — the recorded
  // opt-ins stand, and the reveal completes the moment both profiles exist.
  const own =
    ownProfile ??
    (await readSharedProfile(accountId, {
      purpose: 'stage3-own-profile-check',
      actor: accountId,
      refs: { match_id: m.id },
    }));
  if (!profileIsFilled(own)) {
    throw await sharedProfileConsentError(cfg, {
      accountId,
      matchId: m.id,
      counterpartyAccount: counterAccountId,
    });
  }
  const account = await getAccount(counterAccountId);
  if (!account) throw new Error('counterparty account missing');
  const optinRow = await getPool().query(
    `SELECT max(recorded_at) AS at FROM consent_tokens
     WHERE match_id = $1 AND kind = 'stage3-optin'`,
    [m.id],
  );
  const fields = await decryptFields(
    counterAccountId,
    account.data_key_enc,
    { first_name: account.first_name_enc, locality: account.locality_enc },
    {
      purpose: 'stage3-mutual-disclosure',
      actor: accountId,
      refs: { match_id: m.id },
    },
  );
  const counterparty = {
    first_name: fields.first_name.trim(),
    locality: fields.locality.trim(),
  };
  if (!profileIsFilled({ firstName: counterparty.first_name, locality: counterparty.locality })) {
    throw counterpartyProfileConsentError();
  }
  return assertOutbound('intro.mutual', {
    schema_version: SCHEMA_VERSION,
    kind: 'intro.mutual' as const,
    intro_id: m.id,
    counterparty,
    optin: {
      both_recorded: true as const,
      recorded_at: new Date(optinRow.rows[0].at).toISOString(),
    },
  });
}

export async function openChannel(matchId: string, accountId: string) {
  const m = await loadOpenMatchFor(matchId, accountId);
  const optins = await stage3OptinCount(m.id);
  if (optins < 2 || m.stage < 3) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'A conversation can open only after both humans opt in to mutual disclosure.',
    });
  }
  let channelId = m.channel_id;
  let openedAt = m.opened_at;
  if (!channelId) {
    channelId = `ch_${randomUUID()}`;
    openedAt = new Date();
    // The channel gets its own key at the moment it comes into being. Message
    // bodies are encrypted under it and nothing else can read them; it lives
    // on the match row and dies with it. See domain/channel.ts for why the
    // account envelope keys are deliberately not used for a conversation.
    const channelKey = await generateChannelKey(channelId);
    await getPool().query(
      `UPDATE matches SET stage = 4, channel_id = $2, opened_at = $3,
              channel_key_enc = $4, updated_at = now()
       WHERE id = $1`,
      [matchId, channelId, openedAt, channelKey],
    );
  }
  return assertOutbound('conversation.open', {
    schema_version: SCHEMA_VERSION,
    kind: 'conversation.open' as const,
    intro_id: m.id,
    conversation: { medium: 'in-app' as const, conversation_id: channelId },
    opened_at: new Date(openedAt!).toISOString(),
  });
}

/**
 * Fetch one specific stage payload for a match. Throws NOT_UNLOCKED_YET when the
 * requested stage is not unlocked for this pair (e.g. stage 3 without both
 * humans' opt-in tokens).
 */
export async function getStagePayload(
  cfg: Config,
  accountId: string,
  matchId: string,
  stage: number,
) {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  switch (stage) {
    case 1:
      if (m.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET');
      return buildSignal(m, accountId);
    case 2:
      return buildAttributes(m, accountId);
    case 3:
      return buildMutual(cfg, m, accountId);
    default:
      throw Object.assign(
        new Error(`step must be 'signal', 'details' or 'names' (talking is open_conversation)`),
        { validation: ['step'] },
      );
  }
}

/** A switchboard-authored, human-facing sentence that rides beside a match
 *  entry. The agent leads with this verbatim rather than inventing a noun for
 *  the machinery — every one is written plain, warm and jargon-free. */
const sbNote = (text: string) => ({ text, provenance: 'switchboard-system' as const });

/** The leaf category as a human would say it mid-sentence, with the article
 *  the sentences here need in front of it: "a mountain bike", "climbing gear",
 *  "a book club". The words come from the taxonomy, so nothing looks like a
 *  code and no acronym arrives lower-cased. */
const plainLeaf = (category: string) => categoryPhraseWithArticle(category);

/** What "taken down" means, in the words the agent says it in. The thing this
 *  was about is off the switchboard, so nobody new comes into it; the two
 *  people already talking are left to finish. */
const takenDownSentence = (takenDown: 'yours' | 'theirs'): string =>
  takenDown === 'yours'
    ? "What your human put up has been taken down, so nobody new comes into this. The conversation with this person stays open until the two of them are done; when they are, say the word and I will file it away."
    : "What they put up has been taken down, so nobody new comes into this. The conversation stays open until the two of them are done; when they are, say the word and I will file it away.";

/** The ready sentence for a fresh stage-1 signal, warmed by which side the
 *  other person is on: they have what your human is after, or they are after
 *  what your human put up. No card/match/stage words reach the human. */
function signalNote(category: string, counterpartyType: 'looking_for' | 'offering'): { text: string; provenance: 'switchboard-system' } {
  const thing = plainLeaf(category);
  const opening =
    counterpartyType === 'offering'
      ? `Someone nearby has ${thing} going that could be what you're after.`
      : `Someone nearby is looking for ${thing} like yours.`;
  return sbNote(`${opening} Say the word and I'll let them know you're keen; if they're keen too, you'll each learn a little more.`);
}

/** All matches visible to an account, as stage-appropriate payloads. */
export async function checkMatches(cfg: Config, accountId: string, intentId?: string) {
  const params: any[] = [accountId];
  let filter = '';
  if (intentId) {
    filter = 'AND (m.card_want = $2 OR m.card_have = $2)';
    params.push(intentId);
  }
  const r = await getPool().query(
    `SELECT m.* FROM matches m
     WHERE (m.account_want = $1 OR m.account_have = $1) ${filter}
     ORDER BY m.created_at DESC LIMIT 50`,
    params,
  );
  const out: any[] = [];
  /** Wants and haves whose closed best-offer result is already on the sweep. */
  const bestOfferShown = new Set<string>();
  // The caller's own profile is the same for every match in the list, so it is
  // read at most once for the whole sweep (one audit line, not fifty).
  let own: SharedProfile | undefined;
  const ownProfile = async (): Promise<SharedProfile> =>
    (own ??= await readSharedProfile(accountId, {
      purpose: 'stage3-own-profile-check',
      actor: accountId,
    }));
  for (const m of r.rows as MatchRow[]) {
    if (m.state === 'archived') {
      // A finished connection, kept retrievable. It is never an actionable or
      // new signal — no `next`, no stage-1 signal — but it carries enough to
      // recall it: the category, when it was filed, and, where the humans
      // reached stage 3, the disclosed first name and area.
      const entry: any = {
        intro_id: m.id,
        state: 'archived',
        category: m.category,
        archived_at: m.archived_at ? new Date(m.archived_at).toISOString() : null,
      };
      if (m.stage >= 3) {
        try {
          entry.mutual = await buildMutual(cfg, m, accountId, await ownProfile());
        } catch (e) {
          // A disclosure that only ever needs a profile that is now gone stays
          // silent here; the record itself is still returned.
          if (!(e instanceof OsbError)) throw e;
        }
      }
      // A ready sentence to answer "who was that again?" from later — the first
      // name and area if the two reached mutual disclosure, plainly, with no
      // system words. This is the whole of what the agent relays on recall.
      //
      // Two of them are not a recollection at all but news, and they are the
      // ones the fit sequencer files away: a slot whose clock ran out, and a
      // best-offer seller who went with somebody else. Both sides are owed a
      // sentence saying so rather than an introduction that quietly stops.
      const c = entry.mutual?.counterparty;
      if (m.archived_via === 'lapsed') {
        entry.note = sbNote(
          `This one went quiet and has been filed away. Nothing more is expected of either of you about the ${plainLeaf(m.category)}; say the word if you would like me to look again.`,
        );
      } else if (m.archived_via === 'not-chosen') {
        // No figure, no count, nothing about anyone else: the losing side is
        // told the outcome and not one thing more.
        entry.note = sbNote(
          'The seller went with someone else on this one. Say the word and I will keep an ear out for another.',
        );
      } else {
        entry.note = c
          ? sbNote(`You got chatting with ${c.first_name} over in ${c.locality} about ${plainLeaf(m.category)} a while back. The conversation and any number you swapped are here in our chat.`)
          : sbNote(`You had ${plainLeaf(m.category)} sorted with someone a while back; it has since been filed away.`);
      }
      out.push(entry);
      continue;
    }
    if (m.state !== 'open') {
      out.push({ intro_id: m.id, state: m.state });
      continue;
    }
    // IN LINE. Only the introductions in a slot are live. The rest are rows
    // waiting their turn, and who sees one depends on whose line is full:
    //
    //   - the HOLDER (their own want or have has no slot free) is shown
    //     nothing of it at all. They are already talking to someone about this
    //     and a queue behind that person is not their business to manage;
    //     their own line is summed up once, on the live introduction, as a
    //     count they can act on.
    //   - the person WAITING gets one entry, one sentence, and nothing else:
    //     no count, no position, no signal, no category. Being told "not yet"
    //     is the difference between waiting and silence, and everything past
    //     that sentence would be scarcity theatre.
    if (m.live === false) {
      if (await ownCardIsFull(ownCardId(m, accountId))) continue;
      out.push({ intro_id: m.id, state: 'in_line', note: sbNote(IN_LINE_SENTENCE) });
      continue;
    }
    const signal = await buildSignal(m, accountId);
    const entry: any = {
      intro_id: m.id,
      state: 'open',
      // A word for what the agent can do now, in place of a stage number to
      // read out.
      next: nextAction(m, accountId),
      signal,
      // The ready human sentence for a fresh signal rides right here on the
      // entry, so the agent leads with it instead of naming the machinery.
      note: signalNote(m.category, signal.counterparty_type),
    };
    // THE LINE, and it is the HOLDER'S OWN. How many people are waiting behind
    // this one on the caller's own want or have: their queue, on their own
    // thing, so it is theirs to know. Nothing about it ever crosses to the
    // other side, and it carries no names, no order and no hint of who.
    const ownCard = ownCardId(m, accountId);
    const waiting = await inLineCount(ownCard);
    if (waiting > 0) {
      entry.line = {
        in_line: waiting,
        note: sbNote(
          `${waiting === 1 ? 'One more person is' : `${waiting} more people are`} in line for this; they come to you one at a time as this one settles.`,
        ),
      };
    }
    // The underpricing note. Only ever to the holder, only on something they
    // are selling outright, never with a figure and never with a count. See
    // domain/offers.ts for the floor of five it will not speak below.
    const { bestOfferResult, underpricingNote } = await import('./offers.js');
    const priceNote = await underpricingNote(ownCard, accountId);
    if (priceNote) entry.price_note = sbNote(priceNote);
    // A best offer whose gathering window has closed: every number at once,
    // best first, on the seller's own want or have and once for the whole
    // sweep rather than scattered one per introduction. Nothing of it exists
    // for a buyer — bestOfferResult answers only its own card's owner.
    if (!bestOfferShown.has(ownCard)) {
      const result = await bestOfferResult(ownCard, accountId);
      if (result) {
        bestOfferShown.add(ownCard);
        entry.best_offers = { offers: result.offers, note: sbNote(result.note) };
      }
    }
    // A match that has reached stage 4 names its conversation here, so an agent
    // polling for matches already knows where to collect from. How many
    // messages are waiting is counted once for the whole sweep, in the tool
    // layer, alongside the sentence written for the human.
    let takenDown: 'yours' | 'theirs' | undefined;
    if (m.stage >= 4 && m.channel_id) {
      entry.conversation = { conversation_id: m.channel_id };
      // The thing this was about may have been taken down while the two were
      // still talking. The conversation stays open on purpose; say so, so the
      // agent neither treats it as ended nor as something new is coming into.
      const own = await getCard(ownCardId(m, accountId));
      const theirs = await getCard(sideOf(m, accountId) === 'want' ? m.card_have : m.card_want);
      if (own?.lifecycle_state === 'WITHDRAWN') takenDown = 'yours';
      else if (theirs?.lifecycle_state === 'WITHDRAWN') takenDown = 'theirs';
      // The field is for the agent; the sentence is what it says out loud.
      // Left bare, this one reached the human as the words "taken down" in a
      // sweep whose main sentence was about a figure on the table instead.
      if (takenDown) {
        entry.taken_down = takenDown;
        entry.taken_down_note = sbNote(takenDownSentence(takenDown));
      }
    }
    // A pending offer FROM the other side must reach this agent on its ordinary
    // sweep — otherwise a routine "anything new?" misses a figure on the table.
    // The amount is a deliberate disclosure (an offer is meant to be seen), so
    // it crosses; the human note carries it in plain words for relay.
    const incoming = await incomingOffer(m.id, accountId);
    if (incoming) {
      entry.offer = { amount: incoming.amount, ccy: incoming.ccy, message: incoming.message };
      entry.next = 'awaiting_your_human';
    }
    // BOTH sides of the table, most recent first. An agent that only ever saw
    // the other side's figures had no way to know its own human had typed one
    // on their approval page, and told them their number never went out.
    const { offerTable, offerTableNote } = await import('./offers.js');
    const table = await offerTable(accountId, m.id);
    if (table.length) {
      entry.offers = table;
      // The offer sentence names the thing the way a person would say it in
      // one — "for your mountain bike" — where the signal sentence wants the
      // article in front of it as well.
      const noteText = offerTableNote(table, categoryPhrase(m.category), sideOf(m, accountId));
      if (noteText) entry.offer_note = sbNote(noteText);
      // A figure one human proposed and the other took, whichever way round:
      // the deal is agreed and the switchboard has nothing further to do on it.
      // (Run 6: the accepting side's agent read 'ready_to_talk' and told its
      // human the accept was still pending.)
      if (table.some((l) => l.state === 'accepted-by-human')) {
        entry.next = 'deal_agreed';
      }
    }
    if (m.stage >= 2) entry.attributes = await buildAttributes(m, accountId);
    if (m.stage >= 3) {
      try {
        entry.mutual = await buildMutual(cfg, m, accountId, await ownProfile());
      } catch (e) {
        if (!(e instanceof OsbError)) throw e;
        // A stage-3 reveal that is only waiting on someone's first name and
        // area is worth saying out loud, so the agent can relay the one thing
        // its human has to do.
        if (e.payload.code === 'CONSENT_REQUIRED') {
          entry.mutual_blocked = e.payload;
          // The one thing left is on the human's own page (their first name and
          // area), so the word for this match is that it waits on the human.
          entry.next = 'awaiting_your_human';
        }
      }
    }
    // Give every surfaced state its own ready sentence, so the agent leads with
    // the note rather than inventing a word for whose turn it is. The fresh
    // signal already reads right; the later states get their own line here.
    switch (entry.next) {
      case 'awaiting_other_side':
        entry.note = sbNote(
          "You are keen and they know it — the next move is theirs. They will see it when they next check in with their assistant, and I will bring their reply straight to you.",
        );
        break;
      case 'details_unlocked':
        entry.note = sbNote(
          "You are both keen. Here is a little more about what they have — take a look, and if you would like to go further, say the word and I will share your first name and rough area so the two of you can talk.",
        );
        break;
      case 'awaiting_your_human':
        // An offer waiting is its own sentence (offer_note); otherwise it is the
        // one step left before the two can talk.
        entry.note = entry.offer_note
          ? entry.offer_note
          : sbNote(
              "You are both keen to talk. The last step is yours: give me the go-ahead and I will share your first name and rough area so the two of you can connect.",
            );
        break;
      case 'ready_to_talk':
        entry.note = sbNote(
          takenDown
            ? takenDownSentence(takenDown)
            : "You are connected now — you can message each other through me whenever you like.",
        );
        break;
      case 'deal_agreed':
        // The offer note already says the figure and whose it was, so it is
        // the whole of what the agent relays here.
        if (entry.offer_note) entry.note = entry.offer_note;
        break;
    }
    out.push(entry);
  }
  return out;
}
