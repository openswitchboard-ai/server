/**
 * TRADES BETWEEN TWO LISTS: THINGS FOR THINGS (14 November 2026; migration 075;
 * the trades design, phase P2).
 *
 * Two people whose lists meet both ways are one pairing (domain/pairings.ts).
 * One of them puts a trade to the other: some of their own things and some of
 * the other person's, each with how many. Nothing binds until both humans
 * have pressed:
 *
 *   DRAFT    propose_trade. The proposer's assistant names what goes each way,
 *            and the switchboard checks every rule below and holds the trade
 *            as a draft ('awaiting-send'). The answer is always a page: the
 *            assistant drafts, the human sends.
 *   SEND     the proposer's own press on that page (consent event
 *            'trade-sent-by-human', with the fingerprint of the terms). Under
 *            the pairing's lock every rule is checked again, and the trade
 *            goes open, superseding any trade already open between the two of
 *            them in the same locked transaction. A counter is simply a trade
 *            sent the other way.
 *   ACCEPT   the other human's own press on their page (consent event
 *            'trade-accepted-by-human'), the PIN or passkey ceremony exactly
 *            as accepting a figure takes. Under the pairing's lock the trade,
 *            the pairing, every thing in it (still up, enough left) and every
 *            written line between the two are read again; then the things come
 *            off both lists, those with none left come down, everything that
 *            can no longer be met closes with a sentence, and both people are
 *            sent the same record.
 *
 * THE RULES (tradeRefusal, pure):
 *   - your side is only your own things, up on a list that allows a trade;
 *   - their side is only their things that met one of your wants in this
 *     pairing, on a list pair that allows a trade (maybes included);
 *   - one to ten things each side, each no more than is left of it;
 *   - no shotgunning: your open trades together never give more of a thing
 *     than you hold;
 *   - three trades from each side per pairing per rolling day, ten open from
 *     any one account, and each counts against the hour a figure does;
 *   - a trade stands seven days at most.
 *
 * NO MONEY IN THIS VERSION (founder, 14 November 2026). The columns are there
 * and a check keeps them empty.
 *
 * THE SWITCHBOARD NEVER VALUES A TRADE. Nothing here reads a price, ranks a
 * trade, calls one fair or says what anything is worth. Nothing here knows
 * what kind of goods anything is.
 */
import type pg from 'pg';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import type { Config } from '../config.js';
import { writeConsentEvent } from '../crypto.js';
import { validateOfferNote } from './negotiation.js';
import { carriesMoneyFigure } from './moneyInWords.js';
import { runIntake } from '../intake/pipe.js';
import { screenedContentOf } from './screenedContent.js';
import { leftOf, takeDownNoneLeft, takeUnits } from './quantities.js';
import { dealsAllow, seenBy, type PairingRow } from './pairings.js';
import { KIND_MAX_CHARS, categoryPhrase } from './matchRules.js';
import { promptSafe } from '../intake/promptText.js';
import {
  LINES_BLOCKED_PAIRING_WORDS,
  applyLinePress,
  confirmLinesByHuman,
  lineText,
  standingLines,
  unconfirmed,
  waitingOn,
  waitingOnOther,
  withIntroductionLocked,
  type ConfirmLineRow,
  type LinePress,
} from './confirmLines.js';
import {
  namesIfBothPressed,
  tradeReceiptFrom,
  tradeTermsFrom,
  type Receipt,
  type TradeItemFact,
  type TradeRole,
} from './receipt.js';

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const sb = (text: string) => ({ text, provenance: 'switchboard-system' as const });

// ---------------------------------------------------------------------------
// THE NUMBERS.
// ---------------------------------------------------------------------------

/** How long a trade stands, at most and by default (days). */
export const TRADE_DAYS = 7;
/** Things on each side of one trade. */
export const TRADE_ITEMS_MIN = 1;
export const TRADE_ITEMS_MAX = 10;
/** Trades one side may put on one pairing in a rolling day, drafts included. */
export const TRADES_PER_SIDE_PER_PAIRING_PER_DAY = 3;
/** Trades one account may have open and waiting on answers at once. */
export const OPEN_TRADES_OUTGOING_MAX = 10;

export type TradeState =
  | 'awaiting-send'
  | 'open'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'superseded'
  | 'expired'
  | 'closed';

/** Where a trade's press may be recorded from: the human's own page, and nowhere else. */
export const TRADE_RECORDED_VIA = ['counter'] as const;
export type TradeRecordedVia = (typeof TRADE_RECORDED_VIA)[number];

// ---------------------------------------------------------------------------
// THE SENTENCES. Every one an assistant or a person reads is here, so the
// suite can hold each to the copy lint.
// ---------------------------------------------------------------------------

export const TRADE_ITEMS_WORDS =
  'A trade has from one to ten things on each side, each named by its item_id with how many of it. Send it again in that shape.';

export const TRADE_NOT_PAIRING_WORDS =
  'That is not one of the people your human’s lists meet. Read the list of them with read_pairings and use the pairing_id it gives.';

export const TRADE_PAIRING_ENDED_WORDS = 'This one has ended, so no trade can be put or taken on it.';

export const TRADE_NOT_POSSIBLE_WORDS =
  'The lists between these two do not both allow a trade, so there is no trade to put here. A sale of one thing goes as a figure on that thing.';

export const GIVE_NOT_YOURS_WORDS =
  'Your human’s side of a trade is only their own things, up on a list that allows a trade. Take their item ids from this pairing or from read_lists, and send the trade again.';

export const GET_NOT_MATCHED_WORDS =
  'Their side of a trade is only their things that met one of your human’s wants on this pairing, as the pairing lists them. Read it again, and send the trade again.';

export const NOT_ENOUGH_LEFT_TO_ASK_WORDS =
  'A trade asks for no more of a thing than is left of it. Read the pairing again for how many of each are left, and send the trade again.';

export const ALREADY_PROMISED_WORDS =
  'Some of that is already in another trade your human has sent, still open, and together they would give more than your human has. Put fewer in this one, or take the other back on your human’s word first.';

export const TRADES_PER_DAY_WORDS =
  'That is three trades from your human on this pairing inside a day, which is as many as one day takes. A fourth can go once a day has passed since the first of them.';

export const OPEN_TRADES_FULL_WORDS =
  'Your human has ten trades out and waiting on answers. One of them has to be answered, run out or be taken back before another goes.';

export const FIGURE_IN_TRADE_NOTE_WORDS =
  'This one has not gone. There is no money in a trade here, so the note with it carries no sum of money. Send it again with the figure taken out of the note.';

export const TRADE_EXPIRY_WORDS =
  'A trade stands for up to seven days, from now. Give it a date inside that, or leave the expiry out for the full seven days.';

export const TRADE_EXPIRED_WORDS =
  'That trade has run out, so there is nothing left to accept or send. Either of them can put another.';

export const TRADE_NO_LONGER_OPEN_WORDS = 'That trade is no longer open, so there is nothing to answer on it.';

export const TRADE_OWN_SIDE_WORDS =
  'That trade is your own side’s. Only the other person can accept it or turn it down.';

export const TRADE_NOT_THEIRS_TO_WITHDRAW_WORDS =
  'Only the side that put a trade can take it back. Your human can turn it down instead.';

export const TRADE_SENT_ALREADY_WORDS = 'That trade has already been sent, so there is nothing more to press on this page.';

export const NOT_YOUR_TRADE = 'There is no trade of your human’s with that id.';

/** Answers. */
export const TRADE_DECLINED_SENTENCE =
  'That trade is turned down, and no reason went with it. Nothing came off either list, and either of you can put another.';

export const TRADE_WITHDRAWN_SENTENCE =
  'That trade is taken back. Nothing came off either list, and your human can put another whenever they like.';

/** On the pairing entry, said to the human. Replaces the "in conversation for now" sentence of P1. */
export const TRADE_HOW_SENTENCE =
  'You can put a trade to them: tell me which of your things and which of theirs, with how many of each, and you send it from your own page. Nothing is agreed until they accept it on theirs, and then what goes comes off both lists.';

export const TRADE_FROM_THEM_SENTENCE =
  'They have put a trade to you, and what goes each way is beside this. It is yours to weigh up. Nothing is agreed until you accept it on your own page, and then what goes comes off both lists.';

export const TRADE_FROM_YOU_SENTENCE =
  'Your trade is with them. Nothing is agreed until they accept it on their own page.';

export const TRADE_DRAFT_SENTENCE = 'A trade is drafted and waiting for your own press to send it.';

/** What the assistant does next, by where the trade stands. Never said aloud. */
export const TRADE_WHAT_TO_DO_THEIRS =
  'To accept, fetch your human’s page with answer_trade(request_accept) on this trade_id, hand it over and wait on the press. To turn it down, answer_trade(decline), only on your human’s word. To answer with a different trade, put it with propose_trade: once your human sends it, it replaces this one. Never say whether a trade is fair or what anything is worth. Say none of the ids aloud.';

export const TRADE_WHAT_TO_DO_YOURS =
  'Only the other side can accept it. To take it back, answer_trade(withdraw), only on your human’s word. Say none of the ids aloud.';

export const TRADE_WHAT_TO_DO_DRAFT =
  'To fetch the page again, send the same trade with propose_trade. To drop it, answer_trade(withdraw). Say none of the ids aloud.';

export const TRADE_WHAT_TO_DO_NONE =
  'A trade goes on propose_trade with this entry’s pairing_id: give is your human’s own things (their item_id here, or from read_lists), get is their things on this entry, each with how many your human said. It answers with a page your human presses to send it. Written lines for a trade go on respond(ask_confirmation) with this entry’s intro_id, either way round. Say none of the ids aloud.';

/** The last trade between them, when it has ended lately. */
export const LAST_TRADE_ACCEPTED_SENTENCE =
  'The trade between you is agreed, and what went came off both lists. You both have the record by email. Each of you sends your own things, and postage is for the two of you to arrange in the conversation.';
export const LAST_TRADE_DECLINED_TO_PROPOSER =
  'They turned down the trade you put to them. Nothing came off either list, and either of you can put another.';
export const LAST_TRADE_DECLINED_TO_RECIPIENT = 'You turned down their trade. Nothing came off either list.';
export const LAST_TRADE_WITHDRAWN_TO_RECIPIENT =
  'They took back the trade they had put to you. Nothing came off either list.';
export const LAST_TRADE_WITHDRAWN_TO_PROPOSER = 'You took back your trade. Nothing came off either list.';
export const LAST_TRADE_EXPIRED_SENTENCE =
  'The last trade between you ran out before it was accepted. Nothing came off either list.';
export const LAST_TRADE_CLOSED_SENTENCE =
  'The last trade between you could no longer be met as it stood, because something in it went in another deal or came off its list, so it has closed. Nothing came off either list for it.';

/** On the pages. */
export const TRADE_LINES_HEADING = 'The other side asked you to confirm';
export const TRADE_YOU_CONFIRMED_HEADING = 'You have confirmed in writing';
export const TRADE_THEY_CONFIRMED_HEADING = 'They have confirmed in writing';
export const TRADE_YOU_GIVE_HEADING = 'You give';
export const TRADE_YOU_GET_HEADING = 'You get';
export const TRADE_COMES_OFF_HEADING = 'These come off your list';
export const TRADE_COMES_OFF_IF_HEADING = 'If they accept, these come off your list';
export const TRADE_POSTAGE_LINE =
  'Each of you sends your own things, and postage is for the two of you to arrange.';
export const TRADE_SEND_AGREED_LINE =
  'Nothing is agreed until they accept it, and that takes their own press.';
export const TRADE_ACCEPT_ELSEWHERE_LINE = 'To answer with a different trade or say no, tell your assistant.';
export const TRADE_SENT_DONE_WORDS =
  'Your trade is with them. Nothing is agreed until they accept it on their own page.';
export const TRADE_ACCEPTED_DONE_WORDS =
  'The trade is agreed. What goes has come off both lists, and you have both been sent the record by email. Your assistant takes it from here.';

// ---------------------------------------------------------------------------
// THE SHAPE OF A CALL. Pure.
// ---------------------------------------------------------------------------

export interface TradeLine {
  item_id: string;
  quantity: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const shapeError = () => Object.assign(new Error(TRADE_ITEMS_WORDS), { validation: ['give', 'get'] });

/**
 * One side of a trade as the call sent it: one to ten things, each an id and
 * a whole number of at least one (one where none was given). The same thing
 * twice on one side is refused rather than added up, so the call says exactly
 * what the human said. Throws a validation error in words. Pure.
 */
export function readTradeLines(raw: unknown): TradeLine[] {
  if (!Array.isArray(raw) || raw.length < TRADE_ITEMS_MIN || raw.length > TRADE_ITEMS_MAX) throw shapeError();
  const seen = new Set<string>();
  const out: TradeLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw shapeError();
    const id = String((entry as any).item_id ?? '').toLowerCase();
    if (!UUID.test(id)) throw shapeError();
    const q = (entry as any).quantity === undefined ? 1 : (entry as any).quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) throw shapeError();
    if (seen.has(id)) throw shapeError();
    seen.add(id);
    out.push({ item_id: id, quantity: q });
  }
  return out;
}

/**
 * When a new trade stops standing: the date given, which must be ahead of now
 * and inside seven days, or seven days from now where none was given. Pure.
 */
export function tradeExpiry(raw: unknown, now: number = Date.now()): Date {
  if (raw === undefined || raw === null || raw === '') return new Date(now + TRADE_DAYS * 86_400_000);
  const at = new Date(String(raw));
  if (Number.isNaN(at.getTime()) || at.getTime() <= now || at.getTime() > now + TRADE_DAYS * 86_400_000) {
    throw Object.assign(new Error(TRADE_EXPIRY_WORDS), { validation: ['expiry'] });
  }
  return at;
}

// ---------------------------------------------------------------------------
// THE RULES. Pure: every fact is read first, so the same check runs at the
// draft, at the send and at the accept, each time on a fresh read.
// ---------------------------------------------------------------------------

/** One thing as the rules read it. */
export interface ItemFact {
  id: string;
  account_id: string;
  type: 'WANT' | 'HAVE' | string;
  lifecycle_state: string;
  list_id: string | null;
  list_deal: string | null;
  list_state?: string | null;
  attributes?: unknown;
  quantity_gone?: number | null;
}

export interface TradeCheckFacts {
  proposer: string;
  recipient: string;
  give: TradeLine[];
  get: TradeLine[];
  items: Map<string, ItemFact>;
  /** The recipient's things that met one of the proposer's wants in this
   *  pairing, on a pair of lists that allows a trade. */
  askable: Set<string>;
  /** Units of the proposer's things already given in their other open trades. */
  committed: Map<string, number>;
}

const TRADES_ON = new Set(['trade', 'sale_or_trade']);

/** Is this one of this person's things, up on a list that allows a trade? Pure. */
export function tradeableBy(item: ItemFact | undefined, accountId: string): boolean {
  return (
    !!item &&
    item.account_id === accountId &&
    item.type === 'HAVE' &&
    item.lifecycle_state === 'PUBLISHED' &&
    !!item.list_id &&
    TRADES_ON.has(String(item.list_deal ?? '')) &&
    (item.list_state === undefined || item.list_state === null || item.list_state === 'open')
  );
}

/**
 * The first rule this trade breaks, in the words to say, or undefined where
 * it keeps them all. Pure.
 */
export function tradeRefusal(f: TradeCheckFacts): string | undefined {
  if (
    f.give.length < TRADE_ITEMS_MIN ||
    f.give.length > TRADE_ITEMS_MAX ||
    f.get.length < TRADE_ITEMS_MIN ||
    f.get.length > TRADE_ITEMS_MAX
  ) {
    return TRADE_ITEMS_WORDS;
  }
  // Your side: only your own things, up on a list that allows a trade.
  for (const g of f.give) {
    if (!tradeableBy(f.items.get(g.item_id), f.proposer)) return GIVE_NOT_YOURS_WORDS;
  }
  // Their side: only theirs that met one of your wants here.
  for (const g of f.get) {
    if (!f.askable.has(g.item_id) || !tradeableBy(f.items.get(g.item_id), f.recipient)) return GET_NOT_MATCHED_WORDS;
  }
  // No more of anything than is left.
  for (const g of [...f.give, ...f.get]) {
    if (g.quantity > leftOf(f.items.get(g.item_id)!)) return NOT_ENOUGH_LEFT_TO_ASK_WORDS;
  }
  // No shotgunning: your open trades together give no more than you hold.
  for (const g of f.give) {
    const already = f.committed.get(g.item_id) ?? 0;
    if (already + g.quantity > leftOf(f.items.get(g.item_id)!)) return ALREADY_PROMISED_WORDS;
  }
  return undefined;
}

/** The caps, as counts read beforehand. Pure. */
export function tradeCapRefusal(c: { thisPairingToday: number; openOutgoing: number }): string | undefined {
  if (c.thisPairingToday >= TRADES_PER_SIDE_PER_PAIRING_PER_DAY) return TRADES_PER_DAY_WORDS;
  if (c.openOutgoing >= OPEN_TRADES_OUTGOING_MAX) return OPEN_TRADES_FULL_WORDS;
  return undefined;
}

/** One trade's things, as a fixed string for the link it is sent from. Pure. */
export function tradeItemsKey(items: { card_id: string; giver_account: string; quantity: number }[]): string {
  return items
    .map((i) => `${String(i.card_id).toLowerCase()}:${String(i.giver_account).toLowerCase()}:${Number(i.quantity)}`)
    .sort()
    .join(',');
}

/** Has this trade's own clock run out? Pure. */
export function tradeHasExpired(p: { expiry: Date | string }, now: number = Date.now()): boolean {
  const at = new Date(p.expiry).getTime();
  return !Number.isNaN(at) && at <= now;
}

// ---------------------------------------------------------------------------
// READING THE FACTS.
// ---------------------------------------------------------------------------

export const ITEM_FACTS_SQL = `SELECT c.id, c.account_id, c.type, c.lifecycle_state, c.list_id, c.attributes, c.quantity_gone,
            c.kind, c.category, c.screened_content, l.deal AS list_deal, l.state AS list_state
       FROM cards c LEFT JOIN lists l ON l.id = c.list_id
      WHERE c.id = ANY($1::uuid[])`;

async function itemFacts(db: Queryable, ids: string[], lock = false): Promise<Map<string, any>> {
  if (!ids.length) return new Map();
  const r = await db.query(lock ? `${ITEM_FACTS_SQL} FOR UPDATE OF c` : ITEM_FACTS_SQL, [ids]);
  return new Map((r.rows as any[]).map((row) => [String(row.id), row]));
}

/**
 * The open members of a pairing on which the proposer is the one wanting:
 * each one's intro id and the other person's thing, kept only where the two
 * lists allow a trade.
 */
export const ASKABLE_SQL = `SELECT m.id, m.card_have, lw.deal AS want_deal, lh.deal AS have_deal
       FROM matches m
       JOIN cards w ON w.id = m.card_want
       JOIN cards h ON h.id = m.card_have
       JOIN lists lw ON lw.id = w.list_id
       JOIN lists lh ON lh.id = h.list_id
      WHERE m.pairing_id = $1 AND m.account_want = $2 AND m.state = 'open' AND m.item_set_aside_at IS NULL`;

async function askableFor(
  db: Queryable,
  pairingId: string,
  proposer: string,
): Promise<{ cards: Set<string>; byIntro: Map<string, string> }> {
  const r = await db.query(ASKABLE_SQL, [pairingId, proposer]);
  const cards = new Set<string>();
  const byIntro = new Map<string, string>();
  for (const row of r.rows as any[]) {
    if (!dealsAllow(row.have_deal, row.want_deal).trade) continue;
    cards.add(String(row.card_have));
    byIntro.set(String(row.id), String(row.card_have));
  }
  return { cards, byIntro };
}

/** The proposer's own things the other wants here, by intro id, so an intro id works as an item id. */
async function ownByIntro(db: Queryable, pairingId: string, proposer: string): Promise<Map<string, string>> {
  const r = await db.query(
    `SELECT id, card_have FROM matches WHERE pairing_id = $1 AND account_have = $2 AND state = 'open'`,
    [pairingId, proposer],
  );
  return new Map((r.rows as any[]).map((row) => [String(row.id), String(row.card_have)]));
}

/** Units of these things the proposer already gives in their open trades, leaving some out. */
export const COMMITTED_SQL = `SELECT i.card_id, sum(i.quantity)::int AS units
       FROM trade_proposal_items i
       JOIN trade_proposals p ON p.id = i.proposal_id
      WHERE p.proposer_account = $1 AND i.giver_account = $1
        AND p.state = 'open' AND p.expiry > now()
        AND i.card_id = ANY($2::uuid[])
        AND NOT (p.id = ANY($3::uuid[]))
      GROUP BY i.card_id`;

async function committedBy(
  db: Queryable,
  proposer: string,
  cardIds: string[],
  leaveOut: string[],
): Promise<Map<string, number>> {
  if (!cardIds.length) return new Map();
  const r = await db.query(COMMITTED_SQL, [proposer, cardIds, leaveOut]);
  return new Map((r.rows as any[]).map((row) => [String(row.card_id), Number(row.units ?? 0)]));
}

function asFacts(rows: Map<string, any>): Map<string, ItemFact> {
  return new Map(
    [...rows].map(([id, row]) => [
      id,
      {
        id,
        account_id: String(row.account_id),
        type: row.type,
        lifecycle_state: row.lifecycle_state,
        list_id: row.list_id ?? null,
        list_deal: row.list_deal ?? null,
        list_state: row.list_state ?? null,
        attributes: row.attributes,
        quantity_gone: Number(row.quantity_gone ?? 0),
      },
    ]),
  );
}

async function readPairingRow(db: Queryable, pairingId: string, lock = false): Promise<PairingRow | undefined> {
  const r = await db.query(`SELECT * FROM pairings WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [pairingId]);
  return r.rows[0] as PairingRow | undefined;
}

const otherOf = (p: Pick<PairingRow, 'account_lo' | 'account_hi'>, accountId: string) =>
  p.account_lo === accountId ? p.account_hi : p.account_lo;

// ---------------------------------------------------------------------------
// THE WORDS FOR A THING. The giver's own screened words, never an identifier.
// ---------------------------------------------------------------------------

const RESERVED = new Set(['quantity', 'free', 'trade']);

function detailsOf(attrs: unknown): Record<string, unknown> {
  const a = attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(a).filter(([k]) => !RESERVED.has(k)));
}

/** A thing in its owner's own screened words, else its shelf. */
function wordsOf(row: any): string {
  const s = screenedContentOf(row);
  const kind = typeof s?.kind === 'string' && s.kind.trim() ? s.kind.trim() : '';
  return kind || (typeof row?.kind === 'string' && row.kind.trim() ? row.kind.trim() : '') || categoryPhrase(row?.category);
}

async function detailsSentence(row: any): Promise<string | undefined> {
  const { attributesSentence } = await import('../counter/pagesHome.js');
  const s = screenedContentOf(row);
  return attributesSentence(detailsOf(s?.attributes ?? row?.attributes));
}

// ---------------------------------------------------------------------------
// DRAFTING: propose_trade.
// ---------------------------------------------------------------------------

export interface TradeLinkAnswer {
  trade_id: string;
  say: string;
  link: string;
  press_id: string;
  expires_in_minutes: number;
  what_it_does: string;
}

interface ProposalRow {
  id: string;
  pairing_id: string;
  proposer_account: string;
  recipient_account: string;
  state: TradeState;
  note: any;
  expiry: Date | string;
  sent_at?: Date | string | null;
  accepted_at?: Date | string | null;
  terms_sha256?: string | null;
  receipt_sha256?: string | null;
  closed_because?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProposalItemRow {
  card_id: string;
  giver_account: string;
  quantity: number;
}

async function proposalItems(db: Queryable, proposalId: string): Promise<ProposalItemRow[]> {
  const r = await db.query(
    `SELECT card_id, giver_account, quantity FROM trade_proposal_items WHERE proposal_id = $1 ORDER BY created_at, card_id`,
    [proposalId],
  );
  return (r.rows as any[]).map((x) => ({
    card_id: String(x.card_id),
    giver_account: String(x.giver_account),
    quantity: Number(x.quantity),
  }));
}

async function loadProposal(db: Queryable, id: string, lock = false): Promise<ProposalRow | undefined> {
  const r = await db.query(`SELECT * FROM trade_proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] as ProposalRow | undefined;
}

/** Map an id the call gave to the thing it names: a thing's own id, or the intro id it sits on in this pairing. */
function resolveIds(lines: TradeLine[], byIntro: Map<string, string>): TradeLine[] {
  return lines.map((l) => ({ ...l, item_id: byIntro.get(l.item_id) ?? l.item_id }));
}

/** The note as stored: the proposer's own words, labelled as theirs. */
function noteText(note: any): string | undefined {
  const t = typeof note === 'string' ? note : note?.text;
  return typeof t === 'string' && t.trim() ? t : undefined;
}

/**
 * Draft a trade for the proposer's human to send. Every rule is checked here
 * so a page is never handed out for a trade that could not go, and checked
 * again at the press. Answers with the page, always.
 */
export async function proposeTrade(
  cfg: Config,
  accountId: string,
  input: { pairing_id?: unknown; give?: unknown; get?: unknown; note?: unknown; expiry?: unknown },
): Promise<TradeLinkAnswer> {
  const pairingId = String(input.pairing_id ?? '');
  if (!UUID.test(pairingId)) throw Object.assign(new Error(TRADE_NOT_PAIRING_WORDS), { notFound: true });
  const give = readTradeLines(input.give);
  const get = readTradeLines(input.get);
  const db = getPool();
  const p = await readPairingRow(db, pairingId);
  if (!p || (p.account_lo !== accountId && p.account_hi !== accountId)) {
    throw Object.assign(new Error(TRADE_NOT_PAIRING_WORDS), { notFound: true });
  }
  if (p.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
  if (!p.live) {
    const { readLaneFacts } = await import('./lanes.js');
    const { inLineSentence } = await import('./matches.js');
    const facts = await readLaneFacts(accountId);
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: inLineSentence(facts.arrangement, facts.hearsVia) });
  }
  if (!seenBy(p, accountId).tradeTo) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NOT_POSSIBLE_WORDS });
  const recipient = otherOf(p, accountId);
  const expiry = tradeExpiry(input.expiry);
  const note = validateOfferNote(input.note);
  if (!note.ok) throw Object.assign(new Error(note.error), { validation: ['note'] });
  if (note.value && carriesMoneyFigure(note.value)) {
    throw new OsbError('CONSENT_REQUIRED', { human_action: FIGURE_IN_TRADE_NOTE_WORDS });
  }
  const askable = await askableFor(db, p.id, accountId);
  const own = await ownByIntro(db, p.id, accountId);
  const giveIds = resolveIds(give, own);
  const getIds = resolveIds(get, askable.byIntro);
  const rows = await itemFacts(db, [...giveIds, ...getIds].map((l) => l.item_id));
  // This person's own trade open on this same pairing is replaced the moment
  // this one is sent, so what it gives is not counted against this one.
  const ownOpen = await db.query(
    `SELECT id FROM trade_proposals WHERE pairing_id = $1 AND proposer_account = $2 AND state = 'open'`,
    [p.id, accountId],
  );
  const refusal = tradeRefusal({
    proposer: accountId,
    recipient,
    give: giveIds,
    get: getIds,
    items: asFacts(rows),
    askable: askable.cards,
    committed: await committedBy(
      db,
      accountId,
      giveIds.map((g) => g.item_id),
      (ownOpen.rows as any[]).map((r) => String(r.id)),
    ),
  });
  if (refusal) throw new OsbError('NOT_UNLOCKED_YET', { human_action: refusal });
  const items = [
    ...giveIds.map((g) => ({ card_id: g.item_id, giver_account: accountId, quantity: g.quantity })),
    ...getIds.map((g) => ({ card_id: g.item_id, giver_account: recipient, quantity: g.quantity })),
  ];
  // THE SAME TRADE AGAIN, while its draft still stands: no new row, and so no
  // cost against the day; a fresh page for the draft already there.
  const same = await sameDraft(db, p.id, accountId, items, note.value);
  if (same) return { trade_id: same, ...(await tradeSendLinkFor(cfg, accountId, same)) };
  // The caps, early and in words. The day's cap rides the insert as well.
  const counts = await db.query(
    `SELECT (SELECT count(*) FROM trade_proposals
              WHERE pairing_id = $1 AND proposer_account = $2 AND created_at > now() - interval '24 hours')::int AS today,
            (SELECT count(*) FROM trade_proposals
              WHERE proposer_account = $2 AND state = 'open' AND expiry > now())::int AS open_out`,
    [p.id, accountId],
  );
  const cap = tradeCapRefusal({
    thisPairingToday: Number(counts.rows[0]?.today ?? 0),
    openOutgoing: Number(counts.rows[0]?.open_out ?? 0) - ownOpen.rows.length,
  });
  if (cap) throw new OsbError('RATE_LIMITED_OFFERS', { retry_after: 3600, human_action: cap });
  // A trade counts against the hour a figure does (domain/quotas.ts).
  const { checkOfferRate } = await import('./quotas.js');
  await checkOfferRate(accountId, cfg.quotas);
  // THE OFFER_WORDS DOOR, as a note beside a figure and a written line pass
  // it: the anchor is the introduction it is between.
  if (note.value) {
    const intake = await runIntake(cfg, {
      door: 'offer_words',
      sender_account: accountId,
      recipient_account: recipient,
      match_id: String(p.anchor_match_id),
      text: note.value,
    });
    if (intake.outcome === 'refuse') {
      if (intake.reason_code === 'SUSPENDED') throw new OsbError('SUSPENDED', { human_action: intake.plain_words });
      const { refusalWords } = await import('./channel.js');
      throw new OsbError('CONSENT_REQUIRED', {
        human_action: await refusalWords(accountId, intake.reason_code, intake.plain_words),
      });
    }
  }
  const tradeId = await insertDraft(p.id, accountId, recipient, items, note.value, expiry);
  if (!tradeId) throw new OsbError('RATE_LIMITED_OFFERS', { retry_after: 3600, human_action: TRADES_PER_DAY_WORDS });
  return { trade_id: tradeId, ...(await tradeSendLinkFor(cfg, accountId, tradeId)) };
}

async function sameDraft(
  db: Queryable,
  pairingId: string,
  accountId: string,
  items: ProposalItemRow[],
  note: string | undefined,
): Promise<string | undefined> {
  const r = await db.query(
    `SELECT id, note FROM trade_proposals
      WHERE pairing_id = $1 AND proposer_account = $2 AND state = 'awaiting-send' AND expiry > now()
      ORDER BY created_at DESC LIMIT 5`,
    [pairingId, accountId],
  );
  const want = tradeItemsKey(items);
  for (const row of r.rows as any[]) {
    if ((noteText(row.note) ?? '') !== (note ?? '')) continue;
    if (tradeItemsKey(await proposalItems(db, String(row.id))) === want) return String(row.id);
  }
  return undefined;
}

/** The draft and its things in one transaction, the day's cap in the insert. */
async function insertDraft(
  pairingId: string,
  proposer: string,
  recipient: string,
  items: ProposalItemRow[],
  note: string | undefined,
  expiry: Date,
): Promise<string | undefined> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO trade_proposals (pairing_id, proposer_account, recipient_account, note, expiry)
       SELECT $1, $2, $3, $4::jsonb, $5
        WHERE (SELECT count(*) FROM trade_proposals
                WHERE pairing_id = $1 AND proposer_account = $2
                  AND created_at > now() - interval '24 hours') < $6::int
       RETURNING id`,
      [
        pairingId,
        proposer,
        recipient,
        note ? JSON.stringify({ text: note, provenance: 'counterparty-untrusted' }) : null,
        expiry.toISOString(),
        TRADES_PER_SIDE_PER_PAIRING_PER_DAY,
      ],
    );
    const id = r.rows[0]?.id ? String(r.rows[0].id) : undefined;
    if (!id) {
      await client.query('ROLLBACK');
      return undefined;
    }
    for (const i of items) {
      await client.query(
        `INSERT INTO trade_proposal_items (proposal_id, card_id, giver_account, quantity) VALUES ($1, $2, $3, $4)`,
        [id, i.card_id, i.giver_account, i.quantity],
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function tradeSendLinkFor(cfg: Config, accountId: string, tradeId: string) {
  const { tradeSendLink } = await import('./humanLinks.js');
  return tradeSendLink(cfg, accountId, tradeId);
}

/** What a page or a link needs to say about one trade, for one reader. */
export async function tradeCounts(
  tradeId: string,
  readerId: string,
): Promise<{ mine: number; theirs: number; items: ProposalItemRow[] }> {
  const items = await proposalItems(getPool(), tradeId);
  const mine = items.filter((i) => i.giver_account === readerId).reduce((n, i) => n + i.quantity, 0);
  const theirs = items.filter((i) => i.giver_account !== readerId).reduce((n, i) => n + i.quantity, 0);
  return { mine, theirs, items };
}

// ---------------------------------------------------------------------------
// THE TERMS: what the proposer presses Send on, and the middle of the record.
// ---------------------------------------------------------------------------

async function itemFactsForRecord(
  rows: Map<string, any>,
  items: ProposalItemRow[],
  giver: string,
): Promise<TradeItemFact[]> {
  const out: TradeItemFact[] = [];
  for (const i of items.filter((x) => x.giver_account === giver)) {
    const row = rows.get(i.card_id);
    const details = row ? await detailsSentence(row) : undefined;
    out.push({ thing: row ? wordsOf(row) : 'a thing on their list', ...(details ? { details } : {}), quantity: i.quantity });
  }
  return out;
}

async function termsOf(
  db: Queryable,
  proposal: ProposalRow,
  items: ProposalItemRow[],
  rows?: Map<string, any>,
): Promise<{ receipt: Receipt; fromProposer: TradeItemFact[]; fromAccepter: TradeItemFact[]; note?: string }> {
  const r = rows ?? (await itemFacts(db, items.map((i) => i.card_id)));
  const fromProposer = await itemFactsForRecord(r, items, proposal.proposer_account);
  const fromAccepter = await itemFactsForRecord(r, items, proposal.recipient_account);
  const note = noteText(proposal.note);
  return { receipt: tradeTermsFrom({ fromProposer, fromAccepter, ...(note ? { note } : {}) }), fromProposer, fromAccepter, note };
}

// ---------------------------------------------------------------------------
// SENDING: the proposer's own press.
// ---------------------------------------------------------------------------

/**
 * SENDING SUPERSEDES WHAT IS OPEN, in two statements inside the one locked
 * transaction: the open trade between the two of them is moved aside first,
 * then this one opens. Nothing else can open or move a trade on the pairing
 * while its row lock is held, so the one-open index never sees two, and a
 * failure in the second rolls the first back with it.
 */
export const SUPERSEDE_SQL = `UPDATE trade_proposals
          SET state = CASE WHEN expiry <= now() THEN 'expired' ELSE 'superseded' END, updated_at = now()
        WHERE pairing_id = $2 AND state = 'open' AND id <> $1
        RETURNING id`;

export const OPEN_SQL = `UPDATE trade_proposals
        SET state = 'open', sent_at = now(), sent_via = $2, terms_sha256 = $3, supersedes = $4, updated_at = now()
      WHERE id = $1 AND state = 'awaiting-send'
      RETURNING id, supersedes`;

export function isTradeRecordedVia(v: unknown): v is TradeRecordedVia {
  return typeof v === 'string' && (TRADE_RECORDED_VIA as readonly string[]).includes(v);
}

/**
 * The proposer's Send. Reached only from their own press on their own page.
 * Under the anchor's lines lock and the pairing's row lock, everything is
 * read again; the trade goes open and the open one is superseded in one
 * statement. The lines the page listed are confirmed by the same press after
 * it, as on the page that sends a figure: sending is never held up by a line.
 */
export async function sendTradeByHuman(
  tradeId: string,
  humanAccountId: string,
  recordedVia: TradeRecordedVia,
  cfg?: Config,
  opts: { lines?: LinePress } = {},
): Promise<{ sent: true; superseded?: string; linesConfirmed: boolean | undefined }> {
  if (!isTradeRecordedVia(recordedVia)) {
    throw new Error("sendTradeByHuman: a trade is only sent from the human's own press (recorded_via must be 'counter')");
  }
  const first = await loadProposal(getPool(), tradeId);
  if (!first || first.proposer_account !== humanAccountId) {
    throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  }
  const p0 = await readPairingRow(getPool(), first.pairing_id);
  if (!p0?.anchor_match_id) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
  const anchorId = String(p0.anchor_match_id);
  const out = await withIntroductionLocked(anchorId, async (client) => {
    const p = await readPairingRow(client, first.pairing_id, true);
    if (!p || p.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
    // One account's sends one at a time, so two trades sent at once on two
    // pairings cannot both count the same units as free.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('osb-trade-send:' || $1, 0))`, [humanAccountId]);
    const t = await loadProposal(client, tradeId, true);
    if (!t) throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
    if (t.state !== 'awaiting-send') {
      throw new OsbError('NOT_UNLOCKED_YET', {
        human_action: t.state === 'open' || t.state === 'accepted' ? TRADE_SENT_ALREADY_WORDS : TRADE_NO_LONGER_OPEN_WORDS,
      });
    }
    if (tradeHasExpired(t)) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_EXPIRED_WORDS });
    const items = await proposalItems(client, t.id);
    const open = await client.query(
      `SELECT id, proposer_account FROM trade_proposals WHERE pairing_id = $1 AND state = 'open' FOR UPDATE`,
      [p.id],
    );
    const ownOpen = (open.rows as any[]).filter((r) => r.proposer_account === humanAccountId).map((r) => String(r.id));
    const askable = await askableFor(client, p.id, humanAccountId);
    const rows = await itemFacts(client, items.map((i) => i.card_id));
    const give = items.filter((i) => i.giver_account === humanAccountId).map((i) => ({ item_id: i.card_id, quantity: i.quantity }));
    const get = items.filter((i) => i.giver_account !== humanAccountId).map((i) => ({ item_id: i.card_id, quantity: i.quantity }));
    const refusal = tradeRefusal({
      proposer: humanAccountId,
      recipient: t.recipient_account,
      give,
      get,
      items: asFacts(rows),
      askable: askable.cards,
      committed: await committedBy(client, humanAccountId, give.map((g) => g.item_id), ownOpen),
    });
    if (refusal) throw new OsbError('NOT_UNLOCKED_YET', { human_action: refusal });
    const outgoing = await client.query(
      `SELECT count(*)::int AS n FROM trade_proposals
        WHERE proposer_account = $1 AND state = 'open' AND expiry > now() AND NOT (id = ANY($2::uuid[]))`,
      [humanAccountId, ownOpen],
    );
    if (Number(outgoing.rows[0]?.n ?? 0) >= OPEN_TRADES_OUTGOING_MAX) {
      throw new OsbError('RATE_LIMITED_OFFERS', { retry_after: 3600, human_action: OPEN_TRADES_FULL_WORDS });
    }
    const terms = (await termsOf(client, t, items, rows)).receipt;
    // THE PRESS FIRST, in the locked log, with the fingerprint of what was sent.
    await writeConsentEvent({
      event: 'trade-sent-by-human',
      trade_id: t.id,
      pairing_id: p.id,
      match_id: anchorId,
      account_id: humanAccountId,
      recorded_via: recordedVia,
      terms_sha256: terms.sha256,
    });
    const old = await client.query(SUPERSEDE_SQL, [t.id, p.id]);
    const supersedes = old.rows[0]?.id ? String(old.rows[0].id) : null;
    const sent = await client.query(OPEN_SQL, [t.id, recordedVia, terms.sha256, supersedes]);
    if (!sent.rows[0]) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    return { superseded: sent.rows[0].supersedes ? String(sent.rows[0].supersedes) : undefined };
  });
  // The lines the page listed, confirmed by the same press, after the send.
  let linesConfirmed: boolean | undefined;
  if (opts.lines) {
    try {
      linesConfirmed = (await confirmLinesByHuman(anchorId, humanAccountId, 'counter', opts.lines)).confirmed.length > 0;
    } catch (e) {
      if (!(e instanceof OsbError)) throw e;
      linesConfirmed = false;
    }
  }
  const { noteMovement } = await import('./sequencer.js');
  await noteMovement(anchorId);
  await enqueueTradeNotice(cfg, tradeId, 'arrived');
  return { sent: true, ...(out.superseded ? { superseded: out.superseded } : {}), linesConfirmed };
}

// ---------------------------------------------------------------------------
// ACCEPTING: the other human's own press.
// ---------------------------------------------------------------------------

/** The confirmed lines between the two, each saying which way it went. Pure. */
export function confirmedForTrade(
  proposer: string,
  lines: Pick<ConfirmLineRow, 'state' | 'asked_by' | 'line'>[],
): { text: string; askedBy: TradeRole }[] {
  const out: { text: string; askedBy: TradeRole }[] = [];
  for (const l of lines) {
    if (l.state !== 'confirmed') continue;
    const text = lineText(l.line);
    if (text) out.push({ text, askedBy: l.asked_by === proposer ? 'proposer' : 'accepter' });
  }
  return out;
}

/**
 * The other human's Accept. Reached only from their own press on their own
 * page, after the ceremony. Holds the anchor's lines lock and the pairing's
 * row lock (the lock endPairing takes), reads everything again, then commits:
 * the units come off both sides, and the record's fingerprint goes on the
 * trade and into the locked log beside the press. After the commit, things
 * with none left come down with the reason 'traded', and every trade and
 * figure that can no longer be met closes with a sentence.
 */
export async function acceptTradeByHuman(
  tradeId: string,
  humanAccountId: string,
  recordedVia: TradeRecordedVia,
  cfg?: Config,
  opts: { lines?: LinePress } = {},
): Promise<{ accepted: true; receipt: Receipt; left: Record<string, number> }> {
  if (!isTradeRecordedVia(recordedVia)) {
    throw new Error("acceptTradeByHuman: a trade is only accepted from the human's own press (recorded_via must be 'counter')");
  }
  const first = await loadProposal(getPool(), tradeId);
  if (!first || (first.recipient_account !== humanAccountId && first.proposer_account !== humanAccountId)) {
    throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  }
  if (first.proposer_account === humanAccountId) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_OWN_SIDE_WORDS });
  }
  const p0 = await readPairingRow(getPool(), first.pairing_id);
  if (!p0?.anchor_match_id) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
  const anchorId = String(p0.anchor_match_id);
  const outcome = await withIntroductionLocked(anchorId, async (client) => {
    const p = await readPairingRow(client, first.pairing_id, true);
    if (!p || p.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
    const t = await loadProposal(client, tradeId, true);
    if (!t || t.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    if (tradeHasExpired(t)) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_EXPIRED_WORDS });
    if (t.recipient_account !== humanAccountId) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_OWN_SIDE_WORDS });
    const items = await proposalItems(client, t.id);
    // Every thing, read again with its row locked: still up, still the
    // giver's, still on a list that trades, enough left.
    const rows = await itemFacts(client, items.map((i) => i.card_id), true);
    const askable = await askableFor(client, p.id, t.proposer_account);
    const give = items.filter((i) => i.giver_account === t.proposer_account).map((i) => ({ item_id: i.card_id, quantity: i.quantity }));
    const get = items.filter((i) => i.giver_account !== t.proposer_account).map((i) => ({ item_id: i.card_id, quantity: i.quantity }));
    const refusal = tradeRefusal({
      proposer: t.proposer_account,
      recipient: t.recipient_account,
      give,
      get,
      items: asFacts(rows),
      askable: askable.cards,
      committed: new Map(),
    });
    if (refusal) {
      throw new OsbError('NOT_UNLOCKED_YET', {
        human_action: refusal === NOT_ENOUGH_LEFT_TO_ASK_WORDS ? 'Something in this trade has fewer left than it asks for now, so it can no longer be taken as it stands.' : 'Something in this trade has come off its list or out of this pairing, so it can no longer be taken as it stands.',
      });
    }
    // THE LINES. The accepter's press confirms what its page listed that
    // waits on them; every line between the two must then be confirmed.
    const anchor = (await client.query('SELECT * FROM matches WHERE id = $1 FOR SHARE', [anchorId])).rows[0];
    await applyLinePress(client, anchor, humanAccountId, recordedVia, opts.lines);
    const lines = await standingLines(anchorId, client);
    if (unconfirmed(lines).length) {
      throw Object.assign(new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_BLOCKED_PAIRING_WORDS }), {
        linesNotConfirmed: true,
      });
    }
    // THE RECORD, built before the press is written down.
    const terms = await termsOf(client, t, items, rows);
    const people = await namesIfBothPressed(anchor, t.proposer_account, t.recipient_account);
    const at = new Date();
    const receipt = tradeReceiptFrom({
      at,
      fromProposer: terms.fromProposer,
      fromAccepter: terms.fromAccepter,
      ...(terms.note ? { note: terms.note } : {}),
      confirmed: confirmedForTrade(t.proposer_account, lines),
      ...(people ? { people: { proposer: people[0], accepter: people[1] } } : {}),
    });
    await writeConsentEvent({
      event: 'trade-accepted-by-human',
      trade_id: t.id,
      pairing_id: p.id,
      match_id: anchorId,
      account_id: humanAccountId,
      recorded_via: recordedVia,
      terms_sha256: t.terms_sha256 ?? terms.receipt.sha256,
      receipt_sha256: receipt.sha256,
    });
    // THE UNITS COME OFF BOTH SIDES, each in one guarded statement.
    const left: Record<string, number> = {};
    for (const i of items) left[i.card_id] = await takeUnits(client, i.card_id, i.quantity);
    const done = await client.query(
      `UPDATE trade_proposals
          SET state = 'accepted', accepted_at = now(), accepted_by = $2, accepted_via = $3,
              receipt_sha256 = $4, updated_at = now()
        WHERE id = $1 AND state = 'open'
        RETURNING id`,
      [t.id, humanAccountId, recordedVia, receipt.sha256],
    );
    if (!done.rows[0]) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    return { receipt, left, accounts: [t.proposer_account, t.recipient_account] };
  });
  // None left: down, with the reason, said on the page before the press.
  for (const [cardId, n] of Object.entries(outcome.left)) {
    if (n === 0) await takeDownNoneLeft(cardId, anchorId, cfg, 'traded');
  }
  await closeUnmeetableTrades(Object.keys(outcome.left));
  const { noteMovement } = await import('./sequencer.js');
  await noteMovement(anchorId);
  if (cfg) await sendTradeReceiptToBoth(cfg, tradeId, outcome.accounts, outcome.receipt);
  await enqueueTradeNotice(cfg, tradeId, 'accepted');
  return { accepted: true, receipt: outcome.receipt, left: outcome.left };
}

/** The same record to both, through the receipt email path. Best-effort. */
async function sendTradeReceiptToBoth(cfg: Config, tradeId: string, accounts: string[], receipt: Receipt): Promise<void> {
  let sendReceiptEmail: typeof import('../counter/email.js').sendReceiptEmail;
  let accountEmail: typeof import('./counterOps.js').accountEmail;
  try {
    ({ sendReceiptEmail } = await import('../counter/email.js'));
    ({ accountEmail } = await import('./counterOps.js'));
  } catch (err) {
    console.warn('trade receipt email failed; the trade stands', err);
    return;
  }
  // One mail each, each on its own try, so an address that will not take mail
  // costs the other person nothing.
  for (const accountId of accounts) {
    try {
      const to = await accountEmail(accountId, 'receipt');
      if (!to) continue;
      await sendReceiptEmail(cfg, to, accountId, { offerId: tradeId, block: receipt.block, fingerprint: receipt.sha256 });
    } catch (err) {
      console.warn('trade receipt email failed; the trade stands', err);
    }
  }
}

// ---------------------------------------------------------------------------
// NOBODY WHO HEARS BY EMAIL IS LEFT WAITING IN SILENCE. A trade sent tells the
// person it was put to; one accepted or turned down tells the person who put
// it. The ordinary road: one job on the ops queue carrying ids only, and the
// digest engine sends the one fixed notice behind every gate
// (email/digestEngine.ts, notifyTrade). Best-effort: the trade stands either way.
// ---------------------------------------------------------------------------
export async function enqueueTradeNotice(
  cfg: Config | undefined,
  tradeId: string,
  moment: 'arrived' | 'accepted' | 'declined',
): Promise<void> {
  if (!cfg?.opsQueueUrl) return;
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.opsQueueUrl,
        MessageBody: JSON.stringify({ op: 'trade-notify', trade_id: tradeId, moment }),
      }),
    );
  } catch (e: any) {
    console.error(`trade-notify: enqueue failed (the trade stands): ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------
// ANSWERING: answer_trade.
// ---------------------------------------------------------------------------

export type TradeAnswer = 'request_accept' | 'decline' | 'withdraw';

export async function answerTrade(
  cfg: Config,
  accountId: string,
  tradeId: unknown,
  action: unknown,
): Promise<any> {
  const id = String(tradeId ?? '');
  if (!UUID.test(id)) throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  const t = await loadProposal(getPool(), id);
  if (!t || (t.proposer_account !== accountId && t.recipient_account !== accountId)) {
    throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  }
  if (action === 'request_accept') {
    const { tradeAcceptLink } = await import('./humanLinks.js');
    return { trade_id: t.id, ...(await tradeAcceptLink(cfg, accountId, t.id)) };
  }
  if (action === 'decline') {
    if (t.proposer_account === accountId) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_OWN_SIDE_WORDS });
    if (t.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    // Guarded: only a trade still open is turned down. No reason is carried.
    const r = await getPool().query(
      `UPDATE trade_proposals SET state = 'declined', updated_at = now() WHERE id = $1 AND state = 'open' RETURNING id`,
      [t.id],
    );
    if (!r.rows[0]) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    await movement(t.pairing_id);
    await enqueueTradeNotice(cfg, t.id, 'declined');
    return { trade_id: t.id, state: 'declined', note: sb(TRADE_DECLINED_SENTENCE) };
  }
  if (action === 'withdraw') {
    if (t.proposer_account !== accountId) {
      throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NOT_THEIRS_TO_WITHDRAW_WORDS });
    }
    if (t.state !== 'open' && t.state !== 'awaiting-send') {
      throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    }
    const r = await getPool().query(
      `UPDATE trade_proposals SET state = 'withdrawn', updated_at = now()
        WHERE id = $1 AND state IN ('open', 'awaiting-send') RETURNING id`,
      [t.id],
    );
    if (!r.rows[0]) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
    await movement(t.pairing_id);
    return { trade_id: t.id, state: 'withdrawn', note: sb(TRADE_WITHDRAWN_SENTENCE) };
  }
  throw Object.assign(new Error("answer_trade action is 'request_accept', 'decline' or 'withdraw'"), {
    validation: ['action'],
  });
}

async function movement(pairingId: string): Promise<void> {
  try {
    const r = await getPool().query(`SELECT anchor_match_id FROM pairings WHERE id = $1`, [pairingId]);
    const anchor = r.rows[0]?.anchor_match_id;
    if (!anchor) return;
    const { noteMovement } = await import('./sequencer.js');
    await noteMovement(String(anchor));
  } catch {
    // The answer stands; the clock is a courtesy.
  }
}

/**
 * Mint-time checks for the accept page: a page is never handed out for a
 * trade whose press would be refused. Returns the trade and its counts.
 */
export async function assertAcceptable(accountId: string, tradeId: string): Promise<{ t: ProposalRow; anchorId: string }> {
  const t = await loadProposal(getPool(), tradeId);
  if (!t || (t.proposer_account !== accountId && t.recipient_account !== accountId)) {
    throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  }
  if (t.proposer_account === accountId) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_OWN_SIDE_WORDS });
  if (t.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_NO_LONGER_OPEN_WORDS });
  if (tradeHasExpired(t)) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_EXPIRED_WORDS });
  const p = await readPairingRow(getPool(), t.pairing_id);
  if (!p || p.state !== 'open' || !p.anchor_match_id) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_PAIRING_ENDED_WORDS });
  }
  const anchorId = String(p.anchor_match_id);
  if (waitingOnOther(await standingLines(anchorId), accountId).length) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: LINES_BLOCKED_PAIRING_WORDS });
  }
  return { t, anchorId };
}

/** Mint-time checks for the send page. */
export async function assertSendable(accountId: string, tradeId: string): Promise<ProposalRow> {
  const t = await loadProposal(getPool(), tradeId);
  if (!t || t.proposer_account !== accountId) throw Object.assign(new Error(NOT_YOUR_TRADE), { notFound: true });
  if (t.state !== 'awaiting-send') {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: t.state === 'open' ? TRADE_SENT_ALREADY_WORDS : TRADE_NO_LONGER_OPEN_WORDS,
    });
  }
  if (tradeHasExpired(t)) throw new OsbError('NOT_UNLOCKED_YET', { human_action: TRADE_EXPIRED_WORDS });
  return t;
}

// ---------------------------------------------------------------------------
// WHAT CAN NO LONGER BE MET CLOSES.
// ---------------------------------------------------------------------------

/** What is left of a thing, in SQL, the way quantities.ts leftOf counts it. */
const LEFT_SQL = `((CASE WHEN jsonb_typeof(c.attributes->'quantity') = 'number'
                         THEN GREATEST((c.attributes->>'quantity')::numeric::int, 1) ELSE 1 END) - c.quantity_gone)`;

/**
 * Every open or drafted trade on these things that can no longer be met:
 * something in it has come down, or fewer are left than it asks for. One
 * statement; the reason is recorded, and each side's sweep says it. Best-effort,
 * because whatever called it has already happened.
 */
export const CLOSE_UNMEETABLE_SQL = `UPDATE trade_proposals p
    SET state = 'closed', updated_at = now(),
        closed_because = CASE WHEN EXISTS (
            SELECT 1 FROM trade_proposal_items i JOIN cards c ON c.id = i.card_id
             WHERE i.proposal_id = p.id AND c.lifecycle_state <> 'PUBLISHED') THEN 'taken_down' ELSE 'none_left' END
  WHERE p.state IN ('open', 'awaiting-send')
    AND EXISTS (SELECT 1 FROM trade_proposal_items i JOIN cards c ON c.id = i.card_id
                 WHERE i.proposal_id = p.id AND i.card_id = ANY($1::uuid[])
                   AND (c.lifecycle_state <> 'PUBLISHED' OR ${LEFT_SQL} < i.quantity))
  RETURNING p.id`;

export async function closeUnmeetableTrades(cardIds: string[], db: Queryable = getPool()): Promise<string[]> {
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (!ids.length) return [];
  try {
    const r = await db.query(CLOSE_UNMEETABLE_SQL, [ids]);
    return (r.rows as any[]).map((x) => String(x.id));
  } catch (e: any) {
    console.warn(`trades: closing what can no longer be met failed: ${e?.message ?? e}`);
    return [];
  }
}

/**
 * Trades on these pairings asking for a thing of the other person's that no
 * longer met one of the proposer's wants here (one of theirs was said not to
 * be the thing, or its introduction ended). Closed with the reason. Best-effort.
 */
export const CLOSE_UNASKABLE_SQL = `UPDATE trade_proposals p
    SET state = 'closed', closed_because = 'taken_down', updated_at = now()
  WHERE p.pairing_id = ANY($1::uuid[]) AND p.state IN ('open', 'awaiting-send')
    AND EXISTS (SELECT 1 FROM trade_proposal_items i
                 WHERE i.proposal_id = p.id AND i.giver_account = p.recipient_account
                   AND NOT EXISTS (SELECT 1 FROM matches m
                                    WHERE m.pairing_id = p.pairing_id AND m.state = 'open'
                                      AND m.item_set_aside_at IS NULL
                                      AND m.card_have = i.card_id AND m.account_want = p.proposer_account))
  RETURNING p.id`;

export async function closeUnaskableTrades(pairingIds: string[], db: Queryable = getPool()): Promise<string[]> {
  const ids = [...new Set(pairingIds.filter(Boolean))];
  if (!ids.length) return [];
  try {
    const r = await db.query(CLOSE_UNASKABLE_SQL, [ids]);
    return (r.rows as any[]).map((x) => String(x.id));
  } catch (e: any) {
    console.warn(`trades: closing trades whose things left the pairing failed: ${e?.message ?? e}`);
    return [];
  }
}

/** Ending a pairing closes every trade on it, in the ending's own transaction. */
export const CLOSE_ON_PAIRING_END_SQL = `UPDATE trade_proposals
    SET state = 'closed', closed_because = 'pairing_ended', updated_at = now()
  WHERE pairing_id = $1 AND state IN ('open', 'awaiting-send')`;

/** A trade whose time ran out while open reads as such. */
export const EXPIRE_SQL = `UPDATE trade_proposals SET state = 'expired', updated_at = now()
  WHERE pairing_id = $1 AND state = 'open' AND expiry <= now()`;

/** Account deletion: what this account put is taken back, what was put to it closes, and its notes come off. */
export const ACCOUNT_DELETION_TRADES_SQL = `UPDATE trade_proposals
    SET state = CASE WHEN proposer_account = $1 THEN 'withdrawn' ELSE 'closed' END,
        closed_because = CASE WHEN proposer_account = $1 THEN closed_because ELSE 'pairing_ended' END,
        updated_at = now()
  WHERE (proposer_account = $1 OR recipient_account = $1) AND state IN ('open', 'awaiting-send')`;

export const ACCOUNT_DELETION_TRADE_NOTES_SQL = `UPDATE trade_proposals SET note = NULL
  WHERE proposer_account = $1 AND note IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pairings pr WHERE pr.id = trade_proposals.pairing_id
                     AND pr.anchor_match_id = ANY($2::uuid[]))`;

// ---------------------------------------------------------------------------
// WHAT AN ASSISTANT IS SHOWN, on the pairing's entry and on read_pairings.
// ---------------------------------------------------------------------------

const theirWords = (kind: string) => ({
  text: promptSafe(kind, KIND_MAX_CHARS),
  provenance: 'counterparty-untrusted' as const,
});

/** How long an ended trade is still mentioned on the entry. */
export const LAST_TRADE_SHOWN_DAYS = 7;

/** The sentence for the last trade between two people, from one reader's side. Pure. */
export function lastTradeSentence(
  t: Pick<ProposalRow, 'state' | 'proposer_account'>,
  readerId: string,
): string | undefined {
  const mine = t.proposer_account === readerId;
  switch (t.state) {
    case 'accepted':
      return LAST_TRADE_ACCEPTED_SENTENCE;
    case 'declined':
      return mine ? LAST_TRADE_DECLINED_TO_PROPOSER : LAST_TRADE_DECLINED_TO_RECIPIENT;
    case 'withdrawn':
      return mine ? LAST_TRADE_WITHDRAWN_TO_PROPOSER : LAST_TRADE_WITHDRAWN_TO_RECIPIENT;
    case 'expired':
      return LAST_TRADE_EXPIRED_SENTENCE;
    case 'closed':
      return LAST_TRADE_CLOSED_SENTENCE;
    default:
      return undefined;
  }
}

/** One trade as one reader sees it: what they give, what they get. */
async function tradeBlock(t: ProposalRow, readerId: string): Promise<any> {
  const items = await proposalItems(getPool(), t.id);
  const rows = await itemFacts(getPool(), items.map((i) => i.card_id));
  const youGive: any[] = [];
  const youGet: any[] = [];
  for (const i of items) {
    const row = rows.get(i.card_id);
    if (i.giver_account === readerId) {
      youGive.push({
        item_id: i.card_id,
        your_item: row?.kind ?? null,
        quantity: i.quantity,
        ...(row ? { left_now: leftOf(row) } : {}),
      });
    } else {
      const details = detailsOf(screenedContentOf(row)?.attributes);
      youGet.push({
        item_id: i.card_id,
        their_words: row ? theirWords(wordsOf(row)) : null,
        ...(Object.keys(details).length ? { details } : {}),
        quantity: i.quantity,
      });
    }
  }
  const note = noteText(t.note);
  const mine = t.proposer_account === readerId;
  return {
    trade_id: t.id,
    from: mine ? 'you' : 'them',
    state: t.state === 'awaiting-send' ? 'awaiting_your_press' : t.state,
    you_give: youGive,
    you_get: youGet,
    ...(note ? { [mine ? 'your_note' : 'their_note']: { text: note, provenance: 'counterparty-untrusted' as const } } : {}),
    expires_at: new Date(t.expiry).toISOString(),
  };
}

/**
 * The trade part of a pairing's entry, for one reader: the open trade (or
 * this reader's draft), the sentence to lead with, and what to do; or, where
 * a trade both lists allow could be put, how. Read-only, bar marking a trade
 * whose time has run out.
 */
export async function tradeForEntry(
  p: Pick<PairingRow, 'id' | 'account_lo' | 'account_hi'>,
  readerId: string,
  tradePossible: boolean,
): Promise<{ lead?: string; fields: Record<string, unknown> }> {
  try {
    await getPool().query(EXPIRE_SQL, [p.id]);
    const r = await getPool().query(
      `SELECT * FROM trade_proposals
        WHERE pairing_id = $1
          AND (state = 'open' OR (state = 'awaiting-send' AND proposer_account = $2 AND expiry > now()))
        ORDER BY (state = 'open') DESC, created_at DESC LIMIT 1`,
      [p.id, readerId],
    );
    const t = r.rows[0] as ProposalRow | undefined;
    if (t) {
      const block = await tradeBlock(t, readerId);
      const theirs = t.state === 'open' && t.proposer_account !== readerId;
      const sentence =
        t.state === 'awaiting-send' ? TRADE_DRAFT_SENTENCE : theirs ? TRADE_FROM_THEM_SENTENCE : TRADE_FROM_YOU_SENTENCE;
      const whatToDo =
        t.state === 'awaiting-send' ? TRADE_WHAT_TO_DO_DRAFT : theirs ? TRADE_WHAT_TO_DO_THEIRS : TRADE_WHAT_TO_DO_YOURS;
      return {
        lead: sentence,
        fields: { trade: { ...block, note: sb(sentence), what_to_do: whatToDo }, trade_waiting_on_you: theirs },
      };
    }
    const last = await getPool().query(
      `SELECT * FROM trade_proposals
        WHERE pairing_id = $1 AND state NOT IN ('open', 'awaiting-send', 'superseded')
          AND NOT (state = 'withdrawn' AND sent_at IS NULL)
          AND updated_at > now() - make_interval(days => $2::int)
        ORDER BY updated_at DESC LIMIT 1`,
      [p.id, LAST_TRADE_SHOWN_DAYS],
    );
    const ended = last.rows[0] as ProposalRow | undefined;
    const said = ended ? lastTradeSentence(ended, readerId) : undefined;
    const fields: Record<string, unknown> = {};
    if (ended && said) fields.last_trade = { trade_id: ended.id, state: ended.state, note: sb(said) };
    if (tradePossible) fields.trade_note = sb(TRADE_HOW_SENTENCE);
    if (tradePossible) fields.trade_what_to_do = TRADE_WHAT_TO_DO_NONE;
    return { ...(said ? { lead: said } : tradePossible ? { lead: TRADE_HOW_SENTENCE } : {}), fields };
  } catch (e: any) {
    // A trade that cannot be read leaves the entry as it was without it.
    console.warn(`trades: reading the trade for an entry failed: ${e?.message ?? e}`);
    return tradePossible ? { lead: TRADE_HOW_SENTENCE, fields: {} } : { fields: {} };
  }
}

// ---------------------------------------------------------------------------
// THE PAGES. What the send page and the accept page say, for one reader.
// ---------------------------------------------------------------------------

export interface TradePageView {
  question: string;
  detail: string[];
  sections: { heading: string; rows: string[] }[];
  lines?: { mode: 'confirm'; heading: string; yes: string; items: { id: string; words: string }[] };
  yesLabel: string;
}

const quoted = (words: string) => `“${words}”`;

function quantityPhrase(q: number): string {
  return q === 1 ? '1 of it' : `${q} of it`;
}

/** The line saying what one of the reader's own things will do to their list. Pure. */
export function comesOffLine(words: string, quantity: number, leftNow: number): string {
  const after = leftNow - quantity;
  if (after <= 0) return `${words}: ${quantityPhrase(quantity)}, the last of it, so it comes off your list.`;
  return `${words}: ${quantityPhrase(quantity)}, and ${after} left on your list after this.`;
}

export async function tradePageView(
  accountId: string,
  tradeId: string,
  which: 'send' | 'accept',
): Promise<TradePageView | { error: string; keepLink?: boolean }> {
  const t = await loadProposal(getPool(), tradeId);
  if (!t || (t.proposer_account !== accountId && t.recipient_account !== accountId)) {
    return { error: 'That trade is not yours to decide.' };
  }
  if (which === 'send') {
    if (t.proposer_account !== accountId) return { error: 'That trade is not yours to send.' };
    if (t.state === 'open' || t.state === 'accepted') return { error: TRADE_SENT_ALREADY_WORDS };
    if (t.state !== 'awaiting-send') return { error: TRADE_NO_LONGER_OPEN_WORDS };
  } else {
    if (t.proposer_account === accountId) return { error: TRADE_OWN_SIDE_WORDS };
    if (t.state !== 'open') return { error: TRADE_NO_LONGER_OPEN_WORDS };
  }
  if (tradeHasExpired(t)) return { error: TRADE_EXPIRED_WORDS };
  const p = await readPairingRow(getPool(), t.pairing_id);
  if (!p || p.state !== 'open' || !p.anchor_match_id) return { error: TRADE_PAIRING_ENDED_WORDS };
  const items = await proposalItems(getPool(), t.id);
  const rows = await itemFacts(getPool(), items.map((i) => i.card_id));
  const give: string[] = [];
  const get: string[] = [];
  const off: string[] = [];
  for (const i of items) {
    const row = rows.get(i.card_id);
    const words = row ? wordsOf(row) : 'a thing on a list';
    const details = row ? await detailsSentence(row) : undefined;
    const said = `${i.giver_account === accountId ? words : quoted(words)}, quantity ${i.quantity}${details ? `. ${details}` : '.'}`;
    if (i.giver_account === accountId) {
      give.push(said);
      if (row) off.push(comesOffLine(words, i.quantity, leftOf(row)));
    } else {
      get.push(said);
    }
  }
  const sections: { heading: string; rows: string[] }[] = [
    { heading: TRADE_YOU_GIVE_HEADING, rows: give },
    { heading: TRADE_YOU_GET_HEADING, rows: get },
  ];
  const note = noteText(t.note);
  const detail: string[] = [];
  if (note) {
    detail.push(which === 'send' ? `With your note: ${quoted(note)}.` : `Their note, in their own words: ${quoted(note)}.`);
  }
  // THE LINES between the two, on the anchor.
  const { linesForPage } = await import('./confirmLines.js');
  const all = await linesForPage(String(p.anchor_match_id));
  const mineWaiting = waitingOn(all, accountId);
  if (which === 'accept' && waitingOnOther(all, accountId).length) {
    return { error: LINES_BLOCKED_PAIRING_WORDS, keepLink: true };
  }
  const youConfirmed = all.filter((l) => l.state === 'confirmed' && l.asked_by !== accountId).map((l) => quoted(l.words));
  const theyConfirmed = all.filter((l) => l.state === 'confirmed' && l.asked_by === accountId).map((l) => quoted(l.words));
  if (theyConfirmed.length) sections.push({ heading: TRADE_THEY_CONFIRMED_HEADING, rows: theyConfirmed });
  if (youConfirmed.length) sections.push({ heading: TRADE_YOU_CONFIRMED_HEADING, rows: youConfirmed });
  // THE FOUNDER'S DECISION: accepting takes things down, said before the press.
  if (off.length) sections.push({ heading: which === 'accept' ? TRADE_COMES_OFF_HEADING : TRADE_COMES_OFF_IF_HEADING, rows: off });
  detail.push(TRADE_POSTAGE_LINE);
  detail.push(which === 'send' ? TRADE_SEND_AGREED_LINE : TRADE_ACCEPT_ELSEWHERE_LINE);
  const { LINE_YES, confirmButtonLabel } = await import('./confirmLines.js');
  const lines = mineWaiting.length
    ? {
        mode: 'confirm' as const,
        heading: TRADE_LINES_HEADING,
        yes: LINE_YES,
        items: mineWaiting.map((l) => ({ id: l.id, words: l.words })),
      }
    : undefined;
  return {
    question: which === 'send' ? 'Send this trade?' : 'Accept this trade?',
    detail,
    sections,
    ...(lines ? { lines } : {}),
    yesLabel: lines
      ? confirmButtonLabel(which === 'send' ? 'trade-send' : 'trade-accept')
      : which === 'send'
        ? 'Send this trade'
        : 'Accept this trade',
  };
}

/** Pool client type, for callers that hold one. */
export type TradeClient = pg.PoolClient;
