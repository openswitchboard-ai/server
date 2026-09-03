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
  renderApproval,
  renderChannelWaiting,
  renderDigest,
  renderKillSwitch,
  renderRenewal,
  renderScreeningRejected,
  renderSecurityNotice,
  renderSettlementProposed,
  renderSettlementUpdate,
  renderSummons,
  renderVerification,
  renderYourMove,
  type EmailContent,
  type FooterLinks,
} from '../../src/email/templates.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { screeningReasonInPlainWords } from '../../src/domain/screening.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { signEmailToken, verifyEmailToken } from '../../src/email/tokens.js';

const COUNTER = 'https://my-dev.openswitchboard.ai';
const links: FooterLinks = {
  settingsUrl: `${COUNTER}/settings`,
  ledgerUrl: `${COUNTER}/ledger`,
  unsubUrl: `${COUNTER}/email/unsub?t=osb_em_test`,
};

// Raw slugs must NEVER appear in an email — only the taxonomy's human label.
const SLUG = 'goods.bicycle.mountain';
const LABEL = 'Mountain bikes';
const LABEL2 = 'Garden tools';
const SUMMARY = `An offer on your ${LABEL} match is waiting for your decision.`;
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
      content: renderApproval(
        { link: `${COUNTER}/a/tok`, summary: SUMMARY, blind: false, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'approval-blind',
      blind: true,
      content: renderApproval(
        { link: `${COUNTER}/a/tok`, blind: true, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'summons',
      blind: false,
      content: renderSummons(
        { count: 1, categoryLabel: LABEL, blind: false, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'summons-batch',
      blind: false,
      content: renderSummons({ count: 3, blind: false, counterUrl: `${COUNTER}/` }, links),
    },
    {
      name: 'summons-blind',
      blind: true,
      content: renderSummons(
        { count: 1, categoryLabel: LABEL, blind: true, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'channel-waiting',
      blind: false,
      content: renderChannelWaiting(
        { categoryLabel: LABEL, blind: false, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'channel-waiting-no-label',
      blind: false,
      content: renderChannelWaiting({ blind: false, counterUrl: `${COUNTER}/` }, links),
    },
    {
      name: 'channel-waiting-blind',
      blind: true,
      content: renderChannelWaiting(
        { categoryLabel: LABEL, blind: true, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'your-move',
      blind: false,
      content: renderYourMove(
        { categoryLabel: LABEL, blind: false, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'your-move-blind',
      blind: true,
      content: renderYourMove(
        { categoryLabel: LABEL, blind: true, counterUrl: `${COUNTER}/` },
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
          counterUrl: `${COUNTER}/`,
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
          counterUrl: `${COUNTER}/`,
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
          counterUrl: `${COUNTER}/`,
          renewAllUrl: `${COUNTER}/renew?t=tok`,
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
          counterUrl: `${COUNTER}/`,
          renewAllUrl: `${COUNTER}/renew?t=tok`,
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
        {
          categoryLabel: LABEL,
          reason: REJECTION_REASON,
          editUrl: `${COUNTER}/ledger/card-1/edit`,
          blind: false,
          counterUrl: `${COUNTER}/`,
        },
        links,
      ),
    },
    {
      // Blind mode strips the label before render (see counter/email.ts) and
      // the template drops the reason with it: a pure pointer remains.
      name: 'card-screening-rejected-blind',
      blind: true,
      content: renderScreeningRejected(
        {
          reason: REJECTION_REASON,
          editUrl: `${COUNTER}/ledger/card-1/edit`,
          blind: true,
          counterUrl: `${COUNTER}/`,
        },
        links,
      ),
    },
    {
      name: 'settlement-proposed',
      blind: false,
      content: renderSettlementProposed(
        {
          link: `${COUNTER}/a/tok`,
          summary: `A settlement of 600 AUD on your ${LABEL} match is waiting for your approval.`,
          blind: false,
          counterUrl: `${COUNTER}/`,
        },
        links,
      ),
    },
    {
      name: 'settlement-proposed-blind',
      blind: true,
      content: renderSettlementProposed(
        { link: `${COUNTER}/a/tok`, blind: true, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-payment-held-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'payment-held', role: 'buyer', blind: false, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-payment-held-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'payment-held', role: 'seller', blind: false, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-confirm-receipt-request',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'confirm-receipt-request', role: 'buyer', blind: false, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-released-seller',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'released', role: 'seller', blind: false, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-refund-buyer',
      blind: false,
      content: renderSettlementUpdate(
        { event: 'refund', role: 'buyer', blind: false, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
    {
      name: 'settlement-update-blind',
      blind: true,
      content: renderSettlementUpdate(
        { event: 'released', role: 'seller', blind: true, settlementUrl: `${COUNTER}/settlements/x`, counterUrl: `${COUNTER}/` },
        links,
      ),
    },
  ];
}

describe('email templates: render suite', () => {
  for (const t of allTemplates()) {
    it(`${t.name}: renders html + text and passes the banned-phrase lint`, () => {
      expect(t.content.subject.length).toBeGreaterThan(3);
      expect(t.content.html).toContain('<!doctype html>');
      expect(t.content.html).toContain('OpenSwitchboard');
      expect(t.content.text.length).toBeGreaterThan(40);
      // Every email links to the counter and carries the footer controls.
      expect(t.content.html).toContain(links.settingsUrl);
      expect(t.content.html).toContain(links.ledgerUrl);
      expect(t.content.text).toContain(links.settingsUrl);
      // VOICE: no antithesis, subject + text + html.
      for (const part of [t.content.subject, t.content.text, t.content.html]) {
        expect(lintEmailCopy(part)).toEqual([]);
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

  it('the screening-rejection email carries the label, the reason and the edit link', () => {
    const byName = Object.fromEntries(allTemplates().map((t) => [t.name, t.content]));
    const c = byName['card-screening-rejected'];
    for (const part of [c.html, c.text]) {
      expect(part).toContain(LABEL);
      expect(part).toContain(REJECTION_REASON);
      expect(part).toContain(`${COUNTER}/ledger/card-1/edit`);
    }
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
