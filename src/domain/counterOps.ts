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
  await getPool().query('UPDATE accounts SET blind_mode = $2 WHERE id = $1', [accountId, on]);
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
  }));
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
