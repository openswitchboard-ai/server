/**
 * Counter-side (human) domain operations: registration spine, kill switch,
 * ledger reads, pending approvals, human offer decline. Consent-bearing
 * transitions write to the WORM consent log FIRST.
 */
import { getPool } from '../db.js';
import { decryptFields, encryptField, generateAccountDataKey, writeConsentEvent } from '../crypto.js';
import { emailHash, getAccount } from './accounts.js';
import type { Config } from '../config.js';

/** Create a 'pending' account at email-verification time (counter registration). */
export async function createPendingAccount(email: string): Promise<{ id: string; status: string }> {
  const pool = getPool();
  const eh = emailHash(email);
  const existing = await pool.query('SELECT id, status FROM accounts WHERE email_hash = $1', [eh]);
  if (existing.rowCount) return existing.rows[0];
  const idRow = await pool.query('SELECT gen_random_uuid() AS id');
  const id = idRow.rows[0].id as string;
  const wrapped = await generateAccountDataKey(id);
  const [emailEnc, nameEnc, locEnc] = await Promise.all([
    encryptField(id, wrapped, email),
    encryptField(id, wrapped, ''),
    encryptField(id, wrapped, ''),
  ]);
  await pool.query(
    `INSERT INTO accounts (id, email_hash, email_enc, first_name_enc, locality_enc, data_key_enc, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [id, eh, emailEnc, nameEnc, locEnc, wrapped],
  );
  await pool.query('INSERT INTO reputation (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return { id, status: 'pending' };
}

export async function setAccountPin(accountId: string, pinHash: string): Promise<void> {
  await getPool().query(
    `UPDATE accounts SET pin_hash = $2, pin_set_at = now(),
       pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`,
    [accountId, pinHash],
  );
}

/**
 * The registration consent step: 18+ assertion + the consent statement.
 * WORM event first; only then does the account go live.
 * Returns the WORM object key.
 */
export async function activateAccountWithConsent(
  accountId: string,
  consentStatement: string,
): Promise<string> {
  const key = await writeConsentEvent({
    event: 'registration-consent',
    account_id: accountId,
    adult_asserted: true,
    consent_statement: consentStatement,
    recorded_via: 'counter',
  });
  await getPool().query(
    `UPDATE accounts SET status = 'active', adult_asserted_at = now(), consented_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [accountId],
  );
  return key;
}

/** Decrypt the account's own email for sending it mail (audit-logged). */
export async function accountEmail(accountId: string, purpose: string): Promise<string | undefined> {
  const a = await getAccount(accountId);
  if (!a) return undefined;
  const f = await decryptFields(
    accountId,
    a.data_key_enc,
    { email: (a as any).email_enc },
    { purpose, actor: 'system' },
  );
  return f.email;
}

// ---------------------------------------------------------------------------
// Kill switch.
// ---------------------------------------------------------------------------

export async function killSwitchOn(accountId: string): Promise<void> {
  const pool = getPool();
  await writeConsentEvent({ event: 'kill-switch-on', account_id: accountId, recorded_via: 'counter' });
  await pool.query(
    `UPDATE cards SET protocol_status = 'latent', paused_by_kill_switch = true, updated_at = now()
     WHERE account_id = $1 AND protocol_status = 'active'
       AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')`,
    [accountId],
  );
  await pool.query(
    `UPDATE oauth_tokens SET suspended = true WHERE account_id = $1 AND NOT revoked`,
    [accountId],
  );
  await pool.query(`UPDATE accounts SET kill_switch_at = now() WHERE id = $1`, [accountId]);
}

export async function killSwitchOff(accountId: string): Promise<void> {
  const pool = getPool();
  await writeConsentEvent({ event: 'kill-switch-off', account_id: accountId, recorded_via: 'counter' });
  await pool.query(
    `UPDATE cards SET protocol_status = 'active', paused_by_kill_switch = false, updated_at = now()
     WHERE account_id = $1 AND paused_by_kill_switch`,
    [accountId],
  );
  await pool.query(`UPDATE oauth_tokens SET suspended = false WHERE account_id = $1`, [accountId]);
  await pool.query(`UPDATE accounts SET kill_switch_at = NULL WHERE id = $1`, [accountId]);
}

export async function setBlindMode(accountId: string, on: boolean): Promise<void> {
  await writeConsentEvent({
    event: 'blind-mode-changed',
    account_id: accountId,
    blind_mode: on,
    recorded_via: 'counter',
  });
  await getPool().query('UPDATE accounts SET blind_mode = $2 WHERE id = $1', [accountId, on]);
}

// ---------------------------------------------------------------------------
// Email frequency controls + suppression state (0.E). Consent-bearing
// changes write to the WORM consent log FIRST; every change is effective
// immediately (the send pipeline reads the row at send time).
// ---------------------------------------------------------------------------

export type EmailFrequency = 'immediate' | 'daily' | 'weekly' | 'off';
export const EMAIL_FREQUENCIES: EmailFrequency[] = ['immediate', 'daily', 'weekly', 'off'];

export interface EmailSettings {
  freqMatches: EmailFrequency;
  freqDigests: EmailFrequency;
  blindMode: boolean;
  unreachable: boolean;
  complaintSuppressed: boolean;
}

export async function emailSettings(accountId: string): Promise<EmailSettings> {
  const r = await getPool().query(
    `SELECT blind_mode, email_freq_matches, email_freq_digests,
            email_unreachable_at, email_complaint_suppressed_at
     FROM accounts WHERE id = $1`,
    [accountId],
  );
  const a = r.rows[0];
  if (!a) throw new Error('account not found');
  return {
    freqMatches: a.email_freq_matches,
    freqDigests: a.email_freq_digests,
    blindMode: !!a.blind_mode,
    unreachable: !!a.email_unreachable_at,
    complaintSuppressed: !!a.email_complaint_suppressed_at,
  };
}

export async function setEmailFrequency(
  accountId: string,
  freqMatches: EmailFrequency,
  freqDigests: EmailFrequency,
  recordedVia: string,
): Promise<void> {
  await writeConsentEvent({
    event: 'email-frequency-changed',
    account_id: accountId,
    email_freq_matches: freqMatches,
    email_freq_digests: freqDigests,
    recorded_via: recordedVia,
  });
  await getPool().query(
    `UPDATE accounts SET email_freq_matches = $2, email_freq_digests = $3 WHERE id = $1`,
    [accountId, freqMatches, freqDigests],
  );
}

/** RFC 8058 one-click unsubscribe: both non-transactional categories -> off. */
export async function unsubscribeAllNonTransactional(
  accountId: string,
  recordedVia: string,
): Promise<void> {
  await writeConsentEvent({
    event: 'email-unsubscribe',
    account_id: accountId,
    recorded_via: recordedVia,
  });
  await getPool().query(
    `UPDATE accounts SET email_freq_matches = 'off', email_freq_digests = 'off' WHERE id = $1`,
    [accountId],
  );
}

/** Human re-enables non-transactional mail after a complaint suppression. */
export async function resumeNonTransactionalEmail(accountId: string): Promise<void> {
  await writeConsentEvent({
    event: 'email-complaint-suppression-lifted',
    account_id: accountId,
    recorded_via: 'counter',
  });
  await getPool().query(
    `UPDATE accounts SET email_complaint_suppressed_at = NULL WHERE id = $1`,
    [accountId],
  );
}

/** Address re-verified at the counter after a hard bounce. */
export async function clearEmailUnreachable(accountId: string): Promise<void> {
  await writeConsentEvent({
    event: 'email-reverified',
    account_id: accountId,
    recorded_via: 'counter',
  });
  await getPool().query(`UPDATE accounts SET email_unreachable_at = NULL WHERE id = $1`, [
    accountId,
  ]);
}

/**
 * "Still true?" renew-all: every open PUBLISHED card restarts its own TTL
 * clock from now. WORM consent event first (nothing-is-forever means renewal
 * is an explicit human act). Returns the renewed cards.
 */
export async function renewAllCards(
  accountId: string,
  recordedVia: string,
): Promise<{ id: string; type: string; category: string; expires_at: Date }[]> {
  const pool = getPool();
  const open = await pool.query(
    `SELECT id FROM cards
     WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()`,
    [accountId],
  );
  if (!open.rowCount) return [];
  await writeConsentEvent({
    event: 'cards-renewed',
    account_id: accountId,
    card_ids: open.rows.map((r) => r.id),
    recorded_via: recordedVia,
  });
  const r = await pool.query(
    `UPDATE cards SET expires_at = now() + make_interval(days => ttl_days),
            renewal_notified_at = NULL, updated_at = now()
     WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
     RETURNING id, type, category, expires_at`,
    [accountId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Ledger.
// ---------------------------------------------------------------------------

export interface LedgerCard {
  id: string;
  type: 'WANT' | 'HAVE';
  category: string;
  lifecycle_state: string;
  protocol_status: string;
  attributes: any;
  ask: any;
  urgency: string;
  ttl_days: number;
  expires_at: Date;
  price?: any; // decrypted for the OWNER only, server-side, audit-logged
  matchCount: number;
  latestMatchState?: string;
  collect_window_minutes?: number | null;
  /** The stored screening verdict (cards.screening). Owner-only, by row. */
  screening?: any;
  /** Who writes this card's negotiating figures. 'relay' unless switched. */
  negotiation_mode: 'relay' | 'mandate';
}

/** Per-card collection-window override; may only SHORTEN the default. */
export async function setCollectWindowOverride(
  accountId: string,
  cardId: string,
  minutes: number | null,
): Promise<void> {
  const r = await getPool().query(
    `UPDATE cards SET collect_window_minutes = $3, updated_at = now()
     WHERE id = $1 AND account_id = $2 RETURNING id`,
    [cardId, accountId, minutes],
  );
  if (!r.rowCount) throw new Error('card not found');
}

export async function ledgerCards(cfg: Config, accountId: string): Promise<LedgerCard[]> {
  const pool = getPool();
  const account = await getAccount(accountId);
  if (!account) return [];
  const r = await pool.query(
    `SELECT c.*, (SELECT count(*)::int FROM matches m WHERE m.card_want = c.id OR m.card_have = c.id) AS match_count
     FROM cards c WHERE c.account_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
    [accountId],
  );
  // One decrypt OPERATION (one WORM audit line) for the whole ledger view.
  const encrypted: Record<string, Buffer> = {};
  for (const row of r.rows) if (row.price_enc) encrypted[row.id] = row.price_enc;
  let bands: Record<string, string> = {};
  if (Object.keys(encrypted).length) {
    bands = await decryptFields(accountId, account.data_key_enc, encrypted, {
      purpose: 'counter-ledger-view',
      actor: accountId,
    });
  }
  return r.rows.map((row: any) => ({
    id: row.id,
    type: row.type,
    category: row.category,
    lifecycle_state: row.lifecycle_state,
    protocol_status: row.protocol_status,
    attributes: row.attributes,
    ask: row.ask,
    urgency: row.urgency,
    ttl_days: row.ttl_days,
    expires_at: row.expires_at,
    price: bands[row.id] ? JSON.parse(bands[row.id]) : undefined,
    matchCount: row.match_count,
    collect_window_minutes: row.collect_window_minutes,
    screening: row.screening,
    negotiation_mode: row.negotiation_mode === 'mandate' ? 'mandate' : 'relay',
  }));
}

/**
 * Cards of this account's that screening turned away and that are still
 * sitting rejected. These are attention items on the approval page: a card in
 * this state is off the board until the person edits it.
 */
export interface RejectedCard {
  id: string;
  category: string;
  screening: any;
}

export async function screeningRejectedCards(accountId: string): Promise<RejectedCard[]> {
  const r = await getPool().query(
    `SELECT id, category, screening FROM cards
     WHERE account_id = $1 AND lifecycle_state = 'SCREENING_REJECTED'
     ORDER BY updated_at DESC LIMIT 20`,
    [accountId],
  );
  return r.rows as RejectedCard[];
}

// ---------------------------------------------------------------------------
// Pending approvals for the dashboard: offers awaiting this human, and
// stage-2 matches still missing this human's stage-3 opt-in.
// ---------------------------------------------------------------------------

export interface PendingOffer {
  offer_id: string;
  match_id: string;
  amount: string;
  ccy: string;
  category: string;
  proposer_account: string;
}

export async function pendingOffers(accountId: string): Promise<PendingOffer[]> {
  const r = await getPool().query(
    `SELECT o.id AS offer_id, o.match_id, o.amount, o.ccy, m.category, o.proposer_account
     FROM offers o JOIN matches m ON m.id = o.match_id
     WHERE o.state = 'awaiting-human' AND o.proposer_account <> $1
       AND (m.account_want = $1 OR m.account_have = $1) AND m.state = 'open'
       AND o.expiry > now()
     ORDER BY o.created_at DESC LIMIT 20`,
    [accountId],
  );
  return r.rows;
}

export interface PendingDisclosure {
  match_id: string;
  category: string;
  counterparty_account: string;
}

export async function pendingDisclosures(accountId: string): Promise<PendingDisclosure[]> {
  const r = await getPool().query(
    `SELECT m.id AS match_id, m.category,
            CASE WHEN m.account_want = $1 THEN m.account_have ELSE m.account_want END AS counterparty_account
     FROM matches m
     WHERE (m.account_want = $1 OR m.account_have = $1)
       AND m.state = 'open' AND m.stage >= 2
       AND NOT EXISTS (SELECT 1 FROM consent_tokens t
                       WHERE t.match_id = m.id AND t.account_id = $1 AND t.kind = 'stage3-optin')
     ORDER BY m.updated_at DESC LIMIT 20`,
    [accountId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// 0.F: match-quality verdicts + collection windows on the dashboard.
// ---------------------------------------------------------------------------

export interface VerdictableMatch {
  match_id: string;
  category: string;
  score: number;
  stage: number;
  verdict?: string;
}

/** Open matches this human can pass a one-tap quality verdict on. */
export async function verdictableMatches(accountId: string): Promise<VerdictableMatch[]> {
  const r = await getPool().query(
    `SELECT m.id AS match_id, m.category, m.score, m.stage, v.verdict
     FROM matches m
     LEFT JOIN match_verdicts v ON v.match_id = m.id AND v.account_id = $1
     WHERE (m.account_want = $1 OR m.account_have = $1) AND m.state = 'open'
     ORDER BY m.created_at DESC LIMIT 10`,
    [accountId],
  );
  return r.rows;
}

export interface OpenWindowView {
  card_id: string;
  category: string;
  type: string;
  until: Date;
  interested_parties: number;
}

/** This human's OWN cards with an open collection window (holder view). */
export async function openCollectionWindows(accountId: string): Promise<OpenWindowView[]> {
  const r = await getPool().query(
    `SELECT c.id AS card_id, c.category, c.type, c.collect_until AS until,
            (SELECT count(*)::int FROM matches m
             WHERE (m.card_want = c.id OR m.card_have = c.id) AND m.state = 'open')
              AS interested_parties
     FROM cards c
     WHERE c.account_id = $1 AND c.collect_until > now() AND c.collect_closed_at IS NULL
     ORDER BY c.collect_until ASC`,
    [accountId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// 1.E: the offers on one match, for the human whose match it is. This is the
// owner's own view of a negotiation — both sides' figures, and which of their
// own they typed themselves — so it is read straight from the rows rather than
// through the counterparty-facing serializer.
// ---------------------------------------------------------------------------

export interface MatchOfferRow {
  id: string;
  amount: string;
  ccy: string;
  state: string;
  expiry: Date;
  proposer_account: string;
  authored_by: 'human' | 'agent';
  message: any;
}

export interface MatchForHuman {
  match_id: string;
  category: string;
  stage: number;
  state: string;
  card_id: string;
  card_type: 'WANT' | 'HAVE';
  negotiation_mode: 'relay' | 'mandate';
}

/** The match, from the side of the human asking — or nothing if it is not theirs. */
export async function matchForHuman(
  accountId: string,
  matchId: string,
): Promise<MatchForHuman | undefined> {
  const r = await getPool().query(
    `SELECT m.id AS match_id, m.category, m.stage, m.state,
            c.id AS card_id, c.type AS card_type, c.negotiation_mode
     FROM matches m
     JOIN cards c ON c.id = CASE WHEN m.account_want = $1 THEN m.card_want ELSE m.card_have END
     WHERE m.id = $2 AND (m.account_want = $1 OR m.account_have = $1)`,
    [accountId, matchId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return { ...row, negotiation_mode: row.negotiation_mode === 'mandate' ? 'mandate' : 'relay' };
}

export async function offersOnMatch(matchId: string): Promise<MatchOfferRow[]> {
  const r = await getPool().query(
    `SELECT id, amount, ccy, state, expiry, proposer_account, authored_by, message
     FROM offers WHERE match_id = $1 ORDER BY created_at ASC LIMIT 50`,
    [matchId],
  );
  return r.rows;
}

/** Human decline of an offer at the counter. Carries NO reason, by design. */
export async function declineOfferByHuman(offerId: string, accountId: string): Promise<void> {
  const r = await getPool().query(
    `UPDATE offers o SET state = 'declined', updated_at = now()
     FROM matches m
     WHERE o.id = $1 AND m.id = o.match_id
       AND o.state IN ('proposed','awaiting-human') AND o.proposer_account <> $2
       AND (m.account_want = $2 OR m.account_have = $2)
     RETURNING o.id`,
    [offerId, accountId],
  );
  if (!r.rowCount) throw new Error('offer is not declinable by this account');
}
