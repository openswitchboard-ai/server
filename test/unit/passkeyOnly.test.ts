/**
 * A person may hold this account with a passkey and no PIN (2026-09-16).
 *
 * Two halves are tested here. The RULES — what an account holds, whether a
 * fresh ceremony is owed, where a signed-in person belongs next — are pure
 * functions in credentials.ts. The PAGES are asserted branch by branch: a PIN
 * account looks exactly as it always did, a passkey-only account is never
 * shown a box it cannot fill, and an account holding both is offered both.
 */
import { describe, expect, it } from 'vitest';
import * as creds from '../../src/counter/credentials.js';
import * as cpages from '../../src/counter/pages.js';
import * as chome from '../../src/counter/pagesHome.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const PIN_ONLY = { hasPin: true, hasPasskey: false };
const PASSKEY_ONLY = { hasPin: false, hasPasskey: true };
const BOTH = { hasPin: true, hasPasskey: true };
const NOTHING = { hasPin: false, hasPasskey: false };

const live = { status: 'live', onboarded_at: '2026-09-01T00:00:00.000Z' };

describe('what an account holds', () => {
  it('either credential is a whole credential', () => {
    expect(creds.holdsCredential(PIN_ONLY)).toBe(true);
    expect(creds.holdsCredential(PASSKEY_ONLY)).toBe(true);
    expect(creds.holdsCredential(BOTH)).toBe(true);
    expect(creds.holdsCredential(NOTHING)).toBe(false);
  });

  it('names what a sensitive press may ask for', () => {
    expect(creds.ceremonyKind(PIN_ONLY)).toBe('pin');
    expect(creds.ceremonyKind(PASSKEY_ONLY)).toBe('passkey');
    expect(creds.ceremonyKind(BOTH)).toBe('either');
    expect(creds.ceremonyKind(NOTHING)).toBe('none');
  });
});

describe('where a signed-in person belongs next', () => {
  it('an account holding nothing goes to the choice screen', () => {
    expect(creds.nextStepFor({ status: 'pending' }, NOTHING)).toBe('/secure');
  });

  it('registration finishes on a passkey with no PIN', () => {
    // The whole point: having taken the passkey, this person is never sent
    // back to a step they have already answered. Sending them to /pin here
    // would send them there for ever, because nothing they do satisfies it.
    expect(creds.nextStepFor({ status: 'pending' }, PASSKEY_ONLY)).toBe('/consent');
    expect(creds.nextStepFor({ status: 'live' }, PASSKEY_ONLY)).toBe('/hello');
    expect(creds.nextStepFor(live, PASSKEY_ONLY)).toBe('/');
    expect(creds.nextStepFor(live, PASSKEY_ONLY, { hasOauthCtx: true })).toBe('/authorize');
  });

  it('a PIN account walks the same path it always did', () => {
    expect(creds.nextStepFor({ status: 'pending' }, PIN_ONLY)).toBe('/consent');
    expect(creds.nextStepFor(live, PIN_ONLY)).toBe('/');
  });

  it('no account at all goes to sign in', () => {
    expect(creds.nextStepFor(undefined, PASSKEY_ONLY)).toBe('/login');
  });
});

describe('changing how you approve things', () => {
  it('takes a fresh ceremony of whatever the account holds now', () => {
    expect(creds.needsFreshCeremony(PIN_ONLY, false)).toBe(true);
    expect(creds.needsFreshCeremony(PASSKEY_ONLY, false)).toBe(true);
    expect(creds.needsFreshCeremony(BOTH, false)).toBe(true);
  });

  it('asks for nothing inside a ceremony window, and nothing during registration', () => {
    expect(creds.needsFreshCeremony(BOTH, true)).toBe(false);
    expect(creds.needsFreshCeremony(NOTHING, false)).toBe(false);
  });
});

describe('the choice screen', () => {
  const html = cpages.credentialChoicePage();

  it('offers a passkey and a PIN, and says what each one means in a line', () => {
    expect(html).toContain('How will you approve things?');
    expect(html).toContain('fingerprint or face check your device already has');
    expect(html).toContain('nothing for you to remember');
    expect(html).toContain('A PIN is six digits you type');
    expect(html).toContain('<button id="enrol">Use a passkey</button>');
    expect(html).toContain('name="pin2"');
    expect(html).toContain('action="/pin/set"');
  });

  it('says either can be added later, and that a new device uses an emailed code', () => {
    expect(html).toContain('You can add the other one later');
    expect(html).toContain('code we email you either way');
  });

  it('offers the PIN alone until the browser reports a platform authenticator', () => {
    // The passkey half is hidden markup, and the ONLY thing that unhides it is
    // the browser saying this device can make one. A button that cannot work
    // is worse than a button that was never there.
    expect(html).toMatch(/<div id="pkoffer" hidden>/);
    expect(html).toContain('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()');
    expect(html).toContain('if (available) { box.hidden = false;');
    // The PIN half stands outside the hidden block.
    const offerEnd = html.indexOf('</div>', html.indexOf('id="pkoffer"'));
    expect(html.indexOf('<h2>A PIN</h2>')).toBeGreaterThan(offerEnd);
  });

  it('does not oversell the passkey or call the PIN weak', () => {
    expect(html).not.toMatch(/weak|insecure|unsafe|safer|more secure/i);
    expect(lintHumanCopy(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every surface that used to print a PIN box, in all three states.
// ---------------------------------------------------------------------------
const approval = (c: cpages.CeremonyView) =>
  cpages.approvalPage({
    action: 'offer-accept',
    refId: 'ref-1',
    facts: [{ k: 'You are agreeing to', v: '620 AUD' }],
    anomalies: [],
    postPath: '/approve',
    ...c,
  });

const oneQuestion = (c: cpages.CeremonyView) =>
  cpages.oneQuestionPage({
    token: 'tok-1',
    question: 'Sam offers $430 AUD for your mountain bike.',
    yesLabel: 'Accept',
    noLabel: 'Not now',
    needsPin: true,
    ...c,
  });

const settlement = (c: cpages.CeremonyView) =>
  cpages.settlementPage({
    id: 's-1',
    role: 'buyer',
    state: 'evidence-locked',
    amount: '87.65 AUD',
    buyerTotal: '90.49 AUD',
    fee: '1.00 AUD',
    processing: '1.84 AUD',
    ccy: 'AUD',
    category: 'Bikes',
    myApprovalPending: false,
    canPay: false,
    needsPaymentSetup: false,
    canLockEvidence: false,
    canConfirm: true,
    canRetryRelease: false,
    canDispute: false,
    evidence: [],
    autoReleaseDays: 7,
    inDispute: false,
    canAddTracking: false,
    canMarkReturned: false,
    canConfirmReturn: false,
    canProposeSplit: false,
    canApproveSplit: false,
    ...c,
  } as any);

const agentKeys = (c: cpages.CeremonyView) =>
  chome.agentKeysPage({ keys: [], atLimit: false, ...c });

const killSwitch = (c: cpages.CeremonyView) =>
  chome.dashboardPage({
    killSwitchOn: true,
    ceremony: c,
    cardCounts: { total: 0, published: 0, pending: 0 },
    pendingApprovals: [],
  });

const SURFACES: [string, (c: cpages.CeremonyView) => string][] = [
  ['the approval page', approval],
  ['the one-question page', oneQuestion],
  ['a settlement release', settlement],
  ['making an agent key', agentKeys],
  ['turning the kill switch off', killSwitch],
];

describe('every surface that asks for a ceremony', () => {
  for (const [name, render] of SURFACES) {
    it(`${name}: a PIN account still gets the PIN box`, () => {
      const html = render({ ...PIN_ONLY, elevated: false });
      expect(html).toContain('Confirm with your PIN');
      expect(html).toContain('name="pin"');
      // Nothing offers a passkey to an account that holds none.
      expect(html).not.toContain('data-pk-form');
    });

    it(`${name}: an elevated session is asked for nothing`, () => {
      for (const c of [PIN_ONLY, PASSKEY_ONLY, BOTH]) {
        const html = render({ ...c, elevated: true });
        expect(html, name).not.toContain('Confirm with your PIN');
        expect(html, name).not.toContain('data-pk-form');
        // The form still carries the field the press posts.
        expect(html, name).toContain('<input type="hidden" name="pin" value="">');
      }
    });

    it(`${name}: a passkey-only account is shown no box it cannot fill`, () => {
      const html = render({ ...PASSKEY_ONLY, elevated: false });
      expect(html).not.toContain('Confirm with your PIN');
      expect(html).not.toContain('class="pinbox"');
      // The action button IS the ceremony.
      expect(html).toContain('data-pk-form=');
      expect(html).toContain('/login/passkey/verify');
    });

    it(`${name}: an account holding both is offered both`, () => {
      const html = render({ ...BOTH, elevated: false });
      expect(html).toContain('Confirm with your PIN');
      expect(html).toContain('Use your passkey instead');
    });

    it(`${name}: passes the copy lint in every state`, () => {
      for (const c of [PIN_ONLY, PASSKEY_ONLY, BOTH]) {
        for (const elevated of [false, true]) {
          expect(lintHumanCopy(render({ ...c, elevated })), `${name} ${JSON.stringify(c)}`).toEqual(
            [],
          );
        }
      }
    });
  }
});

describe('the way through on a device the passkey has never seen', () => {
  it('a passkey-only page says so in plain words and links the emailed code', () => {
    const html = approval({ ...PASSKEY_ONLY, elevated: false });
    expect(html).toContain('This takes your passkey.');
    expect(html).toContain('On a device that does not');
    expect(html).toContain('href="/confirm/code"');
  });

  it('a PIN account is told what it takes, with no dead end to escape', () => {
    expect(approval({ ...PIN_ONLY, elevated: false })).toContain('This takes your PIN.');
    expect(approval({ ...BOTH, elevated: false })).toContain('This takes your PIN or your passkey.');
    expect(approval({ ...PIN_ONLY, elevated: false })).not.toContain('/confirm/code');
  });
});

describe('adding either credential later', () => {
  // A passkey set is a state to confirm, not a door to walk through again:
  // one is enough, and a second only ever exists because a second DEVICE
  // needs one. So the page confirms it and keeps the way to another device
  // in small print, rather than offering "add another" as a standing choice.
  it('the security page confirms a passkey rather than offering another', () => {
    const passkeyOnly = cpages.securityPage({ hasPin: false, passkeyCount: 1 });
    expect(passkeyOnly).toContain('Your passkey approves everything here.');
    expect(passkeyOnly).toContain('Passkey set.');
    expect(passkeyOnly).not.toContain('Add another passkey');
    expect(passkeyOnly).not.toContain('>Add a passkey<');
    expect(passkeyOnly).toContain('>Set a PIN<');
    expect(passkeyOnly).toContain('href="/pin"');
    // The new-device way stays, in small print.
    expect(passkeyOnly).toContain('href="/passkey"');

    const pinOnly = cpages.securityPage({ hasPin: true, passkeyCount: 0 });
    expect(pinOnly).toContain('Your PIN approves everything here.');
    expect(pinOnly).toContain('>Add a passkey<');
    expect(pinOnly).toContain('>Change your PIN<');

    const both = cpages.securityPage({ hasPin: true, passkeyCount: 2 });
    expect(both).toContain('a passkey and a PIN');
    expect(both).not.toContain('Add another passkey');
  });

  it('the PIN page names the difference between setting one and changing one', () => {
    expect(cpages.pinSetPage()).toContain('Set a PIN.');
    expect(cpages.pinSetPage(undefined, { hasPin: true })).toContain('Change your PIN.');
  });

  it('confirming it is you asks with whatever the account holds', () => {
    const pin = cpages.confirmItsYouPage({ ...PIN_ONLY, elevated: false }, '/passkey');
    expect(pin).toContain('Confirm with your PIN');
    expect(pin).toContain('name="next" value="/passkey"');

    const passkey = cpages.confirmItsYouPage({ ...PASSKEY_ONLY, elevated: false }, '/pin');
    expect(passkey).not.toContain('class="pinbox"');
    expect(passkey).toContain('data-pk-form="confirmForm"');
    expect(passkey).toContain('name="next" value="/pin"');
  });

  it('the passkey offer knows whether this is the first one', () => {
    expect(cpages.passkeyOfferPage()).toContain('Add a passkey?');
    expect(cpages.passkeyOfferPage({ hasPasskey: true })).toContain('You already have one');
  });
});

describe('the passkey ceremony script', () => {
  const html = approval({ ...PASSKEY_ONLY, elevated: false });

  it('goes on a page only where something on it can use a passkey', () => {
    expect(approval({ ...PIN_ONLY, elevated: false })).not.toContain('data-pk-form]');
    expect(approval({ ...PASSKEY_ONLY, elevated: true })).not.toContain('data-pk-form]');
    expect(html).toContain("closest('button[data-pk-form]')");
  });

  it('elevates without re-attaching the session, then submits the press', () => {
    expect(html).toContain('elevate_only: true');
    expect(html).toContain('form.submit()');
    // The rest of the form still has to be filled in before a ceremony runs.
    expect(html).toContain('form.reportValidity()');
  });

  it('carries the decision the button was going to send', () => {
    expect(html).toContain('data-pk-name="decision" data-pk-value="approve"');
    expect(oneQuestion({ ...PASSKEY_ONLY, elevated: false })).toContain(
      'data-pk-name="decision" data-pk-value="yes"',
    );
  });
});
