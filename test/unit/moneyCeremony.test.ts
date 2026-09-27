/**
 * MONEY ALWAYS TAKES A FRESH CEREMONY (Lachlan, 27 September 2026).
 *
 * Accepting a figure, sending one, and approving or confirming a payment or a
 * settlement ask for the PIN or the passkey at the press, whatever window a
 * sign-in or an earlier press opened. Every other press keeps the window.
 *
 * The routes are held to it in oneQuestion.test.ts and negotiation.test.ts
 * (an elevated session posting without a PIN moves nothing). This file holds
 * the rule itself, every renderer, and the handler wiring.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as creds from '../../src/counter/credentials.js';
import * as cpages from '../../src/counter/pages.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const PIN_ONLY = { hasPin: true, hasPasskey: false };
const PASSKEY_ONLY = { hasPin: false, hasPasskey: true };
const BOTH = { hasPin: true, hasPasskey: true };
const PIN_BOX = 'Confirm with your PIN';
const EMPTY_PIN = '<input type="hidden" name="pin" value="">';

describe('the rule', () => {
  it('names the money presses and nothing else', () => {
    for (const a of ['offer-accept', 'offer-send', 'settlement-approve', 'settlement-confirm']) {
      expect(creds.isMoneyAction(a), a).toBe(true);
    }
    for (const a of ['stage3-disclosure', 'report', 'conversation-renew', 'conversation-photo', 'shelf-pick']) {
      expect(creds.isMoneyAction(a), a).toBe(false);
    }
  });

  it('ignores the window for money and keeps it for the rest', () => {
    expect(creds.elevationFor('offer-accept', true)).toBe(false);
    expect(creds.elevationFor('stage3-disclosure', true)).toBe(true);
    expect(creds.needsCeremonyAtPress(PIN_ONLY, true, 'offer-send')).toBe(true);
    expect(creds.needsCeremonyAtPress(PASSKEY_ONLY, true, 'settlement-approve')).toBe(true);
    expect(creds.needsCeremonyAtPress(PIN_ONLY, true, 'stage3-disclosure')).toBe(false);
  });
});

const main = (action: cpages.ApprovalView['action'], c: cpages.CeremonyView) =>
  cpages.mainPage({ action, refId: 'r-1', facts: [{ k: 'You would pay', v: '90 AUD' }], anomalies: [], postPath: '/approve', ...c });

describe('the main page', () => {
  for (const action of ['offer-accept', 'settlement-approve'] as const) {
    it(`${action}: an elevated PIN account still gets the PIN box`, () => {
      const html = main(action, { ...PIN_ONLY, elevated: true });
      expect(html).toContain(PIN_BOX);
      expect(html).not.toContain(EMPTY_PIN);
      expect(html).toContain('Money takes your PIN every time.');
    });

    it(`${action}: an elevated passkey-only account presses with its passkey, inside the form`, () => {
      const html = main(action, { ...PASSKEY_ONLY, elevated: true });
      expect(html).not.toContain('class="pinbox"');
      expect(html).toContain('data-pk-inline="1"');
      expect(html).toContain("pk.name = 'passkey'");
      // The way through on a device without it is a PIN, never a dead end.
      expect(html).toContain('href="/pin"');
    });

    it(`${action}: an account holding both is offered both`, () => {
      const html = main(action, { ...BOTH, elevated: true });
      expect(html).toContain(PIN_BOX);
      expect(html).toContain('Use your passkey instead');
      expect(html).toContain('data-pk-inline="1"');
    });
  }

  it('the names step still leans on the window', () => {
    const html = main('stage3-disclosure', { ...PIN_ONLY, elevated: true });
    expect(html).not.toContain(PIN_BOX);
    expect(html).toContain(EMPTY_PIN);
    expect(html).not.toContain('data-pk-inline');
  });

  it('prints a raw fact as markup and escapes the rest', () => {
    const html = cpages.mainPage({
      action: 'offer-accept',
      refId: 'r-1',
      facts: [
        { k: 'You are agreeing to', v: '430 AUD' },
        { k: 'For', v: '<b>Trek</b>' },
        { k: 'Offer expires', v: '<time datetime="2026-10-04T04:53:01.000Z">Sun 4 Oct, 2:53 pm</time>', raw: true },
      ],
      anomalies: [],
      postPath: '/approve',
      ...PIN_ONLY,
      elevated: false,
    });
    expect(html).toContain('&lt;b&gt;Trek&lt;/b&gt;');
    expect(html).toContain('<time datetime="2026-10-04T04:53:01.000Z">Sun 4 Oct, 2:53 pm</time>');
  });
});

describe('the one-question page', () => {
  const q = (money: boolean, c: cpages.CeremonyView) =>
    cpages.oneQuestionPage({ token: 't', question: 'Q?', yesLabel: 'Accept', noLabel: 'Not now', needsPin: true, money, ...c });

  it('a money question asks for the PIN inside the window', () => {
    expect(q(true, { ...PIN_ONLY, elevated: true })).toContain(PIN_BOX);
    expect(q(true, { ...PASSKEY_ONLY, elevated: true })).toContain('data-pk-inline="1"');
  });

  it('any other question keeps the window', () => {
    expect(q(false, { ...PIN_ONLY, elevated: true })).not.toContain(PIN_BOX);
  });
});

describe('the settlement page', () => {
  const view = (over: any) =>
    cpages.settlementPage({
      id: 's-1', role: 'buyer', state: 'evidence-locked', amount: '87.65 AUD', buyerTotal: '90.49 AUD',
      fee: '1.00 AUD', processing: '1.84 AUD', ccy: 'AUD', category: 'Bike', myApprovalPending: false,
      canPay: false, needsPaymentSetup: false, canLockEvidence: false, canConfirm: false, canRetryRelease: false,
      canDispute: false, evidence: [], autoReleaseDays: 7, inDispute: false, canAddTracking: false,
      canMarkReturned: false, canConfirmReturn: false, canProposeSplit: false, canApproveSplit: false,
      ...PIN_ONLY, elevated: true, ...over,
    } as any);

  it('releasing the payment asks for the PIN inside the window', () => {
    const html = view({ canConfirm: true });
    expect(html).toContain('id="pin-confirm"');
  });

  it('raising a dispute keeps the window', () => {
    const html = view({ canDispute: true });
    expect(html).not.toContain(PIN_BOX);
  });

  it('agreeing or proposing a split, and sending a return back, ask too', () => {
    expect(view({ inDispute: true, canProposeSplit: true })).toContain('id="pin-propose"');
    expect(view({ inDispute: true, canConfirmReturn: true, role: 'seller' })).toContain('id="pin-return"');
    expect(
      view({ inDispute: true, canApproveSplit: true, split: { refund: '1', release: '2', refundMinor: 100, releaseMinor: 200, mine: false, theirs: true } }),
    ).toContain('id="pin-split"');
  });
});

describe('the human\'s own offer box', () => {
  it('asks for the PIN inside the window', () => {
    const html = cpages.counterOfferForm('m-1', { ceremony: { ...PIN_ONLY, elevated: true } });
    expect(html).toContain('id="pin-offer"');
    expect(html).toContain('id="offerForm"');
  });

  it('a passkey-only account sends with its passkey, inside the form', () => {
    const html = cpages.counterOfferForm('m-1', { ceremony: { ...PASSKEY_ONLY, elevated: true } });
    expect(html).toContain('data-pk-form="offerForm"');
    expect(html).toContain('data-pk-inline="1"');
  });
});

describe('the copy', () => {
  it('passes the lint in every state', () => {
    for (const c of [PIN_ONLY, PASSKEY_ONLY, BOTH]) {
      const v = { ...c, elevated: true };
      expect(lintHumanCopy(main('offer-accept', v))).toEqual([]);
      expect(lintHumanCopy(cpages.counterOfferForm('m-1', { ceremony: v }))).toEqual([]);
    }
  });
});

describe('the handlers', () => {
  const src = readFileSync(new URL('../../src/counter/routes.ts', import.meta.url), 'utf8');
  const handler = (path: string) => {
    const at = src.indexOf(`counter.post('${path}',`);
    expect(at, path).toBeGreaterThan(-1);
    const next = src.indexOf('counter.', at + 20);
    return src.slice(at, next === -1 ? undefined : next);
  };

  it('every money press runs the fresh ceremony, named for what it is', () => {
    const wired: [string, RegExp][] = [
      ['/approve', /pressCeremony\(s, reply, b, action\)/],
      ['/a/:token', /pressCeremony\(s as Session, reply, b, row\.action\)/],
      ['/matches/:id/offer', /pressCeremony\(s, reply, b, 'offer-send'\)/],
      ['/settlements/:id/confirm', /pressCeremony\(s, reply, req\.body, 'settlement-confirm'\)/],
      ['/settlements/:id/return-received', /pressCeremony\(s, reply, req\.body, 'settlement-return-received'\)/],
      ['/settlements/:id/resolution', /pressCeremony\(s, reply, req\.body, 'settlement-resolution'\)/],
      ['/settlements/:id/resolution/approve', /pressCeremony\(s, reply, req\.body, 'settlement-resolution-approve'\)/],
    ];
    for (const [path, re] of wired) expect(handler(path), path).toMatch(re);
  });

  it('the fresh ceremony never reads the window', () => {
    const at = src.indexOf('const moneyCeremony = async');
    const body = src.slice(at, src.indexOf('};', at));
    expect(body).not.toMatch(/isElevated/);
    expect(body).toMatch(/takeWebauthnChallenge/);
    expect(body).toMatch(/pinCheck\(/);
  });
});
