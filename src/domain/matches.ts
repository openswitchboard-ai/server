import { randomUUID } from 'node:crypto';
import { getPool } from '../db.js';
import { decryptFields, generateChannelKey, writeConsentEvent } from '../crypto.js';
import { getAccount } from './accounts.js';
import { getCard } from './cards.js';
import { MAX_THRESHOLD_BUMP, THRESHOLD_BUMP_STEP } from './matchRules.js';
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
  state: 'open' | 'declined' | 'closed';
  channel_id: string | null;
  opened_at: Date | null;
}

export async function getMatch(id: string): Promise<MatchRow | undefined> {
  const r = await getPool().query('SELECT * FROM matches WHERE id = $1', [id]);
  return r.rows[0];
}

export function sideOf(m: MatchRow, accountId: string): 'want' | 'have' {
  if (m.account_want === accountId) return 'want';
  if (m.account_have === accountId) return 'have';
  throw Object.assign(new Error('match not found'), { notFound: true });
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
  return r.rows[0].id as string;
}

// ---------------------------------------------------------------------------
// Contested matches - the collection window (0.F).
//
// State machine (lives on the CONTESTED CARD, the "holder" side):
//   uncontested --(2nd concurrently-open match created)--> collecting
//     [collect_until stamped by the matcher: min(per-card override,
//      15 min if urgency='today' else 6 h)]
//   collecting --(timer expiry)---------------------------> closed
//   collecting --(holder early-close via counter/agent)----> closed
//   closed is TERMINAL: the window never reopens for that card.
//
// While collecting, the HOLDER's side sees every interested party's
// interest/offers as they arrive but cannot COMMIT (stage-3 opt-in / human
// offer acceptance) until the window closes. The NON-holder side is told
// NOTHING: no rival counts, no window, no hint a contest exists at all
// ("scarcity theatre" ban - asserted in tests).
// ---------------------------------------------------------------------------

export interface CollectionWindow {
  cardId: string;
  until: Date;
  /** open matches on the contested card - visible to the HOLDER only */
  interestedParties: number;
}

/** The caller's OWN card on this match. */
export function ownCardId(m: MatchRow, accountId: string): string {
  return sideOf(m, accountId) === 'want' ? m.card_want : m.card_have;
}

/** Open collection window on a card, if any (undefined = none / closed). */
export async function openCollectionWindow(cardId: string): Promise<CollectionWindow | undefined> {
  const r = await getPool().query(
    `SELECT c.collect_until,
            (SELECT count(*)::int FROM matches m
             WHERE (m.card_want = c.id OR m.card_have = c.id) AND m.state = 'open') AS n
     FROM cards c
     WHERE c.id = $1 AND c.collect_until > now() AND c.collect_closed_at IS NULL`,
    [cardId],
  );
  if (!r.rows[0]) return undefined;
  return { cardId, until: r.rows[0].collect_until, interestedParties: r.rows[0].n };
}

/** Throws STAGE_LOCKED when the caller's own card is still collecting. */
async function assertNotCollecting(m: MatchRow, accountId: string): Promise<void> {
  const w = await openCollectionWindow(ownCardId(m, accountId));
  if (w) {
    const secs = Math.max(1, Math.ceil((new Date(w.until).getTime() - Date.now()) / 1000));
    throw new OsbError('STAGE_LOCKED', {
      human_action:
        'Your collection window is still open on this card: review the interest that has arrived, then close the window early (or let it lapse) before proceeding with a chosen counterpart.',
      retry_after: secs,
    });
  }
}

/**
 * Holder's explicit early-close (agent 'close_collection' action or the
 * counter button). Idempotent; closing is terminal.
 */
export async function closeCollection(
  matchId: string,
  accountId: string,
  recordedVia: string,
): Promise<{ closed: boolean }> {
  const m = await loadOpenMatchFor(matchId, accountId);
  return closeCollectionByCard(ownCardId(m, accountId), accountId, recordedVia);
}

export async function closeCollectionByCard(
  cardId: string,
  accountId: string,
  recordedVia: string,
): Promise<{ closed: boolean }> {
  const card = await getCard(cardId);
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('card not found'), { notFound: true });
  }
  const r = await getPool().query(
    `UPDATE cards SET collect_closed_at = now(), updated_at = now()
     WHERE id = $1 AND collect_until IS NOT NULL AND collect_closed_at IS NULL
       AND collect_until > now()
     RETURNING id`,
    [cardId],
  );
  if (r.rowCount) {
    await writeConsentEvent({
      event: 'collection-early-close',
      card_id: cardId,
      account_id: accountId,
      recorded_via: recordedVia,
    });
  }
  return { closed: !!r.rowCount };
}

// ---------------------------------------------------------------------------
// Match-quality verdicts: one tap, 'good-call' | 'not-for-me', per human per
// match. Simple documented model (no ML):
//   - the verdict row is stored (match_verdicts, unique per human+match);
//   - 'not-for-me' additionally (a) mutes the account pairing so the matcher
//     never pairs these two accounts again, (b) declines the match if still
//     open (reasonless, as all declines are), and (c) nudges the verdict-
//     giver's personal threshold up by +0.01 (cap +0.10 over the 0.75 base);
//   - 'good-call' relaxes the personal threshold by -0.01 (floor 0).
// ---------------------------------------------------------------------------
export async function recordVerdict(
  matchId: string,
  accountId: string,
  verdict: 'good-call' | 'not-for-me',
  recordedVia: string,
): Promise<{ match_id: string; verdict: string }> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('match not found'), { notFound: true });
  sideOf(m, accountId); // throws notFound if not a party
  const pool = getPool();
  await pool.query(
    `INSERT INTO match_verdicts (match_id, account_id, verdict, recorded_via)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (match_id, account_id) DO UPDATE SET verdict = $3, created_at = now()`,
    [matchId, accountId, verdict, recordedVia],
  );
  if (verdict === 'not-for-me') {
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
  return { match_id: matchId, verdict };
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

async function loadOpenMatchFor(matchId: string, accountId: string): Promise<MatchRow> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('match not found'), { notFound: true });
  sideOf(m, accountId); // throws notFound if not a party
  if (m.state === 'declined' || m.state === 'closed') {
    // A closed match discloses nothing further; declines carry no reason.
    throw new OsbError('STAGE_LOCKED');
  }
  return m;
}

/** Record stage-1 interest for the calling side. Advances stage to 2 when mutual. */
export async function expressInterest(matchId: string, accountId: string): Promise<MatchRow> {
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
  if (updated.interest_want && updated.interest_have && updated.stage < 2) {
    const r2 = await getPool().query(
      `UPDATE matches SET stage = 2, updated_at = now() WHERE id = $1 RETURNING *`,
      [matchId],
    );
    return r2.rows[0];
  }
  return updated;
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
    throw new OsbError('STAGE_LOCKED', {
      human_action: 'Both sides must first express interest at stage 1.',
    });
  }
  // Collection window: while the caller's OWN card is contested and still
  // collecting, the holder cannot commit to one counterpart. (The other,
  // non-holder side is unaffected - and never told a contest exists.)
  await assertNotCollecting(m, accountId);
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
  const n = await stage3OptinCount(matchId);
  if (n >= 2 && m.stage < 3) {
    await getPool().query(`UPDATE matches SET stage = 3, updated_at = now() WHERE id = $1`, [
      matchId,
    ]);
  }
  const updated = (await getMatch(matchId))!;
  return { match: updated, both: n >= 2 };
}

/** Decline: closes the match. NO reason is recorded on the wire (anti-probing). */
export async function declineMatch(matchId: string, accountId: string): Promise<void> {
  await loadOpenMatchFor(matchId, accountId);
  await getPool().query(
    `UPDATE matches SET state = 'declined', updated_at = now() WHERE id = $1`,
    [matchId],
  );
}

// ---------------------------------------------------------------------------
// Stage payload builders. Every payload is validated OUTBOUND against its
// protocol schema before being returned (assertOutbound) — the disclosure
// schemas have additionalProperties:false and no price-band slot, so a leak
// is structurally impossible on this path.
// ---------------------------------------------------------------------------

export async function buildSignal(m: MatchRow, accountId: string) {
  const side = sideOf(m, accountId);
  return assertOutbound('match.signal', {
    schema_version: SCHEMA_VERSION,
    kind: 'match.signal' as const,
    match_id: m.id,
    score: Math.max(0, Math.min(1, m.score)),
    category: m.category,
    counterparty_type: side === 'want' ? ('HAVE' as const) : ('WANT' as const),
  });
}

export async function buildAttributes(m: MatchRow, accountId: string) {
  if (m.state !== 'open') throw new OsbError('STAGE_LOCKED');
  if (m.stage < 2) {
    throw new OsbError('STAGE_LOCKED', {
      human_action: 'Stage 2 unlocks when both sides have expressed interest.',
    });
  }
  const side = sideOf(m, accountId);
  const counterCardId = side === 'want' ? m.card_have : m.card_want;
  const card = await getCard(counterCardId);
  if (!card) throw new Error('counterparty card missing');
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');
  const payload: any = {
    schema_version: SCHEMA_VERSION,
    kind: 'match.attributes' as const,
    match_id: m.id,
    attributes: card.attributes ?? {},
  };
  // Only the deliberate, disclosable ask ever crosses — never the price band.
  if (card.type === 'HAVE' && card.ask) payload.ask = card.ask;
  return assertOutbound('match.attributes', payload);
}

export async function buildMutual(
  cfg: Config,
  m: MatchRow,
  accountId: string,
  ownProfile?: SharedProfile,
) {
  if (m.state !== 'open') throw new OsbError('STAGE_LOCKED');
  // HARD GATE: stage-3 data is NEVER returned without BOTH humans' recorded
  // opt-in tokens. The check queries consent_tokens directly — not the stage
  // column — so a bug elsewhere cannot open the gate.
  const optins = await stage3OptinCount(m.id);
  if (optins < 2 || m.stage < 3) {
    throw new OsbError('STAGE_LOCKED', {
      human_action:
        'Mutual disclosure needs both humans to opt in. Ask your human to approve stage-3 disclosure.',
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
  return assertOutbound('match.mutual', {
    schema_version: SCHEMA_VERSION,
    kind: 'match.mutual' as const,
    match_id: m.id,
    counterparty,
    optin: {
      both_recorded: true as const,
      recorded_at: new Date(optinRow.rows[0].at).toISOString(),
    },
  });
}

export async function openChannel(matchId: string, accountId: string) {
  const m = await loadOpenMatchFor(matchId, accountId);
  await assertNotCollecting(m, accountId); // holder commits only after the window
  const optins = await stage3OptinCount(m.id);
  if (optins < 2 || m.stage < 3) {
    throw new OsbError('STAGE_LOCKED', {
      human_action: 'A channel can open only after both humans opt in to mutual disclosure.',
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
  return assertOutbound('channel.open', {
    schema_version: SCHEMA_VERSION,
    kind: 'channel.open' as const,
    match_id: m.id,
    channel: { medium: 'in-app' as const, channel_id: channelId },
    opened_at: new Date(openedAt!).toISOString(),
  });
}

/**
 * Fetch one specific stage payload for a match. Throws STAGE_LOCKED when the
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
  if (!m) throw Object.assign(new Error('match not found'), { notFound: true });
  sideOf(m, accountId);
  switch (stage) {
    case 1:
      if (m.state !== 'open') throw new OsbError('STAGE_LOCKED');
      return buildSignal(m, accountId);
    case 2:
      return buildAttributes(m, accountId);
    case 3:
      return buildMutual(cfg, m, accountId);
    default:
      throw Object.assign(new Error(`stage must be 1, 2 or 3 (channel.open via open_channel)`), {
        validation: ['stage'],
      });
  }
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
  // The caller's own profile is the same for every match in the list, so it is
  // read at most once for the whole sweep (one audit line, not fifty).
  let own: SharedProfile | undefined;
  const ownProfile = async (): Promise<SharedProfile> =>
    (own ??= await readSharedProfile(accountId, {
      purpose: 'stage3-own-profile-check',
      actor: accountId,
    }));
  for (const m of r.rows as MatchRow[]) {
    if (m.state !== 'open') {
      out.push({ match_id: m.id, state: m.state });
      continue;
    }
    const entry: any = {
      match_id: m.id,
      state: 'open',
      stage_unlocked: m.stage,
      signal: await buildSignal(m, accountId),
    };
    // Collection-window info is shown ONLY to the holder (the side whose OWN
    // card is contested). A rival's view carries no trace of the contest.
    const w = await openCollectionWindow(ownCardId(m, accountId));
    if (w) {
      entry.collection = {
        collecting: true,
        until: new Date(w.until).toISOString(),
        interested_parties: w.interestedParties,
      };
    }
    // A match that has reached stage 4 names its channel here, so an agent
    // polling for matches already knows where to collect from. How many
    // messages are waiting is counted once for the whole sweep, in the tool
    // layer, alongside the sentence written for the human.
    if (m.stage >= 4 && m.channel_id) entry.channel = { channel_id: m.channel_id };
    if (m.stage >= 2) entry.attributes = await buildAttributes(m, accountId);
    if (m.stage >= 3) {
      try {
        entry.mutual = await buildMutual(cfg, m, accountId, await ownProfile());
      } catch (e) {
        if (!(e instanceof OsbError)) throw e;
        // A stage-3 reveal that is only waiting on someone's first name and
        // area is worth saying out loud, so the agent can relay the one thing
        // its human has to do.
        if (e.payload.code === 'CONSENT_REQUIRED') entry.mutual_blocked = e.payload;
      }
    }
    out.push(entry);
  }
  return out;
}
