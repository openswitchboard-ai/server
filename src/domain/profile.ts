/**
 * The shared profile: the first name and rough area a human agrees to hand
 * over when a match reaches stage 3, and nothing beyond that.
 *
 * Two rules hold this file together.
 *
 *  1. Identity enters the switchboard ONLY through the human's own pages.
 *     There is no agent-reachable write path here, and the service never
 *     invents a value for an empty field. An account whose profile is still
 *     empty is refused at the opt-in gate with CONSENT_REQUIRED and a link to
 *     the page where its human can fill it in.
 *  2. The fields live under the account's own envelope key like every other
 *     identity field, so reading one writes a WORM audit line first.
 *
 * Registration stays lean on purpose: nothing here is asked for at sign-up.
 * The collection happens at the consent moment, where the person can see what
 * the answer is for.
 */
import { decryptFields, encryptField, writeConsentEvent } from '../crypto.js';
import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import { getAccount } from './accounts.js';
import type { Config } from '../config.js';

export interface SharedProfile {
  firstName: string;
  locality: string;
}

export const FIRST_NAME_MAX = 40;
export const LOCALITY_MIN = 2;
export const LOCALITY_MAX = 60;

/** The one sentence every blocked path says to the human. */
export const SHARED_PROFILE_ACTION =
  "Add the first name and area you'd share, on your approval page";

/** Said to the side that has done its part and is waiting on the other one. */
export const COUNTERPARTY_PROFILE_ACTION =
  'The other side has not added the first name and area they share yet. This match opens up once they do.';

export function profileIsFilled(p: SharedProfile): boolean {
  return p.firstName.trim().length > 0 && p.locality.trim().length >= LOCALITY_MIN;
}

// ---------------------------------------------------------------------------
// Modest validation. A first name and a suburb are all this page wants, so
// anything shaped like a way to reach someone is turned away here rather than
// carried into a disclosure payload.
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/;
const WEB_ADDRESS = /(https?:\/\/|\bwww\.)/i;
const DOMAIN_TAIL = /\.(com|net|org|io|ai|co|uk|au|nz|de|fr|it|es|info|biz|xyz)\b/i;

function looksLikeAContactDetail(s: string): boolean {
  if (s.includes('@')) return true;
  if (WEB_ADDRESS.test(s) || DOMAIN_TAIL.test(s)) return true;
  if (/^\+\s*\d/.test(s)) return true;
  // A postcode is fine; a phone number is not.
  return (s.match(/\d/g) ?? []).length >= 6;
}

export type ProfileValidation =
  | { ok: true; value: SharedProfile }
  | { ok: false; error: string };

export function validateSharedProfile(input: {
  firstName: unknown;
  locality: unknown;
}): ProfileValidation {
  const firstName = String(input.firstName ?? '').trim();
  const locality = String(input.locality ?? '').trim();

  if (CONTROL_CHARS.test(firstName) || CONTROL_CHARS.test(locality)) {
    return { ok: false, error: 'Plain text only in both boxes.' };
  }
  if (!firstName) {
    return { ok: false, error: 'Add the first name you would like to share.' };
  }
  if (firstName.length > FIRST_NAME_MAX) {
    return {
      ok: false,
      error: `That first name runs past ${FIRST_NAME_MAX} characters. The short version is fine.`,
    };
  }
  if (looksLikeAContactDetail(firstName)) {
    return { ok: false, error: 'Just a first name here — no email, phone or web address.' };
  }
  if (locality.length < LOCALITY_MIN) {
    return { ok: false, error: 'Add the suburb or area you are in.' };
  }
  if (locality.length > LOCALITY_MAX) {
    return {
      ok: false,
      error: `That area runs past ${LOCALITY_MAX} characters. A suburb or town is enough.`,
    };
  }
  if (looksLikeAContactDetail(locality)) {
    return { ok: false, error: 'Just a suburb or area here — no email, phone or web address.' };
  }
  return { ok: true, value: { firstName, locality } };
}

// ---------------------------------------------------------------------------
// Storage. Same envelope pattern as every other identity field.
// ---------------------------------------------------------------------------

export interface ProfileReadContext {
  purpose: string;
  actor: string;
  refs?: Record<string, string>;
}

/** Read an account's shared profile. Empty strings come back as empty. */
export async function readSharedProfile(
  accountId: string,
  ctx: ProfileReadContext,
): Promise<SharedProfile> {
  const account = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { notFound: true });
  const fields = await decryptFields(
    accountId,
    account.data_key_enc,
    { first_name: account.first_name_enc, locality: account.locality_enc },
    ctx,
  );
  return { firstName: fields.first_name.trim(), locality: fields.locality.trim() };
}

/**
 * Write the profile the human just typed on their own page. WORM consent
 * event first (the values themselves never enter the log — only the fact that
 * this human set them, and from where).
 */
export async function saveSharedProfile(
  accountId: string,
  value: SharedProfile,
  recordedVia: string,
): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { notFound: true });
  await writeConsentEvent({
    event: 'shared-profile-set',
    account_id: accountId,
    fields: ['first_name', 'locality'],
    recorded_via: recordedVia,
  });
  const [nameEnc, locEnc] = await Promise.all([
    encryptField(accountId, account.data_key_enc, value.firstName),
    encryptField(accountId, account.data_key_enc, value.locality),
  ]);
  await getPool().query(
    'UPDATE accounts SET first_name_enc = $2, locality_enc = $3 WHERE id = $1',
    [accountId, nameEnc, locEnc],
  );
}

// ---------------------------------------------------------------------------
// The refusal. An agent that asks to opt in (or to read stage 3) for an
// account with an empty profile gets a machine-readable CONSENT_REQUIRED
// carrying the human's own approval link, because only the human can answer.
// ---------------------------------------------------------------------------

/**
 * Mint (or re-use) the stage-3 approval link for this human and this match.
 * Re-use matters: an agent that retries must not stack up link rows, and the
 * token is recomputable from the stored row, so the live one comes back.
 */
async function stage3LinkFor(
  cfg: Config,
  accountId: string,
  matchId: string,
  counterpartyAccount: string,
): Promise<string | undefined> {
  try {
    const { createApprovalLink, signLink } = await import('../counter/links.js');
    const existing = await getPool().query(
      `SELECT * FROM approval_links
       WHERE account_id = $1 AND action = 'stage3-disclosure' AND ref_id = $2
         AND used_at IS NULL AND expires_at > now() + interval '1 minute'
       ORDER BY created_at DESC LIMIT 1`,
      [accountId, matchId],
    );
    const token = existing.rows[0]
      ? signLink(existing.rows[0])
      : (
          await createApprovalLink({
            accountId,
            action: 'stage3-disclosure',
            refId: matchId,
            counterpartyAccount,
          })
        ).token;
    return `${cfg.counterOrigin}/counter/a/${encodeURIComponent(token)}`;
  } catch (err) {
    // A link is the courtesy, the refusal is the rule: if the link cannot be
    // minted the account is still refused, with the plain instruction.
    console.warn('stage-3 approval link mint failed; refusing without a link', err);
    return undefined;
  }
}

/**
 * The CONSENT_REQUIRED an empty profile earns. `human_action` is capped at
 * 300 characters by the error schema, so the link is appended only when the
 * sentence still fits with it.
 */
export async function sharedProfileConsentError(
  cfg: Config,
  opts: { accountId: string; matchId: string; counterpartyAccount: string },
): Promise<OsbError> {
  const url = await stage3LinkFor(cfg, opts.accountId, opts.matchId, opts.counterpartyAccount);
  const withLink = url ? `${SHARED_PROFILE_ACTION}: ${url}` : SHARED_PROFILE_ACTION;
  return new OsbError('CONSENT_REQUIRED', {
    human_action: withLink.length <= 300 ? withLink : SHARED_PROFILE_ACTION,
  });
}

/** The counterpart refusal: this human is done, the other one is not. */
export function counterpartyProfileConsentError(): OsbError {
  return new OsbError('CONSENT_REQUIRED', { human_action: COUNTERPARTY_PROFILE_ACTION });
}
