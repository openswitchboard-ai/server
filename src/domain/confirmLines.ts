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
 *   CONFIRMING  is the SELLER'S HUMAN PRESS and nothing else. The lines sit
 *               on the page the seller already uses to send a figure or take
 *               one, each a box to tick, and on a page of their own. One
 *               press covers the lot: ticked is confirmed, unticked is
 *               declined. No assistant, no agent key and no queue message can
 *               answer one; answerLinesByHuman refuses anything that is not a
 *               press on the human's own page, and the database says the same
 *               (migration 066).
 *   THE RULE    An offer is accepted only with every asked line confirmed
 *               (domain/offers.ts, acceptOfferByHuman). Sending a figure is
 *               never held up. A line that was taken off holds nothing up.
 *   THE RECORD  lists the confirmed lines and no others.
 *
 * ONE LOCK PER INTRODUCTION. Asking, taking off, answering and accepting all
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
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, noMoneySentence, sideOf, type MatchRow } from './matches.js';
import { looksLikeContactDetail } from './arrangement.js';
import { carriesMoneyFigure } from './moneyInWords.js';
import { runIntake } from '../intake/pipe.js';
import { OsbError } from '../protocol.js';
import type { Config } from '../config.js';

export type LineState = 'asked' | 'confirmed' | 'declined' | 'withdrawn';

/** Which page a line was answered on. */
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
  'That is asked. The seller’s human answers it on their own page, with their own press, and their assistant cannot answer it for them. Your next check_in says whether it was confirmed. Only a confirmed line goes on the record of a deal.';

export const LINE_WITHDRAWN_SENTENCE =
  'That line is off. It no longer holds anything up, and it will not be on the record of a deal.';

export const LINE_ALREADY_WITHDRAWN_SENTENCE = 'That line was already off.';

/** What the seller's assistant is told while something is waiting on its human. */
export const LINES_NOTE_SELLER_WAITING =
  'The buyer has asked your human to confirm some things in writing, and they are on your human’s own page. Tell your human so in a sentence and hand them the page: respond(request_confirm), or the page for a figure, which lists them too. You cannot confirm any of them yourself, and nothing can be accepted while one is unanswered.';

export const LINES_NOTE_SELLER_ANSWERED =
  'Your human has answered what the buyer asked them to confirm in writing. Only the confirmed lines go on the record of a deal. You cannot change an answer yourself; your human can, on their own page.';

export const LINES_NOTE_BUYER_DECLINED =
  'The seller’s human did not confirm everything you asked: each line here says which. Tell your human which was not confirmed, and ask whether they want to go ahead without it. Only on their yes, take it off with respond(withdraw_confirmation). Nothing can be accepted while it stands, and only confirmed lines go on the record.';

export const LINES_NOTE_BUYER_WAITING =
  'The seller’s human has not yet answered everything you asked them to confirm in writing: each line here says which. Nothing can be accepted until they have. Only confirmed lines go on the record of a deal, and nothing said in conversation does.';

export const LINES_NOTE_BUYER_CONFIRMED =
  'The seller’s human has confirmed in writing everything you asked. Those lines go on the record of the deal; nothing said in conversation does.';

/** The short half that rides on the sweep's lead sentence. */
export const LINES_LEAD_SELLER =
  'The buyer has also asked you to confirm some things in writing, on your own page.';
export const LINES_LEAD_BUYER =
  'Something you asked the seller to confirm in writing was not confirmed.';

// What a person reads.

/** The buyer, at their own accept page and at the press. */
export const BUYER_BLOCKED_WORDS =
  'The seller has not confirmed everything you asked for in writing, so nothing is agreed yet. If you want to go ahead without it, tell your assistant to take it off, then open this again.';

/** The seller, after pressing Accept with something still unconfirmed. */
export const SELLER_NOT_AGREED_TITLE = 'Nothing is agreed';
export const SELLER_NOT_AGREED_WORDS =
  'Something the buyer asked you to confirm is still unconfirmed, so nothing is agreed. Your answers are saved, and the buyer is told. To answer again, ask your assistant for a fresh page.';

/** What an assistant holding the line on that press says once it has landed. */
export const PRESS_NOT_AGREED_SENTENCE =
  'Your press landed, and nothing is agreed: something that was asked to be confirmed in writing is still unconfirmed. Say the word if you want the page again.';

/** On the seller's pages, above the boxes. */
export const SELLER_LINES_HEADING = 'The buyer asked you to confirm';
export const SELLER_LINES_ON_ACCEPT =
  'Tick each one that is true. What you tick goes on the record of the deal as confirmed by you. Leave one unticked and nothing is agreed.';
export const SELLER_LINES_ON_SEND =
  'Tick each one that is true. What you tick goes on the record of any deal as confirmed by you. One you leave unticked is saved as unconfirmed, and the buyer is told.';
export const SELLER_LINES_ALONE = SELLER_LINES_ON_SEND;
/** The label on each box: whose words they are. */
export const SELLER_LINE_LABEL = 'The buyer’s words:';
export const SELLER_LINE_DONE_LABEL = 'You have confirmed:';

/** On the buyer's accept page. */
export const BUYER_LINES_HEADING = 'The seller has confirmed in writing';
export const BUYER_LINES_INTRO =
  'You asked for these, and the seller confirmed each one. They go on the record of the deal.';
export const BUYER_LINE_LABEL = 'Your words:';

/** The seller's page of its own. */
export const CONFIRM_PAGE_YES = 'Confirm what is ticked';
export const CONFIRM_DONE_TITLE = 'Saved';
export const CONFIRM_DONE_WORDS =
  'Your answers are saved, and the buyer is told. Only what you confirmed goes on the record of a deal.';
export const CONFIRM_NOTHING_WAITING = 'There is nothing waiting to be confirmed on this one.';
/** Beside "Sent" when a figure went out from a page that also had boxes. */
export const SEND_DONE_LINES_SAVED = 'Your answers on what the buyer asked are saved too.';

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
 * off or answers a line runs in here, and so does accepting an offer.
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

/** The ones that hold an acceptance up: unanswered, or answered no. */
export const unconfirmed = (lines: ConfirmLineRow[]): ConfirmLineRow[] =>
  lines.filter((l) => l.state === 'asked' || l.state === 'declined');

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
 * stands, whatever the answer to it was: a buyer who would rather go ahead
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
// Answering. The seller's human, by a press on their own page, and nobody
// and nothing else.
// ---------------------------------------------------------------------------

/** Where an answer may be recorded from. The same one place an accept may. */
export const ANSWER_RECORDED_VIA = ['counter'] as const;
export type AnswerRecordedVia = (typeof ANSWER_RECORDED_VIA)[number];

/** What one press said about the boxes on the page it was pressed on. */
export interface LinePress {
  /** The lines the page showed a box for. A line asked after the page was
   *  drawn is in neither list, and stays unanswered. */
  shown: string[];
  /** The ones that were ticked. */
  ticked: string[];
  on: AnsweredOn;
}

export interface PressOutcome {
  confirmed: string[];
  declined: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The boxes back out of a posted form. The page prints one hidden field
 * naming every line it showed and one checkbox per line, each with a name of
 * its own, because this service reads a form body as one value per name.
 */
export function readLinePress(body: any, on: AnsweredOn): LinePress | undefined {
  const shown = String(body?.lines_shown ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));
  if (!shown.length) return undefined;
  return { shown, ticked: shown.filter((id) => String(body?.[`line_${id}`] ?? '') === 'yes'), on };
}

/**
 * Apply one press, INSIDE the introduction's lock (the caller holds it).
 *
 * Ticked becomes confirmed, whether it was unanswered or answered no before:
 * a seller may change a no to a yes. Shown and left unticked becomes
 * declined, where it was unanswered. A confirmed line is never touched: the
 * buyer may already be relying on it.
 *
 * THE RECORD FIRST, as every consent-bearing act here is written: each answer
 * goes to the locked log before the row changes, naming the introduction and
 * the line and never the words.
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
      "confirm lines: an answer is only recorded from the human's own press (recorded_via must be 'counter')",
    );
  }
  const none: PressOutcome = { confirmed: [], declined: [] };
  // Only the seller answers. A press by the buying side carries no answers,
  // whatever its form said.
  if (!press || humanAccountId !== m.account_have) return none;
  const open = await client.query(
    `SELECT id, state FROM confirm_lines
      WHERE match_id = $1 AND state IN ('asked', 'declined')
      ORDER BY created_at ASC, id ASC`,
    [m.id],
  );
  const shown = new Set(press.shown);
  const ticked = new Set(press.ticked);
  const rows = open.rows as { id: string; state: LineState }[];
  const confirmed = rows.filter((r) => ticked.has(r.id)).map((r) => r.id);
  const declined = rows
    .filter((r) => r.state === 'asked' && shown.has(r.id) && !ticked.has(r.id))
    .map((r) => r.id);
  if (!confirmed.length && !declined.length) return none;
  await Promise.all([
    ...confirmed.map((id) =>
      writeConsentEvent({
        event: 'line-confirmed-by-human',
        match_id: m.id,
        line_id: id,
        account_id: humanAccountId,
        recorded_via: recordedVia,
      }),
    ),
    ...declined.map((id) =>
      writeConsentEvent({
        event: 'line-declined-by-human',
        match_id: m.id,
        line_id: id,
        account_id: humanAccountId,
        recorded_via: recordedVia,
      }),
    ),
  ]);
  const answer = (state: 'confirmed' | 'declined', ids: string[], from: string) =>
    ids.length
      ? client.query(
          `UPDATE confirm_lines
              SET state = $2, answered_at = now(), answered_by = $3, answered_via = $4,
                  answered_on = $5, updated_at = now()
            WHERE match_id = $1 AND id = ANY($6::uuid[]) AND state IN (${from})`,
          [m.id, state, humanAccountId, recordedVia, press.on, ids],
        )
      : Promise.resolve(undefined);
  await answer('confirmed', confirmed, `'asked', 'declined'`);
  await answer('declined', declined, `'asked'`);
  return { confirmed, declined };
}

/**
 * The seller's press where no accept rides on it: the page of its own, and
 * the page that sends a figure. Takes the lock, applies the press, and says
 * what it did.
 */
export async function answerLinesByHuman(
  matchId: string,
  humanAccountId: string,
  recordedVia: AnswerRecordedVia,
  press: LinePress | undefined,
): Promise<PressOutcome> {
  if (!(ANSWER_RECORDED_VIA as readonly string[]).includes(recordedVia)) {
    throw new Error(
      "confirm lines: an answer is only recorded from the human's own press (recorded_via must be 'counter')",
    );
  }
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, humanAccountId);
  if (!press || humanAccountId !== m.account_have) return { confirmed: [], declined: [] };
  return withIntroductionLocked(m.id, (client) =>
    applyLinePress(client, m, humanAccountId, recordedVia, press),
  );
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
  const declined = lines.some((l) => l.state === 'declined');
  if (side === 'have') {
    return waiting
      ? { text: LINES_NOTE_SELLER_WAITING, lead: LINES_LEAD_SELLER }
      : { text: LINES_NOTE_SELLER_ANSWERED };
  }
  if (declined) return { text: LINES_NOTE_BUYER_DECLINED, lead: LINES_LEAD_BUYER };
  if (waiting) return { text: LINES_NOTE_BUYER_WAITING };
  return { text: LINES_NOTE_BUYER_CONFIRMED };
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

/** The introductions on which something is waiting for this seller to answer. */
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
// asked that nobody has answered are taken off, and the words this account
// wrote are erased unless the introduction is under a safety hold.
// ---------------------------------------------------------------------------
export const ACCOUNT_DELETION_WITHDRAW_SQL = `UPDATE confirm_lines
    SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
  WHERE asked_by = $1 AND state = 'asked'`;

export const ACCOUNT_DELETION_ERASE_SQL = `UPDATE confirm_lines SET line = NULL
  WHERE asked_by = $1 AND line IS NOT NULL
    AND NOT (match_id = ANY($2::uuid[]))`;
