/**
 * Counter unit tests, including the STRUCTURAL route-isolation matrix:
 *  - an MCP bearer token is rejected (403) on EVERY registered /counter
 *    route, enumerated from the live route table — before any DB access;
 *  - a counter session cookie is worthless on /mcp (401).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { COUNTER_ROUTE_TABLE } from '../../src/counter/routes.js';
import { CONSENT_STATEMENT } from '../../src/counter/pages.js';
import { lockoutMinutes, pinFormatOk, PIN_MAX_ATTEMPTS } from '../../src/counter/pin.js';
import { bindingString, signLink } from '../../src/counter/links.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://counter.test',
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
};

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
});

const fillParams = (url: string) =>
  url
    .replace(':token', 'sometoken')
    .replace(':id', '00000000-0000-0000-0000-000000000000');

describe('route isolation: agent credentials x counter routes', () => {
  it('the counter route class is non-trivially enumerated', () => {
    expect(COUNTER_ROUTE_TABLE.length).toBeGreaterThanOrEqual(25);
    const urls = COUNTER_ROUTE_TABLE.map((r) => `${r.method} ${r.url}`);
    for (const must of [
      'GET /counter',
      'POST /counter/register',
      'POST /counter/verify',
      'POST /counter/pin/set',
      'POST /counter/approve',
      'GET /counter/ledger',
      'POST /counter/kill',
      'POST /counter/authorize',
      'GET /counter/a/:token',
    ]) {
      expect(urls, `missing route ${must}`).toContain(must);
    }
  });

  it('an MCP bearer token gets 403 on EVERY /counter route', async () => {
    for (const r of COUNTER_ROUTE_TABLE) {
      const res = await app.inject({
        method: r.method as any,
        url: fillParams(r.url),
        headers: {
          host: 'counter.test',
          authorization: 'Bearer osb_at_agent-token-should-never-work-here',
        },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().error, `${r.method} ${r.url}`).toBe('agent_credentials_rejected');
    }
  });

  it('a counter session cookie gets 401 on /mcp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'mcp.test',
        cookie: 'osb_counter=osb_cs_some-session-value',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
  });

  it('/mcp is not served on the counter hostname', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'counter.test', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('/counter is not served on the MCP hostname', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/counter',
      headers: { host: 'mcp.test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PIN policy', () => {
  it('requires 6-12 digits', () => {
    expect(pinFormatOk('123456')).toBe(true);
    expect(pinFormatOk('123456789012')).toBe(true);
    expect(pinFormatOk('12345')).toBe(false);
    expect(pinFormatOk('abcdef')).toBe(false);
    expect(pinFormatOk('12 3456')).toBe(false);
  });
  it('locks after 5 tries with exponential backoff, capped at 60 minutes', () => {
    expect(PIN_MAX_ATTEMPTS).toBe(5);
    expect(lockoutMinutes(5)).toBe(1);
    expect(lockoutMinutes(6)).toBe(2);
    expect(lockoutMinutes(7)).toBe(4);
    expect(lockoutMinutes(20)).toBe(60);
  });
});

describe('approval link signing', () => {
  const key = Buffer.from('a'.repeat(64), 'hex');
  const row = {
    id: '11111111-1111-1111-1111-111111111111',
    account_id: 'acct-1',
    action: 'offer-accept',
    ref_id: 'offer-1',
    amount: 620,
    ccy: 'AUD',
    counterparty_account: 'acct-2',
  };
  it('binds {account, action, amount, counterparty}: any change breaks the MAC', () => {
    const token = signLink(row, key);
    expect(token.startsWith(row.id + '.')).toBe(true);
    for (const tampered of [
      { ...row, account_id: 'acct-9' },
      { ...row, action: 'stage3-disclosure' },
      { ...row, amount: 9999 },
      { ...row, counterparty_account: 'acct-9' },
      { ...row, ref_id: 'offer-2' },
    ]) {
      expect(signLink(tampered as any, key)).not.toBe(token);
    }
  });
  it('binding string is stable and complete', () => {
    expect(bindingString(row as any)).toBe(
      '11111111-1111-1111-1111-111111111111|acct-1|offer-accept|offer-1|620|AUD|acct-2',
    );
  });
});

describe('consent statement', () => {
  it('is the exact agreed text', () => {
    expect(CONSENT_STATEMENT).toBe(
      'My agent may store wants & haves as cards on my behalf. I can see, edit, or withdraw everything on my approval page.',
    );
  });
});

// ---------------------------------------------------------------------------
// COPY CULL render suite (0.H) — mirrors the email suite: render every
// counter page with representative data and assert the banned phrasing and
// raw category slugs can never regress. Routes hand pages the taxonomy's
// human label (categoryLeafLabel); pages must never see or show a raw slug.
// ---------------------------------------------------------------------------
import * as cpages from '../../src/counter/pages.js';
import * as chome from '../../src/counter/pagesHome.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { categoryLeafLabel } from '../../src/domain/matchRules.js';

const SLUG = 'goods.bicycle.mountain';
const LABEL = categoryLeafLabel(SLUG);

describe('counter pages: copy-cull render suite', () => {
  const allPages = (): { name: string; html: string }[] => [
    { name: 'landing', html: cpages.landingPage() },
    { name: 'register-email', html: cpages.registerEmailPage('Bad email.') },
    {
      name: 'code-entry',
      html: cpages.codeEntryPage({ verificationId: 'v-1', action: '/counter/verify' }),
    },
    { name: 'pin-set', html: cpages.pinSetPage() },
    { name: 'passkey-offer', html: cpages.passkeyOfferPage() },
    { name: 'consent', html: cpages.consentPage() },
    { name: 'login', html: cpages.loginEmailPage() },
    { name: 'message-default-back', html: cpages.messagePage('Renewed', '<p>Done.</p>') },
    { name: 'link-dead-used', html: cpages.linkDeadPage('used') },
    { name: 'link-dead-expired', html: cpages.linkDeadPage('expired') },
    { name: 'link-dead-invalid', html: cpages.linkDeadPage('invalid') },
    {
      name: 'approval-offer',
      html: cpages.approvalPage({
        action: 'offer-accept',
        refId: 'ref-1',
        facts: [
          { k: 'You are agreeing to', v: '620 AUD' },
          { k: 'For', v: LABEL },
          { k: 'Offer expires', v: 'Tue, 01 Sep 2026 00:00:00 GMT' },
        ],
        anomalies: ['3× your usual amount'],
        hasPasskey: true,
        elevated: false,
        postPath: '/counter/approve',
      }),
    },
    { name: 'oauth-authorize', html: cpages.authorizePage('Claude for Chores', '/counter/authorize', {}) },
    { name: 'registration-closed', html: cpages.registrationClosedPage() },
    {
      name: 'dashboard',
      html: chome.dashboardPage({
        emailUnreachable: true,
        killSwitchOn: false,
        cardCounts: { total: 2, published: 1, pending: 1 },
        pendingApprovals: [
          { href: '/counter/approvals/offer/o-1', label: `Offer on your ${LABEL} match`, amount: '620 AUD' },
        ],
        matches: [{ matchId: 'm-1', category: LABEL, score: 0.87 }],
        collectionWindows: [
          { cardId: 'c-1', category: LABEL, type: 'WANT', until: '2026-09-01 00:00 UTC', interestedParties: 2 },
        ],
      }),
    },
    { name: 'dashboard-kill-on', html: chome.dashboardPage({ killSwitchOn: true, cardCounts: { total: 0, published: 0, pending: 0 }, pendingApprovals: [], matches: [], collectionWindows: [] }) },
    {
      name: 'ledger',
      html: chome.ledgerPage([
        {
          id: 'c-1',
          type: 'WANT',
          category: LABEL,
          state: 'PUBLISHED',
          status: 'active',
          expiresAt: '2026-10-01',
          priceBand: '0–800 AUD',
          matchSummary: 'no matches yet',
          attributes: 'condition: good',
        },
      ], 'Withdrawn — effective immediately.'),
    },
    {
      name: 'card-edit',
      html: chome.cardEditPage({
        id: 'c-1',
        type: 'WANT',
        category: LABEL,
        urgency: 'none',
        status: 'active',
        ttlDays: 60,
        attributesJson: '{}',
        collectWindowDefault: 240,
      }),
    },
    {
      name: 'settings',
      html: chome.settingsPage({
        blindMode: false,
        freqMatches: 'immediate',
        freqDigests: 'daily',
        complaintSuppressed: true,
        emailUnreachable: true,
      }),
    },
    {
      name: 'renew',
      html: chome.renewPage(
        [
          {
            type: 'WANT',
            category: LABEL,
            attributes: 'condition: good · frame: large',
            expires: '2026-09-05',
            expiringSoon: true,
          },
        ],
        'osb_em_tok',
      ),
    },
    { name: 'unsub', html: chome.unsubPage('osb_em_tok') },
    { name: 'reverify', html: chome.reverifyCodePage('v-1') },
  ];

  it('the taxonomy maps the test slug to a human label', () => {
    expect(LABEL).toBe('Mountain bikes');
    expect(LABEL).not.toContain('.');
  });

  for (const p of allPages()) {
    it(`${p.name}: no "the counter", no raw slugs, passes the banned-phrase lint`, () => {
      const low = p.html.toLowerCase();
      // "the counter" and "your counter" are gone from every page. URLs are
      // fine: route paths are "/counter/...", which never form the phrase.
      expect(low).not.toContain('the counter');
      expect(low).not.toContain('your counter');
      // Raw category slugs never render — the label does.
      expect(p.html).not.toContain(SLUG);
      expect(low).not.toMatch(/goods\.[a-z]/);
      // Banned jargon stays out of page copy.
      expect(low).not.toContain('safety rail');
      // VOICE: same antithesis lint the email suite runs.
      expect(lintEmailCopy(p.html)).toEqual([]);
    });
  }

  it('pages given a category label show it', () => {
    const byName = Object.fromEntries(allPages().map((p) => [p.name, p.html]));
    for (const name of ['dashboard', 'ledger', 'card-edit', 'renew', 'approval-offer']) {
      expect(byName[name], name).toContain(LABEL);
    }
  });

  it('card rows carry the attributes detail line that tells same-category cards apart', () => {
    const byName = Object.fromEntries(allPages().map((p) => [p.name, p.html]));
    expect(byName['ledger']).toContain('condition: good');
    expect(byName['renew']).toContain('condition: good · frame: large');
  });
});
