/**
 * 0.E gate (a): the template render suite.
 *  - every template renders an HTML part AND a plaintext part;
 *  - every rendered subject/body passes the banned-phrase (no-antithesis)
 *    lint;
 *  - blind-mode variants carry ZERO content beyond the pointer (no category,
 *    no counts of card specifics, no card list, no summaries);
 *  - email action tokens (unsubscribe / renew-all) round-trip and reject
 *    tampering, purpose confusion and expiry.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  categoryPhrase,
  renderApproval,
  renderChannelWaiting,
  renderDealAgreed,
  renderDigest,
  renderKillSwitch,
  renderOfferOnTheTable,
  renderRenewal,
  renderScreeningRejected,
  renderSecurityNotice,
  renderSettlementProposed,
  renderSettlementUpdate,
  renderSummons,
  renderVerification,
  renderYourMove,
  EXEMPT_TEMPLATES,
  NOTICE_TEMPLATES,
  type EmailContent,
  type FooterLinks,
} from '../../src/email/templates.js';
import { lintEmailCopy, lintHumanCopy, noticeLinkHits } from '../../src/email/lint.js';
import { screeningReasonInPlainWords } from '../../src/domain/screening.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { signEmailToken, verifyEmailToken } from '../../src/email/tokens.js';

const COUNTER = 'https://my-dev.openswitchboard.ai';
const links: FooterLinks = {
  settingsUrl: `${COUNTER}/settings`,
  unsubUrl: `${COUNTER}/email/unsub?t=osb_em_test`,
};
/** The two footer controls are the only links a notice may carry. */
const FOOTER_PREFIXES = [`${COUNTER}/settings`, `${COUNTER}/email/unsub`];

// Raw slugs must NEVER appear in an email — only the taxonomy's human label.
const SLUG = 'goods.bicycle.mountain';
const LABEL = 'Mountain bikes';
const LABEL2 = 'Garden tools';
const SUMMARY = `An offer on your ${LABEL} introduction is waiting for your decision.`;
// The plain-words rejection sentence the screening domain hands the template.
const REJECTION_REASON = screeningReasonInPlainWords('pii-in-card');

/** name -> [content, mustNotAppearInBlindVariant] */
function allTemplates(): { name: string; content: EmailContent; blind: boolean }[] {
  return [
    {
      name: 'verification-register',
      blind: false,
      content: renderVerification(
        { code: '123456', link: `${COUNTER}/verify?t=tok`, purpose: 'register' },
        links,
      ),
    },
    {
      name: 'verification-login',
      blind: false,
      content: renderVerification(
        { code: '654321', link: `${COUNTER}/verify?t=tok`, purpose: 'login' },
        links,
      ),
    },
    {
      name: 'approval',
      blind: false,
      content: renderApproval({ summary: SUMMARY, blind: false }, links),
    },
    {
      name: 'approval-blind',
      blind: true,
      content: renderApproval({ blind: true }, links),
    },
    {
      name: 'summons',
      blind: false,
      content: renderSummons({ count: 1, categoryLabel: LABEL, blind: false }, links),
    },
    {
      name: 'summons-batch',
      blind: false,
      content: renderSummons({ count: 3, blind: false }, links),
    },
    {
      name: 'summons-blind',
      blind: true,
      content: renderSummons({ count: 1, categoryLabel: LABEL, blind: true }, links),
    },
    {
      name: 'channel-waiting',
      blind: false,
      content: renderChannelWaiting({ categoryLabel: LABEL, blind: false }, links),
    },
    {
      name: 'channel-waiting-no-label',
      blind: false,
      content: renderChannelWaiting({ blind: false }, links),
    },
    {
      name: 'channel-waiting-blind',
      blind: true,
      content: renderChannelWaiting({ categoryLabel: LABEL, blind: true }, links),
    },
    {
      name: 'your-move',
      blind: false,
      content: renderYourMove({ categoryLabel: LABEL, blind: false }, links),
    },
    {
      name: 'your-move-blind',
      blind: true,
      content: renderYourMove({ categoryLabel: LABEL, blind: true }, links),
    },
    {
      name: 'offer-on-the-table',
      blind: false,
      content: renderOfferOnTheTable(
        { amount: 415, ccy: 'AUD', categoryLabel: LABEL, blind: false },
        links,
      ),
    },
    {
      name: 'offer-on-the-table-blind',
      blind: true,
      content: renderOfferOnTheTable(
        { amount: 415, ccy: 'AUD', categoryLabel: LABEL, blind: true },
        links,
      ),
    },
    {
      name: 'deal-agreed',
      blind: false,
      content: renderDealAgreed(
        { amount: 415, ccy: 'AUD', categoryLabel: LABEL, blind: false },
        links,
      ),
    },
    {
      name: 'deal-agreed-blind',
      blind: true,
      content: renderDealAgreed(
        { amount: 415, ccy: 'AUD', categoryLabel: LABEL, blind: true },
        links,
      ),
    },
    {
      name: 'digest',
      blind: false,
      content: renderDigest(
        {
          cadence: 'weekly',
          blind: false,
          items: [
            { type: 'WANT', categoryLabel: LABEL, newOpposite: 4, nearMisses: 2 },
            { type: 'HAVE', categoryLabel: LABEL2, newOpposite: null, nearMisses: 1 },
          ],
        },
        links,
      ),
    },
    {
      name: 'digest-blind',
      blind: true,
      content: renderDigest(
        {
          cadence: 'daily',
          blind: true,
          items: [{ type: 'WANT', categoryLabel: LABEL, newOpposite: 4, nearMisses: 2 }],
        },
        links,
      ),
    },
    {
      name: 'renewal',
      blind: false,
      content: renderRenewal(
        {
          blind: false,
          cards: [
            { type: 'WANT', categoryLabel: LABEL, expiresAt: new Date('2026-09-03'), expiringSoon: true },
            { type: 'HAVE', categoryLabel: LABEL2, expiresAt: new Date('2026-10-20'), expiringSoon: false },
          ],
        },
        links,
      ),
    },
    {
      name: 'renewal-blind',
      blind: true,
      content: renderRenewal(
        {
          blind: true,
          cards: [
            { type: 'WANT', categoryLabel: LABEL, expiresAt: new Date('2026-09-03'), expiringSoon: true },
          ],
        },
        links,
      ),
    },
    {
      name: 'kill-switch-on',
      blind: false,
      content: renderKillSwitch({ on: true, counterUrl: `${COUNTER}/` }, links),
    },
    {
      name: 'kill-switch-off',
      blind: false,
      content: renderKillSwitch({ on: false, counterUrl: `${COUNTER}/` }, links),
    },
    {
      name: 'security-agent-authorized',
      blind: false,
      content: renderSecurityNotice(
        { event: 'agent-authorized', agentName: 'Claude for Chores', counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'security-pin-changed',
      blind: false,
      content: renderSecurityNotice({ event: 'pin-changed', counterUrl: `${COUNTER}/` }, links),
    },
    {
      name: 'security-agent-key-created',
      blind: false,
      content: renderSecurityNotice(
        { event: 'agent-key-created', agentName: 'the laptop agent', counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      // Blind mode strips the key's name before render (see counter/email.ts);
      // what remains must be a pure pointer.
      name: 'security-agent-key-created-blind',
      blind: true,
      content: renderSecurityNotice(
        { event: 'agent-key-created', counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'card-screening-rejected',
      blind: false,
      content: renderScreeningRejected(
        { categoryLabel: LABEL, reason: REJECTION_REASON, blind: false },
        links,
      ),
    },
    {
      // Blind mode strips the label before render (see counter/email.ts) and
      // the template drops the reason with it: a pure pointer remains.
      name: 'card-screening-rejected-blind',
      blind: true,
      content: renderScreeningRejected(
        { reason: REJECTION_REASON, blind: true },
        links,
      ),
    },
    {
      name: 'settlement-proposed',
      blind: false,
      content: renderSettlementProposed(
        {
          summary: `A settlement of 600 AUD on your ${LABEL} introduction is waiting for your approval.`,
          blind: false,
        },
        links,
      ),
    },
    {
      name: 'settlement-proposed-blind',
      blind: true,
      content: renderSettlementProposed({ blind: true }, links),
    },
    {
      name: 'settlement-payment-held-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'payment-held', role: 'buyer', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-payment-held-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'payment-held', role: 'seller', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-confirm-receipt-request',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'confirm-receipt-request', role: 'buyer', blind: false },
        links,
      ),
    },
    // The handover mails, with and without the clock the deployment runs.
    {
      name: 'settlement-handover-window-buyer',
      blind: false,
      content: renderSettlementUpdate(
        {
          event: 'handover-window',
          role: 'buyer',
          blind: false,
          deadline: new Date('2026-09-12T02:00:00.000Z'),
        },
        links,
      ),
    },
    {
      name: 'settlement-handover-window-buyer-no-clock',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'handover-window', role: 'buyer', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-confirm-receipt-request-seller-clock',
      blind: false,
      content: renderSettlementUpdate(
        {
          event: 'confirm-receipt-request',
          role: 'seller',
          blind: false,
          deadline: new Date('2026-09-12T02:00:00.000Z'),
        },
        links,
      ),
    },
    {
      name: 'settlement-released-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'released', role: 'seller', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-released-auto-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'released', role: 'seller', blind: false, auto: true },
        links,
      ),
    },
    {
      name: 'settlement-released-auto-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'released', role: 'buyer', blind: false, auto: true },
        links,
      ),
    },
    {
      name: 'settlement-refund-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'refund', role: 'buyer', blind: false },
        links,
      ),
    },
    // The frozen half. A dispute freezes the payment and moves nothing, so
    // these three mails have to say what is on hold, what each side can do
    // about it, and — in both endings — that the two fee lines stay paid.
    {
      name: 'settlement-disputed-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'disputed', role: 'buyer', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-disputed-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'disputed', role: 'seller', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-resolution-proposed-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'resolution-proposed', role: 'buyer', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-split-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'split', role: 'seller', blind: false },
        links,
      ),
    },
    {
      name: 'settlement-released-blind',
      blind: true,
      content: renderSettlementUpdate(
        { event: 'released', role: 'seller', blind: true },
        links,
      ),
    },
  ];
}

describe('email templates: render suite', () => {
  for (const t of allTemplates()) {
    it(`${t.name}: renders html + text and passes the human-copy lint`, () => {
      expect(t.content.subject.length).toBeGreaterThan(3);
      expect(t.content.html).toContain('<!doctype html>');
      expect(t.content.html).toContain('OpenSwitchboard');
      expect(t.content.text.length).toBeGreaterThan(40);
      // Every email carries the two footer controls and nothing else of the
      // sort: the one-click unsubscribe and a place to change what is sent.
      expect(t.content.html).toContain(links.settingsUrl);
      expect(t.content.html).toContain(links.unsubUrl!);
      expect(t.content.text).toContain(links.settingsUrl);
      expect(t.content.html).not.toContain(`${COUNTER}/ledger"`);
      // VOICE: no antithesis, and no "card" — one "card" is one want or one
      // have, and from 2026-09-11 the word a person reads is want or have.
      // Payment cards are exempt; nothing else is.
      for (const part of [t.content.subject, t.content.text, t.content.html]) {
        expect(lintHumanCopy(part)).toEqual([]);
      }
      // COPY CULL: "the counter" never appears in email copy (URLs are fine
      // and never contain the phrase), and raw category slugs never render.
      const all = (t.content.subject + t.content.text + t.content.html).toLowerCase();
      expect(all).not.toContain('the counter');
      expect(all).not.toContain(SLUG);
      // FONTS: one system sans stack everywhere; mono only for codes. Every
      // font-family in the HTML must be one of the two approved stacks, and
      // no web fonts are ever linked.
      const APPROVED = [
        "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
        'ui-monospace,Menlo,Consolas,monospace',
      ];
      const fams = [...t.content.html.matchAll(/font-family:([^;"]+)/g)].map((m) => m[1].trim());
      expect(fams.length).toBeGreaterThan(0);
      for (const fam of fams) expect(APPROVED).toContain(fam);
      expect(t.content.html).not.toMatch(/fonts\.googleapis|@font-face|<link/i);
    });
  }

  it('blind variants carry zero content beyond the pointer', () => {
    for (const t of allTemplates().filter((x) => x.blind)) {
      const both = t.content.html + '\n' + t.content.text + '\n' + t.content.subject;
      expect(both).not.toContain(LABEL);
      expect(both).not.toContain(LABEL2);
      expect(both).not.toContain('Mountain');
      expect(both).not.toContain('offer');
      expect(both).not.toContain('2026-09-03');
      expect(both).not.toContain('WANT');
      expect(both).not.toContain('HAVE');
      expect(both).not.toContain('near miss');
    }
  });

  it('the screening-rejection email carries the label and the reason, and no link', () => {
    const byName = Object.fromEntries(allTemplates().map((t) => [t.name, t.content]));
    const c = byName['card-screening-rejected'];
    for (const part of [c.html, c.text]) {
      expect(part).toContain(categoryPhrase(LABEL));
      expect(part).toContain(REJECTION_REASON);
      expect(part).toContain('Ask your assistant');
    }
    expect(c.html).not.toContain(`${COUNTER}/ledger/card-1/edit`);
    // Blind mode: the pointer, and nothing of why.
    const blind = byName['card-screening-rejected-blind'];
    const both = blind.html + blind.text + blind.subject;
    expect(both).not.toContain(REJECTION_REASON);
    expect(both).not.toContain('personal details');
    expect(both).not.toContain('/ledger/card-1/edit');
  });

  it('the lint catches each banned antithesis construction', () => {
    expect(lintEmailCopy('It is a nudge, not a newsletter.')).toHaveLength(1);
    expect(lintEmailCopy('This is signal — not noise.')).toHaveLength(1);
    expect(lintEmailCopy('We match intent, not just keywords here.')).toHaveLength(2);
    expect(lintEmailCopy('A clean, plain sentence about the counter.')).toHaveLength(0);
  });

  // The vocabulary rule (2026-09-11). One "card" is one want or one have, and
  // the word a person reads is want or have. The word survives in three
  // places only: a payment card, the one simile a document is allowed, and
  // the markup hooks that happen to share the spelling.
  it('the lint catches "card" wherever a person would read it', () => {
    expect(lintHumanCopy('Your card lapses on Thursday.')).toHaveLength(1);
    expect(lintHumanCopy('Cards on the switchboard lapse on their own.')).toHaveLength(1);
    expect(lintHumanCopy('Every index card goes through screening.')).toHaveLength(1);
    expect(lintHumanCopy('Your wants and haves lapse on their own.')).toHaveLength(0);
  });

  it('the lint leaves payment cards, the one simile and the markup alone', () => {
    expect(lintHumanCopy('The introductory fee and the card processing stay paid.')).toEqual([]);
    expect(lintHumanCopy('the card\nprocessor keeps its own fee on a refund')).toEqual([]);
    expect(lintHumanCopy('It is as thin as an index card.')).toEqual([]);
    expect(lintHumanCopy('<div class="card-row" data-card-id="x" style="background:var(--card)">')).toEqual([]);
    expect(lintHumanCopy('<a href="/counter/ledger?card=7">Ledger</a>')).toEqual([]);
  });

  // The antithesis lint alone is what a shipped manual changelog entry is
  // held to: an entry that has gone out is never reworded, and the early
  // ones say "card".
  it('the antithesis lint on its own says nothing about vocabulary', () => {
    expect(lintEmailCopy('It covers posting thin cards.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE EMAIL RULE (2026-09-11).
//
// The assistant does the talking and the carrying; whenever a formality is
// needed it hands the person a single-use link to a one-question page, in the
// conversation they are already having. Email is not part of that path. So a
// notice email carries NO link and NO button, says what happened in one
// sentence, and ends "Ask your assistant."
//
// Three exemptions, and only three: the verification code, the security
// notices, and the kill-switch mail. The two footer controls (unsubscribe and
// email settings) are on every mail, because any sender has to carry them.
// ---------------------------------------------------------------------------

/** The one piece of markup a button is: the padded, dark, centred link. */
const hasButton = (html: string): boolean => html.includes('padding:14px 34px');

describe('the email rule: a notice carries no link and no button', () => {
  const byName = (): Record<string, EmailContent> =>
    Object.fromEntries(allTemplates().map((t) => [t.name, t.content]));

  /** Every rendered template that is not one of the three exemptions. */
  const notices = () =>
    allTemplates().filter(
      (t) =>
        !t.name.startsWith('verification') &&
        !t.name.startsWith('security') &&
        !t.name.startsWith('kill-switch'),
    );

  it('every notice passes the notice lint: nothing but the footer controls', () => {
    for (const t of notices()) {
      expect(noticeLinkHits(t.content, FOOTER_PREFIXES), t.name).toEqual([]);
    }
  });

  it('every notice ends on "Ask your assistant."', () => {
    for (const t of notices()) {
      expect(hasButton(t.content.html), t.name).toBe(false);
      expect(t.content.text, t.name).toContain('Ask your assistant');
      expect(t.content.html, t.name).toContain('Ask your assistant');
    }
  });

  it('the notice list and the exemption list between them cover every template', () => {
    for (const t of allTemplates()) {
      // The fixture names carry a suffix ("-blind", "-buyer"); the template
      // name is the send-log name, and every one of them is in one list.
      const covered = [...NOTICE_TEMPLATES, ...EXEMPT_TEMPLATES];
      expect(covered.some((n) => t.name.startsWith(n)), t.name).toBe(true);
    }
    // No template is in both.
    for (const n of NOTICE_TEMPLATES) expect(EXEMPT_TEMPLATES.has(n)).toBe(false);
  });

  it('the notice lint catches a button and a stray link', () => {
    expect(
      noticeLinkHits({ html: '<a style="padding:14px 34px">Go</a>', text: '' }, FOOTER_PREFIXES),
    ).toHaveLength(1);
    expect(
      noticeLinkHits({ html: `<a href="${COUNTER}/a/tok">Go</a>`, text: '' }, FOOTER_PREFIXES),
    ).toHaveLength(1);
    expect(noticeLinkHits({ html: '', text: `Open:\n${COUNTER}/a/tok` }, FOOTER_PREFIXES)).toHaveLength(1);
    expect(
      noticeLinkHits({ html: `<a href="${links.settingsUrl}">Settings</a>`, text: links.unsubUrl! }, FOOTER_PREFIXES),
    ).toEqual([]);
  });

  it('the summons says who came forward, and then to ask', () => {
    const c = byName()['summons'];
    expect(c.text).toContain('Someone has come forward about your mountain bike.');
    expect(c.text.trimEnd()).toContain('Ask your assistant.');
  });

  it('a waiting message says the assistant will read it out', () => {
    const c = byName()['channel-waiting'];
    expect(c.text).toContain('Ask your assistant and it will read it to you.');
  });

  it('your move says whose turn it is, and nothing to press', () => {
    const c = byName()['your-move'];
    expect(c.text).toContain('is keen and ready to talk');
    expect(c.html).not.toContain(`${COUNTER}/a/`);
  });

  it('a figure on the table names the figure and stops', () => {
    const c = byName()['offer-on-the-table'];
    expect(c.text).toContain('has offered $415 AUD for your mountain bike');
    expect(c.html).not.toContain(`${COUNTER}/matches/`);
  });

  it('the renewal says the day it lapses and what to ask for', () => {
    const c = byName()['renewal'];
    expect(c.text).toContain('lapses Thursday 3 September');
    expect(c.text).toContain('Ask your assistant to renew or let it go.');
    expect(c.html).not.toContain('/renew?t=');
  });

  it('the settlement notices say what moved, and point at no page', () => {
    const all = byName();
    for (const name of ['settlement-proposed', 'settlement-payment-held-buyer']) {
      expect(hasButton(all[name].html), name).toBe(false);
      expect(all[name].html, name).not.toContain(`${COUNTER}/settlements/`);
      expect(all[name].text, name).toContain('Ask your assistant.');
    }
  });

  it('the three exemptions keep their links', () => {
    const all = byName();
    for (const name of ['verification-register', 'kill-switch-on', 'security-agent-key-created']) {
      expect(hasButton(all[name].html), name).toBe(true);
    }
    // A security notice that is not the revoke gate keeps the guidance as
    // text, with no button on it.
    for (const name of ['security-agent-authorized', 'security-pin-changed']) {
      expect(hasButton(all[name].html), name).toBe(false);
      expect(all[name].text, name).toContain(`Sign in at ${COUNTER}/ to look.`);
    }
  });
});

describe('email action tokens', () => {
  beforeAll(async () => {
    process.env.COUNTER_LINK_HMAC_KEY = 'ab'.repeat(32);
    process.env.COUNTER_COOKIE_KEY = 'cd'.repeat(32);
    await initCounterKeys({} as any);
  });

  const ACCOUNT = '11111111-2222-3333-4444-555555555555';

  it('round-trips and binds to the purpose', () => {
    const t = signEmailToken(ACCOUNT, 'unsubscribe');
    expect(verifyEmailToken(t, 'unsubscribe')).toMatchObject({ ok: true, accountId: ACCOUNT });
    expect(verifyEmailToken(t, 'renew-all').ok).toBe(false);
  });

  it('rejects tampering', () => {
    const t = signEmailToken(ACCOUNT, 'renew-all');
    const [body, sig] = t.slice('osb_em_'.length).split('.');
    const otherPayload = Buffer.from(
      `99999999-2222-3333-4444-555555555555|renew-all|${Math.floor(Date.now() / 1000) + 1000}`,
    ).toString('base64url');
    expect(verifyEmailToken(`osb_em_${otherPayload}.${sig}`, 'renew-all').ok).toBe(false);
    expect(verifyEmailToken(`osb_em_${body}.AAAA${sig!.slice(4)}`, 'renew-all').ok).toBe(false);
    expect(verifyEmailToken('osb_em_garbage', 'renew-all').ok).toBe(false);
  });
});
