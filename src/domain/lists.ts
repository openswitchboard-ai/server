/**
 * A LIST: MANY POSTINGS AT ONCE (founder, October 2026; migration 068).
 *
 * A person with a whole collection, a stock sheet or a long want list could
 * only ever post one thing per call, ten a day, twenty open. Now their own
 * assistant converts what they hold — an app's export file, a spreadsheet, a
 * typed list, a photo of a shelf — into a list, and posts it here in one call.
 * The switchboard builds no importers, holds no third-party keys and keeps no
 * catalogue. Nothing in this file branches on what sort of goods a list is
 * about, which app it came from or which community uses it.
 *
 * WHAT A LIST IS. Many postings sharing one side, one shelf, one place and
 * reach, one kind of deal (sale, trade or free) and one expiry. Each item
 * carries only: a name in plain words (the posting's `kind`), up to three
 * identifiers (domain/identifiers.ts, the same rules), details from the
 * ordinary attribute vocabulary such as condition, a quantity, and on a sale
 * either an asking price or "open to offers" (a want's items may carry the
 * private most-they-will-pay instead). No free-text description, no photos.
 *
 * EVERY ITEM IS AN ORDINARY POSTING. Each is a cards row with list_id set, so
 * the screen, the snapshot the other side is shown, the matcher and its
 * own-account exclusion, amend_intent, withdraw_intent, expiry, suspension and
 * erasure all work on an item exactly as on a posting. Each item goes through
 * PENDING_SCREENING -> PUBLISHED -> matching, the same road.
 *
 * THE DOOR, IN ORDER (publishList below):
 *
 *   1. The call's shape: 1 to LIST_CALL_MAX_ITEMS items; the shared fields
 *      read, or held to the ones the list went up with.
 *   2. The day's publishes, as a courtesy before any work (a list call is one
 *      publish however many items it carries).
 *   3. The shelf, ONCE for the list: the deny list, then filed the way an
 *      amend files a posting, without asking (a list cannot stop for a shelf
 *      question per item, and every item says what it is in its own name).
 *   4. Each item read on its own, purely: a bad or thin item is turned back
 *      with its number, the reason and the one move that fixes it. ONE BAD
 *      ITEM NEVER SINKS THE LIST. No item is ever asked questions: an item
 *      that does not say what it is is reported as not posted.
 *   5. On a list already up, the items are matched to the ones there
 *      (matchItems): unchanged ones are left alone, keeping any introductions.
 *   6. The list's shared reach is asked about, or confirmed once, the way a
 *      posting's is, and the figures on what is going up are READ BACK ONCE
 *      FOR THE WHOLE CALL as a short summary, then posted again with the
 *      `reference`.
 *   7. The place, resolved once.
 *   8. Each item that will be written through the pipe's posting door, as a
 *      posting is at publish (the money check over its name and details, the
 *      ledger).
 *   9. The writes: withdrawals (a finished replace), amendments (the same
 *      statement amend_intent uses), and the new items inserted in one
 *      transaction under the account's lock, with the list ceiling counted in
 *      it.
 *  10. The screening queue, paced (enqueueListScreening).
 */
import { createHash, randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { decryptFields, encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import { OsbError, SCHEMA_VERSION, validatePayload } from '../protocol.js';
import { decidingCheck, runIntake } from '../intake/pipe.js';
import { attributeFields } from '../intake/checks/moneyFigure.js';
import { canonicaliseAttributes } from './attributeCanon.js';
import { snapCategory } from './categoryBackfill.js';
import { recordShelfGap, shortlistForGap } from './shelfGaps.js';
import { shelfInWords } from './shelfPick.js';
import { shelfRuleRefusal, NO_MONEY_REASON } from './shelfRules.js';
import {
  FIGURE_RADIUS_TAIL,
  RADIUS_ACTION_LOOKING,
  RADIUS_ACTION_OFFERING,
  RADIUS_QUESTION_LOOKING,
  RADIUS_QUESTION_OFFERING,
  REACH_ACTION_LOOKING,
  REACH_ACTION_OFFERING,
  REACH_QUESTION_LOOKING,
  REACH_QUESTION_OFFERING,
  assertCategoryOpen,
  filedUnderNote,
  kindComplaint,
  locationEcho,
  peopleOnCards,
  placeCard,
  withdrawIntent,
  writeAmendment,
} from './cards.js';
import {
  IDENTIFIER_SENTENCES,
  identifierNorms,
  identifiersOf,
  ownIdentifiers,
  readIdentifiers,
  type Identifier,
} from './identifiers.js';
import {
  LIST_ITEMS_HELD_SQL,
  checkDayQuota,
  listCeilingSentence,
  listItemsRoom,
  recordPublishWithinQuota,
} from './quotas.js';
import { closePostingRef, noteAsked, readPostingRef, type PostingGate } from './postingRef.js';
import { rejectionInPlainWords } from './screening.js';
import type { NormalisedGeo } from '../geo/normalise.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// THE NUMBERS.
// ---------------------------------------------------------------------------

/**
 * HOW MANY ITEMS ONE CALL TAKES: 200.
 *
 * Three things set it. The server takes a request body of 256 KiB at most
 * (app.ts bodyLimit). An item at every one of its limits, written in plain
 * Latin text, comes to about 1.2 KB of JSON, so two hundred of them stay under
 * that limit with the call around them (test/unit/lists.test.ts works the sum
 * out); an ordinary item is a few hundred bytes, so an ordinary call of two
 * hundred is well under a third of it. A call is also answered while the
 * assistant waits: every item is read, checked and run through the pipe's
 * door before the answer, and two hundred keeps that to seconds. And five
 * hundred, the most anybody holds, is three calls.
 *
 * A list longer than this goes in several calls to the same list_id.
 */
export const LIST_CALL_MAX_ITEMS = 200;

/** Details per item: condition and a few more facts. No descriptions. */
export const LIST_ITEM_MAX_DETAILS = 6;
/** A detail's name, and its value, at most. */
export const LIST_DETAIL_KEY_MAX = 40;
export const LIST_DETAIL_VALUE_MAX = 60;
/** How many of one item, at most. */
export const LIST_ITEM_MAX_QUANTITY = 999;
/** A list read a page at a time. */
export const LIST_PAGE_SIZE = 50;
/** The most parts a replace may come in: 10 x 200 is twice the ceiling. */
export const LIST_MAX_PARTS = 10;
/** The most money a figure may carry, as the protocol allows. */
const MONEY_MAX = 100_000_000_000;

/** The detail names a list keeps for itself: the quantity and the deal. */
const RESERVED_DETAILS = new Set(['quantity', 'free', 'trade']);

/** The keys an item may carry. */
const ITEM_KEYS = new Set(['name', 'identifiers', 'details', 'quantity', 'price', 'open_to_offers', 'price_limit']);

// ---------------------------------------------------------------------------
// THE SCREENING QUEUE, AND A FAIR SHARE OF IT.
//
// A list's items go to the screen in messages of LIST_SCREEN_CHUNK, each
// screened with one model call (domain/screening.ts screenCardsTogether). The
// messages are spaced LIST_CHUNK_SPACING_SECONDS apart as they are sent, after
// any of this person's list items still waiting, so a list of five hundred
// reaches the worker over about twelve minutes rather than all at once. The
// worker adds the second half (workers/screeningWorker.ts fairShare): in every
// read, single postings are worked first and only one list message, so a
// person posting one ordinary thing never waits behind somebody's whole list.
// ---------------------------------------------------------------------------

/** The message kind a list's items travel to the screen in. */
export const LIST_SCREEN_CHUNK_KIND = 'screen-list-chunk';
/** Items per screening message: one model call's worth. */
export const LIST_SCREEN_CHUNK = 10;
/** How far apart a list's messages are released, and how long one passed over waits. */
export const LIST_CHUNK_SPACING_SECONDS = 15;
/** The most an SQS standard queue lets a message wait. */
export const SQS_MAX_DELAY_SECONDS = 900;
/** Embeddings run this many at a time within one message. */
export const LIST_EMBED_CONCURRENCY = 4;
/** Items checked at the door this many at a time. */
const DOOR_CONCURRENCY = 8;

/** An array in slices of n, in order. */
export function inBatches<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** The delay each of a call's screening messages is sent with. */
export function chunkDelays(chunks: number, alreadyWaitingItems: number): number[] {
  const ahead = Math.ceil(Math.max(0, alreadyWaitingItems) / LIST_SCREEN_CHUNK);
  return Array.from({ length: chunks }, (_, k) =>
    Math.min(SQS_MAX_DELAY_SECONDS, (ahead + k) * LIST_CHUNK_SPACING_SECONDS),
  );
}

/**
 * Send a call's new and changed items to the screen, ten to a message, spaced
 * out after whatever of this person's list is still waiting there.
 */
export async function enqueueListScreening(
  cfg: Config,
  accountId: string,
  listId: string,
  entries: { card_id: string; content_version: number }[],
): Promise<void> {
  if (!entries.length) return;
  const waiting = await getPool().query(
    `SELECT count(*)::int AS n FROM cards
      WHERE account_id = $1 AND list_id IS NOT NULL AND lifecycle_state = 'PENDING_SCREENING'
        AND NOT (id = ANY($2::uuid[]))`,
    [accountId, entries.map((e) => e.card_id)],
  );
  const chunks = inBatches(entries, LIST_SCREEN_CHUNK);
  const delays = chunkDelays(chunks.length, Number(waiting.rows[0]?.n ?? 0));
  for (const [k, cards] of chunks.entries()) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.screeningQueueUrl,
        MessageBody: JSON.stringify({ kind: LIST_SCREEN_CHUNK_KIND, list_id: listId, cards }),
        ...(delays[k] ? { DelaySeconds: delays[k] } : {}),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// WHAT THE ASSISTANT IS TOLD ABOUT AN ITEM THAT DID NOT GO UP.
//
// One reason word per refusal, for a caller to branch on, and one sentence
// saying the one move that fixes it. The sentences are the assistant's: it
// reads them to its human in its own plain words.
// ---------------------------------------------------------------------------

export type ItemRefusalReason =
  | 'shape'
  | 'name'
  | 'identifiers'
  | 'details'
  | 'quantity'
  | 'price'
  | 'figure_in_words'
  | 'not_carried'
  | 'duplicate'
  | 'limit_reached';

export interface ItemRefusal {
  /** Where the item sat in the call's `items`, counting from 0. */
  index: number;
  reason: ItemRefusalReason;
  /** The one move that fixes it, in plain words. */
  fix: string;
}

export const ITEM_FIXES = {
  shape:
    'Send this item as an object with a name, and only identifiers, details, quantity and a price besides. Leave out anything else.',
  name: (complaint: string): string =>
    `Give this item a name that says what it is, in a few plain words: ${complaint}. Numbers belong in its identifiers or details.`,
  details_count: `Keep this item to ${LIST_ITEM_MAX_DETAILS} details at most, each a short fact such as its condition. A description has no place on a list.`,
  details_shape: `Each detail has a short name in lower case with underscores, and a value of a word, a number or a short phrase of ${LIST_DETAIL_VALUE_MAX} characters at most.`,
  details_reserved:
    'The quantity and the deal have places of their own. Take quantity, free and trade out of the details, and give the quantity in quantity.',
  quantity: `Give the quantity as a whole number from 1 to ${LIST_ITEM_MAX_QUANTITY}, or leave it out for one.`,
  price_missing:
    'On a list for sale, give this item an asking price your human said, or mark it open to offers.',
  price_both: 'Give this item an asking price or mark it open to offers. One of the two.',
  price_no_money:
    'This list is a trade or a giveaway, so its items carry no money. Take the price off this item, or post the priced ones as a list for sale.',
  price_on_want:
    'On a want list, the most your human would pay goes in price_limit, which nobody else is shown. Move the figure there, or leave it off.',
  limit_on_have:
    'price_limit belongs on a want list. On a list of haves for sale, give an asking price or mark the item open to offers.',
  price_value: `A price is a figure above nothing and below ${MONEY_MAX}. Give the figure your human said, or leave it off.`,
  currency: 'Say which money the prices are in: put the three-letter currency in the shared fields.',
  duplicate: 'This item is in the call twice. Send it once, with its quantity.',
  limit: (held: number, limit: number): string => listCeilingSentence(held, limit),
} as const;

// ---------------------------------------------------------------------------
// THE SHARED FIELDS.
// ---------------------------------------------------------------------------

export type ListDeal = 'sale' | 'trade' | 'free';

/** The shared fields as the assistant sent them. */
export interface SharedSent {
  side: 'looking_for' | 'offering';
  category: string;
  geo: { place?: string; bucket?: string; reach?: string; radius_km?: number };
  deal: ListDeal;
  currency?: string;
  ttl_days: number;
}

/** What a list row keeps in `shared`. */
export interface SharedStored {
  sent: SharedSent;
  placed: Pick<NormalisedGeo, 'geo' | 'lat' | 'lon' | 'radius_km' | 'reach' | 'country'> & {
    display?: string;
  };
}

/** A refusal of the call itself: a plain sentence and the field to fix. */
function callRefusal(field: string, sentence: string): Error {
  return Object.assign(new Error(sentence), { validation: [field] });
}

const SIDES = new Set(['looking_for', 'offering']);
const DEALS = new Set(['sale', 'trade', 'free']);

/** The shared fields, read and checked, or a refusal of the call. */
export function readShared(raw: unknown): SharedSent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw callRefusal(
      'shared',
      'A new list needs its shared fields: the side, the shelf, the place written in full with how far it reaches, and the deal.',
    );
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!['side', 'category', 'geo', 'deal', 'currency', 'ttl_days'].includes(k)) {
      throw callRefusal('shared', `The shared fields take no '${k}'. They are side, category, geo, deal, currency and ttl_days.`);
    }
  }
  if (typeof o.side !== 'string' || !SIDES.has(o.side)) {
    throw callRefusal('shared.side', 'Say which side the list is on: "offering" for things your human has, "looking_for" for things they are after.');
  }
  if (typeof o.deal !== 'string' || !DEALS.has(o.deal)) {
    throw callRefusal('shared.deal', 'Say what kind of deal the whole list is: "sale", "trade" or "free".');
  }
  if (o.currency !== undefined && (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency))) {
    throw callRefusal('shared.currency', 'The currency is three capital letters, such as "AUD".');
  }
  const ttl = o.ttl_days === undefined ? 60 : o.ttl_days;
  if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 90) {
    throw callRefusal('shared.ttl_days', 'ttl_days is a whole number of days from 1 to 90, or left out for 60.');
  }
  // The side, the shelf and the place, held to the protocol's own document as
  // a posting's are, so a list cannot carry what a posting could not.
  const v = validatePayload('intent-card', {
    schema_version: SCHEMA_VERSION,
    type: o.side,
    category: o.category,
    geo: o.geo,
    ttl_days: ttl,
  });
  if (!v.valid) {
    throw Object.assign(new Error(`this list cannot go up as it stands: ${v.plain.join('; ')}`), {
      validation: v.reasons.map((r) => `shared.${r}`),
    });
  }
  return {
    side: o.side as SharedSent['side'],
    category: o.category as string,
    geo: o.geo as SharedSent['geo'],
    deal: o.deal as ListDeal,
    ...(o.currency ? { currency: o.currency as string } : {}),
    ttl_days: ttl as number,
  };
}

/** The shared fields a later call is held to: everything but how long it stays up. */
export function sharedKey(s: SharedSent): string {
  const g = s.geo ?? {};
  return JSON.stringify({
    side: s.side,
    category: s.category,
    deal: s.deal,
    currency: s.currency ?? null,
    place: typeof g.place === 'string' ? g.place.trim().toLowerCase() : null,
    bucket: typeof g.bucket === 'string' ? g.bucket.trim().toLowerCase() : null,
    reach: g.reach ?? null,
    radius_km: g.reach === 'radius' || g.reach === undefined ? (g.radius_km ?? null) : null,
  });
}

// ---------------------------------------------------------------------------
// ONE ITEM, READ ON ITS OWN. Pure.
// ---------------------------------------------------------------------------

/** An item as the door reads it. */
export interface ListItem {
  index: number;
  /** The name, which is the posting's `kind`. */
  kind: string;
  identifiers: Identifier[];
  /** The details as sent, before the shelf's spelling is applied. */
  details: Record<string, string | number | boolean>;
  quantity: number;
  /** A have's asking price on a sale. */
  price?: number;
  openToOffers: boolean;
  /** A want's private most-they-will-pay, on a sale. */
  priceLimit?: number;
  /** The attributes the posting carries: the details, the quantity over one, and the deal. */
  attributes: Record<string, string | number | boolean>;
}

export type ReadItem = { ok: true; item: ListItem } | { ok: false; refusal: ItemRefusal };

const money = (v: unknown): number | undefined | null => {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MONEY_MAX ? v : null;
};

/**
 * One item, checked against the rules every item is held to, or turned back
 * with the one move that fixes it. The minimum an item needs is a name that
 * says what it is: everything else is optional, and the shared fields carry
 * the rest. An item is never asked a question.
 */
export function readListItem(
  raw: unknown,
  index: number,
  ctx: { type: 'WANT' | 'HAVE'; deal: ListDeal },
): ReadItem {
  const no = (reason: ItemRefusalReason, fix: string): ReadItem => ({
    ok: false,
    refusal: { index, reason, fix },
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('shape', ITEM_FIXES.shape);
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !ITEM_KEYS.has(k))) return no('shape', ITEM_FIXES.shape);

  const complaint = kindComplaint(o.name);
  if (complaint) return no('name', ITEM_FIXES.name(complaint));
  const kind = String(o.name).trim().replace(/\s+/g, ' ');

  const ids = readIdentifiers(o.identifiers);
  if (!ids.ok) return no('identifiers', IDENTIFIER_SENTENCES[ids.reason]);

  const details: Record<string, string | number | boolean> = {};
  if (o.details !== undefined && o.details !== null) {
    if (typeof o.details !== 'object' || Array.isArray(o.details)) return no('details', ITEM_FIXES.details_shape);
    const entries = Object.entries(o.details as Record<string, unknown>);
    if (entries.length > LIST_ITEM_MAX_DETAILS) return no('details', ITEM_FIXES.details_count);
    for (const [k, v] of entries) {
      if (RESERVED_DETAILS.has(k)) return no('details', ITEM_FIXES.details_reserved);
      if (!/^[a-z][a-z0-9_]*$/.test(k) || k.length > LIST_DETAIL_KEY_MAX) {
        return no('details', ITEM_FIXES.details_shape);
      }
      if (typeof v === 'string') {
        const t = v.trim().replace(/\s+/g, ' ');
        if (!t || t.length > LIST_DETAIL_VALUE_MAX) return no('details', ITEM_FIXES.details_shape);
        details[k] = t;
      } else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') {
        details[k] = v;
      } else {
        return no('details', ITEM_FIXES.details_shape);
      }
    }
  }

  const q = o.quantity === undefined || o.quantity === null ? 1 : o.quantity;
  if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > LIST_ITEM_MAX_QUANTITY) {
    return no('quantity', ITEM_FIXES.quantity);
  }
  const quantity = q as number;

  const price = money(o.price);
  const priceLimit = money(o.price_limit);
  if (price === null || priceLimit === null) return no('price', ITEM_FIXES.price_value);
  const offers = o.open_to_offers === true;
  if (o.open_to_offers !== undefined && typeof o.open_to_offers !== 'boolean') return no('shape', ITEM_FIXES.shape);
  if (ctx.deal !== 'sale') {
    if (price !== undefined || priceLimit !== undefined || offers) return no('price', ITEM_FIXES.price_no_money);
  } else if (ctx.type === 'HAVE') {
    if (priceLimit !== undefined) return no('price', ITEM_FIXES.limit_on_have);
    if (price !== undefined && offers) return no('price', ITEM_FIXES.price_both);
    if (price === undefined && !offers) return no('price', ITEM_FIXES.price_missing);
  } else {
    if (price !== undefined || offers) return no('price', ITEM_FIXES.price_on_want);
  }

  // The deal is said on every item, in the words the posting door already
  // treats as the arrangement rather than the thing (postingDetail.ts), so the
  // other side reads it at the details step. A sale says nothing extra: its
  // asking price, or the want's private limit, says it.
  const attributes: Record<string, string | number | boolean> = {
    ...details,
    ...(quantity > 1 ? { quantity } : {}),
    ...(ctx.deal === 'trade' ? { trade: true } : ctx.deal === 'free' ? { free: true } : {}),
  };
  return {
    ok: true,
    item: {
      index,
      kind,
      identifiers: ids.identifiers,
      details,
      quantity,
      ...(price !== undefined ? { price } : {}),
      openToOffers: offers,
      ...(priceLimit !== undefined ? { priceLimit } : {}),
      attributes,
    },
  };
}

// ---------------------------------------------------------------------------
// MATCHING A LIST SENT AGAIN TO THE ITEMS ALREADY UP. Pure.
//
// The rules, in order:
//
//   1. BY IDENTIFIER. A new item that carries identifiers is matched to an
//      item already up that shares one of them, compared in every form an
//      identifier is compared in (domain/identifiers.ts identifierNorms).
//      Where several share it — two of the same product in different
//      condition — the one whose name and details also agree is taken first,
//      then the oldest.
//   2. BY NAME AND DETAILS. Otherwise, an item already up whose name and
//      details agree once normalised (case, accents, punctuation and spacing
//      folded; the quantity, the deal and the price left out, because those
//      are what changes between one export and the next).
//   3. Each item already up is matched once. What is left over on the new side
//      is added; what is left over on the old side comes down after a
//      replace's last part.
//
// A matched pair is UNCHANGED where the name, the identifiers, the details
// (quantity and deal included) and the money are all the same, and CHANGED
// otherwise. An unchanged item is not touched at all, so its introductions
// carry on as they were. A changed one is amended (writeAmendment, the
// statement amend_intent uses) and goes back through the screen.
// ---------------------------------------------------------------------------

/** Text folded for comparing: case, accents, punctuation and spacing. */
export function foldText(v: unknown): string {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The name and details an item is matched on: no quantity, no deal, no money. */
export function nameKey(kind: unknown, attributes: unknown): string {
  const attrs =
    attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? Object.entries(attributes as Record<string, unknown>)
          .filter(([k]) => !RESERVED_DETAILS.has(k))
          .map(([k, v]) => `${k}=${foldText(v)}`)
          .sort()
      : [];
  return [foldText(kind), ...attrs].join('|');
}

/** An item already up on the list, as the matching reads it. */
export interface OldItem {
  id: string;
  kind: string | null;
  identifiers: unknown;
  attributes: unknown;
  ask: unknown;
  /** Whether a private band is on the row. */
  hasBand: boolean;
  /** The band, opened, where the comparison needed it. */
  band?: string;
  list_pass?: string | null;
}

/** A new item as the matching reads it: its name, identifiers and the attributes it will carry. */
export interface NewItem {
  index: number;
  kind: string;
  identifiers: Identifier[];
  attributes: Record<string, unknown>;
}

/** Which item already up each new item is matched to, by index, and how. */
export function matchItems(
  olds: OldItem[],
  news: NewItem[],
): Map<number, { old: OldItem; how: 'identifier' | 'name' }> {
  const out = new Map<number, { old: OldItem; how: 'identifier' | 'name' }>();
  const taken = new Set<string>();
  const formsOf = (ids: unknown) => new Set(identifierNorms(identifiersOf(ids)));
  const oldForms = new Map(olds.map((o) => [o.id, formsOf(o.identifiers)]));
  const oldKeys = new Map(olds.map((o) => [o.id, nameKey(o.kind, o.attributes)]));
  // 1. By identifier.
  for (const n of news) {
    if (!n.identifiers.length) continue;
    const mine = identifierNorms(n.identifiers);
    const sharing = olds.filter(
      (o) => !taken.has(o.id) && mine.some((f) => oldForms.get(o.id)!.has(f)),
    );
    if (!sharing.length) continue;
    const key = nameKey(n.kind, n.attributes);
    const pick = sharing.find((o) => oldKeys.get(o.id) === key) ?? sharing[0];
    taken.add(pick.id);
    out.set(n.index, { old: pick, how: 'identifier' });
  }
  // 2. By name and details.
  for (const n of news) {
    if (out.has(n.index)) continue;
    const key = nameKey(n.kind, n.attributes);
    const pick = olds.find((o) => !taken.has(o.id) && oldKeys.get(o.id) === key);
    if (!pick) continue;
    taken.add(pick.id);
    out.set(n.index, { old: pick, how: 'name' });
  }
  return out;
}

/** Keys sorted all the way down, so two equal objects write the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The identifiers as their owner gave them, in a fixed order, for comparing. */
const idsText = (ids: unknown): string =>
  canonicalJson(
    identifiersOf(ids)
      .map(({ kind, value }) => ({ kind, value }))
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
  );

/**
 * Is the new item the same as the one up? Everything an item carries: its
 * name, its identifiers, every attribute, its asking price and its private
 * band. `band` is the new item's band as it would be stored, or undefined.
 */
export function sameItem(
  old: OldItem,
  next: { kind: string; identifiers: Identifier[]; attributes: Record<string, unknown>; ask?: unknown; band?: string },
): boolean {
  if ((old.kind ?? '') !== next.kind) return false;
  if (idsText(old.identifiers) !== idsText(next.identifiers)) return false;
  if (canonicalJson(old.attributes ?? {}) !== canonicalJson(next.attributes)) return false;
  if (canonicalJson(old.ask ?? null) !== canonicalJson(next.ask ?? null)) return false;
  if (old.hasBand !== (next.band !== undefined)) return false;
  if (next.band !== undefined && old.band !== next.band) return false;
  return true;
}

// ---------------------------------------------------------------------------
// THE FIGURES, READ BACK ONCE FOR THE WHOLE CALL.
//
// A posting with a figure comes back once with the figure said in plain words
// (domain/postingFigure.ts): the switchboard never posts a number nobody was
// asked about. A list of two hundred cannot be read back a line at a time, so
// it is read back as a summary: how many items carry a figure, the lowest and
// the highest, and the money. The figures are only ever the ones the
// assistant sent; nothing here works one out.
//
// Only the figures on what is GOING UP in this call are read back: new items
// and changed ones. An item matched unchanged was confirmed when it went up.
// The memory is the same as a posting's: the attempt's reference and the
// figures it was read back with. A changed figure under the same reference is
// read back again.
// ---------------------------------------------------------------------------

export interface ListFigures {
  what: 'asking price' | 'the most they will pay';
  count: number;
  lowest: number;
  highest: number;
  currency: string;
}

/** The summary of the figures on these items, or nothing where none carry one. */
export function listFigures(items: ListItem[], type: 'WANT' | 'HAVE', currency: string): ListFigures | undefined {
  const amounts = items
    .map((i) => (type === 'HAVE' ? i.price : i.priceLimit))
    .filter((a): a is number => typeof a === 'number');
  if (!amounts.length) return undefined;
  return {
    what: type === 'HAVE' ? 'asking price' : 'the most they will pay',
    count: amounts.length,
    lowest: Math.min(...amounts),
    highest: Math.max(...amounts),
    currency,
  };
}

/** What the read-back is remembered by: every figure, sorted, as a digest. Never the names. */
export function listFiguresKey(items: ListItem[], type: 'WANT' | 'HAVE', currency: string): string {
  const amounts = items
    .map((i) => (type === 'HAVE' ? i.price : i.priceLimit))
    .filter((a): a is number => typeof a === 'number')
    .sort((a, b) => a - b);
  const digest = createHash('sha256').update(`${currency}|${amounts.join(',')}`).digest('hex').slice(0, 32);
  return `list|${amounts.length}|${digest}`;
}

/** The one line telling the assistant what to do with the summary. */
export const LIST_FIGURE_HUMAN_ACTION =
  'Nothing has gone up yet. Tell your human how many items carry a figure and the lowest and highest, as they stand. Post again with the `reference` only if those are their figures; take off any they did not give.';

/** The question to put to the human, in their own plain words. */
export function listFigureQuestion(f: ListFigures): string {
  const said = f.what === 'asking price' ? 'asking prices' : 'most you would pay';
  const items = f.count === 1 ? 'this item' : `these ${f.count} items`;
  if (f.lowest === f.highest) {
    return `Is $${f.lowest} ${f.currency} the ${f.what === 'asking price' ? 'asking price' : 'most you would pay'} you gave for ${items}, or did I put it there myself?`;
  }
  return `Are the ${said} on ${items}, from $${f.lowest} to $${f.highest} ${f.currency}, figures you gave, or did I put any there myself?`;
}

/** The figures as the refusal carries them: the lowest and the highest, or the one. */
export function listFigureEntries(f: ListFigures): { what: string; amount: number; currency: string }[] {
  if (f.lowest === f.highest) {
    return [{ what: `${f.what} on every item with one`, amount: f.lowest, currency: f.currency }];
  }
  return [
    { what: `lowest ${f.what} on the list`, amount: f.lowest, currency: f.currency },
    { what: `highest ${f.what} on the list`, amount: f.highest, currency: f.currency },
  ];
}

// ---------------------------------------------------------------------------
// THE ATTEMPT AND ITS NUMBER, as a posting's (domain/postingRef.ts). A new
// list that went up takes the attempt's reference as its id, the way a
// posting does, so one number runs from the first question to the list.
// ---------------------------------------------------------------------------

interface ListAttempt {
  reference?: string;
  asked: Set<PostingGate>;
  amounts?: string;
}

async function openListAttempt(accountId: string, sent: unknown): Promise<ListAttempt> {
  const open = await readPostingRef(accountId, sent);
  return { reference: open?.reference, asked: new Set(open?.asked ?? []), amounts: open?.amounts };
}

async function askOnce(accountId: string, attempt: ListAttempt, gate: PostingGate, amounts?: string): Promise<string> {
  attempt.reference = await noteAsked(accountId, attempt.reference, gate, amounts);
  attempt.asked.add(gate);
  if (amounts !== undefined) attempt.amounts = amounts;
  return attempt.reference;
}

function figuresWillAsk(attempt: ListAttempt, key: string | undefined): boolean {
  if (!key) return false;
  return !(attempt.asked.has('figure') && attempt.amounts === key);
}

async function confirmListFigures(
  accountId: string,
  attempt: ListAttempt,
  figures: ListFigures | undefined,
  key: string | undefined,
  radiusQuestion?: string,
): Promise<void> {
  if (!figures || !key || !figuresWillAsk(attempt, key)) return;
  const reference = await askOnce(accountId, attempt, 'figure', key);
  throw new OsbError('CONFIRM_FIGURE', {
    human_action: radiusQuestion ? `${LIST_FIGURE_HUMAN_ACTION}${FIGURE_RADIUS_TAIL}` : LIST_FIGURE_HUMAN_ACTION,
    questions: radiusQuestion ? [listFigureQuestion(figures), radiusQuestion] : [listFigureQuestion(figures)],
    figures: listFigureEntries(figures),
    reference,
  });
}

// ---------------------------------------------------------------------------
// THE DOOR.
// ---------------------------------------------------------------------------

export interface PublishListArgs {
  list_id?: unknown;
  shared?: unknown;
  items?: unknown;
  replace?: unknown;
  part?: unknown;
  parts?: unknown;
  reference?: unknown;
}

export type ItemResult = 'added' | 'changed' | 'unchanged';

export interface ListResult {
  list_id?: string;
  /** PENDING_SCREENING where anything is on its way to the screen. */
  state: 'PENDING_SCREENING' | 'UNCHANGED' | 'NOTHING_POSTED';
  sent: number;
  added: number;
  changed: number;
  unchanged: number;
  withdrawn: number;
  refused: number;
  /** Each item that is up or on its way, by its place in the call. */
  items: { index: number; intent_id: string; result: ItemResult }[];
  /** Each item that did not go up, with the reason and the one move that fixes it. */
  refused_items: ItemRefusal[];
  /** The attempt's number, where nothing went up after a question was asked. */
  reference?: string;
  replace?: { part: number; parts: number; finished: boolean };
  /** The withdrawn items' introductions, as withdraw_intent counts them. */
  introductions_archived?: number;
  conversations_kept?: number;
  items_held: number;
  items_limit: number;
  location_resolved?: { display: string; radius_km: number };
  filed_under: string;
  category: string;
  filed_under_note: { text: string; provenance: 'switchboard-system' };
  results_note: { text: string; provenance: 'switchboard-system' };
}

/** A list row as this file reads it. */
interface ListRow {
  id: string;
  account_id: string;
  type: 'WANT' | 'HAVE';
  category: string;
  category_as_posted: string | null;
  deal: ListDeal;
  shared: SharedStored;
  state: 'open' | 'withdrawn';
  expires_at: Date;
  replace_pass: string | null;
  replace_parts: number | null;
  replace_next: number | null;
}

/**
 * Post a list, add to one, or send one again. The attempt's number rides on
 * every refusal, exactly as on a posting (cards.ts publishIntent).
 */
export async function publishList(cfg: Config, accountId: string, args: PublishListArgs): Promise<ListResult> {
  const attempt = await openListAttempt(accountId, args.reference);
  try {
    return await runPublishList(cfg, accountId, args, attempt);
  } catch (e) {
    if (e instanceof OsbError && !e.payload.reference) {
      e.payload.reference = await noteAsked(accountId, attempt.reference);
    }
    throw e;
  }
}

const NOT_YOURS =
  'That list is not one your human has up: it may have been taken down or run out. Post a new list, leaving list_id out.';

/** Run a function over items a few at a time, keeping their order. */
async function eachLimited<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const batch of inBatches(items, n)) out.push(...(await Promise.all(batch.map(fn))));
  return out;
}

async function runPublishList(
  cfg: Config,
  accountId: string,
  args: PublishListArgs,
  attempt: ListAttempt,
): Promise<ListResult> {
  // 1. THE CALL'S SHAPE.
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > LIST_CALL_MAX_ITEMS) {
    throw callRefusal(
      'items',
      `A list call takes 1 to ${LIST_CALL_MAX_ITEMS} items. Send the rest in further calls to the same list, with its list_id.`,
    );
  }
  const sentItems: unknown[] = rawItems;
  const replace = args.replace === true;
  if (args.replace !== undefined && typeof args.replace !== 'boolean') {
    throw callRefusal('replace', 'replace is true or left out.');
  }
  const part = args.part === undefined ? 1 : args.part;
  const parts = args.parts === undefined ? 1 : args.parts;
  const wholeIn = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= LIST_MAX_PARTS;
  if (!wholeIn(part) || !wholeIn(parts) || (part as number) > (parts as number)) {
    throw callRefusal('part', `part and parts are whole numbers from 1 to ${LIST_MAX_PARTS}, and part is never more than parts.`);
  }
  if (!replace && (args.part !== undefined || args.parts !== undefined)) {
    throw callRefusal('part', 'part and parts go with replace. To add to a list, send the items with its list_id alone.');
  }
  const listIdSent = typeof args.list_id === 'string' ? args.list_id : undefined;
  if (replace && !listIdSent) {
    throw callRefusal('replace', 'replace sends a list that is already up again, so it needs that list_id. A new list needs no replace.');
  }

  // The list already up, where this call is about one.
  let list: ListRow | undefined;
  if (listIdSent) {
    const r = await getPool().query(`SELECT * FROM lists WHERE id = $1 AND account_id = $2`, [listIdSent, accountId]);
    list = r.rows[0] as ListRow | undefined;
    if (!list || list.state !== 'open' || new Date(list.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error(NOT_YOURS), { notFound: true });
    }
  }
  let shared: SharedSent;
  if (list) {
    shared = list.shared.sent;
    if (args.shared !== undefined && sharedKey(readShared(args.shared)) !== sharedKey(shared)) {
      throw callRefusal(
        'shared',
        'A list keeps the side, shelf, place, reach and deal it went up with. Leave shared out to add to it, or take the list down and post a new one to change those.',
      );
    }
  } else {
    shared = readShared(args.shared);
  }
  const type: 'WANT' | 'HAVE' = shared.side === 'looking_for' ? 'WANT' : 'HAVE';

  // Which replace pass this is, and whether it is the last part.
  let pass: string | undefined;
  if (replace && list) {
    if (part === 1) pass = randomUUID();
    else if (list.replace_pass && list.replace_parts === parts && (part as number) <= (list.replace_next ?? 0)) {
      pass = list.replace_pass;
    } else {
      throw callRefusal('part', 'Send part 1 first. A list sent again starts from its first part, and the parts follow in order.');
    }
  }
  const finishing = replace && part === parts;

  // 2. THE DAY, before anything costs anything.
  await checkDayQuota(accountId, cfg.quotas);

  // 3. THE SHELF, once for the whole list.
  let filed: { category: string; from: string; changed: boolean };
  if (list) {
    filed = { category: list.category, from: list.category_as_posted ?? list.category, changed: list.category !== (list.category_as_posted ?? list.category) };
  } else {
    await assertCategoryOpen(cfg, shared.category, accountId, undefined, { kindCheckedPerItem: true });
    const firstName = (sentItems.find((i: any) => typeof i?.name === "string") as any)?.name;
    const snapped = await snapCategory(cfg, shared.category, undefined, {
      fallbackToAncestor: true,
      posting: { kind: typeof firstName === 'string' ? firstName : null },
    });
    if (snapped.changed && (snapped.how === 'ancestor' || snapped.confident === false)) {
      await recordShelfGap({
        as_posted: snapped.from,
        kind: firstName,
        outcome: snapped.how === 'ancestor' && !snapped.category.includes('.') ? 'top_level' : 'snapped_low_confidence',
        picked: snapped.category,
        shortlist: shortlistForGap(snapped.shortlist),
      });
    }
    filed = { category: snapped.category, from: snapped.from, changed: snapped.changed };
  }

  // 4. EACH ITEM, ON ITS OWN.
  const refusals: ItemRefusal[] = [];
  const good: ListItem[] = [];
  const currency = shared.currency;
  const seen = new Set<string>();
  for (const [index, raw] of sentItems.entries()) {
    const read = readListItem(raw, index, { type, deal: shared.deal });
    if (!read.ok) {
      refusals.push(read.refusal);
      continue;
    }
    const item = read.item;
    if ((item.price !== undefined || item.priceLimit !== undefined) && !currency) {
      refusals.push({ index, reason: 'price', fix: ITEM_FIXES.currency });
      continue;
    }
    // The item as a posting, held to the protocol's own document and to the
    // shelf's rules, as a posting is.
    const asCard = {
      schema_version: SCHEMA_VERSION,
      type: shared.side,
      category: filed.category,
      kind: item.kind,
      geo: shared.geo,
      attributes: item.attributes,
      ...(item.price !== undefined ? { ask: { amount: item.price, ccy: currency } } : {}),
      ...(item.priceLimit !== undefined ? { price: { band: { max: item.priceLimit }, ccy: currency } } : {}),
      ttl_days: shared.ttl_days,
    };
    const v = validatePayload('intent-card', asCard);
    if (!v.valid) {
      refusals.push({ index, reason: 'details', fix: `This item cannot go up as it stands: ${v.plain.join('; ')}.` });
      continue;
    }
    const shelf = shelfRuleRefusal(asCard);
    if (shelf) {
      refusals.push({ index, reason: shelf.reason_code === NO_MONEY_REASON ? 'price' : 'not_carried', fix: shelf.human_action });
      continue;
    }
    item.attributes = canonicaliseAttributes(filed.category, item.attributes) as ListItem['attributes'];
    const dup = `${nameKey(item.kind, item.attributes)}#${identifierNorms(item.identifiers).sort().join(',')}`;
    if (seen.has(dup)) {
      refusals.push({ index, reason: 'duplicate', fix: ITEM_FIXES.duplicate });
      continue;
    }
    seen.add(dup);
    good.push(item);
  }

  // 5. ON A LIST ALREADY UP, WHAT IS ALREADY THERE.
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');
  let olds: OldItem[] = [];
  if (list) {
    const r = await getPool().query(
      `SELECT id, kind, identifiers, attributes, ask, price_enc, list_pass FROM cards
        WHERE list_id = $1 AND account_id = $2
          AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')
        ORDER BY created_at, id`,
      [list.id, accountId],
    );
    olds = (r.rows as any[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      identifiers: row.identifiers,
      attributes: row.attributes,
      ask: row.ask,
      hasBand: !!row.price_enc,
      list_pass: row.list_pass,
      _enc: row.price_enc,
    })) as (OldItem & { _enc?: Buffer })[];
  }
  // A replace matches only what this pass has not already seen in an earlier part.
  const pool = pass ? olds.filter((o) => o.list_pass !== pass) : olds;
  const matched = matchItems(pool, good);
  // The private limits on matched wants, opened once for the whole call, so
  // an unchanged limit leaves its item alone. One audit line for all of them.
  const toOpen = [...matched.entries()].filter(
    ([idx, m]) => m.old.hasBand && good.find((g) => g.index === idx)?.priceLimit !== undefined,
  );
  if (toOpen.length) {
    const opened = await decryptFields(
      accountId,
      account.data_key_enc,
      Object.fromEntries(toOpen.map(([, m]) => [m.old.id, (m.old as any)._enc as Buffer])),
      { purpose: 'list-replace-compare', actor: accountId, refs: { list_id: list!.id } },
    );
    for (const [, m] of toOpen) m.old.band = opened[m.old.id];
  }
  const bandOf = (item: ListItem): string | undefined =>
    item.priceLimit !== undefined ? JSON.stringify({ band: { max: item.priceLimit }, ccy: currency }) : undefined;
  const askOf = (item: ListItem) => (item.price !== undefined ? { amount: item.price, ccy: currency } : null);

  const toAdd: ListItem[] = [];
  const toChange: { item: ListItem; old: OldItem; how: 'identifier' | 'name' }[] = [];
  const unchanged: { item: ListItem; old: OldItem }[] = [];
  for (const item of good) {
    const m = matched.get(item.index);
    if (m && sameItem(m.old, { ...item, ask: askOf(item), band: bandOf(item) })) {
      unchanged.push({ item, old: m.old });
    } else if (m && replace) {
      // A different name under a shared identifier is the same product under
      // tidier words; under a name match the name is the same by definition.
      toChange.push({ item, old: m.old, how: m.how });
    } else {
      toAdd.push(item);
    }
  }
  const claimed = new Set([...matched.values()].map((m) => m.old.id));
  const toWithdraw = finishing ? pool.filter((o) => !claimed.has(o.id)) : [];
  // What will be amended; narrowed below to what the pipe lets through.
  let changing = toChange;
  let adding = toAdd;
  /** What the person holds on lists, for an answer that wrote nothing. */
  let heldNothing = 0;

  // Nothing could go up and nothing comes down: no question is worth asking.
  if (!toAdd.length && !toChange.length && !toWithdraw.length) return nothingWritten();

  // 6. THE GATES: the list's reach, then its figures, one refusal at a time.
  const offering = type === 'HAVE';
  const isGoods = String(shared.category).split('.')[0] === 'goods';
  const radiusQuestion = offering ? RADIUS_QUESTION_OFFERING : RADIUS_QUESTION_LOOKING;
  const goingUp = [...toAdd, ...toChange.map((c) => c.item)];
  const figures = currency ? listFigures(goingUp, type, currency) : undefined;
  const figuresKey = currency && figures ? listFiguresKey(goingUp, type, currency) : undefined;
  if (!list && isGoods) {
    const reach = shared.geo?.reach;
    if (!reach) {
      throw new OsbError('NEEDS_DETAIL', {
        reference: await askOnce(accountId, attempt, 'reach'),
        human_action: offering ? REACH_ACTION_OFFERING : REACH_ACTION_LOOKING,
        questions: [offering ? REACH_QUESTION_OFFERING : REACH_QUESTION_LOOKING],
      });
    }
    if (!attempt.asked.has('reach')) {
      if (figuresWillAsk(attempt, figuresKey)) {
        // The reach question rides on the figure read-back, as on a posting.
        await askOnce(accountId, attempt, 'reach');
        await confirmListFigures(accountId, attempt, figures, figuresKey, radiusQuestion);
      } else if (reach === 'radius') {
        throw new OsbError('NEEDS_DETAIL', {
          reference: await askOnce(accountId, attempt, 'reach'),
          human_action: offering ? RADIUS_ACTION_OFFERING : RADIUS_ACTION_LOOKING,
          questions: [radiusQuestion],
        });
      }
    }
  }
  await confirmListFigures(accountId, attempt, figures, figuresKey);

  // 7. THE PLACE, once.
  let placed: SharedStored['placed'];
  if (list) {
    placed = list.shared.placed;
  } else {
    const p = placeCard(shared.geo);
    placed = {
      geo: p.geo,
      lat: p.lat,
      lon: p.lon,
      radius_km: p.radius_km,
      reach: p.reach,
      country: p.country,
      ...(p.resolved ? { display: p.resolved.display } : {}),
    };
  }
  const geo: NormalisedGeo = { ...placed };

  // 8. EACH ITEM THAT WILL BE WRITTEN, THROUGH THE PIPE'S POSTING DOOR, as a
  // posting is at publish: the money check over its name and its details, and
  // the ledger. Unchanged items write nothing and are not run again.
  const doorRefused = new Set<number>();
  await eachLimited(goingUp, DOOR_CONCURRENCY, async (item) => {
    const intake = await runIntake(cfg, {
      door: 'posting',
      sender_account: accountId,
      fields: { category: shared.category, kind: item.kind, ...attributeFields(item.details) },
    });
    if (intake.outcome !== 'refuse') return;
    doorRefused.add(item.index);
    refusals.push({
      index: item.index,
      reason: intake.reason_code === 'money-figure-in-words' ? 'figure_in_words' : 'not_carried',
      fix: intake.plain_words ?? decidingCheck(intake)?.plain_words ?? 'This item is not something the switchboard carries. Leave it off the list.',
    });
  });
  adding = toAdd.filter((i) => !doorRefused.has(i.index));
  changing = toChange.filter((c) => !doorRefused.has(c.item.index));

  /**
   * NOTHING TO WRITE. Nothing is counted against the day, and a new list is
   * not created. A replace part still keeps its books: it has seen every item
   * it matched. The attempt stays open, so a call sent again with its items
   * fixed is not asked what it has already answered.
   */
  async function nothingWritten(): Promise<ListResult> {
    if (list && replace) await keepBooks((sql, params) => getPool().query(sql, params as any[]));
    const { held } = await listItemsRoom(accountId, cfg.quotas);
    heldNothing = held;
    return answer(list?.id, 'nothing');
  }

  /**
   * THE LIST'S OWN BOOKS, on a list already up: a replace marks what it has
   * seen, so its last part knows what to take down; the last part clears the
   * pass and moves the expiry on, for the list and every item still up on it
   * (sending the whole list again keeps it up for another stretch); an
   * append only touches the row. Run inside the insert's transaction, and on
   * its own where a call has nothing to write, because a part that changed
   * nothing has still seen its items.
   */
  async function keepBooks(q: (sql: string, params: unknown[]) => Promise<any>): Promise<Date> {
    const row = list!;
    if (finishing) {
      const renewed = await q(
        `UPDATE lists SET expires_at = now() + make_interval(days => $2::int),
                replace_pass = NULL, replace_parts = NULL, replace_next = NULL, updated_at = now()
          WHERE id = $1 RETURNING expires_at`,
        [row.id, shared.ttl_days],
      );
      const until: Date = renewed.rows[0]?.expires_at ?? row.expires_at;
      await q(
        `UPDATE cards SET expires_at = $2, renewal_notified_at = NULL, updated_at = now()
          WHERE list_id = $1 AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')`,
        [row.id, until],
      );
      return until;
    }
    if (replace) {
      const next = part === 1 ? 2 : Math.max(row.replace_next ?? 1, (part as number) + 1);
      await q(
        `UPDATE lists SET replace_pass = $2, replace_parts = $3, replace_next = $4, updated_at = now() WHERE id = $1`,
        [row.id, pass, parts, next],
      );
      const seenIds = [...unchanged.map((u) => u.old.id), ...changing.map((c) => c.old.id)];
      if (seenIds.length) {
        await q(`UPDATE cards SET list_pass = $2 WHERE id = ANY($1::uuid[])`, [seenIds, pass]);
      }
      return row.expires_at;
    }
    await q(`UPDATE lists SET updated_at = now() WHERE id = $1`, [row.id]);
    return row.expires_at;
  }

  // Nothing to write at all: nothing is counted and nothing is created.
  const { held: heldBefore, room: roomBefore } = await listItemsRoom(accountId, cfg.quotas);
  const room = roomBefore + toWithdraw.length;
  if (!adding.length && !changing.length && !toWithdraw.length) return nothingWritten();
  if (adding.length && room === 0 && !changing.length && !toWithdraw.length) {
    throw new OsbError('QUOTA_EXCEEDED', { human_action: listCeilingSentence(heldBefore, cfg.quotas.maxListItems) });
  }

  // 9. THE WRITES. The day's publish first, once for the call: if the day is
  // done, nothing has been written.
  const listId = list?.id ?? attempt.reference ?? randomUUID();
  await recordPublishWithinQuota(accountId, listId, cfg.quotas);

  // A finished replace takes down what it never saw, the way withdraw_intent
  // takes a posting down: open conversations stay open.
  let introductions_archived = 0;
  let conversations_kept = 0;
  await eachLimited(toWithdraw, DOOR_CONCURRENCY, async (o) => {
    const w = await withdrawIntent(accountId, o.id, cfg);
    introductions_archived += w.introductions_archived;
    conversations_kept += w.conversations_kept;
  });

  const encBand = async (item: ListItem): Promise<Buffer | null> => {
    const band = bandOf(item);
    return band ? encryptField(accountId, account.data_key_enc, band) : null;
  };
  const ttl = shared.ttl_days;
  const changedVersions: { card_id: string; content_version: number }[] = [];
  await eachLimited(changing, DOOR_CONCURRENCY, async ({ item, old }) => {
    const version = await writeAmendment(old.id, {
      geo,
      attributes: item.attributes,
      ask: askOf(item),
      urgency: 'none',
      status: 'active',
      ttlDays: ttl,
      priceEnc: await encBand(item),
      slots: 1,
      sale: 'straight',
      category: filed.category,
      categoryFrom: filed.from,
      identifiers: item.identifiers,
      ...(item.kind !== (old.kind ?? '') ? { kind: item.kind } : {}),
    });
    changedVersions.push({ card_id: old.id, content_version: Number(version ?? 1) });
  });

  // The new items, in one transaction under the account's lock, with the
  // ceiling counted inside it: two calls racing cannot both pass the count.
  const prepared = await Promise.all(
    adding.map(async (item) => {
      const enc = await encBand(item);
      return {
        item,
        row: {
          id: randomUUID(),
          kind: item.kind,
          attributes: item.attributes,
          ...(item.price !== undefined ? { ask: { amount: item.price, ccy: currency } } : {}),
          ...(enc ? { price_enc: enc.toString('base64') } : {}),
          ...(item.identifiers.length
            ? { identifiers: item.identifiers, norms: identifierNorms(item.identifiers) }
            : {}),
        },
      };
    }),
  );
  const inserted: { item: ListItem; id: string; content_version: number }[] = [];
  let heldAfter = heldBefore;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(68068, hashtext($1::text))`, [accountId]);
    let expiresAt: Date;
    if (!list) {
      const created = await client.query(
        `INSERT INTO lists (id, account_id, type, category, category_as_posted, deal, shared, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + make_interval(days => $8::int))
         RETURNING expires_at`,
        [listId, accountId, type, filed.category, filed.from, shared.deal, JSON.stringify({ sent: shared, placed }), ttl],
      );
      expiresAt = created.rows[0].expires_at;
    } else {
      expiresAt = await keepBooks((sql, params) => client.query(sql, params));
    }
    const heldNow = Number((await client.query(LIST_ITEMS_HELD_SQL, [accountId])).rows[0]?.n ?? 0);
    const roomNow = Math.max(0, cfg.quotas.maxListItems - heldNow);
    const taking = prepared.slice(0, roomNow);
    for (const { item } of prepared.slice(roomNow)) {
      refusals.push({ index: item.index, reason: 'limit_reached', fix: ITEM_FIXES.limit(heldNow, cfg.quotas.maxListItems) });
    }
    if (taking.length) {
      const r = await client.query(
        `INSERT INTO cards (id, account_id, schema_version, type, category, category_as_posted, kind,
                            geo, geo_lat, geo_lon, geo_radius_km, geo_country, attributes, ask,
                            urgency, visibility, protocol_status, price_enc, ttl_days, expires_at,
                            slots, sale, identifiers, identifier_norms, list_id, list_pass)
         SELECT r.id, $1, $2, $3, $4, $5, r.kind,
                $6::jsonb, $7, $8, $9, $10, r.attributes, r.ask,
                'none', 'anonymous-until-match', 'active',
                CASE WHEN r.price_enc IS NULL THEN NULL ELSE decode(r.price_enc, 'base64') END,
                $11::int, $12::timestamptz, 1, 'straight', r.identifiers,
                CASE WHEN r.norms IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(r.norms)) END,
                $13::uuid, $14::uuid
           FROM jsonb_to_recordset($15::jsonb)
                AS r(id uuid, kind text, attributes jsonb, ask jsonb, price_enc text, identifiers jsonb, norms jsonb)
          WHERE (SELECT count(*) FROM cards
                  WHERE account_id = $1 AND list_id IS NOT NULL
                    AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')) + $16::int <= $17::int
         RETURNING id, content_version`,
        [
          accountId,
          SCHEMA_VERSION,
          type,
          filed.category,
          filed.from,
          JSON.stringify(geo.geo),
          geo.lat,
          geo.lon,
          geo.radius_km,
          geo.country,
          ttl,
          expiresAt,
          listId,
          pass ?? null,
          JSON.stringify(taking.map((t) => t.row)),
          taking.length,
          cfg.quotas.maxListItems,
        ],
      );
      const versions = new Map<string, number>(
        (r.rows as { id: string; content_version: number }[]).map((x) => [x.id, Number(x.content_version ?? 1)]),
      );
      for (const t of taking) {
        if (versions.has(t.row.id)) {
          inserted.push({ item: t.item, id: t.row.id, content_version: versions.get(t.row.id)! });
        } else {
          refusals.push({ index: t.item.index, reason: 'limit_reached', fix: ITEM_FIXES.limit(heldNow, cfg.quotas.maxListItems) });
        }
      }
    }
    heldAfter = heldNow + inserted.length;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await closePostingRef(attempt.reference);

  // 10. THE SCREEN, paced.
  await enqueueListScreening(cfg, accountId, listId, [
    ...inserted.map((i) => ({ card_id: i.id, content_version: i.content_version })),
    ...changedVersions,
  ]);

  return answer(listId, 'written');

  function answer(id: string | undefined, how: 'nothing' | 'written'): ListResult {
    const items: ListResult['items'] = [
      ...(how === 'written' ? inserted.map((i) => ({ index: i.item.index, intent_id: i.id, result: 'added' as const })) : []),
      ...(how === 'written' ? changing.map((c) => ({ index: c.item.index, intent_id: c.old.id, result: 'changed' as const })) : []),
      ...unchanged.map((u) => ({ index: u.item.index, intent_id: u.old.id, result: 'unchanged' as const })),
    ].sort((a, b) => a.index - b.index);
    const refused = [...refusals].sort((a, b) => a.index - b.index);
    const counts = {
      sent: sentItems.length,
      added: how === 'written' ? inserted.length : 0,
      changed: how === 'written' ? changing.length : 0,
      unchanged: unchanged.length,
      withdrawn: how === 'written' ? toWithdraw.length : 0,
      refused: refused.length,
    };
    const state: ListResult['state'] =
      counts.added || counts.changed ? 'PENDING_SCREENING' : counts.unchanged || counts.withdrawn ? 'UNCHANGED' : 'NOTHING_POSTED';
    return {
      ...(id && (list || how === 'written') ? { list_id: id } : {}),
      state,
      ...counts,
      // Where nothing went up after a question was asked, the attempt's number
      // comes back, so the call sent again with its items fixed is not asked
      // the same question twice.
      ...(how === 'nothing' && attempt.reference ? { reference: attempt.reference } : {}),
      items,
      refused_items: refused,
      ...(replace ? { replace: { part: part as number, parts: parts as number, finished: finishing } } : {}),
      ...(how === 'written' && toWithdraw.length ? { introductions_archived, conversations_kept } : {}),
      items_held: how === 'written' ? heldAfter : heldNothing,
      items_limit: cfg.quotas.maxListItems,
      // Where a new list was placed, said out loud as a posting's place is.
      ...(how === 'written' && !list && placed?.display
        ? locationEcho({ ...geo, resolved: { display: placed.display } as any })
        : {}),
      filed_under: shelfInWords(filed.category),
      category: filed.category,
      filed_under_note: { text: filedUnderNote(filed), provenance: 'switchboard-system' as const },
      results_note: {
        text: resultsSentence(counts, replace ? { finished: finishing, left: (parts as number) - (part as number) } : undefined),
        provenance: 'switchboard-system' as const,
      },
    };
  }
}

/**
 * The one sentence about how the call went, for the assistant to put in its
 * own words. Counts only: no figure, no id, nothing about any one item.
 */
export function resultsSentence(
  c: { sent: number; added: number; changed: number; unchanged: number; withdrawn: number; refused: number },
  replace?: { finished: boolean; left: number },
): string {
  const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  const parts: string[] = [];
  if (c.added) parts.push(`${n(c.added, 'item is', 'items are')} going up`);
  if (c.changed) parts.push(`${n(c.changed, 'item has', 'items have')} changed and ${c.changed === 1 ? 'is' : 'are'} being checked again`);
  if (c.unchanged) parts.push(`${n(c.unchanged, 'item is', 'items are')} up as before`);
  if (c.withdrawn) parts.push(`${n(c.withdrawn, 'item no longer on the list has', 'items no longer on the list have')} come down`);
  if (c.refused) parts.push(`${n(c.refused, 'item was', 'items were')} not posted, each with the reason beside it`);
  const head = `Of ${n(c.sent, 'item', 'items')} sent: ${parts.length ? parts.join('; ') : 'nothing changed'}.`;
  if (replace && !replace.finished && replace.left > 0) {
    return `${head} Send the remaining ${n(replace.left, 'part', 'parts')}; items no longer on the list come down after the last one.`;
  }
  return head;
}

/** What to say once a list call is answered, for the assistant's own words. */
export const LIST_SAY_NOTE = {
  text: 'Tell your human how many items went up, and read out each one that did not with the reason beside it, in plain words. The ids, the field names and the dotted path are yours to work with and are never said aloud, and every price is their own figure.',
  provenance: 'switchboard-system' as const,
};

// ---------------------------------------------------------------------------
// READING ONE'S OWN LISTS.
// ---------------------------------------------------------------------------

interface ListCounts {
  up: number;
  checking: number;
  turned_away: number;
  taken_down: number;
  ran_out: number;
}

/** The sentence for one list, in plain words. */
export function listSentence(
  type: 'WANT' | 'HAVE',
  category: string,
  state: 'open' | 'withdrawn' | 'expired',
  c: ListCounts,
): string {
  const what = `Your list of ${type === 'HAVE' ? 'haves' : 'wants'} on ${shelfInWords(category)}`;
  if (state === 'withdrawn') return `${what} is taken down.`;
  if (state === 'expired') return `${what} has run out. Send it again to put it back up.`;
  const bits = [`${c.up} up`];
  if (c.checking) bits.push(`${c.checking} being checked`);
  if (c.turned_away) bits.push(`${c.turned_away} turned away`);
  return `${what}: ${bits.join(', ')}.`;
}

export interface ListSummary {
  list_id: string;
  side: 'looking_for' | 'offering';
  deal: ListDeal;
  state: 'open' | 'withdrawn' | 'expired';
  filed_under: string;
  items: ListCounts;
  expires_at: Date;
  created_at: Date;
  note: { text: string; provenance: 'switchboard-system' };
}

/** Every list this account holds, newest first, with its counts. */
export async function listSummaries(accountId: string, onlyOpen = false): Promise<ListSummary[]> {
  const r = await getPool().query(
    `SELECT l.id, l.type, l.category, l.deal, l.state, l.expires_at, l.created_at,
            count(c.id) FILTER (WHERE c.lifecycle_state = 'PUBLISHED')::int          AS up,
            count(c.id) FILTER (WHERE c.lifecycle_state = 'PENDING_SCREENING')::int  AS checking,
            count(c.id) FILTER (WHERE c.lifecycle_state = 'SCREENING_REJECTED')::int AS turned_away,
            count(c.id) FILTER (WHERE c.lifecycle_state = 'WITHDRAWN')::int          AS taken_down,
            count(c.id) FILTER (WHERE c.lifecycle_state = 'EXPIRED')::int            AS ran_out
       FROM lists l
       LEFT JOIN cards c ON c.list_id = l.id
      WHERE l.account_id = $1
        ${onlyOpen ? `AND l.state = 'open' AND l.expires_at > now()` : ''}
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT 50`,
    [accountId],
  );
  return (r.rows as any[]).map((row) => {
    const state: ListSummary['state'] =
      row.state === 'withdrawn' ? 'withdrawn' : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
    const items: ListCounts = {
      up: Number(row.up ?? 0),
      checking: Number(row.checking ?? 0),
      turned_away: Number(row.turned_away ?? 0),
      taken_down: Number(row.taken_down ?? 0),
      ran_out: Number(row.ran_out ?? 0),
    };
    return {
      list_id: row.id,
      side: row.type === 'WANT' ? 'looking_for' : 'offering',
      deal: row.deal,
      state,
      filed_under: shelfInWords(row.category),
      items,
      expires_at: row.expires_at,
      created_at: row.created_at,
      note: { text: listSentence(row.type, row.category, state, items), provenance: 'switchboard-system' as const },
    };
  });
}

/**
 * One list and a page of its items, in the order they went up. Each item is
 * shown to its owner the way list_intents shows a posting: its own words, its
 * identifiers as given, its asking price where it has one, and how many
 * people have come forward on it. A private limit is never echoed.
 */
export async function readList(accountId: string, listId: string, page = 1): Promise<any> {
  const summaries = await getPool().query(`SELECT id FROM lists WHERE id = $1 AND account_id = $2`, [listId, accountId]);
  if (!summaries.rows[0]) throw Object.assign(new Error('That list is not one of your human\'s.'), { notFound: true });
  const summary = (await listSummaries(accountId)).find((s) => s.list_id === listId);
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const r = await getPool().query(
    `SELECT id, type, category, kind, identifiers, attributes, ask, lifecycle_state, screening, expires_at
       FROM cards WHERE list_id = $1 AND account_id = $2
      ORDER BY created_at, id
      LIMIT $3 OFFSET $4`,
    [listId, accountId, LIST_PAGE_SIZE + 1, (p - 1) * LIST_PAGE_SIZE],
  );
  const rows = (r.rows as any[]).slice(0, LIST_PAGE_SIZE);
  const up = rows.filter((row) => row.lifecycle_state === 'PUBLISHED').map((row) => row.id);
  const people = await peopleOnCards(up);
  const items = rows.map((row) => {
    const attrs = (row.attributes ?? {}) as Record<string, unknown>;
    const details = Object.fromEntries(Object.entries(attrs).filter(([k]) => !RESERVED_DETAILS.has(k)));
    const who = row.lifecycle_state === 'PUBLISHED' ? (people.get(row.id) ?? { here: 0, waiting: 0 }) : undefined;
    const rej = row.lifecycle_state === 'SCREENING_REJECTED' ? rejectionInPlainWords(row.screening) : undefined;
    return {
      intent_id: row.id,
      state: row.lifecycle_state,
      name: row.kind,
      ...(identifiersOf(row.identifiers).length ? { identifiers: ownIdentifiers(row.identifiers) } : {}),
      ...(Object.keys(details).length ? { details } : {}),
      quantity: typeof attrs.quantity === 'number' ? attrs.quantity : 1,
      ...(row.ask?.amount ? { price: row.ask.amount } : {}),
      ...(row.type === 'HAVE' && !row.ask && !attrs.trade && !attrs.free ? { open_to_offers: true } : {}),
      ...(who ? { people_here: who.here, in_line: who.waiting } : {}),
      ...(rej ? { note: { text: rej.plain, provenance: 'switchboard-system' as const } } : {}),
    };
  });
  return {
    ...(summary ?? { list_id: listId }),
    page: p,
    ...(r.rows.length > LIST_PAGE_SIZE ? { next_page: p + 1 } : {}),
    list_items: items,
  };
}

// ---------------------------------------------------------------------------
// TAKING A LIST DOWN.
// ---------------------------------------------------------------------------

/**
 * Take every item on a list down, each the way withdraw_intent takes a posting
 * down: nobody new is introduced, introductions that never reached a
 * conversation are filed away, and a conversation already open stays open.
 * The list is marked taken down. Taking down a list already down changes
 * nothing.
 */
export async function withdrawList(
  cfg: Config,
  accountId: string,
  listId: string,
): Promise<{
  list_id: string;
  state: 'WITHDRAWN';
  items_withdrawn: number;
  introductions_archived: number;
  conversations_kept: number;
}> {
  const found = await getPool().query(`SELECT id FROM lists WHERE id = $1 AND account_id = $2`, [listId, accountId]);
  if (!found.rows[0]) throw Object.assign(new Error('That list is not one of your human\'s.'), { notFound: true });
  const live = await getPool().query(
    `SELECT id FROM cards WHERE list_id = $1 AND account_id = $2
        AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')`,
    [listId, accountId],
  );
  let introductions_archived = 0;
  let conversations_kept = 0;
  await eachLimited(live.rows as { id: string }[], DOOR_CONCURRENCY, async ({ id }) => {
    const w = await withdrawIntent(accountId, id, cfg);
    introductions_archived += w.introductions_archived;
    conversations_kept += w.conversations_kept;
  });
  await getPool().query(
    `UPDATE lists SET state = 'withdrawn', withdrawn_at = COALESCE(withdrawn_at, now()),
            replace_pass = NULL, replace_parts = NULL, replace_next = NULL, updated_at = now()
      WHERE id = $1 AND account_id = $2`,
    [listId, accountId],
  );
  return {
    list_id: listId,
    state: 'WITHDRAWN',
    items_withdrawn: live.rows.length,
    introductions_archived,
    conversations_kept,
  };
}
