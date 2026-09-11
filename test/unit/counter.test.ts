/**
 * Counter unit tests, including the STRUCTURAL route-isolation matrix:
 *  - an MCP bearer token is rejected (403) on EVERY registered /
 *    route, enumerated from the live route table — before any DB access;
 *  - a counter session cookie is worthless on /mcp (401).
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { COUNTER_ROUTE_TABLE } from '../../src/counter/routes.js';
import { CONSENT_STATEMENT } from '../../src/counter/pages.js';
import { lockoutMinutes, pinFormatOk, PIN_MAX_ATTEMPTS } from '../../src/counter/pin.js';
import { bindingString, signLink } from '../../src/counter/links.js';
import * as sess from '../../src/counter/session.js';
import * as db from '../../src/db.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
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
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
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
      'GET /',
      'POST /register',
      'POST /verify',
      'POST /pin/set',
      'POST /approve',
      'GET /ledger',
      'POST /kill',
      'POST /authorize',
      'GET /a/:token',
      'GET /profile',
      'POST /profile',
      'GET /arrangement',
      'POST /arrangement',
      'POST /arrangement/clear',
      'GET /approvals/settlement/:id',
      'GET /settlements/:id',
      'POST /settlements/:id/pay',
      'POST /settlements/:id/confirm',
      'POST /settlements/:id/dispute',
      'POST /settlements/:id/evidence/lock',
    ]) {
      expect(urls, `missing route ${must}`).toContain(must);
    }
  });

  it('an MCP bearer token gets 403 on EVERY / route', async () => {
    for (const r of COUNTER_ROUTE_TABLE) {
      const res = await app.inject({
        method: r.method as any,
        url: fillParams(r.url),
        headers: {
          host: 'my.test',
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
      headers: { host: 'my.test', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the human pages are not served on the MCP hostname', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ledger',
      headers: { host: 'mcp.test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the MCP hostname answers its own root with the endpoint banner', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'mcp.test' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('https://mcp.test/mcp');
  });

  it('an old /counter path on the MCP hostname is a 404, never a redirect', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/counter/ledger',
      headers: { host: 'mcp.test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the move to the my.* hostname', () => {
  it('an old /counter path 308s to the same page without the prefix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/counter/ledger?card=7',
      headers: { host: 'my.test' },
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe('/ledger?card=7');
  });

  it('bare /counter 308s to the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/counter', headers: { host: 'my.test' } });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe('/');
  });

  it('the old hostname 308s to the new one, prefix and query intact', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/counter/a/sometoken?x=1',
      headers: { host: 'counter.test' },
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe('https://my.test/a/sometoken?x=1');
  });

  it('the old hostname 308s a path that never had the prefix too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'counter.test' },
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe('https://my.test/login');
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

// ---------------------------------------------------------------------------
// Patch. The pages carry the real artwork rather than an emoji standing in for
// him, so the bytes and the route that serves them are part of the contract.
// ---------------------------------------------------------------------------
describe('Patch, served from the pages that show him', () => {
  const isPng = (b: Buffer) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  it('the header mark and the tab icon are real PNGs, and small', async () => {
    const { PATCH_HEADER_PNG, PATCH_FAVICON_PNG } = await import('../../src/counter/patchAsset.js');
    for (const b of [PATCH_HEADER_PNG, PATCH_FAVICON_PNG]) {
      expect(isPng(b)).toBe(true);
      expect(b.length).toBeLessThan(8 * 1024);
    }
    // 126x96 for the header (a 63x48 box at 2x); 64x64 square for the tab.
    expect([PATCH_HEADER_PNG.readUInt32BE(16), PATCH_HEADER_PNG.readUInt32BE(20)]).toEqual([126, 96]);
    expect([PATCH_FAVICON_PNG.readUInt32BE(16), PATCH_FAVICON_PNG.readUInt32BE(20)]).toEqual([64, 64]);
  });

  it('both are served from the human hostname, cached for a year', async () => {
    for (const url of ['/assets/patch.png', '/assets/favicon.png']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'my.test' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('image/png');
      expect(res.headers['cache-control'], url).toContain('max-age=31536000');
      expect(res.headers['cache-control'], url).toContain('immutable');
      expect(res.headers.etag, url).toBeTruthy();
      expect(isPng(res.rawPayload), url).toBe(true);
    }
  });

  it('every page points at him, and no page still shows the stand-in emoji', async () => {
    const cp = await import('../../src/counter/pages.js');
    const html = cp.landingPage();
    expect(html).toContain('src="/assets/patch.png"');
    expect(html).toContain('rel="icon" type="image/png" href="/assets/favicon.png"');
    expect(html).not.toContain('🐙');
  });
});

describe('consent statement', () => {
  it('is the exact agreed text', () => {
    expect(CONSENT_STATEMENT).toBe(
      'My agent may post wants & haves on my behalf. I can see, edit, or withdraw everything on my approval page.',
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
import { lintEmailCopy, lintHumanCopy } from '../../src/email/lint.js';
import { categoryLeafLabel } from '../../src/domain/matchRules.js';
import { screeningReasonInPlainWords } from '../../src/domain/screening.js';

const SLUG = 'goods.bicycle.mountain';
const LABEL = categoryLeafLabel(SLUG);

/** A settlement page view, with only the interesting parts named. */
const settlementView = (over: Partial<cpages.SettlementView> = {}): cpages.SettlementView => ({
  id: 's-1',
  role: 'buyer',
  state: 'approved',
  amount: '87.65 AUD',
  fee: '1.00 AUD',
  processing: '1.84 AUD',
  buyerTotal: '90.49 AUD',
  category: LABEL,
  myApprovalPending: false,
  canPay: false,
  needsPaymentSetup: false,
  canLockEvidence: false,
  canConfirm: false,
  canRetryRelease: false,
  canDispute: false,
  evidence: [],
  hasPasskey: false,
  elevated: false,
  autoReleaseDays: 7,
  inDispute: false,
  canAddTracking: false,
  canMarkReturned: false,
  canConfirmReturn: false,
  canProposeSplit: false,
  canApproveSplit: false,
  agreedMinor: 8765,
  ccy: 'AUD',
  ...over,
});

/** Every day on these pages arrives as localTime() markup: the browser prints
 *  the reader's own clock, and the UTC day inside is what anything else sees. */
const DAY = (iso: string) => cpages.localTime(iso, 'day');
const SEP_5 = DAY('2026-09-05T00:00:00.000Z');
const SEP_12 = DAY('2026-09-12T00:00:00.000Z');
const SEP_19 = DAY('2026-09-19T00:00:00.000Z');

/** The buyer's clock, as the page is handed it while the window runs. */
const HANDOVER = {
  sellerName: 'Priya',
  onDay: SEP_5,
  byDay: SEP_12,
};

// ---------------------------------------------------------------------------
// Times on the human pages belong to whoever is reading them. The server
// prints UTC and marks the element; the browser rewrites it into the reader's
// own clock. Nothing agent-facing changes — an agent relays words, not markup.
// ---------------------------------------------------------------------------
describe('local times', () => {
  it('a minute carries the ISO stamp and a UTC fallback', () => {
    expect(cpages.localTime('2026-09-09T10:28:00.000Z')).toBe(
      '<time datetime="2026-09-09T10:28:00.000Z" data-local="minute">2026-09-09 10:28 UTC</time>',
    );
  });

  it('a day falls back to the day in plain words', () => {
    expect(cpages.localTime(new Date('2026-09-13T00:00:00.000Z'), 'day')).toBe(
      '<time datetime="2026-09-13T00:00:00.000Z" data-local="day">Sunday 13 September</time>',
    );
  });

  it('every page carries the one script that localises them', () => {
    const html = cpages.landingPage();
    expect(html).toContain("document.querySelectorAll('time[data-local]')");
    expect(html).toContain('Intl.DateTimeFormat(');
    // The reader's clock needs no label, so none is appended.
    expect(html).not.toContain("+ ' UTC'");
  });

  it('the pages print the markup rather than escaping it', () => {
    const settlement = cpages.settlementPage(
      settlementView({ state: 'evidence-locked', canConfirm: true, handover: HANDOVER }),
    );
    expect(settlement).toContain('<time datetime="2026-09-05T00:00:00.000Z" data-local="day">');
    expect(settlement).not.toContain('&lt;time');

    const dashboard = chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 1, published: 1, pending: 0 },
      pendingApprovals: [],
      collectionWindows: [
        {
          cardId: 'c-1',
          category: LABEL,
          type: 'WANT',
          until: cpages.localTime('2026-09-09T10:28:00.000Z'),
          interestedParties: 2,
        },
      ],
    });
    expect(dashboard).toContain(
      'window open until <time datetime="2026-09-09T10:28:00.000Z" data-local="minute">2026-09-09 10:28 UTC</time>',
    );
  });

  it('the offer and arrangement pages do the same', () => {
    const offers = chome.matchOffersPage({
      matchId: 'm-1',
      cardId: 'c-1',
      category: LABEL,
      type: 'WANT',
      mode: 'assisted',
      canOffer: true,
      offers: [
        {
          amount: '620 AUD',
          mine: false,
          state: 'open',
          expires: cpages.localTime('2026-09-09T10:28:00.000Z'),
        },
      ],
    });
    expect(offers).toContain(
      'good until <time datetime="2026-09-09T10:28:00.000Z" data-local="minute">2026-09-09 10:28 UTC</time>',
    );

    const arrangement = chome.arrangementPage(
      { check_every_minutes: 720 },
      { updated: cpages.localTime('2026-09-02T04:00:00.000Z') },
    );
    expect(arrangement).toContain(
      'Last changed <time datetime="2026-09-02T04:00:00.000Z" data-local="minute">2026-09-02 04:00 UTC</time>',
    );
  });
});

/** The offers page's view, with the parts a given test cares about swapped in. */
const offersView = (over: Partial<chome.MatchOffersView> = {}): chome.MatchOffersView => ({
  matchId: 'm-1',
  cardId: 'c-1',
  category: LABEL,
  type: 'HAVE',
  mode: 'relay',
  canOffer: true,
  offers: [],
  ...over,
});

describe('counter pages: copy-cull render suite', () => {
  const allPages = (): { name: string; html: string }[] => [
    { name: 'landing', html: cpages.landingPage() },
    { name: 'register-email', html: cpages.registerEmailPage('Bad email.') },
    {
      name: 'code-entry',
      html: cpages.codeEntryPage({ verificationId: 'v-1', action: '/verify' }),
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
        elevated: false,
        postPath: '/approve',
      }),
    },
    {
      name: 'approval-stage3-collect',
      html: cpages.approvalPage({
        action: 'stage3-disclosure',
        refId: 'm-1',
        facts: [
          { k: 'What gets shared', v: 'first name + locality' },
          { k: 'For', v: LABEL },
          { k: 'Shared with', v: 'your matched counterparty' },
        ],
        anomalies: [],
        collectProfile: { firstName: '', locality: '' },
        hasPasskey: false,
        elevated: false,
        postPath: '/approve',
      }),
    },
    {
      name: 'approval-settlement',
      html: cpages.approvalPage({
        action: 'settlement-approve',
        refId: 's-1',
        facts: [
          { k: 'You would pay', v: '90.49 AUD' },
          { k: 'For', v: LABEL },
          { k: 'What you agreed', v: '87.65 AUD' },
          { k: 'Introductory fee', v: '1.00 AUD, paid by the buyer' },
          { k: 'Card processing', v: "1.84 AUD, at Stripe's standard rate" },
          { k: 'The seller receives', v: '87.65 AUD in full' },
          { k: 'How it works', v: 'held until you confirm receipt' },
        ],
        anomalies: [],
        hasPasskey: false,
        elevated: false,
        postPath: '/approve',
      }),
    },
    { name: 'settlement-buyer-pay', html: cpages.settlementPage(settlementView({ canPay: true })) },
    {
      name: 'settlement-buyer-confirm',
      html: cpages.settlementPage(settlementView({ state: 'evidence-locked', canConfirm: true, canDispute: true })),
    },
    {
      name: 'settlement-buyer-handover-window',
      html: cpages.settlementPage(
        settlementView({
          state: 'evidence-locked',
          canConfirm: true,
          canDispute: true,
          handover: HANDOVER,
        }),
      ),
    },
    {
      name: 'settlement-seller-handover-window',
      html: cpages.settlementPage(
        settlementView({
          role: 'seller',
          state: 'evidence-locked',
          canDispute: true,
          handover: HANDOVER,
        }),
      ),
    },
    {
      name: 'settlement-buyer-frozen',
      html: cpages.settlementPage(
        settlementView({
          state: 'disputed',
          inDispute: true,
          disputeGround: 'not_as_described',
          canProposeSplit: true,
          canMarkReturned: true,
          deadlockByDay: SEP_19,
        }),
      ),
    },
    {
      name: 'settlement-seller-frozen',
      html: cpages.settlementPage(
        settlementView({
          role: 'seller',
          state: 'resolution-proposed',
          inDispute: true,
          disputeGround: 'not_arrived',
          canAddTracking: true,
          canProposeSplit: true,
          canApproveSplit: true,
          trackingGraceByDay: SEP_12,
          deadlockByDay: SEP_19,
          split: {
            refundMinor: 2000,
            releaseMinor: 6765,
            refund: '20.00 AUD',
            release: '67.65 AUD',
            mine: false,
            theirs: true,
          },
        }),
      ),
    },
    {
      name: 'settlement-seller-declare-handover',
      html: cpages.settlementPage(
        settlementView({ role: 'seller', state: 'funded', canLockEvidence: true, canDispute: true, canAddTracking: true }),
      ),
    },
    {
      name: 'settlement-buyer-retry-release',
      html: cpages.settlementPage(settlementView({ state: 'confirmed', canRetryRelease: true })),
    },
    {
      name: 'settlement-buyer-retry-auto-release',
      html: cpages.settlementPage(
        settlementView({ state: 'confirmed', canRetryRelease: true, autoReleased: true }),
      ),
    },
    {
      name: 'settlement-seller-setup',
      html: cpages.settlementPage(settlementView({ role: 'seller', needsPaymentSetup: true })),
    },
    { name: 'shared-profile-empty', html: chome.sharedProfilePage({ firstName: '', locality: '' }) },
    {
      name: 'shared-profile-filled',
      html: chome.sharedProfilePage(
        { firstName: 'Ana', locality: 'Fremantle' },
        { notice: 'Saved. This is what a match sees once you both say yes.' },
      ),
    },
    { name: 'oauth-authorize', html: cpages.authorizePage('Claude for Chores', '/authorize', {}) },
    { name: 'registration-closed', html: cpages.registrationClosedPage() },
    {
      name: 'dashboard',
      html: chome.dashboardPage({
        emailUnreachable: true,
        killSwitchOn: false,
        cardCounts: { total: 2, published: 1, pending: 1 },
        pendingApprovals: [
          {
            href: '/ledger/c-9/edit',
            label: `Your ${LABEL} didn't pass screening — see why and fix it`,
            cta: 'See why and fix it',
          },
          { href: '/approvals/offer/o-1', label: `Offer on your ${LABEL} match`, amount: '620 AUD' },
        ],
        collectionWindows: [
          { cardId: 'c-1', category: LABEL, type: 'WANT', until: cpages.localTime('2026-09-01T00:00:00.000Z'), interestedParties: 2 },
        ],
      }),
    },
    { name: 'dashboard-kill-on', html: chome.dashboardPage({ killSwitchOn: true, cardCounts: { total: 0, published: 0, pending: 0 }, pendingApprovals: [], collectionWindows: [] }) },
    {
      name: 'ledger',
      html: chome.ledgerPage([
        {
          id: 'c-1',
          type: 'WANT',
          category: LABEL,
          location: 'Canberra, Australian Capital Territory, Australia — matching within 150 km',
          state: 'PUBLISHED',
          status: 'active',
          expiresAt: '2026-10-01',
          priceBand: '0–800 AUD',
          matchSummary: 'no matches yet',
          attributes: 'condition: good',
        },
        {
          id: 'c-2',
          type: 'HAVE',
          category: LABEL,
          location: 'Canberra, Australian Capital Territory, Australia — reaching all of Australia',
          state: 'PUBLISHED',
          status: 'active',
          expiresAt: '2026-10-01',
          matchSummary: 'no matches yet',
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
      name: 'card-edit-screening-rejected',
      html: chome.cardEditPage({
        id: 'c-1',
        type: 'WANT',
        category: LABEL,
        urgency: 'none',
        status: 'active',
        ttlDays: 60,
        attributesJson: '{}',
        collectWindowDefault: 240,
        screeningRejection: {
          plain: screeningReasonInPlainWords('pii-in-card'),
          code: 'pii-in-card',
        },
      }),
    },
    {
      name: 'settings',
      html: chome.settingsPage({
        hearsVia: 'email',
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
    {
      name: 'agent-keys',
      html: chome.agentKeysPage(
        {
          keys: [
            {
              keyId: 'k-1',
              name: 'the laptop agent',
              created: DAY('2026-09-01T00:00:00.000Z'),
              lastUsed: DAY('2026-09-02T00:00:00.000Z'),
              expires: DAY('2026-11-30T00:00:00.000Z'),
            },
          ],
          elevated: false,
          atLimit: false,
        },
        'Revoked. Anything still using that key stops working right now.',
      ),
    },
    {
      name: 'agent-key-created',
      html: chome.agentKeyCreatedPage({
        name: 'the laptop agent',
        token: 'osb_ak_ZXhhbXBsZS1rZXktdmFsdWUtZm9yLXRoZS1yZW5kZXItc3VpdGU',
        expires: DAY('2026-11-30T00:00:00.000Z'),
      }),
    },
    {
      name: 'settings-hears-through-assistant',
      html: chome.settingsPage({
        hearsVia: 'assistant',
        blindMode: true,
        freqMatches: 'immediate',
        freqDigests: 'daily',
        complaintSuppressed: false,
        emailUnreachable: false,
      }),
    },
    { name: 'match-offers', html: chome.matchOffersPage(offersView()) },
    {
      name: 'match-offers-mine-on-the-table',
      html: chome.matchOffersPage(
        offersView({
          myOfferOnTable: '400 AUD',
          offers: [
            {
              amount: '400 AUD',
              mine: true,
              state: 'proposed',
              authoredByMe: 'human',
              expires: cpages.localTime('2026-09-16T10:28:00.000Z'),
            },
          ],
        }),
      ),
    },
    {
      name: 'match-offers-agreed',
      html: chome.matchOffersPage(
        offersView({
          agreedAmount: '415 AUD',
          offers: [
            {
              amount: '415 AUD',
              mine: false,
              state: 'accepted-by-human',
              expires: cpages.localTime('2026-09-16T10:28:00.000Z'),
            },
          ],
        }),
      ),
    },
    { name: 'unsub', html: chome.unsubPage('osb_em_tok') },
    { name: 'reverify', html: chome.reverifyCodePage('v-1') },
  ];

  it('the taxonomy maps the test slug to a human label', () => {
    expect(LABEL).toBe('Mountain bikes');
    expect(LABEL).not.toContain('.');
  });

  // The buyer pays the fees, itemised, so BOTH humans are told the same three
  // lines in the same words, on the page where they act.
  it('every settlement page itemises the three lines and who pays them', () => {
    for (const role of ['buyer', 'seller'] as const) {
      const html = cpages.settlementPage(settlementView({ role, canPay: role === 'buyer' }));
      expect(html, role).toContain('Introductory fee');
      expect(html, role).toContain('1.00 AUD, paid by the buyer');
      expect(html, role).toContain('Card processing');
      expect(html, role).toContain('1.84 AUD');
      expect(html, role).toContain('90.49 AUD');
      expect(html, role).toContain('87.65 AUD in full');
    }
  });

  it('the buyer sees the three lines before they go to Stripe', () => {
    const html = cpages.settlementPage(settlementView({ canPay: true }));
    expect(html).toContain('87.65 AUD for what you agreed');
    expect(html).toContain('an introductory fee of\n1.00 AUD');
    expect(html).toContain("1.84 AUD for card processing at Stripe's standard rate");
    expect(html).toContain('That comes to 90.49 AUD');
    expect(html).toContain('the seller receives the 87.65 AUD you agreed, in full');
  });

  it('confirming says the seller receives the agreed amount in full', () => {
    const html = cpages.settlementPage(
      settlementView({ state: 'evidence-locked', canConfirm: true }),
    );
    expect(html).toContain('<h2>It arrived as agreed</h2>');
    expect(html).toContain('Saying so releases 87.65 AUD to the seller');
    expect(html).toContain('nothing comes off the seller');
  });

  it('the buyer is told who handed over, when, and what happens if they do nothing', () => {
    const html = cpages.settlementPage(
      settlementView({
        state: 'evidence-locked',
        canConfirm: true,
        canDispute: true,
        handover: HANDOVER,
      }),
    );
    expect(html).toContain(`Priya says it was handed over on ${SEP_5}.`);
    expect(html).toContain('Say it arrived as agreed when you\'re happy, or say something is wrong.');
    expect(html).toContain(`payment releases to Priya on its own on ${SEP_12}`);
    // The two dates are on the facts list too, in the same words.
    expect(html).toContain('Handed over');
    expect(html).toContain('Releases on its own');
    // And the fold says the clock stops.
    expect(html).toContain(`nothing is released on ${SEP_12}`);
  });

  it('the seller sees the same clock, from their own side', () => {
    const html = cpages.settlementPage(
      settlementView({ role: 'seller', state: 'evidence-locked', handover: HANDOVER }),
    );
    expect(html).toContain(`You declared the handover on ${SEP_5}.`);
    expect(html).toContain(`until\n${SEP_12}`);
    // The seller's own name is never read back to them.
    expect(html).not.toContain('Priya');
  });

  // -------------------------------------------------------------------------
  // The frozen half. Every one of these is a step only a human takes, on their
  // own page, and the copy has to say plainly what it does to the money.
  // -------------------------------------------------------------------------
  it('saying something is wrong holds the payment, and asks which of the two things it was', () => {
    const html = cpages.settlementPage(
      settlementView({ state: 'evidence-locked', canConfirm: true, canDispute: true }),
    );
    expect(html).toContain('Something is wrong');
    expect(html).toContain('This freezes the payment where it is. Nothing goes anywhere');
    expect(html).toContain('value="not_arrived"');
    expect(html).toContain('value="not_as_described"');
    expect(html).toContain('It never arrived');
    expect(html).toContain('It arrived and something is wrong with it');
    // An in-person handover has no parcel, so the page says which one to pick.
    expect(html).toContain('there is no parcel to go astray');
    // And the promise the terms make about the two fee lines.
    expect(html).toContain('processor keeps its own fee on a refund');
    // Nothing on this page offers to send the whole payment back any more.
    expect(html).not.toContain('send the payment back');
  });

  it('a frozen payment says what happens if neither of them does anything', () => {
    const html = cpages.settlementPage(
      settlementView({
        state: 'disputed',
        inDispute: true,
        canProposeSplit: true,
        disputeGround: 'not_as_described',
        deadlockByDay: SEP_19,
      }),
    );
    expect(html).toContain('The payment is on hold');
    expect(html).toContain(`the payment goes on ${SEP_19}`);
    expect(html).toContain('whichever\nside can show where the item went');
    expect(html).toContain('The rule decides on');
  });

  it('the seller is asked for tracking, with the day it stops helping', () => {
    const html = cpages.settlementPage(
      settlementView({
        role: 'seller',
        state: 'disputed',
        inDispute: true,
        disputeGround: 'not_arrived',
        canAddTracking: true,
        canProposeSplit: true,
        trackingGraceByDay: SEP_12,
        deadlockByDay: SEP_19,
      }),
    );
    expect(html).toContain('<h2>Add tracking</h2>');
    expect(html).toContain('The buyer says it never arrived.');
    expect(html).toContain(`delivered by ${SEP_12}`);
  });

  it('the buyer sends it back tracked, and is told what the seller has to do', () => {
    const html = cpages.settlementPage(
      settlementView({
        state: 'disputed',
        inDispute: true,
        canMarkReturned: true,
        canProposeSplit: true,
      }),
    );
    expect(html).toContain("<h2>I've sent it back</h2>");
    expect(html).toContain('87.65 AUD comes back to you');
    // Postage is outside the hold, and the page says so where it matters.
    expect(html).toContain('Postage is between the two of you');
  });

  it('the seller closes a return, and the copy keeps the fees where they are', () => {
    const html = cpages.settlementPage(
      settlementView({
        role: 'seller',
        state: 'disputed',
        inDispute: true,
        canConfirmReturn: true,
        canProposeSplit: true,
        returnedOnDay: SEP_12,
        returnTracking: 'AP 7XY441',
        returnSilenceByDay: SEP_19,
      }),
    );
    expect(html).toContain("<h2>I've got it back</h2>");
    expect(html).toContain('sends 87.65 AUD back to the buyer');
    expect(html).toContain('processor keeps its own fee on a refund');
    expect(html).toContain(`Sent back on ${SEP_12}`);
    expect(html).toContain(`says nothing by ${SEP_19}`);
  });

  it('a split on the table shows both figures and who has agreed', () => {
    const html = cpages.settlementPage(
      settlementView({
        state: 'resolution-proposed',
        inDispute: true,
        canProposeSplit: true,
        canApproveSplit: true,
        split: {
          refundMinor: 2000,
          releaseMinor: 6765,
          refund: '20.00 AUD',
          release: '67.65 AUD',
          mine: false,
          theirs: true,
        },
      }),
    );
    expect(html).toContain('<h2>On the table</h2>');
    expect(html).toContain('20.00 AUD back to the buyer and 67.65 AUD to the seller');
    expect(html).toContain('You have not agreed to this yet.');
    expect(html).toContain('The other side has agreed.');
    expect(html).toContain('Agree to this split');
    // The figures the human is agreeing to ride with the press, so a split
    // that changed underneath them cannot be approved by accident.
    expect(html).toContain('name="refund_minor" value="2000"');
    expect(html).toContain('name="release_minor" value="6765"');
  });

  it('the split form says the two figures have to add up to what is held', () => {
    const html = cpages.settlementPage(
      settlementView({ state: 'disputed', inDispute: true, canProposeSplit: true }),
    );
    expect(html).toContain('<h2>Propose a split</h2>');
    expect(html).toContain('the 87.65 AUD being held');
    expect(html).toContain('have to add up to\nexactly that');
    expect(html).toContain('postage itself is between the two of you');
    expect(html).toContain('name="refund_to_buyer"');
    expect(html).toContain('name="release_to_seller"');
  });

  it("the seller's handover step is named for what it is, and photos are optional", () => {
    const html = cpages.settlementPage(
      settlementView({ role: 'seller', state: 'funded', canLockEvidence: true }),
    );
    expect(html).toContain('<h2>Handed over</h2>');
    expect(html).toContain('Photos are optional');
    expect(html).toContain('Photos of the handover (optional)');
    expect(html).toContain("Handed over — start the buyer's 7 days");
    // The button is live before anything is uploaded.
    expect(html).not.toContain('id="lockBtn" disabled');
  });

  for (const p of allPages()) {
    it(`${p.name}: no "the counter", no raw slugs, no "card", passes the banned-phrase lint`, () => {
      const low = p.html.toLowerCase();
      // "the counter" and "your counter" are gone from every page. URLs are
      // fine: route paths are "/...", which never form the phrase.
      expect(low).not.toContain('the counter');
      expect(low).not.toContain('your counter');
      // Raw category slugs never render — the label does.
      expect(p.html).not.toContain(SLUG);
      expect(low).not.toMatch(/goods\.[a-z]/);
      // Banned jargon stays out of page copy.
      expect(low).not.toContain('safety rail');
      // VOICE: same antithesis lint the email suite runs, plus the
      // vocabulary rule — one "card" is one want or one have, and from
      // 2026-09-11 the word a person reads is want or have. CSS hooks
      // (--card, .card-row, data-card-id) and payment cards are exempt.
      expect(lintHumanCopy(p.html)).toEqual([]);
    });
  }

  it('the ledger shows where each card sits and how far it reaches', () => {
    // A card in the wrong place is only visible to the person who lives in
    // the right one, so the resolved location goes on their own page.
    const ledger = Object.fromEntries(allPages().map((p) => [p.name, p.html])).ledger;
    expect(ledger).toContain('Canberra, Australian Capital Territory, Australia');
    expect(ledger).toContain('matching within 150 km');
    // A card that reaches a whole country says so in the same line, in the
    // same words: a radius would be a lie about it.
    expect(ledger).toContain('reaching all of Australia');
  });

  it('pages given a category label show it', () => {
    const byName = Object.fromEntries(allPages().map((p) => [p.name, p.html]));
    for (const name of ['dashboard', 'ledger', 'card-edit', 'renew', 'approval-offer']) {
      expect(byName[name], name).toContain(LABEL);
    }
  });

  it('a rejected card gets its own attention item and its own reason', () => {
    const byName = Object.fromEntries(allPages().map((p) => [p.name, p.html]));
    // Dashboard: the attention item, its own button wording, the edit link.
    expect(byName['dashboard']).toContain(`Your ${LABEL} didn&#39;t pass screening`);
    expect(byName['dashboard']).toContain('/ledger/c-9/edit');
    expect(byName['dashboard']).toContain('See why and fix it');
    // Everything else on the dashboard keeps the decide-on-it wording.
    expect(byName['dashboard']).toContain('Review &amp; decide');
    // Edit page: plain words up top, raw code small underneath.
    expect(byName['card-edit-screening-rejected']).toContain(
      screeningReasonInPlainWords('pii-in-card'),
    );
    expect(byName['card-edit-screening-rejected']).toContain('screening code: pii-in-card');
    expect(byName['card-edit']).not.toContain('screening code:');
  });

  it('the dashboard leads with what is waiting, and navigation comes after it', () => {
    const html = Object.fromEntries(allPages().map((p) => [p.name, p.html])).dashboard;
    const waiting = html.indexOf('<h2>Waiting for you</h2>');
    const nav = html.indexOf('<h2>Your switchboard</h2>');
    expect(waiting).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(waiting);
    // The decisions are tappable cards, and the first of them is a decision
    // rather than a link to a list.
    expect(html.indexOf('class="todo urgent"')).toBeGreaterThan(waiting);
    expect(html.indexOf('class="todo urgent"')).toBeLessThan(nav);
    // The decisions come first and the quiet half follows them.
    expect(html.indexOf('WAITING FOR YOU')).toBeGreaterThan(waiting);
    expect(html.indexOf('WAITING FOR YOU')).toBeLessThan(nav);
    // The quiet half is a list of links rather than a stack of buttons.
    expect(html.indexOf('class="navlist"')).toBeGreaterThan(nav);
    for (const href of ['/ledger', '/profile', '/arrangement', '/agent-keys', '/settings']) {
      expect(html, href).toContain(`<a href="${href}"><span class="nav-t">`);
    }
    // The kill switch stays at the bottom, in its own frame.
    expect(html.indexOf('class="kill"')).toBeGreaterThan(html.indexOf('class="navlist"'));
  });

  it('an empty dashboard says so rather than showing an empty heading', () => {
    const html = chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
      collectionWindows: [],
    });
    expect(html).toContain('Nothing is waiting for you.');
    expect(html).toContain('<h2>Waiting for you</h2>');
  });

  it('wants and haves near the end of their clock are something waiting, with no figure in the link', () => {
    const html = chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 3, published: 3, pending: 0 },
      pendingApprovals: [],
      collectionWindows: [],
      lapsingSoon: { count: 2, soonest: cpages.localTime('2026-09-08T00:00:00.000Z', 'day') },
    });
    expect(html).toContain('2 of your wants and haves');
    // The day reads as a day, in the reader's own clock: the page prints the
    // markup rather than escaping it.
    expect(html).toContain(
      'out by <time datetime="2026-09-08T00:00:00.000Z" data-local="day">Tuesday 8 September</time>',
    );
    expect(html).not.toContain('&lt;time');
    expect(html).not.toContain('Nothing is waiting for you.');
    expect(lintHumanCopy(html)).toEqual([]);
  });

  it('every page carries the same header and the signature footer line', () => {
    for (const p of allPages()) {
      expect(p.html, p.name).toContain('<header class="site">');
      expect(p.html, p.name).toContain('src="/assets/patch.png"');
      expect(p.html, p.name).toContain('Everything agents must never do, you do here.');
      // Phone first: one column, and a viewport that does not let a page zoom
      // its way out of a 375px screen.
      expect(p.html, p.name).toContain('width=device-width, initial-scale=1');
    }
  });

  it('card rows carry the attributes detail line that tells same-category cards apart', () => {
    const byName = Object.fromEntries(allPages().map((p) => [p.name, p.html]));
    expect(byName['ledger']).toContain('condition: good');
    expect(byName['renew']).toContain('condition: good · frame: large');
  });
});

// ---------------------------------------------------------------------------
// The Giant Talon rehearsal, 9 September. Two assistants, one real bike and
// one real inbox, and every assertion below is a line that run found wrong on
// a page a person was looking at.
// ---------------------------------------------------------------------------

const settingsView = (hearsVia: chome.HearsVia): chome.EmailSettingsView => ({
  hearsVia,
  blindMode: false,
  freqMatches: 'immediate',
  freqDigests: 'daily',
  complaintSuppressed: false,
  emailUnreachable: false,
});

describe('how do you want to hear about things?', () => {
  it('leads the settings page, above the frequency dials and blind mode', () => {
    const html = chome.settingsPage(settingsView('email'));
    const ask = html.indexOf('<h2>How do you want to hear about things?</h2>');
    expect(ask).toBeGreaterThan(-1);
    expect(html.indexOf('<h2>Email frequency</h2>')).toBeGreaterThan(ask);
    expect(html.indexOf('<h2>Blind mode</h2>')).toBeGreaterThan(ask);
  });

  it('puts the two answers in the words a person would use', () => {
    const html = chome.settingsPage(settingsView('email'));
    expect(html).toContain('By email.');
    expect(html).toContain(
      'My assistant only acts when I talk to it. Every match, reply and step reaches me by email.',
    );
    expect(html).toContain('Through my assistant.');
    expect(html).toContain('It checks on its own and brings me the news; email is a backup only.');
    expect(html).toContain('action="/settings/hears-via"');
  });

  it('shows which of the two is on', () => {
    const email = chome.settingsPage(settingsView('email'));
    expect(email).toContain(
      '<input id="hears_email" name="hears_via" type="radio" value="email" checked>',
    );
    expect(email).toContain('Right now everything reaches you by email.');
    expect(email).not.toContain('value="assistant" checked');

    const assistant = chome.settingsPage(settingsView('assistant'));
    expect(assistant).toContain(
      '<input id="hears_assistant" name="hears_via" type="radio" value="assistant" checked>',
    );
    expect(assistant).toContain('Right now your assistant brings you the news');
    expect(assistant).not.toContain('value="email" checked');
  });

  it('keeps the controls that were already there', () => {
    const html = chome.settingsPage(settingsView('assistant'));
    expect(html).toContain('action="/settings/frequency"');
    expect(html).toContain('action="/settings/blind-mode"');
  });
});

describe('the dashboard the rehearsal left notes on', () => {
  const dash = (over: Partial<chome.DashboardView> = {}): string =>
    chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 1, published: 1, pending: 0 },
      pendingApprovals: [],
      collectionWindows: [],
      ...over,
    });

  it('says how many messages wait and what they are about, and nothing of what they say', () => {
    const html = dash({ messagesWaiting: [{ matchId: 'm-1', category: LABEL, count: 1 }] });
    expect(html).toContain(
      '1 message on your mountain bike conversation. Ask your assistant and it will read it to you.',
    );
    expect(html).toContain('MESSAGES WAITING');
    expect(html).not.toContain('Nothing is waiting for you.');
  });

  it('counts the rest of them, and reads them out in the plural', () => {
    const html = dash({ messagesWaiting: [{ matchId: 'm-1', category: LABEL, count: 3 }] });
    expect(html).toContain(
      '3 messages on your mountain bike conversation. Ask your assistant and it will read them to you.',
    );
  });

  it('a deal a human accepted says the figure and where the rest of it happens', () => {
    const html = dash({ agreed: [{ matchId: 'm-1', category: LABEL, amount: '415 AUD' }] });
    expect(html).toContain(
      'Agreed at $415 AUD on your mountain bike match. Sort pickup in the conversation; the switchboard&#39;s part is done.',
    );
    expect(html).toContain('href="/matches/m-1"');
    expect(html).not.toContain('Nothing is waiting for you.');
  });

  // 2026-09-11: the page holds the decisions and nothing else. The one-tap
  // feedback and the percentage beside it made it a place to browse, so the
  // feedback moved to the introduction it is about and the percentage is gone
  // from everywhere a person reads.
  it('says under the greeting what the page is for', () => {
    const html = dash();
    expect(html).toContain(chome.FRONT_PAGE_LEAD);
    expect(html).toContain('Your assistant is where the conversation happens.');
    expect(html).toContain('This page is for the decisions only you can make.');
  });

  it('holds no feedback block and no percentage', () => {
    const html = dash({
      agreed: [{ matchId: 'm-1', category: LABEL, amount: '415 AUD' }],
      messagesWaiting: [{ matchId: 'm-2', category: LABEL, count: 1 }],
    });
    expect(html).not.toContain('Was the switchboard right?');
    expect(html).not.toContain('Good call');
    expect(html).not.toContain('Not for me');
    expect(html).not.toContain('action="/verdict"');
    expect(html).not.toMatch(/score\s*\d+\s*%/i);
    expect(html).not.toContain('badge state">score');
  });

  it('an account with nothing to decide still says so', () => {
    const html = dash();
    expect(html).toContain('Nothing is waiting for you.');
  });
});

describe('the offers page the rehearsal left notes on', () => {
  it('carries a negotiation control where a badge nobody could press used to be', () => {
    const html = chome.matchOffersPage(offersView());
    expect(html).toContain('<h2>How your agent negotiates</h2>');
    expect(html).toContain('action="/ledger/c-1/numbers"');
    expect(html).toContain('name="return_to" value="m-1"');
    expect(html).toContain('Pass on:');
    expect(html).toContain(
      'your agent brings every offer to you and sends back the numbers you give it',
    );
    expect(html).toContain('Auto-negotiate:');
    expect(html).toContain('your agent can put figures on the table inside your limits');
    // The mode is no longer a badge sitting on its own next to the category.
    expect(html).not.toContain('<span class="badge state">Pass on</span>');
    // The numbers ride with the control, out of the way until they are wanted.
    expect(html).toContain('<div id="negnumbers" hidden>');
    expect(html).toContain('name="limit"');
    expect(html).toContain('name="step"');
  });

  it('a card on auto-negotiate shows the limits its agent works inside', () => {
    const html = chome.matchOffersPage(
      offersView({ mode: 'mandate', mandate: { limit: 380, step: 10, ccy: 'AUD' } }),
    );
    expect(html).toContain('<div id="negnumbers">');
    expect(html).toContain('id="negmode_mandate" name="mode" type="radio" value="mandate" checked');
    expect(html).toContain('name="limit" type="number" step="0.01" min="0" value="380"');
    expect(html).toContain('name="step" type="number" step="0.01" min="0" value="10"');
    expect(html).toContain('name="ccy" type="text" maxlength="3" pattern="[A-Za-z]{3}" value="AUD"');
  });

  it('with nothing sent, the box to type a figure into stands open', () => {
    const html = chome.matchOffersPage(offersView());
    expect(html).toContain(`<h2>${chome.OFFER_HEADING_EMPTY}</h2>`);
    expect(html).toContain('<h2>Put a number on the table</h2>');
    expect(html).not.toContain('is on the table.');
  });

  // The assistant carried a figure here, so the box is a confirmation rather
  // than a blank page: the heading says so above the number already in it.
  it('a figure the assistant carried is headed as a confirmation', () => {
    const html = chome.matchOffersPage(
      offersView({ draft: { amount: '400', ccy: 'AUD', note: 'Can collect Saturday.' } }),
    );
    expect(html).toContain('<h2>Confirm the number your assistant brought</h2>');
    expect(html).toContain(`<h2>${chome.OFFER_HEADING_DRAFT}</h2>`);
    expect(html).not.toContain(`<h2>${chome.OFFER_HEADING_EMPTY}</h2>`);
    expect(html).toContain('value="400"');
    expect(html).toContain('value="Can collect Saturday."');
    expect(html).toContain('<button type="submit">Send this number</button>');
  });

  // The one-tap feedback lives here now, at the very foot of the introduction
  // it is about, with no figure anywhere near it.
  it('asks once, quietly, at the bottom whether this was a good one', () => {
    const html = chome.matchOffersPage(offersView());
    expect(html).toContain('Was this a good match?');
    expect(html).toContain('action="/verdict"');
    expect(html).toContain('<input type="hidden" name="verdict" value="good-call">');
    expect(html).toContain('<input type="hidden" name="verdict" value="not-for-me">');
    expect(html).toContain('name="return_to" value="m-1"');
    expect(html).toContain('"No" also mutes');
    expect(html).not.toMatch(/score\s*\d/i);
    // Last on the page: everything that asks something of the person is above it.
    expect(html.indexOf('Was this a good match?')).toBeGreaterThan(
      html.indexOf('<h2>What has been offered</h2>'),
    );
  });

  it('once they have answered, it reads the answer back and stops asking', () => {
    const good = chome.matchOffersPage(offersView({ verdict: 'good-call' }));
    expect(good).toContain('Your call on this one: good call.');
    expect(good).not.toContain('Was this a good match?');
    expect(good).not.toContain('good-call.');
    const no = chome.matchOffersPage(offersView({ verdict: 'not-for-me' }));
    expect(no).toContain('Your call on this one: not for me.');
  });

  it('a figure of theirs that is already out there collapses the form to one line', () => {
    const html = chome.matchOffersPage(
      offersView({
        myOfferOnTable: '400 AUD',
        offers: [
          {
            amount: '400 AUD',
            mine: true,
            state: 'proposed',
            authoredByMe: 'human',
            expires: cpages.localTime('2026-09-16T10:28:00.000Z'),
          },
        ],
      }),
    );
    expect(html).toContain('Your $400 AUD is on the table.');
    expect(html).toContain('Change your number');
    // Folded away rather than gone: the whole form is still on the page.
    expect(html).toContain('<details class="more">');
    expect(html).toContain('name="amount"');
    expect(html).not.toContain(`<h2>${chome.OFFER_HEADING_EMPTY}</h2>`);
  });

  it('the optional line asks for something a person can fit on it', () => {
    expect(chome.matchOffersPage(offersView())).toContain(
      'placeholder="A line to go with it, e.g. can collect Saturday"',
    );
  });

  it('an accepted offer reads as a deal, on its row and at the top of the page', () => {
    const html = chome.matchOffersPage(
      offersView({
        agreedAmount: '415 AUD',
        offers: [
          {
            amount: '415 AUD',
            mine: false,
            state: 'accepted-by-human',
            expires: cpages.localTime('2026-09-16T10:28:00.000Z'),
          },
        ],
      }),
    );
    expect(html).toContain('<strong>Agreed at $415 AUD</strong>');
    expect(html).toContain(
      'Agreed at $415 AUD. Sort pickup in the conversation; the switchboard&#39;s part is done.',
    );
    // Nothing asks for another figure once a person has said yes to one.
    expect(html).not.toContain(`<h2>${chome.OFFER_HEADING_EMPTY}</h2>`);
    // And the row says "agreed" rather than reading its own state back.
    expect(html).not.toContain('>accepted-by-human<');
  });

  it('offer states are said in words', () => {
    const html = chome.matchOffersPage(
      offersView({
        offers: [
          {
            amount: '400 AUD',
            mine: true,
            state: 'proposed',
            authoredByMe: 'human',
            expires: cpages.localTime('2026-09-16T10:28:00.000Z'),
          },
        ],
      }),
    );
    expect(html).toContain('>on the table<');
    expect(html).not.toContain('>proposed<');
  });

  it('the sealed page keeps its own button, named for what is on it', () => {
    const html = chome.matchOffersPage(offersView());
    expect(html).toContain('href="/ledger/c-1/numbers">Your limit on this have</a>');
  });
});

// ---------------------------------------------------------------------------
// Passkey ceremony state: the challenge lifecycle.
//
// The enrolment bug that this covers: takeWebauthnChallenge cleared the
// challenge and read it back through the same UPDATE's RETURNING. PostgreSQL
// (below 18, and dev/prod run 17) evaluates RETURNING against the NEW tuple,
// so the statement handed back the NULL it had just written and every
// /passkey/verify answered 400 no_pending_challenge.
//
// The lifecycle itself is a property of the database, so it is proven for real
// twice over: test/integration/gates.test.ts runs these exact statements
// against live PostgreSQL, and test/e2e/passkey.spec.ts enrols a virtual
// authenticator end to end. What is checkable without a database — the
// statement's structure, and the mapping the module puts on top of it — is
// checked here so the defect cannot come back unnoticed.
// ---------------------------------------------------------------------------
describe('webauthn challenge: single-use, short-TTL, read before clear', () => {
  const take = sess.TAKE_WEBAUTHN_CHALLENGE_SQL;

  it('never projects the challenge out of the RETURNING of the update that nulls it', () => {
    // Everything after the clearing SET, up to the end of that UPDATE's own
    // RETURNING list, must not mention the challenge column: on PostgreSQL a
    // RETURNING list sees the new (cleared) row.
    const clearing = take.slice(take.indexOf('SET webauthn_challenge = NULL'));
    const returning = clearing.slice(clearing.indexOf('RETURNING'));
    const returningList = returning.split(/\)|\n\s*\)/)[0];
    expect(returningList).not.toContain('webauthn_challenge');
    // The value that is handed back is read before the clear instead.
    expect(take).toMatch(/SELECT[\s\S]*webauthn_challenge[\s\S]*FROM counter_sessions/);
  });

  it('reads and clears in one statement, holding the row while it does', () => {
    expect(take).not.toContain(';'); // one statement: no read-then-write window
    expect(take).toContain('FOR UPDATE');
    expect(take).toContain('webauthn_challenge = NULL');
    expect(take).toContain('webauthn_challenge_expires = NULL');
  });

  it('refuses a spent or stale challenge in the statement itself', () => {
    expect(take).toContain('webauthn_challenge IS NOT NULL'); // single-use
    expect(take).toContain('webauthn_challenge_expires > now()'); // TTL
  });

  it('issues a challenge with a short TTL', () => {
    expect(sess.WEBAUTHN_CHALLENGE_TTL).toBe('5 minutes');
    expect(sess.SET_WEBAUTHN_CHALLENGE_SQL).toContain("interval '5 minutes'");
  });

  it('takes the challenge for the given session and reports nothing when there is none', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const fake = (rows: any[]) => ({
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    });

    const spy = vi.spyOn(db, 'getPool');
    try {
      spy.mockReturnValue(fake([{ webauthn_challenge: 'chal-abc' }]) as any);
      expect(await sess.takeWebauthnChallenge('sess-1')).toBe('chal-abc');
      expect(calls[0].sql).toBe(take);
      expect(calls[0].params).toEqual(['sess-1']);

      // No live challenge -> no rows -> undefined, which is what the route
      // turns into 400 no_pending_challenge.
      spy.mockReturnValue(fake([]) as any);
      expect(await sess.takeWebauthnChallenge('sess-1')).toBeUndefined();

      // A row that somehow carries NULL is not a challenge either.
      spy.mockReturnValue(fake([{ webauthn_challenge: null }]) as any);
      expect(await sess.takeWebauthnChallenge('sess-1')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
