/**
 * The fit sequencer: the line, the slots, and the clock on a live slot.
 *
 * What it is for, in the words it was decided in: two people who fit meet,
 * without either of them managing a crowd, and nobody is left in silence. The
 * human stays in charge, nothing binds until they accept, and the switchboard
 * is never a bidding race.
 *
 * So every open want and every open have holds a LINE of candidate
 * introductions and a number of SLOTS (cards.slots, 1-10, default 1). Only the
 * introductions in a slot are LIVE: they surface on the holder's sweep, and
 * interest, the names step, the conversation and any figure all run on them.
 * The rest are IN LINE. They exist as rows, the holder is never shown them at
 * all, and the other side's agent is told one sentence — its human's turn will
 * come — and nothing else. No count and no position ever cross: the ban on
 * scarcity theatre is exactly the rule it always was.
 *
 * WHAT THIS REPLACED. The collection window: a second person coming forward
 * froze the holder for six hours while everyone piled in, and the holder could
 * talk to all of them and commit to none. Nothing blocks a holder now.
 *
 * THREE THINGS LIVE HERE.
 *
 * 1. RANKING (rankByFit, pure). Fit, recomputed whenever the line changes:
 *    whether the two sealed limits overlap as a yes or a no and never by how
 *    much; then distance; then whether the two urgencies agree; then the
 *    account's reliability signal; then arrival time as the tiebreak. A later
 *    arrival that fits better goes ahead of the people still in line, and
 *    never displaces an introduction that is already live — which falls out of
 *    the shape of resequenceCard rather than being a rule bolted on: live rows
 *    are counted, never re-ordered.
 *
 * 2. THE CLOCK. A live introduction has to show movement — any interest, names
 *    step, message or figure, from either side — inside its slot's length, and
 *    each movement resets it. A slot that runs out LAPSES: the introduction is
 *    archived with archived_via 'lapsed', both sides' sweeps say so in a
 *    sentence, and the next in line goes live.
 *
 * 3. THE GATHERING WINDOW, for a have on best offer (cards.sale). For its
 *    length everyone who fits is live at once and slots are ignored; see
 *    domain/offers.ts for the sealing rules, which are the substance of it.
 *
 * Nothing in this file hands a count, a position or a figure to anybody. The
 * only number that crosses to an agent is in_line on the HOLDER's own sweep,
 * which is the holder's own line and no counterparty's business.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { haversineKm } from '../geo/geohash.js';
import type { Config } from '../config.js';

/** The ceiling the wire puts on cards.slots, restated where the server reads it. */
export const MAX_SLOTS = 10;

/** How long a live slot has to show movement before it lapses (minutes). */
export const SLOT_MINUTES_DEFAULT = 24 * 60;
export const SLOT_MINUTES_URGENT = 120; // urgency 'today'

/** How long a best-offer gathering window stays open (minutes). */
export const GATHER_MINUTES_DEFAULT = 24 * 60;
export const GATHER_MINUTES_URGENT = 120; // urgency 'today'

export function slotMinutes(urgency: string | null | undefined): number {
  return urgency === 'today' ? SLOT_MINUTES_URGENT : SLOT_MINUTES_DEFAULT;
}

export function gatherMinutes(urgency: string | null | undefined): number {
  return urgency === 'today' ? GATHER_MINUTES_URGENT : GATHER_MINUTES_DEFAULT;
}

/**
 * What the sequencer ranks on. Every field is either a boolean or a number the
 * switchboard already holds; no price band and no figure is among them, which
 * is the whole point of limitsOverlap being a boolean computed in the matcher.
 */
export interface FitFacts {
  matchId: string;
  /** Do the two sealed limits meet? Yes or no, never by how much. */
  limitsOverlap: boolean;
  /** Kilometres between the two, or null when the pair meets on reach alone. */
  distanceKm: number | null;
  /** Both sides said "today". */
  urgencyMatch: boolean;
  /** The other account's reliability signal, 0..1. */
  reliability: number;
  /** When the introduction was made. The tiebreak, and only the tiebreak. */
  arrivedAt: number;
}

/**
 * The order of the line. Stable and total: two candidates that tie on every
 * fact keep the order they came in, because arrival is the last word.
 *
 * A pair that meets on a declared reach rather than on distance (a whole
 * country, or anywhere) has no kilometres to compare, so it sorts behind the
 * pairs that do have a distance and ahead of nothing else. That is honest
 * rather than punitive: the switchboard genuinely does not know how far apart
 * those two are.
 */
export function rankByFit<T extends FitFacts>(rows: T[]): T[] {
  const far = Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => {
    if (a.limitsOverlap !== b.limitsOverlap) return a.limitsOverlap ? -1 : 1;
    const da = a.distanceKm ?? far;
    const db = b.distanceKm ?? far;
    if (da !== db) return da - db;
    if (a.urgencyMatch !== b.urgencyMatch) return a.urgencyMatch ? -1 : 1;
    if (a.reliability !== b.reliability) return b.reliability - a.reliability;
    return a.arrivedAt - b.arrivedAt;
  });
}

interface LineRow {
  id: string;
  live: boolean;
  limits_overlap: boolean;
  created_at: Date | string;
  other_card: string;
  own_urgency: string | null;
  own_slots: number;
  own_sale: string | null;
  own_gather_open: boolean;
  other_urgency: string | null;
  own_lat: number | null;
  own_lon: number | null;
  other_lat: number | null;
  other_lon: number | null;
  reliability: number;
}

/** Every open introduction on one want or have, with what the ranking needs. */
async function lineOf(cardId: string): Promise<LineRow[]> {
  const r = await getPool().query(
    `SELECT m.id, m.live, m.limits_overlap, m.created_at,
            CASE WHEN m.card_want = $1 THEN m.card_have ELSE m.card_want END AS other_card,
            own.urgency AS own_urgency, own.slots AS own_slots, own.sale AS own_sale,
            (own.sale = 'best-offer' AND own.gather_until IS NOT NULL
             AND own.gather_until > now()) AS own_gather_open,
            own.geo_lat AS own_lat, own.geo_lon AS own_lon,
            oc.urgency AS other_urgency, oc.geo_lat AS other_lat, oc.geo_lon AS other_lon,
            COALESCE(rep.score, 0.5) AS reliability
       FROM matches m
       JOIN cards own ON own.id = $1
       JOIN cards oc ON oc.id = CASE WHEN m.card_want = $1 THEN m.card_have ELSE m.card_want END
       LEFT JOIN reputation rep
              ON rep.account_id = CASE WHEN m.card_want = $1
                                       THEN m.account_have ELSE m.account_want END
      WHERE (m.card_want = $1 OR m.card_have = $1) AND m.state = 'open'`,
    [cardId],
  );
  return r.rows as LineRow[];
}

function factsOf(row: LineRow): FitFacts {
  const placed =
    typeof row.own_lat === 'number' &&
    typeof row.own_lon === 'number' &&
    typeof row.other_lat === 'number' &&
    typeof row.other_lon === 'number';
  return {
    matchId: row.id,
    limitsOverlap: !!row.limits_overlap,
    distanceKm: placed
      ? haversineKm(
          { lat: Number(row.own_lat), lon: Number(row.own_lon) },
          { lat: Number(row.other_lat), lon: Number(row.other_lon) },
        )
      : null,
    urgencyMatch: row.own_urgency === 'today' && row.other_urgency === 'today',
    reliability: Number(row.reliability ?? 0.5),
    arrivedAt: new Date(row.created_at).getTime(),
  };
}

/** How many live introductions one want or have can still take. */
async function freeSlots(cardId: string): Promise<number> {
  const r = await getPool().query(
    `SELECT c.slots, c.sale,
            (c.sale = 'best-offer' AND c.gather_until IS NOT NULL
             AND c.gather_until > now()) AS gather_open,
            (SELECT count(*)::int FROM matches m
              WHERE (m.card_want = c.id OR m.card_have = c.id)
                AND m.state = 'open' AND m.live) AS live_now
       FROM cards c WHERE c.id = $1`,
    [cardId],
  );
  const row = r.rows[0];
  if (!row) return 0;
  // A gathering window ignores slots by design: everyone who fits is in it.
  if (row.gather_open) return MAX_SLOTS;
  return Math.max(0, Number(row.slots ?? 1) - Number(row.live_now ?? 0));
}

/**
 * Fill whatever slots this want or have has free, best fit first.
 *
 * Live rows are counted and never re-ordered, so an introduction already live
 * is never displaced by a better-fitting latecomer — the latecomer simply goes
 * to the front of the people still waiting. An introduction goes live only
 * when BOTH of its two wants-or-haves have a slot free, because a slot is a
 * promise of attention from a person and both people have to be able to make
 * it.
 *
 * Returns the introductions that went live. When `cfg` carries an ops queue,
 * each of them is handed the ordinary summons on the way out: going live from
 * the line is, to the human, someone coming forward, and it reads exactly the
 * same. The enqueue is best-effort and the promotion stands without it.
 */
export async function resequenceCard(cardId: string, cfg?: Config): Promise<string[]> {
  await openGatheringWindow(cardId);
  const rows = await lineOf(cardId);
  if (!rows.length) return [];
  let free = rows[0].own_gather_open
    ? MAX_SLOTS
    : Math.max(0, Number(rows[0].own_slots ?? 1) - rows.filter((r) => r.live).length);
  if (free <= 0) return [];
  const waiting = rankByFit(rows.filter((r) => !r.live).map(factsOf));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const promoted: string[] = [];
  for (const cand of waiting) {
    if (free <= 0) break;
    const other = byId.get(cand.matchId)!.other_card;
    if ((await freeSlots(other)) <= 0) continue;
    const u = await getPool().query(
      `UPDATE matches SET live = true, live_at = now(), last_movement_at = now(),
              updated_at = now()
        WHERE id = $1 AND state = 'open' AND NOT live
        RETURNING id`,
      [cand.matchId],
    );
    if (u.rowCount) {
      promoted.push(cand.matchId);
      free--;
    }
  }
  if (cfg?.opsQueueUrl) for (const id of promoted) await summon(cfg, id);
  return promoted;
}

/** Resequence both sides of one introduction (after a decline, an archive, a lapse). */
export async function resequenceAround(matchId: string, cfg?: Config): Promise<string[]> {
  const r = await getPool().query(`SELECT card_want, card_have FROM matches WHERE id = $1`, [
    matchId,
  ]);
  const m = r.rows[0];
  if (!m) return [];
  const promoted = await resequenceCard(m.card_want, cfg);
  const more = await resequenceCard(m.card_have, cfg);
  return [...promoted, ...more.filter((id) => !promoted.includes(id))];
}

/** The ordinary summons, best-effort and idempotent (summons:{match}:{account}). */
async function summon(cfg: Config, matchId: string): Promise<void> {
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.opsQueueUrl,
        MessageBody: JSON.stringify({ op: 'match-notify', match_id: matchId }),
      }),
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`sequencer: summons enqueue failed (it is still live): ${e?.message ?? e}`);
  }
}

/**
 * Any interest, names step, message or figure from either side. Resets the
 * slot's clock. Best-effort by design: it is a courtesy to the two people, and
 * a failed touch must never turn a successful action into an error.
 */
export async function noteMovement(matchId: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE matches SET last_movement_at = now() WHERE id = $1 AND state = 'open' AND live`,
      [matchId],
    );
  } catch {
    // The action itself stands; the clock simply runs from where it was.
  }
}

/** How many people are waiting behind the live ones. HOLDER'S OWN VIEW ONLY. */
export async function inLineCount(cardId: string): Promise<number> {
  const r = await getPool().query(
    `SELECT count(*)::int AS n FROM matches m
      WHERE (m.card_want = $1 OR m.card_have = $1) AND m.state = 'open' AND NOT m.live`,
    [cardId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Is this account's OWN want or have the one that is full?
 *
 * It decides who sees an introduction that is in line. The person whose own
 * line is full is the holder: they are already talking to somebody about this
 * and are shown nothing of who is behind them on THIS introduction (their own
 * sweep says how many are in line, once, on the live one). The person on the
 * other side is the one waiting, and they get the single "you're in line"
 * sentence so they are never left in silence.
 */
export async function ownCardIsFull(cardId: string): Promise<boolean> {
  return (await freeSlots(cardId)) <= 0;
}

/**
 * Live introductions whose slot has run out of movement. One statement: the
 * clock's length depends on the holder's urgency, so it is compared per row
 * against whichever of the two wants-or-haves is the more urgent — a slot on
 * something wanted today is two hours for both of them.
 */
export async function dueToLapse(limit = 200): Promise<string[]> {
  const r = await getPool().query(
    `SELECT m.id
       FROM matches m
       JOIN cards w ON w.id = m.card_want
       JOIN cards h ON h.id = m.card_have
      WHERE m.state = 'open' AND m.live
        AND m.last_movement_at < now() - make_interval(mins =>
              CASE WHEN w.urgency = 'today' OR h.urgency = 'today' THEN $1::int
                   ELSE $2::int END)
        -- A gathering window runs on its own clock; the slot clock waits.
        AND NOT (h.sale = 'best-offer' AND h.gather_until IS NOT NULL
                 AND h.gather_until > now() AND h.gather_closed_at IS NULL)
      ORDER BY m.last_movement_at ASC
      LIMIT ${Number(limit) || 200}`,
    [SLOT_MINUTES_URGENT, SLOT_MINUTES_DEFAULT],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

// ---------------------------------------------------------------------------
// The gathering window, for a have on best offer.
//
// It opens at the FIRST candidate, not at the second: the point of best offer
// is that the seller asked for it, so there is nothing to wait for. For its
// length slots are ignored and everyone who fits is live at once, which is the
// one place on the switchboard where that happens and the reason it is bounded
// by a clock. The sealing rules — one number each, the ask as the floor,
// nobody seeing anybody else's figure — live in domain/offers.ts.
// ---------------------------------------------------------------------------

/** Stamp the window if this is a best-offer have that has just got a candidate. */
export async function openGatheringWindow(cardId: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE cards c
        SET gather_until = now() + make_interval(mins =>
              CASE WHEN c.urgency = 'today' THEN $2::int ELSE $3::int END),
            updated_at = now()
      WHERE c.id = $1 AND c.type = 'HAVE' AND c.sale = 'best-offer'
        AND c.gather_until IS NULL AND c.gather_closed_at IS NULL
        AND EXISTS (SELECT 1 FROM matches m
                     WHERE m.card_have = c.id AND m.state = 'open')
      RETURNING c.id`,
    [cardId, GATHER_MINUTES_URGENT, GATHER_MINUTES_DEFAULT],
  );
  return !!r.rowCount;
}

export interface GatherOutcome {
  closed: number;
  lapsed: number;
}

/**
 * Close every gathering window whose clock has run out. Closing does two
 * things and no more: it stamps the card so the seller's sweep starts showing
 * the numbers (domain/offers.ts, bestOfferResult), and it files away the
 * people who never put one in, the same way a lapsed slot is filed away, so
 * nobody is left holding an introduction that has already been decided without
 * them. Nobody is told anything about anybody else's figure at any point.
 */
export async function closeDueGatherings(cfg?: Config): Promise<GatherOutcome> {
  const due = await getPool().query(
    `UPDATE cards SET gather_closed_at = now(), updated_at = now()
      WHERE sale = 'best-offer' AND gather_until IS NOT NULL
        AND gather_until <= now() AND gather_closed_at IS NULL
      RETURNING id`,
  );
  const ids = (due.rows as { id: string }[]).map((x) => x.id);
  let lapsed = 0;
  for (const cardId of ids) {
    const r = await getPool().query(
      `UPDATE matches m
          SET state = 'archived', archived_at = now(), archived_via = 'lapsed',
              live = false, updated_at = now()
        WHERE m.card_have = $1 AND m.state = 'open'
          AND NOT EXISTS (SELECT 1 FROM offers o
                           WHERE o.match_id = m.id AND o.state <> 'withdrawn')
        RETURNING m.id`,
      [cardId],
    );
    lapsed += r.rowCount ?? 0;
    for (const row of r.rows as { id: string }[]) await resequenceAround(row.id, cfg);
  }
  return { closed: ids.length, lapsed };
}

export interface LapseOutcome {
  lapsed: number;
  promoted: number;
}

/**
 * The sweep behind the clock. Each lapsed introduction is archived the way any
 * finished one is — the row stays, so both sides can still be told what it was
 * — with archived_via 'lapsed', which is what the sweep sentence reads off.
 * Then the slot it held is refilled from the line.
 */
export async function lapseDueSlots(cfg?: Config): Promise<LapseOutcome> {
  const due = await dueToLapse();
  let lapsed = 0;
  let promoted = 0;
  for (const id of due) {
    const r = await getPool().query(
      `UPDATE matches
          SET state = 'archived', archived_at = now(), archived_via = 'lapsed',
              live = false, updated_at = now()
        WHERE id = $1 AND state = 'open' AND live
        RETURNING id`,
      [id],
    );
    if (!r.rowCount) continue;
    lapsed++;
    await getPool().query(
      `UPDATE channel_messages SET expires_at = now() WHERE match_id = $1 AND expires_at > now()`,
      [id],
    );
    promoted += (await resequenceAround(id, cfg)).length;
  }
  return { lapsed, promoted };
}
