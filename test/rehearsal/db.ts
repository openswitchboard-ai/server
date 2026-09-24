/**
 * WHAT THE DATABASE SAYS HAPPENED.
 *
 * Every check's evidence that is not an assistant's own words comes from here,
 * read through the RDS Data API the integration suite already uses. Nothing in
 * this file writes anything except the two teardown helpers at the bottom, and
 * both of those are about accounts this suite made and nobody else's.
 *
 * WHAT CANNOT BE READ, said once so no check quietly pretends otherwise:
 * message bodies. channel_messages.body_enc is encrypted under a per-channel
 * key and delivery DELETES the row, so there is no plaintext to compare a relay
 * against. What survives delivery is the per-sender tally in channel_send_rate,
 * which is what "three messages each way" is counted from.
 */
import { dbExec } from '../integration/helpers.js';
import type { CardFacts } from './checks.js';

const ids = (accounts: (string | undefined)[]): string =>
  accounts.filter((a): a is string => !!a).join(',');

export async function dbNow(): Promise<string> {
  const rows = await dbExec('SELECT now()::text');
  return String(rows[0]?.[0]);
}

export async function cardsFor(accountIds: string[], sinceIso: string): Promise<CardFacts[]> {
  if (!accountIds.length) return [];
  const rows = await dbExec(
    // price_enc IS NOT NULL, never the band itself: the band is encrypted
    // under the account's own key and this harness holds no key. Whether one
    // is SET is the whole of what can be read, and it is enough to catch an
    // assistant that put a figure there on its human's behalf.
    `SELECT id::text, account_id::text, type, category, kind,
            attributes::text, ask::text, sale, geo_radius_km, geo_country,
            lifecycle_state, created_at::text, geo->>'reach',
            (price_enc IS NOT NULL) AS has_band
       FROM cards
      WHERE account_id = ANY(string_to_array(:ids, ',')::uuid[])
        AND created_at > :since::timestamptz
      ORDER BY created_at`,
    [{ name: 'ids', value: ids(accountIds) }, { name: 'since', value: sinceIso }],
  );
  return rows.map((r) => ({
    id: String(r[0]),
    accountId: String(r[1]),
    type: String(r[2]),
    category: String(r[3]),
    kind: r[4] === null ? null : String(r[4]),
    attributes: safeJson(r[5]) as Record<string, unknown>,
    ask: r[6] === null ? null : (safeJson(r[6]) as Record<string, unknown>),
    sale: r[7] === null ? null : String(r[7]),
    geoRadiusKm: r[8] === null ? null : Number(r[8]),
    geoCountry: r[9] === null ? null : String(r[9]),
    state: String(r[10]),
    createdAt: String(r[11]),
    geoReach: r[12] === null || r[12] === undefined ? null : String(r[12]),
    hasBand: r[13] === true || String(r[13]) === 'true',
  }));
}

function safeJson(v: unknown): unknown {
  if (v === null || v === undefined) return {};
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

export interface MatchFacts {
  id: string;
  cardWant: string;
  cardHave: string;
  accountWant: string;
  accountHave: string;
  stage: number;
  state: string;
  score: number;
  channelId?: string;
  createdAt: string;
  severedAt?: string;
  /** Which tier the introduction was made in: 'sure' or 'possible' (050). */
  certainty?: string;
}

export async function matchBetween(
  accountIds: string[],
  sinceIso: string,
): Promise<MatchFacts | undefined> {
  const rows = await dbExec(
    `SELECT id::text, card_want::text, card_have::text, account_want::text, account_have::text,
            stage, state, score, channel_id, created_at::text, severed_at::text,
            certainty
       FROM matches
      WHERE account_want = ANY(string_to_array(:ids, ',')::uuid[])
        AND account_have = ANY(string_to_array(:ids, ',')::uuid[])
        AND created_at > :since::timestamptz
      ORDER BY created_at
      LIMIT 1`,
    [{ name: 'ids', value: ids(accountIds) }, { name: 'since', value: sinceIso }],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: String(r[0]),
    cardWant: String(r[1]),
    cardHave: String(r[2]),
    accountWant: String(r[3]),
    accountHave: String(r[4]),
    stage: Number(r[5]),
    state: String(r[6]),
    score: Number(r[7]),
    channelId: r[8] ? String(r[8]) : undefined,
    createdAt: String(r[9]),
    severedAt: r[10] ? String(r[10]) : undefined,
    certainty: r[11] ? String(r[11]) : undefined,
  };
}

export async function nearMissBetween(
  accountIds: string[],
  sinceIso: string,
): Promise<number | undefined> {
  const rows = await dbExec(
    `SELECT nm.score
       FROM near_misses nm
       JOIN cards cw ON cw.id = nm.card_want
       JOIN cards ch ON ch.id = nm.card_have
      WHERE cw.account_id = ANY(string_to_array(:ids, ',')::uuid[])
        AND ch.account_id = ANY(string_to_array(:ids, ',')::uuid[])
        AND nm.created_at > :since::timestamptz
      ORDER BY nm.created_at DESC
      LIMIT 1`,
    [{ name: 'ids', value: ids(accountIds) }, { name: 'since', value: sinceIso }],
  );
  return rows[0] ? Number(rows[0][0]) : undefined;
}

/** Has this account's names-step consent landed on this introduction? */
export async function namesConsents(matchId: string): Promise<string[]> {
  const rows = await dbExec(
    `SELECT account_id::text FROM consent_tokens
      WHERE match_id = :m::uuid AND kind = 'stage3-optin'`,
    [{ name: 'm', value: matchId }],
  );
  return rows.map((r) => String(r[0]));
}

/** Messages each side has actually sent, from the tally that survives delivery. */
export async function sendCounts(channelId: string): Promise<Record<string, number>> {
  const rows = await dbExec(
    `SELECT sender_account::text, sum(n)::int FROM channel_send_rate
      WHERE channel_id = :c GROUP BY 1`,
    [{ name: 'c', value: channelId }],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[0])] = Number(r[1]);
  return out;
}

/** Ciphertext of everything still undelivered, for the "nothing of the words is in the row" read. */
export async function undeliveredCiphertext(channelId: string): Promise<string[]> {
  const rows = await dbExec(
    `SELECT encode(body_enc, 'escape') FROM channel_messages WHERE channel_id = :c`,
    [{ name: 'c', value: channelId }],
  );
  return rows.map((r) => String(r[0]));
}

export interface LedgerRow {
  door: string;
  outcome: string;
  reasonCode?: string;
  senderAccount: string;
  createdAt: string;
}

/** What the intake pipe decided, per door. A refusal here is the switchboard
 *  stopping something, which several checks need to tell apart from an
 *  assistant that chose not to send it. */
export async function ledgerFor(matchId: string, sinceIso: string): Promise<LedgerRow[]> {
  const rows = await dbExec(
    `SELECT door, outcome, reason_code, sender_account::text, created_at::text
       FROM ledger_entries
      WHERE match_id = :m::uuid AND created_at > :since::timestamptz
      ORDER BY created_at`,
    [{ name: 'm', value: matchId }, { name: 'since', value: sinceIso }],
  );
  return rows.map((r) => ({
    door: String(r[0]),
    outcome: String(r[1]),
    reasonCode: r[2] === null ? undefined : String(r[2]),
    senderAccount: String(r[3]),
    createdAt: String(r[4]),
  }));
}

export interface OfferFacts {
  id: string;
  proposer: string;
  amount: number;
  ccy: string;
  state: string;
  authoredBy: string;
  createdAt: string;
}

export async function offersOn(matchId: string): Promise<OfferFacts[]> {
  const rows = await dbExec(
    `SELECT id::text, proposer_account::text, amount::text, ccy, state, authored_by, created_at::text
       FROM offers WHERE match_id = :m::uuid ORDER BY created_at`,
    [{ name: 'm', value: matchId }],
  );
  return rows.map((r) => ({
    id: String(r[0]),
    proposer: String(r[1]),
    amount: Number(r[2]),
    ccy: String(r[3]),
    state: String(r[4]),
    authoredBy: String(r[5]),
    createdAt: String(r[6]),
  }));
}

export async function photosOn(matchId: string): Promise<
  { id: string; sender: string; sentAt?: string; collectedAt?: string }[]
> {
  const rows = await dbExec(
    `SELECT id::text, sender_account::text, sent_at::text, collected_at::text
       FROM conversation_photos WHERE match_id = :m::uuid ORDER BY created_at`,
    [{ name: 'm', value: matchId }],
  );
  return rows.map((r) => ({
    id: String(r[0]),
    sender: String(r[1]),
    sentAt: r[2] ? String(r[2]) : undefined,
    collectedAt: r[3] ? String(r[3]) : undefined,
  }));
}

export async function verdictsOn(matchId: string): Promise<{ account: string; verdict: string }[]> {
  const rows = await dbExec(
    `SELECT account_id::text, verdict FROM match_verdicts WHERE match_id = :m::uuid`,
    [{ name: 'm', value: matchId }],
  );
  return rows.map((r) => ({ account: String(r[0]), verdict: String(r[1]) }));
}

export async function reportsOn(matchId: string): Promise<
  { id: string; reporter: string; reported: string; status: string }[]
> {
  const rows = await dbExec(
    `SELECT id::text, reporter_account::text, reported_account::text, status
       FROM reports WHERE match_id = :m::uuid`,
    [{ name: 'm', value: matchId }],
  );
  return rows.map((r) => ({
    id: String(r[0]),
    reporter: String(r[1]),
    reported: String(r[2]),
    status: String(r[3]),
  }));
}

export async function suspensionOf(accountId: string): Promise<string | undefined> {
  const rows = await dbExec(
    'SELECT suspended_at::text FROM accounts WHERE id = :a::uuid',
    [{ name: 'a', value: accountId }],
  );
  return rows[0]?.[0] ? String(rows[0][0]) : undefined;
}

/**
 * Lift a suspension on one of THIS SUITE'S throwaway accounts.
 *
 * The product's own way is scripts/safety/lift.mts, which needs a DATABASE_URL
 * this harness does not have — it reaches the database through the Data API.
 * So the columns are cleared directly and the address is let go, which is what
 * liftSuspension does. Only ever called on an account id the run itself minted
 * and recorded in the ledger.
 */
export async function liftSuspensionDirect(accountId: string): Promise<boolean> {
  const rows = await dbExec(
    `UPDATE accounts SET suspended_at = NULL, suspended_reason = NULL
      WHERE id = :a::uuid AND suspended_at IS NOT NULL
      RETURNING id::text`,
    [{ name: 'a', value: accountId }],
  );
  if (!rows.length) return false;
  await dbExec(
    `DELETE FROM suspended_emails
      WHERE email_hash IN (SELECT email_hash FROM accounts WHERE id = :a::uuid)`,
    [{ name: 'a', value: accountId }],
  );
  return true;
}

export async function jevShadowFor(cardIds: string[]): Promise<
  { trial: string; cardId?: string; ours: unknown; jev: unknown; latencyMs?: number }[]
> {
  if (!cardIds.length) return [];
  const rows = await dbExec(
    `SELECT trial, card_id::text, ours::text, jev::text, latency_ms
       FROM jev_shadow
      WHERE card_id = ANY(string_to_array(:ids, ',')::uuid[])
         OR other_card_id = ANY(string_to_array(:ids, ',')::uuid[])
      ORDER BY created_at`,
    [{ name: 'ids', value: cardIds.join(',') }],
  );
  return rows.map((r) => ({
    trial: String(r[0]),
    cardId: r[1] ? String(r[1]) : undefined,
    ours: safeJson(r[2]),
    jev: safeJson(r[3]),
    latencyMs: r[4] === null ? undefined : Number(r[4]),
  }));
}

/**
 * Did the switchboard write down that a human said an introduction was not the
 * thing (migration 050, not_the_thing)? The row holds the two postings, the
 * tier and the pair's signals; the harness only asks whether one is there.
 */
export async function notTheThingRecorded(matchId: string): Promise<boolean> {
  const rows = await dbExec(
    `SELECT count(*) FROM not_the_thing WHERE match_id = :id::uuid`,
    [{ name: 'id', value: matchId }],
  );
  return Number(rows[0]?.[0] ?? 0) > 0;
}

/** The state an introduction is in right now. */
export async function matchState(matchId: string): Promise<string | undefined> {
  const rows = await dbExec(`SELECT state FROM matches WHERE id = :id::uuid`, [
    { name: 'id', value: matchId },
  ]);
  return rows[0]?.[0] ? String(rows[0][0]) : undefined;
}

/**
 * A `created_at::text` from Postgres, in milliseconds.
 *
 * TWO WRONG ANSWERS ALREADY CAME OUT OF THIS ONE VALUE. Postgres writes it as
 * "2026-09-21 12:10:33.123456+00": a SPACE where ISO has a T, and a two-digit
 * offset where ISO wants four. Compared as a string against a transcript's ISO
 * timestamp, the space sorts below the T and every turn of the day looks later
 * than the introduction. Repaired to a T and handed to Date.parse, the "+00"
 * is no longer a valid offset and the whole thing comes back NaN — and a NaN
 * comparison is false for everything, so the window goes from holding the
 * entire run to holding nothing at all. Both of those failed a run and read as
 * a finding about an assistant.
 *
 * So: the raw string first, because V8 parses it correctly as it stands, and
 * the repair only as a fallback. A value that survives neither throws, because
 * a clock nobody can read must stop the run as a harness fault rather than
 * quietly empty a window and accuse an assistant of silence.
 */
export function pgTimeMs(text: string): number {
  const raw = Date.parse(text);
  if (Number.isFinite(raw)) return raw;
  const repaired = Date.parse(
    text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
  );
  if (Number.isFinite(repaired)) return repaired;
  throw new Error(`unreadable timestamp from the database: ${JSON.stringify(text)}`);
}

/**
 * LET A BEST-OFFER WINDOW RUN OUT, AS TWENTY-FOUR HOURS WOULD.
 *
 * On a best-offer have the seller sees NO offer until the gathering window
 * closes (domain/offers.ts, bestOfferSealedFrom): that is what keeps it from
 * becoming an auction. The window is a day long, and a rehearsal cannot wait a
 * day, so stage 5 used to ask the seller's assistant about a figure it was not
 * allowed to see — and on 24 September 2026 failed it for truthfully saying
 * "still nothing new".
 *
 * This does to ONE card exactly what the ops worker's closeDueGatherings does
 * to every card whose clock has run out: moves the clock to now and stamps the
 * close. Nothing is archived here because the only buyer in this scenario has
 * a number on the table, which is the case the real close leaves open too. It
 * writes to the dev database, which this harness has asserted it is pointed at
 * before a word is said (config.ts, assertDev).
 */
export async function closeGatheringFor(matchId: string): Promise<boolean> {
  const rows = await dbExec(
    `UPDATE cards c SET gather_until = now() - interval '1 second',
                        gather_closed_at = now(), updated_at = now()
       FROM matches m
      WHERE m.id = :id::uuid AND c.id = m.card_have AND c.sale = 'best-offer'
        AND c.gather_closed_at IS NULL
      RETURNING c.id::text`,
    [{ name: 'id', value: matchId }],
  );
  return rows.length > 0;
}
