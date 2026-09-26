/**
 * The shared profile: the first name and suburb a human agrees to hand
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
import {
  countryNamed,
  describePlace,
  looksLikeStreetAddress,
  regionNamed,
  resolveOwnArea,
  type PlaceHint,
} from '../geo/gazetteer.js';
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
  "Add the first name and area you'd share, on your main page";

/**
 * The names step is the human's to press, every time (Lachlan, 2026-09-12).
 * An agent that asks to opt in is handed this and the link, whether or not a
 * first name and area are already on file: the press is what records it.
 */
export const NAMES_GATE_ACTION =
  'Sharing their first name and area is theirs to press. Hand them this link';

/** Said to the side that has done its part and is waiting on the other one. */
export const COUNTERPARTY_PROFILE_ACTION =
  'The other side has not added the first name and area they share yet. This introduction opens up once they do.';

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
// The quiet nudge. Nothing here blocks or rewrites an answer: a person who
// wants to stay vague stays vague, and a coarse area is stored and shared
// exactly as typed. This only names, for the person's own page, the cases
// where what is on file is a whole state, territory or country.
//
// The same offline gazetteer the posting path uses answers this, so there is
// no network call, no autocomplete and no third party in it. `regionNamed`
// and `countryNamed` already exist to tell a wide area from a place people
// live in, and they stay silent on a suburb, a town or a city.
// ---------------------------------------------------------------------------

/**
 * The whole state, territory or country this area names, when that is all it
 * names. Undefined for a suburb, a town, a city, or anything the gazetteer
 * does not recognise — silence is the default, so an unusual answer is never
 * second-guessed.
 *
 * A trailing country hint is looked through, because "Australian Capital
 * Territory, Australia" is the same answer written out longer.
 */
export function wideAreaNamed(locality: string): string | undefined {
  const raw = (locality ?? '').trim();
  if (!raw) return undefined;
  const wide = (s: string): string | undefined => regionNamed(s) ?? countryNamed(s);
  const direct = wide(raw);
  if (direct) return direct;
  const head = raw.split(',')[0]!.trim();
  return head && head !== raw ? wide(head) : undefined;
}

/** The line a person reads on their own page when what is on file is wide. */
export function wideAreaNudge(locality: string): string | undefined {
  const wide = wideAreaNamed(locality);
  return wide
    ? `${wide} covers a lot of ground. A suburb would tell the other person whether you are ten minutes away or two hours.`
    : undefined;
}

// ---------------------------------------------------------------------------
// The area, handed to this human's OWN assistant.
//
// Run 8 (13 September 2026): a human said he had a mountain bike to sell, his
// assistant asked which suburb, he answered with the bike, and it asked again.
// "It seems the location didn't pass through?" It never did: the area a person
// gives at onboarding sat on the account and was read only when first names
// crossed, so every posting opened with a question the switchboard could
// already answer.
//
// So it rides the sweep, the way the timezone does — to the agent on this
// human's own account, about their own area, and nowhere near a counterparty
// payload. With no area on file the sweep says nothing at all and the agent
// asks the way it does today.
// ---------------------------------------------------------------------------

export interface OwnArea {
  /** Exactly what the human typed on their own page. */
  area: string;
  /** The same place written out in full, when the gazetteer settles it. */
  area_resolved?: string;
  /** The one sentence saying what to do with it. */
  note: { text: string; provenance: 'switchboard-system' };
}

/**
 * What an agent is told about its own human's area, or undefined when there is
 * nothing on file or the read fails. A sweep is never broken by this.
 *
 * The read writes a decrypt-audit line like every other identity read, and
 * `purpose` is what a later reader sees: the sweep by default, and the connect
 * manual when the block in mcp/connectFacts.ts asks.
 *
 * The resolved line is the area written in full — town, state and country —
 * which is the one form a posting's place is taken in (26 September 2026). It
 * is offered only where the area plainly names one town (gazetteer.ts
 * resolveOwnArea). Where it does not — a name their own country holds two of,
 * a whole state, a whole country — no resolved line comes, and the note says
 * to ask them for the town, the state and the country instead, because an
 * assistant copying the bare words onto a posting would only be refused.
 */
export async function readOwnArea(
  accountId: string,
  purpose = 'own-area-for-sweep',
  hint: PlaceHint = {},
): Promise<OwnArea | undefined> {
  let area = '';
  try {
    const p = await readSharedProfile(accountId, {
      purpose,
      actor: accountId,
    });
    area = p.locality.trim();
  } catch {
    return undefined;
  }
  if (!area) return undefined;
  const resolved = resolvedAreaName(area, hint);
  return {
    area,
    ...(resolved ? { area_resolved: resolved } : {}),
    note: {
      text: resolved ? areaNote(resolved) : areaNotFullNote(area),
      provenance: 'switchboard-system',
    },
  };
}

/** The area written out in full, when it names one town.
 *
 *  The hint is the country their own clock says they are in, and it settles a
 *  name only where exactly one of the towns that answer to it is there. This
 *  is the human's own page and not the posting path, which reads no hint at
 *  all: see resolveOwnArea for why the two differ. */
export function resolvedAreaName(area: string, hint: PlaceHint = {}): string | undefined {
  const raw = (area ?? '').trim();
  if (!raw) return undefined;
  if (looksLikeStreetAddress(raw)) return undefined;
  if (wideAreaNamed(raw)) return undefined;
  const hit = resolveOwnArea(raw, hint);
  return hit ? describePlace(hit) : undefined;
}

/**
 * The sentence that rides with it. It says the place out loud and tells the
 * agent to say it out loud too: an agent that quietly assumed an area would be
 * putting words in its human's mouth, and the human would find out when
 * somebody turned up in the wrong suburb.
 */
export function areaNote(place: string): string {
  return (
    `Your human is in ${place}. Use that as the area on anything you post for them ` +
    'unless they say somewhere else, and tell them which area you used so they can ' +
    'correct you. They set it themselves on their own page, and they can change it there.'
  );
}

/**
 * The sentence for an area on file that does not name one town on its own
 * (26 September 2026). The switchboard takes a posting's place only written in
 * full, so the area as they typed it would be refused if copied onto one: the
 * agent asks them once for the town, state and country, and uses that.
 */
export function areaNotFullNote(typed: string): string {
  return (
    `Your human gave their area as "${typed}", which could be more than one place. ` +
    'Before you post anything for them, ask which town, state and country they mean, ' +
    'and write the place in full on what you post. They can change the area on their own page.'
  );
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
  cfg?: Config,
): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { notFound: true });
  // THE SHARED_IDENTITY DOOR (docs/trust-and-safety.md: "the shared first name
  // and suburb" is named in the list of things the one pipe was drawn around).
  // The door has existed in intake/types.ts since step one and had no caller.
  //
  // What stands at it today is the suspension check and the ledger, and that is
  // the point of wiring it: a suspended account may not put a name and a suburb
  // in front of anyone, and the one thing this switchboard holds that most
  // needs accounting for — who told whom their real first name and where they
  // live — was, until now, the only thing a person handed over that the pipe
  // never saw. No model reads this: a first name and a suburb ARE personal
  // details, so the screen that refuses personal details has no business here.
  //
  // A refusal here refuses the save. A hold does not: the human pressed the
  // button on their own page, and the words are in the ledger for a person.
  const { runIntake } = await import('../intake/pipe.js');
  const verdict = await runIntake(cfg, {
    door: 'shared_identity',
    sender_account: accountId,
    text: `${value.firstName}, ${value.locality}`,
  });
  if (verdict.outcome === 'refuse') {
    throw Object.assign(new Error(verdict.plain_words ?? 'this cannot be shared'), {
      refused: true,
      reason_code: verdict.reason_code,
    });
  }
  await writeConsentEvent({
    event: 'shared-profile-set',
    account_id: accountId,
    fields: ['first_name', 'locality'],
    recorded_via: recordedVia,
  });
  const [nameEnc, locEnc] = await Promise.all([
    encryptField(accountId, account.data_key_enc, value.firstName, 'first_name'),
    encryptField(accountId, account.data_key_enc, value.locality, 'locality'),
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
 *
 * The names-step email uses this too: that email is the one nudge whose next
 * step is a gate, so it carries this link and nothing else.
 */
export async function stage3LinkFor(
  cfg: Config,
  accountId: string,
  matchId: string,
  counterpartyAccount: string,
): Promise<{ link: string; press_id: string } | undefined> {
  try {
    const { createApprovalLink, signLink } = await import('../counter/links.js');
    const existing = await getPool().query(
      `SELECT * FROM approval_links
       WHERE account_id = $1 AND action = 'stage3-disclosure' AND ref_id = $2
         AND used_at IS NULL AND expires_at > now() + interval '1 minute'
       ORDER BY created_at DESC LIMIT 1`,
      [accountId, matchId],
    );
    const minted = existing.rows[0]
      ? { token: signLink(existing.rows[0]), id: existing.rows[0].id as string }
      : await createApprovalLink({
          accountId,
          action: 'stage3-disclosure',
          refId: matchId,
          counterpartyAccount,
        });
    return {
      link: `${cfg.counterOrigin}/a/${encodeURIComponent(minted.token)}`,
      press_id: minted.id,
    };
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
  return consentErrorWithLink(cfg, SHARED_PROFILE_ACTION, opts);
}

/**
 * The refusal an agent's own opt-in earns, every time. Same link, different
 * sentence: there is nothing wrong here to fix, so the sentence says whose
 * press this is and hands the link over rather than naming a missing field.
 */
export async function namesGateConsentError(
  cfg: Config,
  opts: { accountId: string; matchId: string; counterpartyAccount: string },
): Promise<OsbError> {
  return consentErrorWithLink(cfg, NAMES_GATE_ACTION, opts);
}

async function consentErrorWithLink(
  cfg: Config,
  sentence: string,
  opts: { accountId: string; matchId: string; counterpartyAccount: string },
): Promise<OsbError> {
  const minted = await stage3LinkFor(
    cfg,
    opts.accountId,
    opts.matchId,
    opts.counterpartyAccount,
  );
  const withLink = minted ? `${sentence}: ${minted.link}` : sentence;
  return new OsbError('CONSENT_REQUIRED', {
    human_action: withLink.length <= 300 ? withLink : sentence,
    // The refusal hands over a link, so it hands over the press to wait on too.
    ...(minted ? { press_id: minted.press_id } : {}),
  });
}

/** The counterpart refusal: this human is done, the other one is not. */
export function counterpartyProfileConsentError(): OsbError {
  return new OsbError('CONSENT_REQUIRED', { human_action: COUNTERPARTY_PROFILE_ACTION });
}
