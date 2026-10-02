/**
 * WRITTEN LINES THE SELLER'S HUMAN CONFIRMS (founder, 2 October 2026).
 *
 * The switchboard introduces people and keeps records. It never judges a
 * thing and never judges a dispute; what it does is make sure evidence exists
 * of what was agreed (domain/receipt.ts). The gap that left: a seller's
 * assistant can say something untrue in conversation, and a conversation is
 * carried and then let go, so nothing records it.
 *
 * So a claim that matters goes on the deal as a short written line.
 *
 *   ASKING      The buying side's assistant asks a line, in its human's words.
 *               It is free text from a stranger, so it passes every gate an
 *               offer note passes: short, plain text, no way of reaching
 *               anybody, no figure, and the intake pipe.
 *   CONFIRMING  is the SELLER'S HUMAN PRESS and nothing else, and it is ALL OR
 *               NOTHING. The lines are listed on the page the seller already
 *               uses to send a figure or take one, and on a page of their
 *               own, and the page's main button says it confirms them. One
 *               press confirms every line the page showed. There is no
 *               answering no to a line: a seller for whom something asked is
 *               not true presses Not now, which changes nothing, and the two
 *               assistants sort it out in the conversation. No assistant, no
 *               agent key and no queue message can confirm one;
 *               confirmLinesByHuman refuses anything that is not a press on
 *               the human's own page, and the database says the same
 *               (migration 066).
 *   THE RULE    An offer is accepted only with every asked line confirmed
 *               (domain/offers.ts, acceptOfferByHuman). Sending a figure is
 *               never held up. A line that was taken off holds nothing up.
 *   THE RECORD  lists the confirmed lines and no others.
 *
 * ONE LOCK PER INTRODUCTION. Asking, taking off, confirming and accepting all
 * run inside withIntroductionLocked: a short transaction that first takes an
 * advisory lock keyed on the introduction. Each statement after the lock is a
 * fresh read, so whichever of two presses arrives second sees everything the
 * first one did. That is what makes the rule a gate that cannot be raced.
 *
 * The other side's words are DATA everywhere here: stored labelled, shown as
 * theirs, never obeyed, and never written into a sentence the switchboard
 * signs.
 */
import type pg from 'pg';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, noMoneySentence, sideOf, type MatchRow } from './matches.js';
import { looksLikeContactDetail } from './arrangement.js';
import { carriesMoneyFigure } from './moneyInWords.js';
import { runIntake } from '../intake/pipe.js';
import { OsbError } from '../protocol.js';
import type { Config } from '../config.js';

export type LineState = 'asked' | 'confirmed' | 'withdrawn';

/** Which page a line was confirmed on. */
export type AnsweredOn = 'offer-accept' | 'offer-send' | 'lines-confirm';

export interface ConfirmLineRow {
  id: string;
  match_id: string;
  asked_by: string;
  /** { text, provenance }, as an offer note is stored. Null once erased. */
  line: any;
  state: LineState;
  created_at: Date;
  answered_at?: Date | null;
}

/** How many lines one introduction takes, where the deployment says nothing. */
export const CONFIRM_LINES_DEFAULT_MAX = 10;

/** How long one line may be. A line is one thing to confirm. */
export const CONFIRM_LINE_MAX_CHARS = 200;

/**
 * How many may ever be asked on one introduction, counting the ones taken
 * off: a multiple of the standing limit. It is there so that asking and
 * taking off cannot be run as a loop against somebody else's page.
 */
const EVER_ASKED_MULTIPLE = 3;

export const maxLinesFor = (cfg: Pick<Config, 'maxConfirmLines'> | undefined): number =>
  cfg?.maxConfirmLines ?? CONFIRM_LINES_DEFAULT_MAX;

// ---------------------------------------------------------------------------
// The sentences. Every one an assistant or a person reads is here, so the
// suite can hold each to the copy lint and the report can quote them.
// ---------------------------------------------------------------------------

/** Said to an assistant on the selling side that tried to ask or take one off. */
export const LINES_BUYING_SIDE_ONLY =
  'Your human is the one selling on this introduction, so there is nothing for you to ask here. What the other side asks to have confirmed comes to your human, on their own page.';

/** Where no money changes hands there is no offer to accept and no record. */
export const LINES_NO_DEAL_HERE =
  'No money changes hands on this one, so there is no offer to accept and no record of one. What matters to your human is for the two of them to sort out in the conversation.';

export const LINES_NOT_OPEN = 'This introduction is no longer open.';

export const LINES_AFTER_ACCEPT =
  'A figure has already been accepted on this one, so the deal is agreed as it stands and its record has gone out. Nothing can be added to it or taken off it now.';

export const LINES_FULL =
  'That is as many lines as one introduction takes. Take one off on your human’s word before asking another.';

export const LINE_HAS_FIGURE =
  'This one has not been asked. A line to confirm carries no sum of money: the amount is the offer’s own and is on the record already. Ask it again in plain words with the number left out.';

export const LINE_ASKED_SENTENCE =
  'That is asked. The seller’s human confirms it on their own page, with their own press, and their assistant cannot do it for them. Your next check_in says whether it was confirmed. Only a confirmed line goes on the record of a deal.';

export const LINE_WITHDRAWN_SENTENCE =
  'That line is off. It no longer holds anything up, and it will not be on the record of a deal.';

export const LINE_ALREADY_WITHDRAWN_SENTENCE = 'That line was already off.';

/** What the seller's assistant is told while something is waiting on its human. */
export const LINES_NOTE_SELLER_WAITING =
  'The buyer has asked your human to confirm some things in writing, and they are on your human’s own page. Tell your human so in a sentence and hand them the page: respond(request_confirm), or the page for a figure, which lists them too. The page’s main button confirms them all, and you cannot confirm any yourself. If something asked is not true, your human presses Not now: ask them what is not right, and say so to the other side in the conversation. Nothing can be accepted while one is waiting.';

export const LINES_NOTE_SELLER_CONFIRMED =
  'Your human has confirmed in writing everything the buyer asked. Those lines go on the record of a deal.';

export const LINES_NOTE_BUYER_WAITING =
  'The seller’s human has not yet confirmed everything you asked in writing: each line here says which. Nothing can be accepted until they have. If the other side tells you something you asked is not right, tell your human, and take that line off with respond(withdraw_confirmation) only on their yes. Only confirmed lines go on the record of a deal, and nothing said in conversation does.';

export const LINES_NOTE_BUYER_CONFIRMED =
  'The seller’s human has confirmed in writing everything you asked. Those lines go on the record of the deal; nothing said in conversation does.';

/** The short half that rides on the sweep's lead sentence. */
export const LINES_LEAD_SELLER =
  'The buyer has also asked you to confirm some things in writing, on your own page.';

/** After a Not now on a page that listed lines: for the human, then the agent. */
export const PRESS_NOT_NOW_SENTENCE =
  'You pressed Not now, so nothing was confirmed and nothing is agreed.';
export const PRESS_NOT_NOW_WHAT_TO_DO =
  'Ask your human what was not right about what the buyer asked them to confirm, and say so to the other side in the conversation, in your human’s words. Fetch the page again once it is sorted out.';

// What a person reads.

/** The buyer, at their own accept page and at the press. */
export const BUYER_BLOCKED_WORDS =
  'The seller has not yet confirmed what you asked for in writing, so nothing is agreed yet. If you want to go ahead without it, tell your assistant to take it off, then open this again.';

/** The heading over the lines on the seller's pages. Nothing sits under it
 *  but the lines themselves, each with a plain yes beside it. */
export const SELLER_LINES_HEADING = 'The buyer asked you to confirm';
/**
 * THE MAIN BUTTON WHERE A PAGE LISTS LINES, in one place so the three pages
 * stay in step. The heading sits directly above the lines, so "Confirm" is
 * read against it: "Confirm and accept $415" where the press also takes the
 * buyer's figure, "Confirm and send $415" where it also sends the seller's
 * own, and "Confirm" on the page of its own. `figure` is the short figure the
 * page already shows.
 */
export function confirmButtonLabel(page: AnsweredOn, figure?: string): string {
  if (page === 'offer-accept') return `Confirm and accept ${figure ?? ''}`.trim();
  if (page === 'offer-send') return `Confirm and send ${figure ?? ''}`.trim();
  return 'Confirm';
}
export const LINES_NOT_NOW_LABEL = 'Not now';
/** The word beside each line: what the press will say about it. */
export const LINE_YES = 'yes';

/** After Not now on a page that listed lines. Nothing changed. */
export const NOT_NOW_TITLE = 'Not now';
export const NOT_NOW_WORDS =
  'Nothing is agreed yet. Tell your assistant what is not right, and it can sort it out with the other side.';

/** The buyer has asked for something more since the page was drawn. */
export const LINES_CHANGED_REDRAW =
  'The buyer has asked for something more since you opened this page. It is listed now: read it, then press again.';
export const LINES_CHANGED_WORDS =
  'The buyer has asked for something more since this page opened, so nothing was confirmed and nothing is agreed. Open the page again to see it.';

/** On the buyer's accept page. */
export const BUYER_LINES_HEADING = 'The seller has confirmed in writing';

/** The seller's page of its own. */
export const CONFIRM_DONE_TITLE = 'Confirmed';
export const CONFIRM_DONE_WORDS =
  'You have confirmed what the buyer asked, and they are told. It goes on the record of a deal.';
export const CONFIRM_NOTHING_WAITING = 'There is nothing waiting to be confirmed on this one.';
/** Beside "Sent" when a figure went out from a page that also listed lines. */
export const SEND_DONE_LINES_CONFIRMED = 'What the buyer asked is confirmed too.';
/** And where the buyer asked for more in the moment of that press. */
export const SEND_DONE_LINES_NOT_CONFIRMED =
  'The buyer asked for something more as you pressed, so nothing was confirmed. Ask your assistant for the page.';

// ---------------------------------------------------------------------------
// The words of one line.
// ---------------------------------------------------------------------------

export type LineValidation = { ok: true; value: string } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/;

/**
 * An offer note's rule (domain/negotiation.ts, validateOfferNote), in a
 * line's own words: one short line of plain text, no angle brackets, no way
 * of reaching anybody. Unlike a note, a line cannot be empty.
 */
export function validateConfirmLine(raw: unknown): LineValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'A line to confirm is one short line of text.' };
  }
  const value = raw.trim();
  if (!value) return { ok: false, error: 'A line to confirm needs some words in it.' };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: 'Plain text only in a line to confirm.' };
  if (value.length > CONFIRM_LINE_MAX_CHARS) {
    return { ok: false, error: 'That line is too long. Keep it to one short thing to confirm.' };
  }
  if (looksLikeContactDetail(value)) {
    return {
      ok: false,
      error:
        'That line holds an email, phone number or web address. Keep ways of reaching anybody out of it.',
    };
  }
  return { ok: true, value };
}

/** The words on a stored line: the text, never the wrapper. */
export function lineText(line: unknown): string | null {
  if (!line) return null;
  if (typeof line === 'string') return line.trim() ? line : null;
  const text = (line as any).text;
  return typeof text === 'string' && text.trim() ? text : null;
}

// ---------------------------------------------------------------------------
// The lock.
// ---------------------------------------------------------------------------

/**
 * One short transaction, holding the introduction's own lock for its length.
 * COMMIT on a clean return, ROLLBACK on a throw. Everything that asks, takes
 * off or confirms a line runs in here, and so does accepting an offer.
 */
export async function withIntroductionLocked<T>(
  matchId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('osb-intro-lines:' || $1, 0))`,
      [matchId],
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Every line on an introduction that still stands, in the order asked. */
export async function standingLines(
  matchId: string,
  db: Queryable = getPool(),
): Promise<ConfirmLineRow[]> {
  const r = await db.query(
    `SELECT id, match_id, asked_by, line, state, created_at, answered_at
       FROM confirm_lines
      WHERE match_id = $1 AND state <> 'withdrawn'
      ORDER BY created_at ASC, id ASC`,
    [matchId],
  );
  return r.rows as ConfirmLineRow[];
}

/** The ones that hold an acceptance up: asked and waiting to be confirmed. */
export const unconfirmed = (lines: ConfirmLineRow[]): ConfirmLineRow[] =>
  lines.filter((l) => l.state === 'asked');

/** The confirmed words, in the order asked, for the record. */
export const confirmedWords = (lines: ConfirmLineRow[]): string[] =>
  lines
    .filter((l) => l.state === 'confirmed')
    .map((l) => lineText(l.line))
    .filter((t): t is string => !!t);

async function acceptedAlready(matchId: string, db: Queryable): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM offers WHERE match_id = $1 AND state = 'accepted-by-human' LIMIT 1`,
    [matchId],
  );
  return !!r.rows.length;
}

// ---------------------------------------------------------------------------
// Asking, and taking one off. The buying side's assistant, and nobody else.
// ---------------------------------------------------------------------------

/** The introduction, with every refusal an ask or a take-off shares. */
async function buyingSideOf(accountId: string, matchId: string): Promise<MatchRow> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  const side = sideOf(m, accountId); // not a party: not found
  // No buyer and no seller where no money changes hands (domain/swaps.ts).
  if (noMoneySentence(m)) throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_NO_DEAL_HERE });
  if (side !== 'want') throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_BUYING_SIDE_ONLY });
  return m;
}

export interface AgentLine {
  confirmation_id: string;
  state: Exclude<LineState, 'withdrawn'>;
  /** The words, in the one shape the protocol carries free text in. */
  line: { text: string; provenance: 'counterparty-untrusted' } | null;
  at: string;
}

const agentLine = (l: ConfirmLineRow): AgentLine => {
  const text = lineText(l.line);
  return {
    confirmation_id: l.id,
    state: l.state as AgentLine['state'],
    line: text ? { text, provenance: 'counterparty-untrusted' } : null,
    at: new Date(l.created_at).toISOString(),
  };
};

/**
 * Ask the seller's human to confirm one line in writing.
 *
 * The order is proposeOffer's: who is asking and whether they may, the words
 * held to the note rule, the figure rule, the early answers about room and an
 * accepted deal, and only then the intake pipe, so a line that was never
 * going to be asked cannot spend a model call. The write itself is inside the
 * introduction's lock, where the two answers that matter are read again.
 */
export async function askLine(cfg: Config, accountId: string, matchId: string, raw: unknown) {
  const m = await buyingSideOf(accountId, matchId);
  if (m.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_NOT_OPEN });
  if (m.stage < 2) {
    // The floor under an offer, and so under a line on one (offers.ts).
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'This opens once the details on this one are open.',
    });
  }
  const checked = validateConfirmLine(raw);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { validation: ['line'] });
  // A DISTANCE OR A COUNT WRITTEN WITH A COMMA IS NOT A SUM OF MONEY. The
  // figure check was written for the note beside an offer, where any large
  // number is a second price, and it reads "20,000" as one. A line is a claim
  // about a thing, and "has done under 20,000 km" is exactly the kind worth
  // having in writing. So the separators come out before the check: a bare
  // number then passes, and anything marked as money (a currency sign, the
  // word for one) is still refused.
  if (carriesMoneyFigure(checked.value.replace(/(\d),(?=\d{3}(?!\d))/g, '$1'))) {
    throw new OsbError('CONSENT_REQUIRED', { human_action: LINE_HAS_FIGURE });
  }
  const max = maxLinesFor(cfg);
  if (await acceptedAlready(m.id, getPool())) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_AFTER_ACCEPT });
  }
  if ((await standingLines(m.id)).length >= max) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_FULL });
  }
  // THE OFFER_WORDS DOOR. A line is the same thing an offer note is: one
  // stranger's free words on their way to another, between the same two
  // people. So it is read on the same terms, and refused in the same words.
  const intake = await runIntake(cfg, {
    door: 'offer_words',
    sender_account: accountId,
    recipient_account: m.account_have,
    match_id: m.id,
    text: checked.value,
  });
  if (intake.outcome === 'refuse') {
    if (intake.reason_code === 'SUSPENDED') {
      throw new OsbError('SUSPENDED', { human_action: intake.plain_words });
    }
    const { refusalWords } = await import('./channel.js');
    throw new OsbError('CONSENT_REQUIRED', {
      human_action: await refusalWords(accountId, intake.reason_code, intake.plain_words),
    });
  }
  const stored = JSON.stringify({ text: checked.value, provenance: 'counterparty-untrusted' });
  const row = await withIntroductionLocked(m.id, async (client) => {
    // A line asked after the accept cannot undo a deal, and under the lock
    // there is no "at the same moment": either the accept is already here, or
    // it will find this line when it looks.
    if (await acceptedAlready(m.id, client)) {
      throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_AFTER_ACCEPT });
    }
    const r = await client.query(
      `INSERT INTO confirm_lines (match_id, asked_by, line)
       SELECT $1, $2, $3::jsonb
        WHERE (SELECT count(*) FROM confirm_lines
                WHERE match_id = $1 AND state <> 'withdrawn') < $4::int
          AND (SELECT count(*) FROM confirm_lines WHERE match_id = $1) < $5::int
       RETURNING id, match_id, asked_by, line, state, created_at, answered_at`,
      [m.id, accountId, stored, max, max * EVER_ASKED_MULTIPLE],
    );
    return r.rows[0] as ConfirmLineRow | undefined;
  });
  if (!row) throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_FULL });
  // The seller's human is told it is their move, where email is how they
  // hear. The occasion is the oldest line still unanswered, so however many
  // lines are asked while that one waits, it is one notice.
  const oldest = (await standingLines(m.id).catch(() => [])).find((l) => l.state === 'asked');
  await notifyWrittenMove(cfg, m.id, m.account_have, `asked:${(oldest ?? row).id}`);
  // Something moved on this introduction, so its slot's clock starts again,
  // as it does for a figure and a message (domain/sequencer.ts).
  try {
    const { noteMovement } = await import('./sequencer.js');
    await noteMovement(m.id);
  } catch {
    // The line is asked; the clock is a courtesy.
  }
  return { intro_id: m.id, ...agentLine(row) };
}

/**
 * Take one off. Only the side that asked it, on any line of theirs that still
 * stands, confirmed or still waiting: a buyer who would rather go ahead
 * without a line is the only person that costs anything.
 */
export async function withdrawLine(accountId: string, matchId: string, lineId: string) {
  const m = await buyingSideOf(accountId, matchId);
  return withIntroductionLocked(m.id, async (client) => {
    const found = await client.query(
      `SELECT id, match_id, asked_by, line, state, created_at, answered_at
         FROM confirm_lines WHERE id = $1 AND match_id = $2`,
      [lineId, m.id],
    );
    const row = found.rows[0] as ConfirmLineRow | undefined;
    if (!row || row.asked_by !== accountId) {
      throw Object.assign(new Error('no line of yours with that id on this introduction'), {
        notFound: true,
      });
    }
    if (row.state === 'withdrawn') {
      return { intro_id: m.id, confirmation_id: row.id, state: 'withdrawn' as const, already: true };
    }
    // The record that went out lists what stood at the accept. Nothing is
    // taken off a deal that is already agreed.
    if (await acceptedAlready(m.id, client)) {
      throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_AFTER_ACCEPT });
    }
    await client.query(
      `UPDATE confirm_lines SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
        WHERE id = $1 AND state <> 'withdrawn'`,
      [row.id],
    );
    return { intro_id: m.id, confirmation_id: row.id, state: 'withdrawn' as const, already: false };
  });
}

// ---------------------------------------------------------------------------
// Confirming. The seller's human, by a press on their own page, and nobody
// and nothing else. All or nothing: the press confirms every line the page
// listed, and there is no other answer to give.
// ---------------------------------------------------------------------------

/** Where a confirmation may be recorded from. The same one place an accept may. */
export const ANSWER_RECORDED_VIA = ['counter'] as const;
export type AnswerRecordedVia = (typeof ANSWER_RECORDED_VIA)[number];

/** What one press of the main button said about the lines on its page. */
export interface LinePress {
  /** The lines the page listed. A line asked after the page was drawn is not
   *  among them, and a press that did not list every waiting line is refused
   *  rather than confirming something nobody was shown. */
  shown: string[];
  on: AnsweredOn;
}

export interface PressOutcome {
  confirmed: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The lines a page listed, back out of the form it posted: one hidden field
 * naming them. Undefined where the page listed none.
 */
export function readLinePress(body: any, on: AnsweredOn): LinePress | undefined {
  const shown = String(body?.lines_shown ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));
  return shown.length ? { shown, on } : undefined;
}

/** Is every one of these waiting lines among the ones the page listed? */
export function pressCoversAll(waiting: { id: string }[], press: LinePress | undefined): boolean {
  const shown = new Set(press?.shown ?? []);
  return waiting.every((l) => shown.has(l.id));
}

/**
 * Apply one press of the main button, INSIDE the introduction's lock (the
 * caller holds it).
 *
 * Every waiting line becomes confirmed, provided the page listed every one of
 * them. Where a line is waiting that the page did not list, the press is
 * REFUSED and nothing is confirmed: nobody confirms words they were not
 * shown. The refusal is thrown, so the caller's transaction rolls back with
 * nothing in it.
 *
 * THE RECORD FIRST, as every consent-bearing act here is written: each
 * confirmation goes to the locked log before the row changes, naming the
 * introduction and the line and never the words.
 */
export async function applyLinePress(
  client: Queryable,
  m: MatchRow,
  humanAccountId: string,
  recordedVia: AnswerRecordedVia,
  press: LinePress | undefined,
): Promise<PressOutcome> {
  if (!(ANSWER_RECORDED_VIA as readonly string[]).includes(recordedVia)) {
    throw new Error(
      "confirm lines: a confirmation is only recorded from the human's own press (recorded_via must be 'counter')",
    );
  }
  const none: PressOutcome = { confirmed: [] };
  // Only the seller confirms. A press by the buying side confirms nothing,
  // whatever its form said.
  if (humanAccountId !== m.account_have) return none;
  const open = await client.query(
    `SELECT id, state FROM confirm_lines
      WHERE match_id = $1 AND state = 'asked'
      ORDER BY created_at ASC, id ASC`,
    [m.id],
  );
  const waiting = open.rows as { id: string; state: LineState }[];
  if (!waiting.length) return none;
  if (!pressCoversAll(waiting, press)) {
    throw Object.assign(new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_CHANGED_WORDS }), {
      linesChanged: true,
    });
  }
  const confirmed = waiting.map((r) => r.id);
  await Promise.all(
    confirmed.map((id) =>
      writeConsentEvent({
        event: 'line-confirmed-by-human',
        match_id: m.id,
        line_id: id,
        account_id: humanAccountId,
        recorded_via: recordedVia,
      }),
    ),
  );
  await client.query(
    `UPDATE confirm_lines
        SET state = 'confirmed', answered_at = now(), answered_by = $2, answered_via = $3,
            answered_on = $4, updated_at = now()
      WHERE match_id = $1 AND id = ANY($5::uuid[]) AND state = 'asked'`,
    [m.id, humanAccountId, recordedVia, press!.on, confirmed],
  );
  return { confirmed };
}

/**
 * The seller's press where no accept rides on it: the page of its own, and
 * the page that sends a figure. Takes the lock, confirms what the page
 * listed, and says what it did.
 */
export async function confirmLinesByHuman(
  matchId: string,
  humanAccountId: string,
  recordedVia: AnswerRecordedVia,
  press: LinePress | undefined,
): Promise<PressOutcome> {
  if (!(ANSWER_RECORDED_VIA as readonly string[]).includes(recordedVia)) {
    throw new Error(
      "confirm lines: a confirmation is only recorded from the human's own press (recorded_via must be 'counter')",
    );
  }
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, humanAccountId);
  if (humanAccountId !== m.account_have) return { confirmed: [] };
  return withIntroductionLocked(m.id, (client) =>
    applyLinePress(client, m, humanAccountId, recordedVia, press),
  );
}

// ---------------------------------------------------------------------------
// NOBODY WHO HEARS BY EMAIL IS LEFT WAITING IN SILENCE.
//
// A seller whose assistant only wakes when spoken to would never learn the
// buyer had asked them to confirm something. They are told the way a passive
// human is told it is their turn at the names step: the existing your-move
// notice (email/digestEngine.ts, notifyYourMove), through the ops queue, as
// recordStage3OptIn does it. Everything about that notice is unchanged and is
// what decides whether a mail goes at all: only an account that hears by
// email, never one that has turned match mail off, never a suppressed
// address, and one mail per dedupe key. It is the one fixed notice and it
// carries nothing of what was asked; nothing but ids crosses this function.
//
// Best-effort: a notice that cannot be enqueued changes nothing about the
// line.
// ---------------------------------------------------------------------------
async function notifyWrittenMove(
  cfg: Config | undefined,
  matchId: string,
  recipientAccount: string,
  occasion: string,
): Promise<void> {
  if (!cfg?.opsQueueUrl) return;
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.opsQueueUrl,
        MessageBody: JSON.stringify({
          op: 'your-move-notify',
          match_id: matchId,
          account_id: recipientAccount,
          step: 'written',
          occasion,
        }),
      }),
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`your-move-notify: enqueue failed (line unaffected): ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------
// What each side's assistant sees, wherever it sees the offers.
// ---------------------------------------------------------------------------

export interface LinesForAgent {
  confirmations: AgentLine[];
  note: { text: string; provenance: 'switchboard-system' };
  /** A short sentence for the sweep's lead, where something needs this human. */
  lead?: string;
}

/** Which sentence goes with the lines, from the reading side. Pure. */
export function linesNoteFor(
  side: 'want' | 'have',
  lines: Pick<ConfirmLineRow, 'state'>[],
): { text: string; lead?: string } {
  const waiting = lines.some((l) => l.state === 'asked');
  if (side === 'have') {
    return waiting
      ? { text: LINES_NOTE_SELLER_WAITING, lead: LINES_LEAD_SELLER }
      : { text: LINES_NOTE_SELLER_CONFIRMED };
  }
  return { text: waiting ? LINES_NOTE_BUYER_WAITING : LINES_NOTE_BUYER_CONFIRMED };
}

/**
 * The lines on one introduction, for the assistant of either person on it, or
 * nothing where none stands. The words wear the other side's label exactly as
 * an offer note does, and the sentence beside them is the switchboard's own.
 */
export async function linesForAgent(
  accountId: string,
  m: Pick<MatchRow, 'id' | 'account_want' | 'account_have'>,
): Promise<LinesForAgent | undefined> {
  const lines = await standingLines(m.id);
  if (!lines.length) return undefined;
  const side = sideOf(m as MatchRow, accountId);
  const said = linesNoteFor(side, lines);
  return {
    confirmations: lines.map(agentLine),
    note: { text: said.text, provenance: 'switchboard-system' },
    ...(said.lead ? { lead: said.lead } : {}),
  };
}

// ---------------------------------------------------------------------------
// THE POINTER ON THE MESSAGE PATH (rehearsal, after Stage B went live).
//
// Twice a buyer's human said, up front, that the thing had to be a certain
// way, and twice their assistant put that in a message to the other side and
// never asked it as a line. Every sentence about lines had said to ask one
// when the human was relying on something "the other side has said", and
// nothing stood where the assistant was at that moment: sending a message.
//
// So the answer to opening a conversation and to sending a message carries
// one sentence, for the one assistant it is true and useful for:
//
//   - on the BUYING side (only that side asks a line);
//   - on an introduction where money can change hands (no swap, no no-money
//     shelf: there is no offer to accept there and no record);
//   - while the introduction is open and no figure on it has been accepted
//     (after that nothing can be added to the deal);
//   - and only until a line has been asked on it, in any state, so an
//     assistant that already knows the road is not told again every message.
//
// Two small reads, best-effort: a read that fails says nothing.
//
// AND AGAIN WHEN A FIGURE ARRIVES (dev, the run after). The sentence was read
// as "later": an assistant sent its message, told its human it could have the
// seller confirm things "once we get to a firm deal", a figure was typed and
// accepted, and no line was ever asked. A figure can be accepted the moment
// it is on the table, and nothing can be added after that. So the sentence
// now says to ask in the same turn, and a second one, worded for the moment,
// rides the answers on the offer path under exactly the same conditions: where
// the buying assistant puts a figure forward or fetches the page for one, and
// where the other side's figure is on the table (mcp/tools.ts and the sweep
// in domain/matches.ts say which answers). It is a note beside an answer and
// nothing else: it never holds a figure up.
// ---------------------------------------------------------------------------
export const RECORD_POINTER =
  'What is said in this conversation is off the record of a deal. Anything your human says has to be true for them to go ahead belongs on respond(ask_confirmation): ask it now, in this same turn, as well as saying it here. Do not wait for a figure, and do not ask your human for a go-ahead to ask.';

export const FIGURE_POINTER =
  'A figure can be accepted the moment it is on the table, and nothing can be added once it is. If your human has said anything has to be true for them to go ahead, ask it with respond(ask_confirmation) now, in this same turn, without asking them first.';

/** Which moment the assistant is at: saying something, or a figure moving. */
export type PointerMoment = 'conversation' | 'figure';

/** The same pointer for an offer, found by the introduction it sits on. */
export async function recordPointerForOffer(
  accountId: string,
  offerId: string | undefined,
): Promise<string | undefined> {
  try {
    if (!offerId) return undefined;
    const r = await getPool().query('SELECT match_id FROM offers WHERE id = $1', [offerId]);
    return recordPointerFor(accountId, r.rows[0]?.match_id, 'figure');
  } catch {
    return undefined;
  }
}

export async function recordPointerFor(
  accountId: string,
  matchId: string | undefined,
  moment: PointerMoment = 'conversation',
): Promise<string | undefined> {
  try {
    if (!matchId) return undefined;
    const m = await getMatch(matchId);
    if (!m || m.account_want !== accountId) return undefined;
    if (m.state !== 'open' || noMoneySentence(m)) return undefined;
    const pool = getPool();
    const asked = await pool.query('SELECT 1 FROM confirm_lines WHERE match_id = $1 LIMIT 1', [m.id]);
    if (asked.rows.length) return undefined;
    if (await acceptedAlready(m.id, pool)) return undefined;
    return moment === 'figure' ? FIGURE_POINTER : RECORD_POINTER;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// What each person's page shows.
// ---------------------------------------------------------------------------

export interface PageLine {
  id: string;
  words: string;
  state: Exclude<LineState, 'withdrawn'>;
}

/** The standing lines with their words, for a page. Erased words drop out. */
export async function linesForPage(matchId: string): Promise<PageLine[]> {
  return (await standingLines(matchId))
    .map((l) => ({ id: l.id, words: lineText(l.line) ?? '', state: l.state as PageLine['state'] }))
    .filter((l) => l.words);
}

/** The introductions on which something is waiting for this seller to confirm. */
export async function linesWaitingFor(
  accountId: string,
): Promise<{ match_id: string; category: string; count: number; asked_at: Date }[]> {
  const r = await getPool().query(
    `SELECT l.match_id, m.category, count(*)::int AS count, min(l.created_at) AS asked_at
       FROM confirm_lines l
       JOIN matches m ON m.id = l.match_id
      WHERE m.account_have = $1 AND l.state = 'asked' AND m.state = 'open' AND m.live
      GROUP BY l.match_id, m.category
      ORDER BY min(l.created_at) DESC
      LIMIT 20`,
    [accountId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Account deletion (domain/accountDeletion.ts), matched to what it does to
// offers: the rows are kept with the introduction, the ones this account
// asked that are still waiting are taken off, and the words this account
// wrote are erased unless the introduction is under a safety hold.
// ---------------------------------------------------------------------------
export const ACCOUNT_DELETION_WITHDRAW_SQL = `UPDATE confirm_lines
    SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
  WHERE asked_by = $1 AND state = 'asked'`;

export const ACCOUNT_DELETION_ERASE_SQL = `UPDATE confirm_lines SET line = NULL
  WHERE asked_by = $1 AND line IS NOT NULL
    AND NOT (match_id = ANY($2::uuid[]))`;
