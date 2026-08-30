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
  renderDigest,
  renderKillSwitch,
  renderRenewal,
  renderSecurityNotice,
  renderSummons,
  renderVerification,
  type EmailContent,
  type FooterLinks,
} from '../../src/email/templates.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { signEmailToken, verifyEmailToken } from '../../src/email/tokens.js';

const COUNTER = 'https://counter-dev.openswitchboard.ai';
const links: FooterLinks = {
  settingsUrl: `${COUNTER}/counter/settings`,
  ledgerUrl: `${COUNTER}/counter/ledger`,
  unsubUrl: `${COUNTER}/counter/email/unsub?t=osb_em_test`,
};

const CATEGORY = 'home-services.plumbing.emergency';
const SUMMARY = `An offer on your ${CATEGORY} match is waiting for your decision.`;

/** name -> [content, mustNotAppearInBlindVariant] */
function allTemplates(): { name: string; content: EmailContent; blind: boolean }[] {
  return [
    {
      name: 'verification-register',
      blind: false,
      content: renderVerification(
        { code: '123456', link: `${COUNTER}/counter/verify?t=tok`, purpose: 'register' },
        links,
      ),
    },
    {
      name: 'verification-login',
      blind: false,
      content: renderVerification(
        { code: '654321', link: `${COUNTER}/counter/verify?t=tok`, purpose: 'login' },
        links,
      ),
    },
    {
      name: 'approval',
      blind: false,
      content: renderApproval(
        { link: `${COUNTER}/counter/a/tok`, summary: SUMMARY, blind: false, counterUrl: `${COUNTER}/counter` },
        links,
      ),
    },
    {
      name: 'approval-blind',
      blind: true,
      content: renderApproval(
        { link: `${COUNTER}/counter/a/tok`, blind: true, counterUrl: `${COUNTER}/counter` },
        links,
      ),
    },
    {
      name: 'summons',
      blind: false,
      content: renderSummons(
        { count: 1, category: CATEGORY, blind: false, counterUrl: `${COUNTER}/counter` },
        links,
      ),
    },
    {
      name: 'summons-batch',
      blind: false,
      content: renderSummons({ count: 3, blind: false, counterUrl: `${COUNTER}/counter` }, links),
    },
    {
      name: 'summons-blind',
      blind: true,
      content: renderSummons(
        { count: 1, category: CATEGORY, blind: true, counterUrl: `${COUNTER}/counter` },
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
          counterUrl: `${COUNTER}/counter`,
          items: [
            { type: 'WANT', category: CATEGORY, newOpposite: 4, nearMisses: 2 },
            { type: 'HAVE', category: 'goods.bicycles', newOpposite: null, nearMisses: 1 },
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
          counterUrl: `${COUNTER}/counter`,
          items: [{ type: 'WANT', category: CATEGORY, newOpposite: 4, nearMisses: 2 }],
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
          counterUrl: `${COUNTER}/counter`,
          renewAllUrl: `${COUNTER}/counter/renew?t=tok`,
          cards: [
            { type: 'WANT', category: CATEGORY, expiresAt: new Date('2026-09-03'), expiringSoon: true },
            { type: 'HAVE', category: 'goods.bicycles', expiresAt: new Date('2026-10-20'), expiringSoon: false },
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
          counterUrl: `${COUNTER}/counter`,
          renewAllUrl: `${COUNTER}/counter/renew?t=tok`,
          cards: [
            { type: 'WANT', category: CATEGORY, expiresAt: new Date('2026-09-03'), expiringSoon: true },
          ],
        },
        links,
      ),
    },
    {
      name: 'kill-switch-on',
      blind: false,
      content: renderKillSwitch({ on: true, counterUrl: `${COUNTER}/counter` }, links),
    },
    {
      name: 'kill-switch-off',
      blind: false,
      content: renderKillSwitch({ on: false, counterUrl: `${COUNTER}/counter` }, links),
    },
    {
      name: 'security-agent-authorized',
      blind: false,
      content: renderSecurityNotice(
        { event: 'agent-authorized', agentName: 'Claude for Chores', counterUrl: `${COUNTER}/counter` },
        links,
      ),
    },
    {
      name: 'security-pin-changed',
      blind: false,
      content: renderSecurityNotice({ event: 'pin-changed', counterUrl: `${COUNTER}/counter` }, links),
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
    });
  }

  it('blind variants carry zero content beyond the pointer', () => {
    for (const t of allTemplates().filter((x) => x.blind)) {
      const both = t.content.html + '\n' + t.content.text + '\n' + t.content.subject;
      expect(both).not.toContain(CATEGORY);
      expect(both).not.toContain('plumbing');
      expect(both).not.toContain('bicycles');
      expect(both).not.toContain('offer');
      expect(both).not.toContain('2026-09-03');
      expect(both).not.toContain('WANT');
      expect(both).not.toContain('HAVE');
      expect(both).not.toContain('near miss');
    }
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
