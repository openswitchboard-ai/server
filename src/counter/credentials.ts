/**
 * What an account holds, and what follows from it.
 *
 * From 2026-09-16 a PIN is one of two ways to hold an account rather than the
 * only one. A person can finish registration with a passkey and never set a
 * PIN, so every question that used to read "does this account have a PIN?" now
 * reads "what does this account hold?".
 *
 * WHY A PASSKEY ALONE IS ENOUGH:
 *   - getting back in after losing everything is an emailed code either way,
 *     so a PIN adds nothing to what recovery can do;
 *   - a PIN is the only credential on the account a phishing page could ever
 *     harvest, because it is the only one a person can read out and type;
 *   - a passkey cannot be handed over, even by someone who wants to hand it
 *     over, because the private half never leaves the device.
 *
 * A PIN stays on offer for a device that cannot make a passkey, and for the
 * person who sets a passkey on a laptop and then presses an approval link on a
 * phone that has never seen it.
 *
 * The decisions live here, away from the routes and the database, because
 * every one of them is a rule rather than a query.
 */

export interface CredentialState {
  hasPin: boolean;
  hasPasskey: boolean;
}

/** True once this account can approve something. Either credential does. */
export function holdsCredential(c: CredentialState): boolean {
  return c.hasPin || c.hasPasskey;
}

/**
 * Changing how you approve things takes the way you approve things now, so a
 * borrowed session cannot quietly fit itself a key. An account holding
 * nothing yet is inside registration, where there is nothing to ask for.
 */
export function needsFreshCeremony(c: CredentialState, elevated: boolean): boolean {
  return holdsCredential(c) && !elevated;
}

/** What a sensitive press can ask for. 'none' means nothing is set up yet. */
export function ceremonyKind(c: CredentialState): 'none' | 'pin' | 'passkey' | 'either' {
  if (c.hasPin && c.hasPasskey) return 'either';
  if (c.hasPin) return 'pin';
  if (c.hasPasskey) return 'passkey';
  return 'none';
}

export interface AccountStep {
  status?: string;
  onboarded_at?: unknown;
}

/**
 * Where a signed-in person belongs next.
 *
 * The step that used to demand a PIN now offers the choice, so an account
 * holding EITHER credential passes it. A passkey-only account that was still
 * sent to a PIN step would be sent there for ever, because nothing it does
 * would ever satisfy the test.
 */
export function nextStepFor(
  a: AccountStep | undefined | null,
  c: CredentialState,
  opts: { hasOauthCtx?: boolean } = {},
): string {
  if (!a) return '/login';
  if (!holdsCredential(c)) return '/secure';
  if (a.status === 'pending') return '/consent';
  // One page, once, before any agent is authorised: how this person will hear
  // about things, and what they would share. Every account that existed before
  // the step did carries a stamp already (see migrations/027).
  if (!a.onboarded_at) return '/hello';
  if (opts.hasOauthCtx) return '/authorize';
  return '/';
}
