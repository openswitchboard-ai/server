/**
 * The words on the pages a person decides on, and the small gates around them
 * (28 September 2026):
 *  - an anomaly is one plain sentence, and the new-account line only shows
 *    where it tells somebody something;
 *  - the stop-everything emails say what happened and what turns it back on;
 *  - a verification id that is not an id, a registration carrying a pile of
 *    redirect addresses, and a saved-notice code that names a property of
 *    every object are all turned away plainly;
 *  - an SES error is logged by its name and status, never whole;
 *  - the pages' own accessibility basics.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acceptAnomalyLine, settlementAnomalyLine } from '../../src/counter/anomalies.js';
import { renderKillSwitch, renderSecurityNotice } from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import * as cpages from '../../src/counter/pages.js';
import * as db from '../../src/db.js';
import { verifyByCode } from '../../src/counter/verification.js';
import type { Config } from '../../src/config.js';

const SRC = readFileSync(join(__dirname, '..', '..', 'src', 'counter', 'routes.ts'), 'utf8');

describe('an anomaly is one plain sentence', () => {
  it('a figure out of the ordinary from a new account says both, in one line', () => {
    expect(acceptAnomalyLine({ kind: 'amount', times: '4' }, true)).toBe(
      'This is their first week on OpenSwitchboard, and this figure is 4 times your usual.',
    );
    expect(acceptAnomalyLine({ kind: 'amount', times: '4.5' }, false)).toBe(
      'This figure is 4.5 times your usual.',
    );
  });

  it('a new account alone says nothing on a figure', () => {
    // At launch every account is new; a line on every offer is a line nobody reads.
    expect(acceptAnomalyLine(undefined, true)).toBeUndefined();
    expect(acceptAnomalyLine(undefined, false)).toBeUndefined();
  });

  it('a payment says it whenever the other side is new', () => {
    expect(settlementAnomalyLine(true)).toBe('The other side of this payment joined this week.');
    expect(settlementAnomalyLine(false)).toBeUndefined();
  });

  it('the names step never asks about it at all', () => {
    const at = SRC.indexOf("if (row.action === 'stage3-disclosure') {");
    const branch = SRC.slice(at, SRC.indexOf("if (row.action === 'report') {", at));
    expect(branch).not.toMatch(/counterpartyIsNew|Anomaly/);
  });

  it('no labelled box is left to put one in', () => {
    expect(cpages).not.toHaveProperty('mainPage');
    expect(SRC).not.toContain('Worth a second look');
  });
});

describe('the stop-everything emails', () => {
  const f = { settingsUrl: 'https://my.test/settings', unsubUrl: 'https://my.test/email/unsub?t=x' } as any;

  it('say it is stopped, and that turning it back on takes the passkey or the PIN', () => {
    const on = renderKillSwitch({ on: true, counterUrl: 'https://my.test/' }, f);
    expect(on.subject).toBe('OpenSwitchboard: everything is stopped');
    for (const body of [on.html, on.text]) {
      expect(body).toContain('Everything is stopped.');
      expect(body).toContain('Turning it back on takes your passkey or PIN');
      expect(body).not.toMatch(/kill switch|paused|your sign-in and your PIN/i);
    }
    expect(lintHumanCopy(on.html)).toEqual([]);
  });

  it('say it is back on, and what to press if it was not them', () => {
    const off = renderKillSwitch({ on: false, counterUrl: 'https://my.test/' }, f);
    expect(off.subject).toBe('OpenSwitchboard: everything is back on');
    for (const body of [off.html, off.text]) {
      expect(body).toContain('Everything is back on.');
      expect(body).toContain('Stop all wants and haves');
      expect(body).not.toMatch(/kill switch/i);
    }
  });

  it('every security notice points at the button on the main page', () => {
    for (const event of ['agent-authorized', 'pin-changed', 'pin-set', 'pin-set-by-code', 'passkey-added', 'agent-key-created'] as const) {
      const n = renderSecurityNotice({ event, counterUrl: 'https://my.test/' }, f);
      for (const body of [n.html, n.text]) {
        expect(body, event).toContain('press Stop all wants and haves on your main page');
        expect(body, event).not.toMatch(/kill switch|one tap/i);
      }
    }
  });

  it('a PIN set with an emailed code says what it cannot do yet', () => {
    const n = renderSecurityNotice({ event: 'pin-set-by-code', counterUrl: 'https://my.test/' }, f);
    expect(n.text).toContain('A PIN was just set on your account using a code we emailed you.');
    expect(n.text).toContain('It cannot move money for 24 hours.');
  });
});

describe('the small gates', () => {
  it('a verification id that is not an id is not found, and never reaches the database', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.spyOn(db, 'getPool').mockReturnValue({ query } as any);
    const r = await verifyByCode({} as Config, "x' OR 1=1 --", '123456');
    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(query).not.toHaveBeenCalled();
  });

  it('a saved-notice code is looked up as the list’s own key, never an inherited one', () => {
    expect(SRC).toMatch(/Object\.hasOwn\(SAVED_NOTICES, /);
    expect(SRC).not.toMatch(/= SAVED_NOTICES\[String\(\(req\.query as any\)\?\.saved \?\? ''\)\];/);
  });

  it('an SES error is logged by name and status, never whole', () => {
    expect(SRC).not.toMatch(/req\.log\.\w+\(\{ err \}/);
    expect(SRC).not.toMatch(/req\.log\.\w+\(\{ err, what \}/);
  });
});

describe('dynamic client registration caps what it stores', () => {
  it('turns away more than five redirect addresses, or one longer than 512 characters', async () => {
    const { buildApp } = await import('../../src/app.js');
    const insert = vi.fn(async () => ({ rows: [{ client_id: 'c', created_at: new Date() }], rowCount: 1 }));
    vi.spyOn(db, 'getPool').mockReturnValue({ query: insert } as any);
    const app = buildApp({
      envName: 'dev',
      port: 0,
      publicOrigin: 'https://mcp.test',
      counterOrigin: 'https://my.test',
      legacyCounterHosts: [],
      registrationMode: 'dev-bootstrap',
      quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
    } as unknown as Config);
    await app.ready();
    const register = (redirect_uris: string[]) =>
      app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { host: 'mcp.test', 'content-type': 'application/json' },
        payload: JSON.stringify({ client_name: 'x', redirect_uris }),
      });
    const six = Array.from({ length: 6 }, (_, i) => `https://a.example/cb${i}`);
    expect((await register(six)).statusCode).toBe(400);
    expect((await register([`https://a.example/${'x'.repeat(520)}`])).statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
    expect((await register(six.slice(0, 5))).statusCode).toBe(201);
    await app.close();
  });
});

describe('the pages, for a screen reader and a thumb', () => {
  it('an error box is announced', () => {
    expect(cpages.errBox('Wrong code.')).toContain('role="alert"');
    expect(cpages.loginEmailPage()).toContain('<div id="pkerr" role="alert">');
  });

  it('the passkey never shows the browser’s own error', () => {
    const login = cpages.loginEmailPage();
    expect(login).not.toMatch(/Passkey sign-in failed|e\.message/);
    expect(login).toContain("That didn't work. Try again, or have a code emailed.");
    const choice = cpages.credentialChoicePage();
    expect(choice).not.toMatch(/enrolment failed/i);
    expect(choice).toContain("That didn't work. Try again, or use your PIN.");
    expect(cpages.CEREMONY_SCRIPT).not.toMatch(/ceremony failed|e\.message/);
  });

  it('the dispute question is a fieldset with a legend', () => {
    const html = cpages.settlementPage({
      id: 's-1', role: 'buyer', state: 'funded', amount: '87.65 AUD', buyerTotal: '90.49 AUD',
      fee: '1.00 AUD', processing: '1.84 AUD', ccy: 'AUD', category: 'Bike', myApprovalPending: false,
      canPay: false, needsPaymentSetup: false, canLockEvidence: false, canConfirm: false, canRetryRelease: false,
      canDispute: true, evidence: [], autoReleaseDays: 7, inDispute: false, canAddTracking: false,
      canMarkReturned: false, canConfirmReturn: false, canProposeSplit: false, canApproveSplit: false,
      hasPin: true, hasPasskey: false, elevated: false,
    } as any);
    expect(html).toContain('<legend>What went wrong</legend>');
    expect(html).not.toContain('<label for="ground">');
  });

  it('the photo promise sits in a consent box', () => {
    const html = cpages.photoPage({ token: 't', who: 'Sam', thing: 'bike', maxMb: 8, ttlDays: 7, captionMax: 200 });
    expect(html).toMatch(/<div class="consent-box">\s*<label><input type="checkbox" name="confirm"/);
    expect(html).toContain('<div id="perr" role="alert"></div>');
  });

  it('a pressed page takes the reader to its heading', () => {
    expect(cpages.layout('x', '')).toContain("h.setAttribute('tabindex','-1');h.focus();");
  });

  it('a disabled button looks it, and a row button is big enough for a thumb', () => {
    const html = cpages.layout('x', '');
    expect(html).toContain('button:disabled { opacity:.6; cursor:default; }');
    expect(html).toMatch(/\.row-actions \.btn, \.row-actions button \{[^}]*min-height:44px/);
  });

  it('the PIN box says the same thing everywhere', () => {
    for (const html of [cpages.pinSetPage(), cpages.credentialChoicePage(), cpages.pinRecoverPage()]) {
      expect(html).toContain('<p class="field-help" id="pin-help">Six or more digits.</p>');
      expect(html).not.toContain('6+ digits');
    }
  });

  it('the assistant’s authorisation page is spelt the Australian way', () => {
    const html = cpages.authorizePage('Claude', '/authorize', {});
    expect(html).toContain('>Authorise<');
    expect(html).toContain('Authorise your assistant');
    // What a person reads; the script's own comments are not read by anyone.
    const read = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    expect(read).not.toMatch(/Authorize|\bagent\b/);
  });
});

describe('the new pages pass the copy lint', () => {
  it('lost passkey, PIN set, sign in to see this', () => {
    for (const [name, html] of [
      ['recover-start', cpages.pinRecoverStartPage()],
      ['recover-pin', cpages.pinRecoverPage('The two entries did not match.')],
      ['recovered', cpages.pinRecoveredPage('Tue 29 Sep, 9:02am')],
      ['sign-in-to-see', cpages.signInToSeePage()],
    ] as const) {
      expect(lintHumanCopy(html), name).toEqual([]);
      const read = html.replace(/<(script|style)>[\s\S]*?<\/\1>/g, '');
      expect(read, name).not.toMatch(/\bagent\b|\barea\b|\bcard\b|\blisting\b/i);
    }
  });
});
