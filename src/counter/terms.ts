/**
 * THE TERMS A PERSON AGREES TO (22 November 2026).
 *
 * Until now nobody agreed to the terms of use or the privacy policy: an
 * account was an email code, a credential and the two consent ticks. Meta's
 * connector terms void any terms "accompanying or relating to" a connector
 * that bind its users, so our rules have to stand as an agreement made
 * directly between the person and us, here on our own pages.
 *
 * A new account agrees on the consent page, with a third tick. An account
 * that agreed to an older version (or to none) is asked once, on the page
 * between signing in and their main page or connecting an assistant
 * (/terms-update). Press pages are not held up by it: a person answering a
 * link from their assistant gets their press.
 *
 * Bump TERMS_VERSION whenever the terms or privacy policy change in a way
 * account holders are emailed about; every account is then asked again.
 */

/** The version of the public terms and privacy policy a tick agrees to. */
export const TERMS_VERSION = '2026-11-22';

export const TERMS_URL = 'https://openswitchboard.ai/terms';
export const PRIVACY_URL = 'https://openswitchboard.ai/privacy';

/** The words ticked, exactly as the consent log records them. */
export const TERMS_STATEMENT = 'I agree to the terms of use and the privacy policy.';

/** Whether this account has agreed to the terms as they stand. */
export function termsCurrent(a: { terms_version?: unknown } | undefined | null): boolean {
  return !!a && a.terms_version === TERMS_VERSION;
}
