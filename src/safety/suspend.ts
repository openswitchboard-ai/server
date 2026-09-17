/**
 * Suspension: the account flag, and everything that follows from it
 * (docs/trust-and-safety.md, "Enforcement" and "Telling their assistant").
 *
 * Nothing in, nothing out, at every door. What suspending actually does, in
 * one act, is four things:
 *
 *   1. the flag goes on, which is what every door and every tool call reads;
 *   2. every live want and have of theirs comes down, through the ordinary
 *      withdraw — so nobody new is introduced to something that can no longer
 *      be answered, and the introductions that never reached a conversation are
 *      filed away the way a withdrawal always files them;
 *   3. every open introduction is SEVERED, and the person on the other side is
 *      told only that the switchboard closed the conversation;
 *   4. every credential already out in the world is pulled back: the browser
 *      sessions deleted, the agents' refresh tokens suspended. The flag alone
 *      shuts a door when somebody knocks on it; these are the things holding
 *      keys that were never going to knock;
 *   5. the email hash is remembered, so opening a fresh account on the same
 *      address is refused. Suspending somebody who can sign up again five
 *      minutes later is a gesture rather than an enforcement.
 *
 * WHAT IS NOT HERE. Nothing reads or deletes what the account already put in
 * the ledger: the thirty-day window and the two-keyholder ceremony are the only
 * roads to that, and a suspension is not one of them. And nothing here emails
 * anybody: what a suspended person is told, and by whom, is a decision for the
 * operator rather than a side effect of a flag going on.
 */
import { dbConfigured, getPool } from '../db.js';
import { emailHash, getAccount } from '../domain/accounts.js';
import { decryptFields } from '../crypto.js';
import type { Config } from '../config.js';

export { SUSPENDED_WORDS } from '../intake/checks/suspended.js';

/**
 * Is this account stopped?
 *
 * One small indexed read, and it runs at the top of every tool call and at
 * every door, so it is kept to exactly that: one column, by primary key.
 * Deliberately NOT cached — a suspension that takes effect on the next process
 * restart is not a suspension, and an operator stopping an account in the
 * middle of something needs it to bite now.
 */
export async function isSuspended(accountId: string): Promise<boolean> {
  if (!accountId) return false;
  // A process with no database at all — the harnesses that exercise the pipe's
  // own logic — has no suspensions in it either. A database that is THERE and
  // failing is a different thing entirely and is left to throw, which the pipe
  // reads as a hold: "could not look" is never "looked and found nothing".
  if (!dbConfigured()) return false;
  const r = await getPool().query('SELECT suspended_at FROM accounts WHERE id = $1', [accountId]);
  return !!r.rows[0]?.suspended_at;
}

/** Is this address one a suspended account was opened under? */
export async function emailIsSuspended(email: string): Promise<boolean> {
  const r = await getPool().query('SELECT 1 FROM suspended_emails WHERE email_hash = $1', [
    emailHash(email),
  ]);
  return !!r.rowCount;
}

export interface SuspensionOutcome {
  account_id: string;
  /** False where the account was already suspended: the rest still runs. */
  newly_suspended: boolean;
  postings_withdrawn: number;
  introductions_severed: number;
  email_remembered: boolean;
}

/** The live wants and haves of an account, which are the ones to take down. */
async function livePostings(accountId: string): Promise<string[]> {
  const r = await getPool().query(
    `SELECT id FROM cards
      WHERE account_id = $1 AND lifecycle_state IN ('PENDING_SCREENING', 'PUBLISHED')`,
    [accountId],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** The open introductions an account is a party to, either side. */
async function openIntroductions(accountId: string): Promise<string[]> {
  const r = await getPool().query(
    `SELECT id FROM matches
      WHERE (account_want = $1 OR account_have = $1) AND state = 'open'`,
    [accountId],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/**
 * The account's own address, back out of the field it is encrypted in, so the
 * hash of it can be remembered. It is the one read of a person's own details
 * this file makes, it writes the ordinary audit line, and the address itself
 * never leaves this function: what is kept is the same hash the accounts table
 * already keys on.
 *
 * A decrypt that fails is not a reason to leave an account running: the
 * suspension stands and the address is simply not remembered, which the
 * outcome says plainly so an operator can see it.
 */
async function rememberEmail(accountId: string): Promise<boolean> {
  try {
    const account = await getAccount(accountId);
    const enc = (account as unknown as { email_enc?: Buffer } | undefined)?.email_enc;
    if (!account || !enc) return false;
    const { email } = await decryptFields(
      accountId,
      account.data_key_enc,
      { email: enc },
      { purpose: 'suspension-email-hash', actor: 'operator', refs: { account_id: accountId } },
    );
    if (!email) return false;
    await getPool().query(
      `INSERT INTO suspended_emails (email_hash) VALUES ($1) ON CONFLICT DO NOTHING`,
      [emailHash(email)],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop an account. Operator-driven, and idempotent: running it again on an
 * account that is already suspended re-runs the tidying rather than refusing,
 * because the reason to run it twice is usually that something was still live.
 */
export async function suspendAccount(
  accountId: string,
  reason: string,
  cfg?: Config,
): Promise<SuspensionOutcome> {
  const pool = getPool();
  const flagged = await pool.query(
    `UPDATE accounts SET suspended_at = now(), suspended_reason = $2
      WHERE id = $1 AND suspended_at IS NULL
      RETURNING id`,
    [accountId, reason],
  );
  // The flag goes on FIRST, so that everything below happens with every door
  // already shut: nothing can be posted into the gap while the tidying runs.
  const { withdrawIntent } = await import('../domain/cards.js');
  const { severMatch } = await import('../domain/matches.js');
  let postings_withdrawn = 0;
  for (const id of await livePostings(accountId)) {
    try {
      await withdrawIntent(accountId, id, cfg);
      postings_withdrawn += 1;
    } catch {
      // One posting that will not come down does not stop the others, and it
      // is invisible to the network regardless: the flag is already on.
    }
  }
  let introductions_severed = 0;
  for (const id of await openIntroductions(accountId)) {
    // No `by`: the switchboard severed this one on its own, so the other side
    // reads the switchboard's own sentence and nothing about anybody.
    const r = await severMatch(id, undefined, cfg);
    if (r.severed) introductions_severed += 1;
  }
  // THE CREDENTIALS THAT ARE ALREADY OUT. The flag is read at every door, but
  // a door is only read when somebody knocks on it: a browser session sitting
  // in a phone and a refresh token sitting in an agent are both live things
  // the flag alone does not reach. So both go the way the kill switch sends
  // them — the sessions deleted outright, the tokens suspended rather than
  // revoked, because lifting a suspension has to be able to give them back.
  await pool.query('DELETE FROM counter_sessions WHERE account_id = $1', [accountId]);
  await pool.query('UPDATE oauth_tokens SET suspended = true WHERE account_id = $1 AND NOT revoked', [
    accountId,
  ]);
  const email_remembered = await rememberEmail(accountId);
  return {
    account_id: accountId,
    newly_suspended: !!flagged.rowCount,
    postings_withdrawn,
    introductions_severed,
    email_remembered,
  };
}

/**
 * Lift it. The flag comes off and the address is let go in the same act; what
 * came down stays down, because putting a person's wants and haves back up
 * without asking them is not the switchboard's to do.
 */
export async function liftSuspension(accountId: string): Promise<{ lifted: boolean }> {
  const pool = getPool();
  const r = await pool.query(
    `UPDATE accounts SET suspended_at = NULL, suspended_reason = NULL
      WHERE id = $1 AND suspended_at IS NOT NULL
      RETURNING id`,
    [accountId],
  );
  const account = await getAccount(accountId);
  const enc = (account as unknown as { email_enc?: Buffer } | undefined)?.email_enc;
  if (account && enc) {
    try {
      const { email } = await decryptFields(
        accountId,
        account.data_key_enc,
        { email: enc },
        {
          purpose: 'suspension-lifted-email-hash',
          actor: 'operator',
          refs: { account_id: accountId },
        },
      );
      if (email) {
        await pool.query('DELETE FROM suspended_emails WHERE email_hash = $1', [emailHash(email)]);
      }
    } catch {
      /* the flag is off either way */
    }
  }
  return { lifted: !!r.rowCount };
}
