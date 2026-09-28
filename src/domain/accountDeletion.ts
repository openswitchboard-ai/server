/**
 * DELETE MY ACCOUNT (founder decision, 28 September 2026).
 *
 * Until today the privacy and terms pages said "email us and we delete it",
 * because nothing in the code closed an account. This is the thing that does,
 * pressed by the person themselves on their own Settings page, behind a fresh
 * PIN or passkey (credentials.ts, ACCOUNT_DELETE_ACTION).
 *
 * WHAT IT DOES, IN ORDER.
 *
 *   1. The consent log is written first, the way every consent-bearing act on
 *      this switchboard is: the WORM record says this person deleted their
 *      account, when, and from where.
 *   2. Every credential that is already out in the world is pulled back: the
 *      browser sessions, the OAuth codes and tokens, the agent keys. The rows
 *      are deleted outright, so an agent holding one gets the ordinary
 *      "A valid access token is required." and a refresh gets
 *      "unknown-refresh-token" — neither says anything about the account.
 *      Unused approval links are expired. This comes before the tidying so
 *      nothing can be posted into the gap while it runs.
 *   3. Every live want and have comes down through the ordinary withdraw, so
 *      the other side reads the ordinary taken-down sentence and nothing more.
 *   4. Every introduction still open is closed the ordinary way: one that never
 *      reached a conversation is declined (reasonless, as every decline is),
 *      and a conversation is filed away as an archive files it.
 *   5. One confirmation email goes to the address, before it is erased. It is
 *      an exempt template, keyed on the account, so it is sent once.
 *   6. In ONE transaction: the account is marked deleted and everything it
 *      holds that safety and the law do not need is erased (the table below).
 *
 * Idempotent: an account already marked deleted comes straight back with
 * `already: true` and nothing is run twice. A run that stops half way is run
 * again from the top, and each step is safe to repeat.
 *
 * One thing refuses it: a payment still under way. Money that is held for
 * somebody else has to finish first, and the person is told so plainly.
 *
 * TABLE BY TABLE. Every table that points at accounts, and every table that
 * holds something an account put there, with what deletion does to it.
 * "Held" means a safety hold: the account is suspended, named in a report or a
 * safety review, has a photo in quarantine, or has a ledger entry preserved
 * under lawful process — or, for one introduction, that introduction has any
 * of those against it.
 *
 *   accounts ................ KEEP the row (reports, settlements, matches and
 *                             consent tokens point at it). ERASE: email (the
 *                             sealed address is re-sealed as empty, email_hash
 *                             becomes 'deleted:<id>', email_hash_v2 emptied),
 *                             first name, suburb, time zone, arrangement, PIN
 *                             hash and its lockout state, the old login code
 *                             hash, blind mode, business flag, kill switch.
 *                             Email dials set to off. status 'deleted' and
 *                             deleted_at set. KEEP: suspended_at and its
 *                             reason (safety), consent timestamps (legal),
 *                             the Stripe connected-account id and the data
 *                             key that opens it (money records).
 *   suspended_emails ........ KEEP. If the account is suspended, its hashes
 *                             are written here first if missing, so the
 *                             address still cannot open a new account.
 *   webauthn_credentials .... ERASE (delete rows).
 *   counter_sessions ........ ERASE (delete rows).
 *   oauth_codes ............. ERASE (delete rows).
 *   oauth_tokens ............ ERASE (delete rows): access, refresh, agent keys
 *                             and the names the person gave them.
 *   oauth_clients ........... not per account; untouched.
 *   approval_links .......... KEEP rows (spent links are the press record);
 *                             unused ones expired now.
 *   consumed_email_tokens ... KEEP until their own expiry (stops a replay).
 *   email_verifications ..... ERASE rows for the address (both hashes).
 *   email_sends ............. KEEP the send log; ERASE the address hash on
 *                             this account's rows ('erased').
 *   email_events ............ KEEP; ERASE recipient_hashes on its rows.
 *   email_suppressions ...... KEEP (a bounce or complaint is about the
 *                             address, and protects the sender reputation).
 *   cards ................... Live ones WITHDRAWN (step 3). Rows KEPT, because
 *                             matches point at them. ERASE the words, figures
 *                             and place: kind, attributes, ask, price band, mandate,
 *                             embedding, other words, not-these, as-posted
 *                             category, screened content, geo point and area
 *                             — except on a card that is held.
 *   near_misses ............. ERASE rows on this account's cards.
 *   jev_shadow .............. ERASE rows on this account's cards (eval data
 *                             that quotes the posting).
 *   matches ................. KEEP rows (the other person's record, reports
 *                             point at them). Open ones closed (step 4).
 *   match_verdicts .......... KEEP (a judgement on a pairing; no personal data).
 *   match_mutes ............. ERASE the mutes this account set. KEEP mutes
 *                             other people set on it (their choice).
 *   not_the_thing ........... KEEP (engine evidence; numbers only).
 *   consent_tokens .......... KEEP (legal record of a consent).
 *   offers .................. KEEP (money and negotiation record). Pending
 *                             ones this account made are withdrawn; the
 *                             message words erased unless held.
 *   offer_drafts ............ ERASE.
 *   settlements,
 *   settlement_evidence,
 *   stripe_events ........... KEEP (money records).
 *   channel_messages ........ Expired now, so the ordinary sweep clears them
 *                             (a delivery queue; the safety copy is the
 *                             ledger).
 *   conversation_photos ..... Expired now, so the sweep deletes the bytes —
 *                             except on a held introduction.
 *   channel_send_rate,
 *   channel_notify,
 *   conversation_windows,
 *   read_calls, write_calls,
 *   publish_events,
 *   posting_references,
 *   shelf_attempts,
 *   category_misses ......... ERASE (counters, rate limits and the words a
 *                             posting was asked about).
 *   shelf_gaps .............. KEEP; with shelf_attempts gone nothing links a
 *                             row back to the account.
 *   ledger_entries .......... KEEP until the normal thirty-day expiry, or a
 *                             lawful preservation.
 *   reports ................. KEEP (both as reporter and as reported).
 *   safety_reviews .......... KEEP.
 *   photo_quarantine ........ KEEP.
 *   reputation .............. KEEP (probing flags; no personal data).
 *   pulse_aggregates ........ aggregate; untouched.
 *   the consent log (WORM) .. KEEP, and the deletion is written to it.
 *   the decrypt audit (WORM)  KEEP.
 */
import { getPool } from '../db.js';
import { encryptField, writeConsentEvent } from '../crypto.js';
import { emailHashes, getAccount } from './accounts.js';
import type { Config } from '../config.js';

export interface DeletionOutcome {
  account_id: string;
  /** True where the account was already deleted: nothing ran. */
  already: boolean;
  postings_withdrawn: number;
  introductions_closed: number;
  /** What happened to the one confirmation email. */
  email: 'sent' | 'duplicate' | 'suppressed' | 'failed' | 'no-address' | 'not-configured';
  /** Whether a safety hold kept anything back. */
  held: boolean;
}

/** Refused because money held for somebody else has to finish first. */
export class PaymentUnderWay extends Error {
  readonly paymentUnderWay = true;
  constructor() {
    super('a payment is still under way');
  }
}

/** Settlement states in which nothing is held and nothing is owed. */
const SETTLED_STATES = ['released', 'refunded', 'settled-split', 'declined'];

/** Whether this account is party to a payment still under way. */
export async function paymentUnderWay(accountId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT 1 FROM settlements
      WHERE (buyer_account = $1 OR seller_account = $1)
        AND state <> ALL($2::text[])
      LIMIT 1`,
    [accountId, SETTLED_STATES],
  );
  return !!r.rowCount;
}

/** Is the whole account under a safety hold? */
async function accountHeld(accountId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT (a.suspended_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM reports WHERE reported_account = $1)
         OR EXISTS (SELECT 1 FROM safety_reviews WHERE sender_account = $1)
         OR EXISTS (SELECT 1 FROM photo_quarantine
                     WHERE sender_account = $1 AND status IN ('held', 'referred'))
         OR EXISTS (SELECT 1 FROM ledger_entries
                     WHERE sender_account = $1 AND preserved_until > now()) AS held
       FROM accounts a WHERE a.id = $1`,
    [accountId],
  );
  return !!r.rows[0]?.held;
}

/** The introductions this account is party to that carry a safety hold. */
async function heldIntroductions(accountId: string): Promise<string[]> {
  const r = await getPool().query(
    `SELECT m.id FROM matches m
      WHERE (m.account_want = $1 OR m.account_have = $1)
        AND (EXISTS (SELECT 1 FROM reports r WHERE r.match_id = m.id)
          OR EXISTS (SELECT 1 FROM safety_reviews v WHERE v.match_id = m.id)
          OR EXISTS (SELECT 1 FROM photo_quarantine q WHERE q.match_id = m.id)
          OR EXISTS (SELECT 1 FROM ledger_entries l
                      WHERE l.match_id = m.id AND l.preserved_until > now()))`,
    [accountId],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

async function livePostings(accountId: string): Promise<string[]> {
  const r = await getPool().query(
    `SELECT id FROM cards
      WHERE account_id = $1 AND lifecycle_state IN ('PENDING_SCREENING', 'PUBLISHED')`,
    [accountId],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

async function openIntroductions(
  accountId: string,
): Promise<{ id: string; conversation: boolean }[]> {
  const r = await getPool().query(
    `SELECT id, (channel_id IS NOT NULL AND stage >= 4) AS conversation FROM matches
      WHERE (account_want = $1 OR account_have = $1) AND state = 'open'`,
    [accountId],
  );
  return (r.rows as { id: string; conversation: boolean }[]).map((x) => ({
    id: x.id,
    conversation: !!x.conversation,
  }));
}

/**
 * Delete an account. `recordedVia` is where the press came from ('counter'
 * for the person's own page, 'operator' for a request by email).
 */
export async function deleteAccount(
  accountId: string,
  cfg: Config | undefined,
  recordedVia = 'counter',
): Promise<DeletionOutcome> {
  const account: any = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { notFound: true });
  const base = { account_id: accountId, postings_withdrawn: 0, introductions_closed: 0 };
  if (account.status === 'deleted') {
    return { ...base, already: true, email: 'duplicate', held: false };
  }
  if (await paymentUnderWay(accountId)) throw new PaymentUnderWay();

  const pool = getPool();

  // 1. The record, first.
  await writeConsentEvent({
    event: 'account-deleted',
    account_id: accountId,
    recorded_via: recordedVia,
  });

  // 2. Everything already out in the world, pulled back before the tidying.
  await pool.query('DELETE FROM counter_sessions WHERE account_id = $1', [accountId]);
  await pool.query('DELETE FROM oauth_codes WHERE account_id = $1', [accountId]);
  await pool.query('DELETE FROM oauth_tokens WHERE account_id = $1', [accountId]);
  await pool.query(
    `UPDATE approval_links SET expires_at = now()
      WHERE account_id = $1 AND used_at IS NULL AND expires_at > now()`,
    [accountId],
  );

  // 3. Every live want and have, the ordinary way.
  const { withdrawIntent } = await import('./cards.js');
  let postings_withdrawn = 0;
  for (const id of await livePostings(accountId)) {
    try {
      await withdrawIntent(accountId, id, cfg);
      postings_withdrawn += 1;
    } catch {
      // One that will not come down does not stop the rest; the erase below
      // takes its words off it regardless.
    }
  }

  // 4. Every introduction still open, the ordinary way.
  const { archiveMatch, declineMatch } = await import('./matches.js');
  let introductions_closed = 0;
  for (const m of await openIntroductions(accountId)) {
    try {
      if (m.conversation) await archiveMatch(m.id, accountId, 'account-deleted', cfg);
      else await declineMatch(m.id, accountId, cfg);
      introductions_closed += 1;
    } catch {
      /* already closed by the other side in the meantime */
    }
  }

  // 5. The one email, before the address goes.
  let email: DeletionOutcome['email'] = 'not-configured';
  let address: string | undefined;
  try {
    const { accountEmail } = await import('./counterOps.js');
    address = (await accountEmail(accountId, 'account-deleted-confirmation'))?.trim() || undefined;
  } catch {
    address = undefined;
  }
  if (!address) email = 'no-address';
  else if (cfg) {
    try {
      const { sendAccountDeletedEmail } = await import('../counter/email.js');
      const r = await sendAccountDeletedEmail(cfg, address, accountId);
      email = r.status === 'sent' ? 'sent' : r.status === 'duplicate' ? 'duplicate' : r.status === 'failed' ? 'failed' : 'suppressed';
    } catch {
      // A failed send does not keep an account open that the person asked to
      // close. The outcome says so.
      email = 'failed';
    }
  }

  // A suspended account's address stays refused after the address is gone.
  // suspendAccount wrote it already; this is the floor under a write that
  // failed then.
  if (account.suspended_at && address) {
    const eh = emailHashes(address);
    await pool.query(
      `INSERT INTO suspended_emails (email_hash, email_hash_v2) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [eh.v1, eh.v2],
    );
  }

  // 6. The erase, in one transaction.
  const held = await accountHeld(accountId);
  const heldMatches = held ? [] : await heldIntroductions(accountId);
  const wrapped: Buffer = account.data_key_enc;
  const [emptyEmail, emptyName, emptyLocality] = await Promise.all([
    encryptField(accountId, wrapped, '', 'email'),
    encryptField(accountId, wrapped, '', 'first_name'),
    encryptField(accountId, wrapped, '', 'locality'),
  ]);
  const hashes = address ? emailHashes(address) : undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (sql: string, params: unknown[] = [accountId]) => client.query(sql, params);

    await q(
      `UPDATE accounts SET
          status = 'deleted', deleted_at = now(),
          email_hash = 'deleted:' || id::text, email_hash_v2 = NULL,
          email_enc = $2, first_name_enc = $3, locality_enc = $4,
          login_code_hash = NULL,
          pin_hash = NULL, pin_set_at = NULL, pin_failed_attempts = 0,
          pin_locked_until = NULL, pin_money_from = NULL,
          timezone = NULL, arrangement = NULL, arrangement_updated_at = NULL,
          email_freq_matches = 'off', email_freq_digests = 'off',
          blind_mode = false, is_business = false, kill_switch_at = NULL
        WHERE id = $1 AND status <> 'deleted'`,
      [accountId, emptyEmail, emptyName, emptyLocality],
    );

    // Credentials, again inside the transaction, for anything minted while
    // the tidying ran.
    await q('DELETE FROM webauthn_credentials WHERE account_id = $1');
    await q('DELETE FROM counter_sessions WHERE account_id = $1');
    await q('DELETE FROM oauth_codes WHERE account_id = $1');
    await q('DELETE FROM oauth_tokens WHERE account_id = $1');

    // Counters, limits and working state.
    await q('DELETE FROM offer_drafts WHERE account_id = $1');
    await q('DELETE FROM channel_send_rate WHERE sender_account = $1');
    await q('DELETE FROM channel_notify WHERE recipient_account = $1');
    await q('DELETE FROM conversation_windows WHERE account_id = $1');
    await q('DELETE FROM read_calls WHERE account_id = $1');
    await q('DELETE FROM write_calls WHERE account_id = $1');
    await q('DELETE FROM publish_events WHERE account_id = $1');
    await q('DELETE FROM posting_references WHERE account_id = $1');
    await q('DELETE FROM shelf_attempts WHERE account_id = $1');
    await q('DELETE FROM category_misses WHERE account_id = $1');
    await q('DELETE FROM match_mutes WHERE account_id = $1');

    // The address, wherever it sits as a hash.
    if (hashes) {
      await q('DELETE FROM email_verifications WHERE email_hash = $1 OR email_hash = $2', [
        hashes.v2,
        hashes.v1,
      ]);
    }
    await q(`UPDATE email_sends SET email_hash = 'erased' WHERE account_id = $1`);
    await q('UPDATE email_events SET recipient_hashes = NULL WHERE account_id = $1');

    // Offers: the pending ones withdrawn. Their words come off below.
    await q(
      `UPDATE offers SET state = 'withdrawn', updated_at = now()
        WHERE proposer_account = $1 AND state IN ('proposed', 'awaiting-human')`,
    );

    // Engine and eval rows that quote the postings.
    await q(
      `DELETE FROM near_misses
        WHERE card_want IN (SELECT id FROM cards WHERE account_id = $1)
           OR card_have IN (SELECT id FROM cards WHERE account_id = $1)`,
    );
    await q(
      `DELETE FROM jev_shadow
        WHERE card_id IN (SELECT id FROM cards WHERE account_id = $1)
           OR other_card_id IN (SELECT id FROM cards WHERE account_id = $1)`,
    );

    // Conversations: whatever is still queued goes on the next sweep.
    await q(
      `UPDATE channel_messages SET expires_at = now()
        WHERE (sender_account = $1 OR recipient_account = $1) AND expires_at > now()`,
    );

    if (!held) {
      // The words on this account's offers, except on an introduction under a
      // hold. The figures and dates stay: they are the money record.
      await q(
        `UPDATE offers SET message = NULL
          WHERE proposer_account = $1 AND message IS NOT NULL
            AND NOT (match_id = ANY($2::uuid[]))`,
        [accountId, heldMatches],
      );
      // The words, figures and place of every posting, except those on an
      // introduction under a hold.
      await q(
        `UPDATE cards SET
            kind = NULL, attributes = '{}'::jsonb, ask = NULL,
            price_enc = NULL, mandate_enc = NULL,
            embedding = NULL, also_called = NULL, not_these = NULL,
            category_as_posted = NULL, screened_content = NULL,
            geo = '{}'::jsonb, geo_lat = NULL, geo_lon = NULL,
            geo_radius_km = NULL, geo_country = NULL,
            updated_at = now()
          WHERE account_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM matches m
               WHERE (m.card_want = cards.id OR m.card_have = cards.id)
                 AND m.id = ANY($2::uuid[]))`,
        [accountId, heldMatches],
      );
      await q(
        `UPDATE conversation_photos SET expires_at = now()
          WHERE (sender_account = $1 OR recipient_account = $1)
            AND expires_at > now()
            AND NOT (match_id = ANY($2::uuid[]))`,
        [accountId, heldMatches],
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    ...base,
    already: false,
    postings_withdrawn,
    introductions_closed,
    email,
    held: held || heldMatches.length > 0,
  };
}
